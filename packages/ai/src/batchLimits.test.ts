// Each batch client call has a time limit of its own (https://github.com/bgoleno/opportun/issues/686,
// qa's third pass): with none, a provider that hung held a job worker for the fetch's own 300 s on
// every attempt. A control call (submit's create, a state, a delete) has BATCH_CONTROL_LIMIT_MS; a
// file transfer (the upload, a results download) the longer BATCH_TRANSFER_LIMIT_MS. Every answer
// here is made up and no test reaches any network.
import { describe, expect, it } from 'vitest';
import { BATCH_CONTROL_LIMIT_MS, BATCH_TRANSFER_LIMIT_MS, batchProviderFor } from './batch';
import { BATCH_ID, batchObject } from './openaiBatch.fixtures';
import type { ModelPolicy } from './types';

const POLICIES: Record<'anthropic' | 'openai', ModelPolicy> = {
  anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-5', maxOutputTokens: 2000 },
  openai: { provider: 'openai', model: 'gpt-5', maxOutputTokens: 2000 },
};

/** Waits `ms`, or rejects when `signal` aborts first. */
function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    });
  });
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * A provider whose control calls answer after `controlDelayMs` and whose results downloads after
 * `downloadDelayMs`, each unless the request's signal aborts first.
 */
function slowFetch(controlDelayMs: number, downloadDelayMs: number) {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const download = url.endsWith('/results') || url.endsWith('/content');
    await wait(download ? downloadDelayMs : controlDelayMs, init.signal);
    if (download) return new Response('', { status: 200 });
    if (url.includes('/messages/batches')) {
      return json({ id: 'msgbatch_1', processing_status: 'in_progress' });
    }
    return json(batchObject('completed'));
  }) as typeof globalThis.fetch;
}

function client(
  provider: 'anthropic' | 'openai',
  fetch: typeof globalThis.fetch,
  limits: { controlMs: number; transferMs: number },
) {
  const c = batchProviderFor({
    policy: POLICIES[provider],
    apiKey: 'sk-made-up-0123456789abcdefghij',
    providerFetch: { fetch, allowLoopbackHttp: false },
    limits,
  });
  if (c === null) throw new Error('expected a batch client');
  return c;
}

describe('a batch client call has a time limit of its own (#686)', () => {
  it('the defaults: a minute for a control call, two for a transfer (tl on #715)', () => {
    expect(BATCH_CONTROL_LIMIT_MS).toBe(60_000);
    expect(BATCH_TRANSFER_LIMIT_MS).toBe(120_000);
  });

  it.each(['anthropic', 'openai'] as const)(
    '%s: a state call that hangs is ended at the control limit',
    async (provider) => {
      const c = client(provider, slowFetch(10_000, 0), { controlMs: 50, transferMs: 5_000 });
      const started = Date.now();
      await expect(c.state(BATCH_ID)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
    },
  );

  it.each(['anthropic', 'openai'] as const)(
    '%s: a delete that hangs is ended at the control limit',
    async (provider) => {
      const c = client(provider, slowFetch(10_000, 0), { controlMs: 50, transferMs: 5_000 });
      const started = Date.now();
      await expect(c.cleanup(BATCH_ID)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
    },
  );

  it.each(['anthropic', 'openai'] as const)(
    '%s: a results download gets the longer transfer limit, and is ended at it',
    async (provider) => {
      // Slower than the control limit, within the transfer limit: read.
      await expect(
        client(provider, slowFetch(0, 200), { controlMs: 50, transferMs: 2_000 }).results(BATCH_ID),
      ).resolves.toEqual([]);
      // Past the transfer limit: ended.
      const started = Date.now();
      await expect(
        client(provider, slowFetch(0, 10_000), { controlMs: 50, transferMs: 100 }).results(
          BATCH_ID,
        ),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
    },
  );
});
