// Key validation probe: one minimal generation (1 output token) against one model. This is not
// a task: it bypasses the budget and records nothing in the run ledger. The caller decides
// what a failure means; the error text is always passed through sanitizeDetail.
//
// It does get a span (https://github.com/bgoleno/opportun/issues/344): task `key_check`, the same
// Gen AI span as a task's, with no feature, no prompt name, no attempts and no cost, since it is
// not a task of the router. It takes its user from the trace context, as it has none of its own.
import { APICallError, generateText } from 'ai';
import { createLanguageModel } from './providers';
import { sanitizeDetail } from './router';
import { InferenceSpan, KEY_CHECK_TASK, SDK_TELEMETRY_OFF } from './telemetry';
import type { ProviderFetchOptions, ProviderId } from './types';

export type PingOutcome =
  | { ok: true }
  /** auth: the provider rejected the key itself (HTTP 401). */
  | { ok: false; kind: 'auth' | 'model' | 'error'; error: string };

const PING_TIMEOUT_MS = 20_000;

export async function pingModel(
  provider: ProviderId,
  model: string,
  apiKey: string,
  opts: { baseUrl?: string } & ProviderFetchOptions,
): Promise<PingOutcome> {
  const policy = {
    provider,
    model,
    maxOutputTokens: 1,
    ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
  };
  const span = new InferenceSpan({
    task: KEY_CHECK_TASK,
    policy,
    stream: false,
    outputType: 'text',
  });
  try {
    const lm = createLanguageModel(policy, apiKey, opts);
    const result = await span.run(() =>
      generateText({
        model: lm,
        prompt: 'ping',
        maxOutputTokens: 1,
        maxRetries: 0,
        telemetry: SDK_TELEMETRY_OFF,
        abortSignal: AbortSignal.timeout(PING_TIMEOUT_MS),
      }),
    );
    span.setResponse({
      id: result.response.id,
      modelId: result.response.modelId,
      finishReason: result.finishReason,
    });
    span.end({
      usage: {
        input: result.usage.inputTokens ?? 0,
        output: result.usage.outputTokens ?? 0,
        cacheRead: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        cacheWrite: result.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
      },
    });
    return { ok: true };
  } catch (err) {
    // Any failure is the provider's, whatever its kind: the kind is the caller's to name.
    span.end({ errorType: 'provider_error' });
    const raw = err instanceof Error ? err.message : 'unknown error';
    const error = sanitizeDetail(raw, apiKey) || 'request failed';
    if (APICallError.isInstance(err)) {
      if (err.statusCode === 401) return { ok: false, kind: 'auth', error };
      if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
        return { ok: false, kind: 'model', error };
      }
    }
    return { ok: false, kind: 'error', error };
  }
}
