// Bounds on what a batch client reads back (https://github.com/bgoleno/opportun/issues/620 point 4,
// sec's second audit). A results answer was read whole, with no size or time bound, and its token
// counts were taken as given. Both clients (anthropicBatch.ts, openaiBatch.ts) read the results
// through readBatchText and count tokens through clampTokens. A bound that is hit throws, as an
// unexpected answer does, so the collect job tries the batch again later rather than drop it.

/**
 * The most a results answer may be. A batch holds at most 500 ranking requests (RANK_BATCH_MAX),
 * each a short scored answer, so real ones are a few megabytes; this is far above that.
 */
export const BATCH_RESULTS_MAX_BYTES = 64 * 1024 * 1024;

/** How long reading one results answer may take, from the request to its last byte. */
export const BATCH_RESULTS_TIMEOUT_MS = 120_000;

/** The most a token count may be: far above any model's context, never a ledger-sized number. */
export const MAX_TOKEN_COUNT = 10_000_000;

/** A time bound for a results request, to pass as its fetch signal. */
export function batchResultsSignal(ms: number = BATCH_RESULTS_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * The answer's text, read up to `maxBytes` and within `timeoutMs`: past either it throws, and what
 * is left of the body is not read. A body that is not a stream is read as text, then measured.
 */
export async function readBatchText(
  res: Response,
  maxBytes: number = BATCH_RESULTS_MAX_BYTES,
  timeoutMs: number = BATCH_RESULTS_TIMEOUT_MS,
): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('batch results: the answer is too large');
  }
  const body = res.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('batch results: the answer timed out')), timeoutMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timedOut]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error('batch results: the answer is too large');
      chunks.push(next.value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** A provider's token count as the ledger takes it: a whole number from 0 to MAX_TOKEN_COUNT. */
export function clampTokens(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(Math.floor(v), MAX_TOKEN_COUNT);
}
