// https://github.com/bgoleno/opportun/issues/620 point 4 (sec's second audit): a batch's results
// were read whole (res.text()), with no size or time bound, and their token counts were taken as
// given. Both clients now read the results through one bounded reader, and clamp every count.
import { describe, expect, it, vi } from 'vitest';
import * as anthropic from './anthropicBatch.fixtures';
import {
  BATCH_RESULTS_MAX_BYTES,
  BATCH_RESULTS_TIMEOUT_MS,
  batchProviderFor,
  clampTokens,
} from './batch';
import * as openai from './openaiBatch.fixtures';
import { resolvePolicy } from './policies';
import type { ModelPolicy } from './types';

// The providers' reads, with the size bound at 10 KiB: the real 64 MiB would make each test stream
// that much (and the old whole-body read run out of memory before failing).
const SMALL = 10 * 1024;
vi.mock('./batchRead', async (importOriginal) => {
  const real = await importOriginal<typeof import('./batchRead')>();
  return {
    ...real,
    readBatchText: (res: Response, _max: number, ms: number) => real.readBatchText(res, SMALL, ms),
  };
});
const { readBatchText: realRead } =
  await vi.importActual<typeof import('./batchRead')>('./batchRead');

const SONNET: ModelPolicy = resolvePolicy('discovery.rank', undefined);
const GPT: ModelPolicy = { provider: 'openai', model: 'gpt-5', maxOutputTokens: 2000 };

const providerFor = (policy: ModelPolicy, fetch: typeof globalThis.fetch) => {
  const p = batchProviderFor({
    policy,
    apiKey: policy.provider === 'openai' ? 'sk-proj-test-0123456789abcdefghij' : 'sk-ant-test-key',
    providerFetch: { fetch, allowLoopbackHttp: false },
  });
  if (p === null) throw new Error('expected a batch client');
  return p;
};

/** A body of `chunks` chunks of `size` bytes, counting how many were pulled. */
function streamOf(chunks: number, size: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
  return { body, pulled: () => pulled };
}

describe('readBatchText: a bounded read of a results answer (#620 point 4)', () => {
  it('reads an answer within the bound', async () => {
    const text = await realRead(new Response('line 1\nline 2\n'), 1024, 1000);
    expect(text).toBe('line 1\nline 2\n');
  });

  it('stops at the size bound, without reading the rest', async () => {
    const s = streamOf(100, 1024);
    await expect(realRead(new Response(s.body), 10 * 1024, 1000)).rejects.toThrow(/too large/);
    expect(s.pulled()).toBeLessThan(20);
  });

  it('stops at the time bound when the answer never ends', async () => {
    const never = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    await expect(realRead(new Response(never), 1024, 50)).rejects.toThrow(/timed out/);
  });

  it('the real bounds: 64 MiB, two minutes', () => {
    expect(BATCH_RESULTS_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(BATCH_RESULTS_TIMEOUT_MS).toBe(120_000);
  });
});

describe('both clients read results through the bounded reader (#620 point 4)', () => {
  it('Anthropic: an answer past the bound is refused, not read whole', async () => {
    const s = streamOf(100, 1024);
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response(s.body, { status: 200 });
    }) as typeof globalThis.fetch;
    await expect(providerFor(SONNET, fetch).results(anthropic.BATCH_ID)).rejects.toThrow(
      /too large/,
    );
    // The request itself carries the time bound too.
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('OpenAI: an output file past the bound is refused, not read whole', async () => {
    const s = streamOf(100, 1024);
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/batches/${openai.BATCH_ID}`)) {
        return new Response(JSON.stringify(openai.batchObject('completed')), { status: 200 });
      }
      signals.push(init?.signal);
      return new Response(s.body, { status: 200 });
    }) as typeof globalThis.fetch;
    await expect(providerFor(GPT, fetch).results(openai.BATCH_ID)).rejects.toThrow(/too large/);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('token counts are clamped (#620 point 4)', () => {
  it('clampTokens: a whole number from 0 to 10 million, anything else 0 or the bound', () => {
    expect(clampTokens(120)).toBe(120);
    expect(clampTokens(-5)).toBe(0);
    expect(clampTokens(12.7)).toBe(12);
    expect(clampTokens(1e15)).toBe(10_000_000);
    expect(clampTokens(Number.NaN)).toBe(0);
    expect(clampTokens('300')).toBe(0);
  });

  it('Anthropic: a negative or huge usage reaches the ledger clamped', async () => {
    const line = anthropic.succeededLine('p1', '{"score":1,"rationale":"x"}', {
      input_tokens: -100,
      output_tokens: 1e15,
      cache_creation_input_tokens: 2.5,
      cache_read_input_tokens: null,
    });
    const fetch = (async () =>
      new Response(anthropic.jsonl([line]), { status: 200 })) as typeof globalThis.fetch;
    const [item] = await providerFor(SONNET, fetch).results(anthropic.BATCH_ID);
    expect(item).toMatchObject({
      kind: 'succeeded',
      usage: { input: 2, output: 10_000_000, cacheRead: 0, cacheWrite: 2 },
    });
  });

  it('OpenAI: a negative or huge usage reaches the ledger clamped', async () => {
    const line = openai.succeededLine('p1', '{"score":1,"rationale":"x"}', {
      input: -100,
      output: 1e15,
      cached: 3.9,
    });
    const fetch = (async (url: string) =>
      url.endsWith(`/batches/${openai.BATCH_ID}`)
        ? new Response(JSON.stringify(openai.batchObject('completed', { error_file_id: null })), {
            status: 200,
          })
        : new Response(openai.jsonl([line]), { status: 200 })) as typeof globalThis.fetch;
    const [item] = await providerFor(GPT, fetch).results(openai.BATCH_ID);
    expect(item).toMatchObject({ kind: 'succeeded', usage: { input: 0, output: 10_000_000 } });
    expect((item as { usage: { cacheRead: number } }).usage.cacheRead).toBe(3);
  });
});
