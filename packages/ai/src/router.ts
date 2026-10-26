// Provider-agnostic model router (FR-A1, A2, A5, A6). Every call: resolve the policy, check
// the per-task daily budget, load the key, call the provider, and record exactly one
// TaskRunRecord, whether the call succeeded or failed.
import {
  generateText,
  NoObjectGeneratedError,
  Output,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import type { z } from 'zod';
import { estimateCost } from './pricing';
import { createLanguageModel } from './providers';
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
}

function addUsage(acc: Tokens, usage: LanguageModelUsage | undefined): void {
  acc.input += usage?.inputTokens ?? 0;
  acc.output += usage?.outputTokens ?? 0;
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

class Run {
  private readonly started = Date.now();
  private recorded = false;
  readonly tokens: Tokens = { input: 0, output: 0 };

  constructor(
    private readonly deps: AiDeps,
    private readonly task: TaskKey,
    private readonly policy: ModelPolicy,
    private readonly promptId: string | undefined,
  ) {}

  /** Records once; later calls are ignored (a stream can report both an error and an end). */
  async record(status: 'ok' | 'error', error?: string): Promise<void> {
    if (this.recorded) return;
    this.recorded = true;
    const cost = estimateCost(
      this.policy.provider,
      this.policy.model,
      this.tokens.input,
      this.tokens.output,
      this.policy,
    );
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
  async fail(reason: AiUnavailableReason, detail?: string): Promise<AiUnavailableError> {
    await this.record('error', detail === undefined ? reason : `${reason}: ${detail}`);
    return new AiUnavailableError(reason, detail);
  }
}

/** Budget, key and model resolution shared by both entry points. Records on failure. */
async function prepare(
  deps: AiDeps,
  task: TaskKey,
  promptId: string | undefined,
): Promise<{ run: Run; model: LanguageModel; policy: ModelPolicy; apiKey: string }> {
  const policy = await deps.policyFor(task);
  const run = new Run(deps, task, policy, promptId);

  const spent = await deps.spentTodayUsd(task);
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

/**
 * One structured call: the model output must validate against `schema`. Schema-invalid output
 * is retried once; a second failure throws AiUnavailableError('invalid_output').
 */
export async function runStructured<T>(
  deps: AiDeps,
  task: TaskKey,
  opts: { system: string; prompt: string; schema: z.ZodType<T>; promptId?: string },
): Promise<T> {
  const { run, model, policy, apiKey } = await prepare(deps, task, opts.promptId);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let output: T;
    try {
      const result = await generateText({
        model,
        system: opts.system,
        prompt: opts.prompt,
        output: Output.object({ schema: opts.schema }),
        maxRetries: SDK_MAX_RETRIES,
        ...callSettings(policy),
      });
      addUsage(run.tokens, result.totalUsage);
      output = result.output as T;
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) {
        addUsage(run.tokens, err.usage);
        if (attempt < MAX_ATTEMPTS) continue;
        throw await run.fail('invalid_output');
      }
      throw await run.fail('provider_error', errorDetail(err, apiKey));
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
 * reported here rather than left to reject the callback the SDK is awaiting.
 */
export async function streamChat(
  deps: AiDeps,
  task: TaskKey,
  opts: { system: string; messages: CoreMessage[]; promptId?: string },
): Promise<ChatStreamResult> {
  const { run, model, policy, apiKey } = await prepare(deps, task, opts.promptId);
  const recordSafely = async (status: 'ok' | 'error', error?: string): Promise<void> => {
    try {
      await run.record(status, error);
    } catch (err) {
      console.error(`[ai] streamChat: failed to record task_runs row for ${task}:`, err);
    }
  };

  return streamText<ToolSet>({
    model,
    system: opts.system,
    messages: opts.messages,
    maxRetries: SDK_MAX_RETRIES,
    ...callSettings(policy),
    onFinish: async (event) => {
      addUsage(run.tokens, event.totalUsage);
      await recordSafely('ok');
    },
    onError: async ({ error }) => {
      await recordSafely('error', `provider_error: ${errorDetail(error, apiKey)}`);
    },
    onAbort: async () => {
      await recordSafely('error', 'provider_error: aborted');
    },
  });
}
