// Batch requests (#441, slice 1 of https://github.com/bgoleno/opportun/issues/358; tl's design
// issuecomment-6794239917 and ruling on #441). A batch provider takes many structured requests at
// once, at a lower price, and answers within hours. This file is the provider-neutral side: the
// interface a provider's batch client implements, what a request is estimated to cost, how a
// result is parsed, and its run record. Anthropic's client is anthropicBatch.ts (#509); for every
// other provider batchProviderFor finds none and every request is made live.
import type { z } from 'zod';
import { createAnthropicBatchProvider } from './anthropicBatch';
import { batchMultiplier, estimateCost } from './pricing';
import { CHARS_PER_TOKEN, STRUCTURED_OUTPUT_TOKENS, type StructuredRequest } from './router';
import { ATTR, inBatchSpan, OPERATION_BATCH_COLLECT, OPERATION_BATCH_SUBMIT } from './telemetry';
import type { ModelPolicy, ProviderFetchOptions, TaskKey, TaskRunRecord } from './types';

export { batchMultiplier };

/** One request in a batch: the caller's id for it, and what structuredRequest built. */
export interface BatchRequest {
  customId: string;
  request: StructuredRequest<unknown>;
}

/** The tokens a provider reported for one request (cache tokens are part of `input`). */
export interface BatchUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One request's result, as every provider's batch reports it. */
export type BatchResultItem =
  | { customId: string; kind: 'succeeded'; text: string; usage: BatchUsage }
  | {
      customId: string;
      kind: 'errored';
      /** The request itself was refused (it would fail again): the rest are worth retrying. */
      invalidRequest: boolean;
      detail?: string;
    }
  | { customId: string; kind: 'expired' }
  | { customId: string; kind: 'canceled' };

/**
 * Where a batch stands. `gone`: the provider no longer has it (its results expired, or it was
 * removed); handled as if every request expired (tl on #441).
 */
export type BatchState = 'in_progress' | 'ended' | 'gone';

export interface BatchProvider {
  /** Sends the requests as one batch; resolves with the provider's id for it. */
  submit(requests: readonly BatchRequest[]): Promise<{ batchId: string }>;
  state(batchId: string): Promise<BatchState>;
  /** Every request's result, once the batch has ended. */
  results(batchId: string): Promise<BatchResultItem[]>;
}

/**
 * The batch client for this policy's provider, or null when it has none: then every request is
 * made live. Anthropic has one (#509, anthropicBatch.ts), built like every other provider client
 * here, with the explicit fetch and base URL and never the environment. OpenAI's is slice B; an
 * OpenAI-compatible endpoint has none.
 */
export function batchProviderFor(target: {
  policy: ModelPolicy;
  apiKey: string;
  providerFetch: ProviderFetchOptions;
}): BatchProvider | null {
  return target.policy.provider === 'anthropic'
    ? withBatchSpans(createAnthropicBatchProvider(target), target.policy)
    : null;
}

/**
 * Any provider's batch client, with its two spans (#509 criterion 5, tl's ruling on #509): one
 * for submitting (the request count, the provider's batch id) and one for collecting (the count
 * of each result type, the total tokens and the cost at the batch rate). None for reading the
 * state, which the collect job polls, and none for each request.
 */
function withBatchSpans(provider: BatchProvider, policy: ModelPolicy): BatchProvider {
  return {
    submit: (requests) =>
      inBatchSpan(OPERATION_BATCH_SUBMIT, policy, async (set) => {
        set({ [ATTR.batchRequests]: requests.length });
        const out = await provider.submit(requests);
        set({ [ATTR.batchId]: out.batchId });
        return out;
      }),
    state: (batchId) => provider.state(batchId),
    results: (batchId) =>
      inBatchSpan(OPERATION_BATCH_COLLECT, policy, async (set) => {
        set({ [ATTR.batchId]: batchId });
        const items = await provider.results(batchId);
        const kinds = { succeeded: 0, errored: 0, expired: 0, canceled: 0 };
        const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
        for (const item of items) {
          kinds[item.kind] += 1;
          if (item.kind !== 'succeeded') continue;
          total.input += item.usage.input;
          total.output += item.usage.output;
          total.cacheRead += item.usage.cacheRead;
          total.cacheWrite += item.usage.cacheWrite;
          total.usd += estimateCost(
            policy.provider,
            policy.model,
            item.usage.input,
            item.usage.output,
            policy,
            { readTokens: item.usage.cacheRead, writeTokens: item.usage.cacheWrite },
            { batch: true },
          ).usd;
        }
        set({
          [ATTR.batchSucceeded]: kinds.succeeded,
          [ATTR.batchErrored]: kinds.errored,
          [ATTR.batchExpired]: kinds.expired,
          [ATTR.batchCanceled]: kinds.canceled,
          [ATTR.usageInputTokens]: total.input,
          [ATTR.usageOutputTokens]: total.output,
          [ATTR.usageCacheReadInputTokens]: total.cacheRead,
          [ATTR.usageCacheWriteInputTokens]: total.cacheWrite,
          [ATTR.usageCost]: total.usd,
        });
        return items;
      }),
  };
}

/** How many successful calls an average output must come from before it is trusted (tl). */
export const BATCH_ESTIMATE_MIN_CALLS = 20;

/** The text a request sends, for its input estimate: every system block and the prompt. */
function sentChars(request: StructuredRequest<unknown>): number {
  const system =
    typeof request.system === 'string'
      ? request.system.length
      : (Array.isArray(request.system) ? request.system : [request.system]).reduce(
          (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
          0,
        );
  return system + request.prompt.length;
}

/**
 * What one batch request is estimated to cost, at the batch rate (tl's ruling on #441): input from
 * what is sent, at the router's own characters per token plus the structured-output allowance;
 * output the average of the user's successful calls of this task over 30 days (tokens are the same
 * live and in a batch), or the policy's output limit while there are fewer than 20 of them.
 */
export function estimateBatchRequestUsd(
  policy: ModelPolicy,
  request: StructuredRequest<unknown>,
  history: { outputTokens: number | null; calls: number },
): number {
  const input = Math.ceil(sentChars(request) / CHARS_PER_TOKEN) + STRUCTURED_OUTPUT_TOKENS;
  const output =
    history.calls >= BATCH_ESTIMATE_MIN_CALLS && history.outputTokens !== null
      ? history.outputTokens
      : policy.maxOutputTokens;
  return estimateCost(policy.provider, policy.model, input, output, policy, undefined, {
    batch: true,
  }).usd;
}

/**
 * A result's text as the live call takes it: JSON, then the schema. Anything else is
 * invalid_output, as a live call's second invalid answer is (a batch request is not retried).
 */
export function parseStructuredText<T>(
  text: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; reason: 'invalid_output' } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_output' };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'invalid_output' };
}

/** A batch result's ledger row: the provider's tokens, priced at the batch rate. */
export function batchRunRecord(
  task: TaskKey,
  policy: ModelPolicy,
  usage: BatchUsage,
  opts: { promptId?: string; status?: 'ok' | 'error'; error?: string } = {},
): TaskRunRecord {
  const cost = estimateCost(
    policy.provider,
    policy.model,
    usage.input,
    usage.output,
    policy,
    { readTokens: usage.cacheRead, writeTokens: usage.cacheWrite },
    { batch: true },
  );
  return {
    taskKey: task,
    provider: policy.provider,
    model: policy.model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    estCostUsd: cost.usd,
    fallbackPricing: cost.fallback,
    durationMs: 0,
    status: opts.status ?? 'ok',
    ...(opts.promptId === undefined ? {} : { promptId: opts.promptId }),
    ...(opts.error === undefined ? {} : { error: opts.error }),
  };
}
