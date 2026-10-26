import { describe, expect, it } from 'vitest';
import { toInbound } from '../src/normalize';
import {
  batchEndpoint,
  MAX_BATCH_BODY_BYTES,
  MAX_BATCH_MESSAGES,
  pushBatch,
  splitBatches,
} from '../src/push';
import { CONFIG, makeIo, raw, scriptedFetch, TOKEN } from './fakes';

const msg = (n: number, body = `Hello ${n}`) => toInbound(raw(n, { body })).message;

describe('splitBatches', () => {
  it('splits at 100 messages', () => {
    const items = Array.from({ length: 250 }, (_, i) => msg(i));
    const batches = splitBatches(items);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(MAX_BATCH_MESSAGES).toBe(100);
    expect(batches.flat()).toEqual(items);
  });

  it('splits before the bodies of a batch pass 10MB of UTF-8', () => {
    // 500k chars of a 3-byte character is 1.5MB each: six fit under 10MB, the seventh does not.
    const big = '€'.repeat(500_000);
    const items = Array.from({ length: 14 }, (_, i) => msg(i, big));
    const batches = splitBatches(items);
    expect(batches.map((b) => b.length)).toEqual([6, 6, 2]);
    for (const batch of batches) {
      const bytes = batch.reduce((n, m) => n + Buffer.byteLength(m.bodyText, 'utf8'), 0);
      expect(bytes).toBeLessThanOrEqual(MAX_BATCH_BODY_BYTES);
    }
  });

  it('fills a batch exactly to the 10MB boundary', () => {
    // Built directly: toInbound would cut these bodies at 500k characters.
    const half = 5 * 1024 * 1024;
    const items = [
      { ...msg(1), bodyText: 'a'.repeat(half) },
      { ...msg(2), bodyText: 'b'.repeat(half) },
      msg(3),
    ];
    expect(splitBatches(items).map((b) => b.length)).toEqual([2, 1]);
  });

  it('keeps the serialized request under the server request cap when escaping inflates it', () => {
    // Control characters serialize as \u0001 (6 bytes each): bodies are small, JSON is not.
    const escaped = '\u0001'.repeat(400_000);
    const items = Array.from({ length: 10 }, (_, i) => msg(i, escaped));
    const batches = splitBatches(items);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(Buffer.byteLength(JSON.stringify({ messages: batch }), 'utf8')).toBeLessThan(
        12 * 1024 * 1024,
      );
    }
  });

  it('returns no batches for no messages', () => {
    expect(splitBatches([])).toEqual([]);
  });
});

describe('pushBatch', () => {
  it('POSTs the batch with the bearer token to the connector route', async () => {
    const f = scriptedFetch([{ status: 200, body: { stored: 1, inserted: 1 } }]);
    const { io } = makeIo({ fetch: f.fetch });
    const res = await pushBatch(io, CONFIG, [msg(1)]);
    expect(res).toEqual({ kind: 'ok', stored: 1, inserted: 1 });
    expect(f.calls[0]?.url).toBe('https://opportun.example/api/v1/connector/mail/batch');
    expect(f.calls[0]?.init.method).toBe('POST');
    expect(f.calls[0]?.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0]?.init.headers['content-type']).toBe('application/json');
    expect(f.calls[0]?.body.messages).toHaveLength(1);
  });

  it('keeps a reverse-proxy path prefix', () => {
    expect(batchEndpoint('https://example.org/opportun')).toBe(
      'https://example.org/opportun/api/v1/connector/mail/batch',
    );
  });

  it.each([
    [
      { status: 429, headers: { 'retry-after': '42' } },
      { kind: 'rate_limited', retryAfterMs: 42_000 },
    ],
    [{ status: 429 }, { kind: 'rate_limited', retryAfterMs: null }],
    [{ status: 401 }, { kind: 'unauthorized' }],
    [{ status: 403 }, { kind: 'forbidden' }],
    [{ status: 413, body: { error: { code: 'batch_too_large' } } }, { kind: 'too_large' }],
    [{ status: 503 }, { kind: 'server_error', status: 503 }],
    [
      { status: 422, body: { error: { code: 'too_many_messages' } } },
      { kind: 'rejected', status: 422, code: 'too_many_messages' },
    ],
    [new Error('ECONNREFUSED'), { kind: 'network_error', message: 'ECONNREFUSED' }],
  ] as const)('maps %j', async (reply, expected) => {
    const { io } = makeIo({ fetch: scriptedFetch([reply as never]).fetch });
    expect(await pushBatch(io, CONFIG, [msg(1)])).toEqual(expected);
  });
});
