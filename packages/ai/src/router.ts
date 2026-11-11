// Provider-agnostic model router (FR-A1, A2, A5, A6). Every call: resolve the policy, check
// the per-task daily budget, load the key, call the provider, and record exactly one
// TaskRunRecord, whether the call succeeded or failed.
import {
  APICallError,
  asSchema,
  generateText,
  NoObjectGeneratedError,
  Output,
  RetryError,
  streamText,
  type Instructions,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import type { z } from 'zod';
import { cacheMinTokens, estimateCost } from './pricing';
import { createLanguageModel } from './providers';
import { InferenceSpan, SDK_TELEMETRY_OFF } from './telemetry';
import {
  AiUnavailableError,
  type AiDeps,
  type AiUnavailableReason,
  type ModelPolicy,
  type TaskKey,
  type TaskRunRecord,
} from './types';

/** The AI SDK's name for a chat message (formerly CoreMessage). */
export type CoreMessage = ModelMessage;
export type ChatStreamResult = ReturnType<typeof streamText<ToolSet>>;

/** Schema-invalid output gets one retry, so at most two provider calls per runStructured. */
const MAX_ATTEMPTS = 2;
/** Network-level retries inside the SDK (429, 5xx), separate from the schema retry. */
const SDK_MAX_RETRIES = 2;
const MAX_ERROR_DETAIL = 300;

interface Tokens {
  input: number;
  output: number;
  /** Part of `input` already; priced at their own rates (#356) and given to the span. */
  cacheRead: number;
  cacheWrite: number;
}

function addUsage(acc: Tokens, usage: LanguageModelUsage | undefined): void {
  acc.input += usage?.inputTokens ?? 0;
  acc.output += usage?.outputTokens ?? 0;
  acc.cacheRead += usage?.inputTokenDetails?.cacheReadTokens ?? 0;
  acc.cacheWrite += usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
}

/** Why a run failed, as the ledger and the span each say it (the span never gets `detail`). */
interface Failure {
  reason: AiUnavailableReason;
  detail?: string | undefined;
}

/** What a call tells its span at the start; the policy and the user come from the run. */
interface CallInfo {
  stream: boolean;
  outputType: 'json' | 'text';
  promptId?: string | undefined;
  promptVersion?: number | undefined;
  conversationId?: string | undefined;
}

/** Strips the key (and anything shaped like a bearer credential) from provider text. */
export function sanitizeDetail(detail: string, apiKey: string | undefined): string {
  let out = detail;
  if (apiKey !== undefined && apiKey.length > 0) out = out.split(apiKey).join('[redacted]');
  out = out.replace(/\b(sk|key|token)[-_][A-Za-z0-9_-]{8,}/gi, '[redacted]');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > MAX_ERROR_DETAIL ? `${out.slice(0, MAX_ERROR_DETAIL)}...` : out;
}

function errorDetail(err: unknown, apiKey: string | undefined): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
  return sanitizeDetail(raw, apiKey);
}

/** Whether a call ended on a 401. After retries the SDK reports what it ended on as lastError. */
function isKeyRejected(err: unknown): boolean {
  const last = RetryError.isInstance(err) ? err.lastError : err;
  return APICallError.isInstance(last) && last.statusCode === 401;
}

class Run {
  private readonly started = Date.now();
  private recorded = false;
  readonly tokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** Provider calls made so far: zero means a refusal before the provider was reached. */
  attempts = 0;
  /** One span per run (https://github.com/bgoleno/opportun/issues/344). */
  readonly span: InferenceSpan;

  constructor(
    private readonly deps: AiDeps,
    private readonly task: TaskKey,
    private readonly policy: ModelPolicy,
    private readonly promptId: string | undefined,
    info: CallInfo,
  ) {
    this.span = new InferenceSpan({
      task,
      policy,
      stream: info.stream,
      outputType: info.outputType,
      promptId,
      promptVersion: info.promptVersion,
      conversationId: info.conversationId,
      userId: deps.userId,
    });
  }

  /**
   * Records once; later calls are ignored (a stream can report both an error and an end). The span
   * ends first and the ledger write follows, so a ledger that fails or is slow neither leaves the
   * span open nor delays it. The span says what the ledger says: the same tokens and the same cost.
   */
  async record(status: 'ok' | 'error', failure?: Failure): Promise<void> {
    if (this.recorded) return;
    this.recorded = true;
    const cost = estimateCost(
      this.policy.provider,
      this.policy.model,
      this.tokens.input,
      this.tokens.output,
      this.policy,
      { readTokens: this.tokens.cacheRead, writeTokens: this.tokens.cacheWrite },
    );
    this.span.end({
      ...(failure === undefined ? {} : { errorType: failure.reason }),
      ...(this.attempts === 0
        ? {}
        : {
            usage: {
              input: this.tokens.input,
              output: this.tokens.output,
              cacheRead: this.tokens.cacheRead,
              cacheWrite: this.tokens.cacheWrite,
            },
            attempts: this.attempts,
            costUsd: cost.usd,
          }),
    });
    const error =
      failure === undefined
        ? undefined
        : failure.detail === undefined
          ? failure.reason
          : `${failure.reason}: ${failure.detail}`;
    const rec: TaskRunRecord = {
      taskKey: this.task,
      provider: this.policy.provider,
      model: this.policy.model,
      inputTokens: this.tokens.input,
      outputTokens: this.tokens.output,
      estCostUsd: cost.usd,
      fallbackPricing: cost.fallback,
      durationMs: Math.max(0, Date.now() - this.started),
      status,
      ...(this.promptId === undefined ? {} : { promptId: this.promptId }),
      ...(error === undefined ? {} : { error }),
    };
    await this.deps.record(rec);
  }

  /** Records the failure and returns the error to throw. */
  async fail(
    reason: AiUnavailableReason,
    detail?: string,
    opts: { keyRejected?: boolean } = {},
  ): Promise<AiUnavailableError> {
    await this.record('error', { reason, detail });
    return new AiUnavailableError(reason, detail, opts);
  }
}

/** Budget, key and model resolution shared by both entry points. Records on failure. */
async function prepare(
  deps: AiDeps,
  task: TaskKey,
  info: CallInfo,
): Promise<{ run: Run; model: LanguageModel; policy: ModelPolicy; apiKey: string }> {
  const policy = await deps.policyFor(task);
  // Before the run, so before its span: a lookup that rejects (the ledger's database is down)
  // throws with no span started, rather than leaving one open for good. It leaves no ledger row
  // either, as before.
  const spent = await deps.spentTodayUsd(task);
  const run = new Run(deps, task, policy, info.promptId, info);
  if (spent >= deps.budget.perTaskDailyUsd) throw await run.fail('budget_exceeded');

  let apiKey: string;
  try {
    apiKey = await deps.getKey(policy.provider);
  } catch (err) {
    const reason = err instanceof AiUnavailableError ? err.reason : 'no_key';
    throw await run.fail(reason);
  }

  let model: LanguageModel;
  try {
    model = createLanguageModel(policy, apiKey, deps.providerFetch);
  } catch (err) {
    throw await run.fail('provider_error', errorDetail(err, apiKey));
  }
  return { run, model, policy, apiKey };
}

function callSettings(policy: ModelPolicy): { maxOutputTokens: number; temperature?: number } {
  return {
    maxOutputTokens: policy.maxOutputTokens,
    ...(policy.temperature === undefined ? {} : { temperature: policy.temperature }),
  };
}

/** Characters per token assumed when sizing a prefix: high, so a prefix is never overestimated. */
const CHARS_PER_TOKEN = 4;

/**
 * How many characters of the call the provider would cache at the break: the structured-output
 * schema, which it renders ahead of the system prompt (tools, then system, then messages), and the
 * system text before the break (https://github.com/bgoleno/opportun/issues/388). The schema is
 * measured as the SDK converts it for the request.
 */
async function cachedChars(schema: z.ZodType, cacheBreak: number | undefined): Promise<number> {
  if (cacheBreak === undefined) return 0;
  const json = await asSchema(schema).jsonSchema;
  return JSON.stringify(json).length + cacheBreak;
}

/**
 * The system prompt as the SDK takes it (https://github.com/bgoleno/opportun/issues/356). The
 * prefix is marked for Anthropic's cache only when the model caches a prefix of its size: a
 * marked prefix the model would not cache would earn nothing. Everywhere else the prompt goes
 * whole: OpenAI caches on its own when the start of a prompt repeats, which the split's order
 * already gives, and an OpenAI-compatible endpoint (a local model, a gateway) gets exactly what
 * it got before.
 */
function systemFor(
  policy: ModelPolicy,
  system: string,
  cacheBreak: number | undefined,
  cachedLength: number,
): Instructions {
  if (cacheBreak === undefined || cacheBreak <= 0 || cacheBreak >= system.length) return system;
  // Only Anthropic models have a minimum (cacheMinTokens), so only they are ever marked.
  const min = cacheMinTokens(policy.provider, policy.model);
  if (min === undefined || cachedLength / CHARS_PER_TOKEN < min) return system;
  return [
    {
      role: 'system',
      content: system.slice(0, cacheBreak),
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    { role: 'system', content: system.slice(cacheBreak) },
  ];
}

/**
 * One structured call: the model output must validate against `schema`. Schema-invalid output
 * is retried once; a second failure throws AiUnavailableError('invalid_output').
 */
export async function runStructured<T>(
  deps: AiDeps,
  task: TaskKey,
  opts: {
    system: string;
    /**
     * Where the part of `system` that stays the same from call to call ends, in characters
     * (systemWithCacheBreak). The router may mark the part before it for the provider's cache.
     */
    cacheBreak?: number;
    prompt: string;
    schema: z.ZodType<T>;
    promptId?: string;
    /** The version of the prompt, for the span, when the caller has one. */
    promptVersion?: number;
  },
): Promise<T> {
  // Before the run starts, so nothing here can leave its span open.
  const cached = await cachedChars(opts.schema, opts.cacheBreak);
  const { run, model, policy, apiKey } = await prepare(deps, task, {
    stream: false,
    outputType: 'json',
    promptId: opts.promptId,
    promptVersion: opts.promptVersion,
  });

  const system = systemFor(policy, opts.system, opts.cacheBreak, cached);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let output: T;
    try {
      run.attempts++;
      // Inside the span, so the request the SDK makes is the span's child.
      const result = await run.span.run(() =>
        generateText({
          model,
          system,
          prompt: opts.prompt,
          output: Output.object({ schema: opts.schema }),
          maxRetries: SDK_MAX_RETRIES,
          telemetry: SDK_TELEMETRY_OFF,
          ...callSettings(policy),
        }),
      );
      addUsage(run.tokens, result.totalUsage);
      run.span.setResponse({
        id: result.response.id,
        modelId: result.response.modelId,
        finishReason: result.finishReason,
      });
      output = result.output as T;
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) {
        addUsage(run.tokens, err.usage);
        run.span.setResponse({
          id: err.response?.id,
          modelId: err.response?.modelId,
          finishReason: err.finishReason,
        });
        if (attempt < MAX_ATTEMPTS) continue;
        throw await run.fail('invalid_output');
      }
      throw await run.fail('provider_error', errorDetail(err, apiKey), {
        keyRejected: isKeyRejected(err),
      });
    }
    // Outside the try: a ledger failure is not a provider failure.
    await run.record('ok');
    return output;
  }
  // Unreachable: the loop either returns or throws.
  throw await run.fail('invalid_output');
}

/**
 * A streaming chat call (consumed by the tailoring SSE endpoint). The budget and key are
 * checked before the stream opens; the run is recorded when the stream ends, errors or aborts.
 *
 * The SDK awaits onFinish/onError/onAbort before it closes or errors the consumer's stream (its
 * flush step for onFinish, and an explicit `await` before enqueueing for onError/onAbort), so
 * returning the record promise from these callbacks, rather than firing it and forgetting it,
 * is what makes the ledger write land before a caller observes the stream as finished. A write
 * failure must still not crash the stream (it is not a provider failure), so it is caught and
 * handed to deps.onRecordError (the server logs it; this package does no IO) rather than left to
 * reject the callback the SDK is awaiting.
 */
export async function streamChat(
  deps: AiDeps,
  task: TaskKey,
  opts: {
    system: string;
    messages: CoreMessage[];
    promptId?: string;
    promptVersion?: number;
    /** The tailoring session id, for the span. Never made up here. */
    conversationId?: string;
  },
): Promise<ChatStreamResult> {
  const { run, model, policy, apiKey } = await prepare(deps, task, {
    stream: true,
    outputType: 'text',
    promptId: opts.promptId,
    promptVersion: opts.promptVersion,
    conversationId: opts.conversationId,
  });
  const recordSafely = async (status: 'ok' | 'error', failure?: Failure): Promise<void> => {
    try {
      await run.record(status, failure);
    } catch (err) {
      // This package does no IO, so it does not log: the server says where a failure goes.
      try {
        deps.onRecordError?.(task, err);
      } catch {
        // A broken reporter must not break the stream either.
      }
    }
  };

  run.attempts = 1;
  return run.span.run(() =>
    streamText<ToolSet>({
      model,
      system: opts.system,
      messages: opts.messages,
      maxRetries: SDK_MAX_RETRIES,
      telemetry: SDK_TELEMETRY_OFF,
      ...callSettings(policy),
      onChunk: ({ chunk }) => {
        if (
          (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') &&
          chunk.text.length > 0
        ) {
          run.span.markFirstChunk();
        }
      },
      onFinish: async (event) => {
        addUsage(run.tokens, event.totalUsage);
        run.span.setResponse({
          id: event.response.id,
          modelId: event.response.modelId,
          finishReason: event.finishReason,
        });
        await recordSafely('ok');
      },
      onError: async ({ error }) => {
        await recordSafely('error', {
          reason: 'provider_error',
          detail: errorDetail(error, apiKey),
        });
      },
      onAbort: async () => {
        await recordSafely('error', { reason: 'provider_error', detail: 'aborted' });
      },
    }),
  );
}
