// Key validation probe: one minimal generation (1 output token) against one model. This is not
// a task: it bypasses the budget and records nothing in the run ledger. The caller decides
// what a failure means; the error text is always passed through sanitizeDetail.
import { APICallError, generateText } from 'ai';
import { createLanguageModel } from './providers';
import { sanitizeDetail } from './router';
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
  try {
    const lm = createLanguageModel(
      {
        provider,
        model,
        maxOutputTokens: 1,
        ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
      },
      apiKey,
      opts,
    );
    await generateText({
      model: lm,
      prompt: 'ping',
      maxOutputTokens: 1,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return { ok: true };
  } catch (err) {
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
