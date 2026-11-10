// Gen AI spans for every model call (https://github.com/bgoleno/opportun/issues/344, FR-T4;
// docs/design.md 14.5, 14.6 and 14.8). This is the one file that holds the Gen AI names: the
// conventions are still marked Development, so a later change to them is a change here, and the
// server's catalog imports them from this package.
//
// The names follow https://github.com/open-telemetry/semantic-conventions-genai at commit
// e6658f14c9 (docs/gen-ai/client-inference.md).
//
// This package still does no IO. It uses @opentelemetry/api only, which does nothing until the
// server registers a tracer provider, so with no provider a span here costs a no-op object.
//
// What is never on a span, and why this file has no code that could put it there: the prompt, the
// system text, the model's output and the text of an error (an AI SDK error message can quote the
// output). A span carries ids, closed-list values, numbers and flags only. No exception event
// either: error.type holds the router's reason, never the error's own message.
import {
  context,
  createContextKey,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { TASK_FEATURE } from './features';
import type { AiUnavailableReason, ModelPolicy, TaskKey } from './types';

/** Attribute names, the names of the conventions and Opportun's own under `opportun.`. */
export const ATTR = {
  operationName: 'gen_ai.operation.name',
  providerName: 'gen_ai.provider.name',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  requestMaxTokens: 'gen_ai.request.max_tokens',
  requestTemperature: 'gen_ai.request.temperature',
  requestStream: 'gen_ai.request.stream',
  outputType: 'gen_ai.output.type',
  promptName: 'gen_ai.prompt.name',
  promptVersion: 'gen_ai.prompt.version',
  usageInputTokens: 'gen_ai.usage.input_tokens',
  usageOutputTokens: 'gen_ai.usage.output_tokens',
  usageCacheReadInputTokens: 'gen_ai.usage.cache_read.input_tokens',
  usageCacheWriteInputTokens: 'gen_ai.usage.cache_write.input_tokens',
  responseId: 'gen_ai.response.id',
  responseFinishReasons: 'gen_ai.response.finish_reasons',
  responseTimeToFirstChunk: 'gen_ai.response.time_to_first_chunk',
  conversationId: 'gen_ai.conversation.id',
  errorType: 'error.type',
  userId: 'user.id',
  aiProvider: 'opportun.ai.provider',
  aiTask: 'opportun.ai.task',
  aiFeature: 'opportun.ai.feature',
  aiPromptId: 'opportun.ai.prompt.id',
  aiAttempts: 'opportun.ai.attempts',
  usageCost: 'opportun.gen_ai.usage.cost',
} as const;

/** The only operation a router call has. A workflow's parent span is the server's, not ours. */
export const OPERATION_CHAT = 'chat';

/** The task name of a key check, which is not a task of the router (no budget, no ledger row). */
export const KEY_CHECK_TASK = 'key_check';

/** The name this package's spans are created under. */
export const TRACER_NAME = '@opportun/ai';

/**
 * What the AI SDK's own telemetry is told on every call. It records prompts and responses by
 * default under names that are not the conventions', and it turns on by itself once an
 * integration is registered, so every call says off in words, and recording off as a second line.
 */
export const SDK_TELEMETRY_OFF = {
  isEnabled: false,
  recordInputs: false,
  recordOutputs: false,
} as const;

// ---------------------------------------------------------------- the user in the context

/**
 * Where the request or the job puts the user it runs for (design 14.6). The router reads it to
 * decide whether a call belongs in the trace it finds or starts one of its own.
 */
export const USER_CONTEXT_KEY = createContextKey('opportun.user_id');

/** The user the context was made for, or undefined. */
export function userInContext(ctx: Context = context.active()): string | undefined {
  const value = ctx.getValue(USER_CONTEXT_KEY);
  return typeof value === 'string' ? value : undefined;
}

/** Runs `fn` with the user in the context, as the request plugin and the job runner do. */
export function withUser<T>(userId: string, fn: () => T): T {
  return context.with(context.active().setValue(USER_CONTEXT_KEY, userId), fn);
}

// ---------------------------------------------------------------- what may be named

/**
 * Whether a string has the shape of a model id (design 14.8): up to 128 characters, segments of
 * letters, digits and `. _ : -`, with at most one `/`, not at the start or the end. Anything else
 * (a file path, a sentence) is a string someone typed, and is not put on a span.
 */
export function isModelId(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)?$/.test(value);
}

/**
 * A provider's id for a response (design 14.8, type `code`): up to 64 characters of letters,
 * digits, `_`, `-` and `.`. A gateway of the user's choosing can send anything as an id.
 */
function isCode(value: string): boolean {
  return value.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(value);
}

/** The model id as it may appear on a span: itself when shaped like one, else `_OTHER`. */
function modelAttr(value: string): string {
  return isModelId(value) ? value : '_OTHER';
}

/** `chat {model}` when the model is shaped like a model id, else `chat`. */
export function spanNameFor(model: string): string {
  return isModelId(model) ? `${OPERATION_CHAT} ${model}` : OPERATION_CHAT;
}

/** The provider of the wire format: an OpenAI-compatible endpoint speaks OpenAI's. */
function wireProvider(provider: ModelPolicy['provider']): 'anthropic' | 'openai' {
  return provider === 'anthropic' ? 'anthropic' : 'openai';
}

// ---------------------------------------------------------------- the inference span

export interface InferenceStart {
  /** A task of the router, or `key_check`. */
  task: TaskKey | typeof KEY_CHECK_TASK;
  policy: Pick<ModelPolicy, 'provider' | 'model' | 'maxOutputTokens' | 'temperature'>;
  stream: boolean;
  outputType: 'json' | 'text';
  /** The prompt row's id, and the version of the prompt when the caller has one. */
  promptId?: string | undefined;
  promptVersion?: string | undefined;
  /** The tailoring session id, for the chat's spans only. Never made up. */
  conversationId?: string | undefined;
  /** The user the call is for. A key check has none of its own and reads the context's. */
  userId?: string | undefined;
}

export interface InferenceUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface InferenceEnd {
  /** The router's reason when the call failed. Never an error's text. */
  errorType?: AiUnavailableReason;
  /** Set once a provider call was made: a refusal before the provider has none. */
  usage?: InferenceUsage;
  attempts?: number;
  costUsd?: number;
}

/** What the provider said about the response, as the SDK reports it. */
export interface InferenceResponse {
  id?: string | undefined;
  modelId?: string | undefined;
  finishReason?: string | undefined;
}

/**
 * One inference span: one logical call of the router, retries inside it. It starts when the
 * policy is known and ends where the run is recorded. It is a child of the span in the context
 * unless the call is for another user than the context's, which starts a new trace (14.6).
 */
export class InferenceSpan {
  private readonly span: Span;
  private readonly started = performance.now();
  private ended = false;
  private firstChunk = false;
  private response: InferenceResponse = {};
  /** The context with this span active, and the user it is for. */
  readonly context: Context;

  constructor(start: InferenceStart) {
    const active = context.active();
    const userId = start.userId ?? (start.task === KEY_CHECK_TASK ? userInContext(active) : undefined);
    let parent = active;
    if (start.userId !== undefined && userInContext(active) !== start.userId) {
      // One trace belongs to one user: a call for someone else is not part of this one.
      parent = trace.deleteSpan(active);
    }
    if (userId !== undefined) parent = parent.setValue(USER_CONTEXT_KEY, userId);

    const attributes: Attributes = {
      [ATTR.operationName]: OPERATION_CHAT,
      [ATTR.providerName]: wireProvider(start.policy.provider),
      [ATTR.aiProvider]: start.policy.provider,
      [ATTR.requestModel]: modelAttr(start.policy.model),
      [ATTR.requestMaxTokens]: start.policy.maxOutputTokens,
      [ATTR.outputType]: start.outputType,
      [ATTR.aiTask]: start.task,
    };
    if (start.policy.temperature !== undefined) {
      attributes[ATTR.requestTemperature] = start.policy.temperature;
    }
    if (start.stream) attributes[ATTR.requestStream] = true;
    if (start.task !== KEY_CHECK_TASK) {
      attributes[ATTR.promptName] = start.task;
      attributes[ATTR.aiFeature] = TASK_FEATURE[start.task];
      if (start.promptVersion !== undefined) attributes[ATTR.promptVersion] = start.promptVersion;
      if (start.promptId !== undefined) attributes[ATTR.aiPromptId] = start.promptId;
    }
    if (start.conversationId !== undefined) attributes[ATTR.conversationId] = start.conversationId;
    if (userId !== undefined) attributes[ATTR.userId] = userId;

    this.span = trace
      .getTracer(TRACER_NAME)
      .startSpan(spanNameFor(start.policy.model), { kind: SpanKind.CLIENT, attributes }, parent);
    this.context = trace.setSpan(parent, this.span);
  }

  /** Runs `fn` with this span active, so a request made inside it is the span's child. */
  run<T>(fn: () => T): T {
    return context.with(this.context, fn);
  }

  /** What the provider reported. The last one reported before the span ends is kept. */
  setResponse(response: InferenceResponse): void {
    this.response = { ...this.response, ...definedOnly(response) };
  }

  /** The first chunk of output of a stream: the time to it is an attribute, in seconds. */
  markFirstChunk(): void {
    if (this.firstChunk || this.ended) return;
    this.firstChunk = true;
    this.span.setAttribute(
      ATTR.responseTimeToFirstChunk,
      Math.max(0, performance.now() - this.started) / 1000,
    );
  }

  /** Ends the span once; a later call (a stream can report both an error and an end) does nothing. */
  end(outcome: InferenceEnd): void {
    if (this.ended) return;
    this.ended = true;
    const { id, modelId, finishReason } = this.response;
    if (outcome.usage !== undefined) {
      this.span.setAttribute(ATTR.usageInputTokens, outcome.usage.input);
      this.span.setAttribute(ATTR.usageOutputTokens, outcome.usage.output);
      // Cache tokens are in the input count already; reported on their own when not zero.
      if ((outcome.usage.cacheRead ?? 0) > 0) {
        this.span.setAttribute(ATTR.usageCacheReadInputTokens, outcome.usage.cacheRead ?? 0);
      }
      if ((outcome.usage.cacheWrite ?? 0) > 0) {
        this.span.setAttribute(ATTR.usageCacheWriteInputTokens, outcome.usage.cacheWrite ?? 0);
      }
    }
    if (modelId !== undefined) this.span.setAttribute(ATTR.responseModel, modelAttr(modelId));
    if (id !== undefined && isCode(id)) this.span.setAttribute(ATTR.responseId, id);
    if (finishReason !== undefined) this.span.setAttribute(ATTR.responseFinishReasons, [finishReason]);
    if (outcome.attempts !== undefined) this.span.setAttribute(ATTR.aiAttempts, outcome.attempts);
    if (outcome.costUsd !== undefined) this.span.setAttribute(ATTR.usageCost, outcome.costUsd);
    if (outcome.errorType !== undefined) {
      this.span.setAttribute(ATTR.errorType, outcome.errorType);
      // A status with no message: a message could quote what the model wrote.
      this.span.setStatus({ code: SpanStatusCode.ERROR });
    }
    this.span.end();
  }
}

function definedOnly(response: InferenceResponse): InferenceResponse {
  const out: InferenceResponse = {};
  if (response.id !== undefined) out.id = response.id;
  if (response.modelId !== undefined) out.modelId = response.modelId;
  if (response.finishReason !== undefined) out.finishReason = response.finishReason;
  return out;
}
