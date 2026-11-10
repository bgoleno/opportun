import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

interface Bucket {
  tokens: number;
  updatedAt: number;
  /** When onLimited last ran for this key; absent until it has. */
  notifiedAt?: number;
}

/** Prune full buckets once the map grows past this many keys. */
const PRUNE_THRESHOLD = 10_000;

/**
 * A rate limiter's preHandler, plus a way to give back a token for a request that already
 * spent one here but turned out not to count against this particular limiter's budget.
 */
export type RateLimiter = preHandlerAsyncHookHandler & {
  refund: (req: FastifyRequest) => Promise<void>;
};

/**
 * In-process token bucket (single node by design, section 7). Each key holds up to
 * `limit` tokens refilled continuously over `windowMs`; a request spends one. When
 * empty the request gets 429 with retry-after (seconds until one token is back).
 */
export function rateLimit(opts: {
  keyFn: (req: FastifyRequest) => string | Promise<string>;
  limit: number;
  windowMs: number;
  /**
   * Called when a request is refused, before the 429, for a limiter whose route needs the
   * refusal on the record (the handler never runs, so it cannot log it itself). At most once
   * per key per window: whoever is being throttled must not be able to make the work the
   * hook does, an audit write today, repeat with every refused request.
   */
  onLimited?: (req: FastifyRequest) => Promise<void> | void;
  /**
   * Names this limit in the 429 body, with its size, for a route behind more than one limiter
   * (https://github.com/bgoleno/opportun/issues/272): the body is then
   * `{ code: 'rate_limited', reason, max: limit, windowMinutes }`, so a client can say which
   * limit it hit. Without it the body stays `{ code: 'rate_limited' }`.
   */
  reason?: string;
}): RateLimiter {
  const { keyFn, limit, windowMs, onLimited, reason } = opts;
  const refusal =
    reason === undefined
      ? { code: 'rate_limited' }
      : { code: 'rate_limited', reason, max: limit, windowMinutes: windowMs / 60_000 };
  const refillPerMs = limit / windowMs;
  const buckets = new Map<string, Bucket>();

  function refill(b: Bucket, now: number): void {
    b.tokens = Math.min(limit, b.tokens + (now - b.updatedAt) * refillPerMs);
    b.updatedAt = now;
  }

  function prune(now: number): void {
    for (const [key, b] of buckets) {
      refill(b, now);
      if (b.tokens >= limit) buckets.delete(key);
    }
  }

  const handler = async function rateLimitHandler(req, reply) {
    const now = Date.now();
    const key = await keyFn(req);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      if (buckets.size >= PRUNE_THRESHOLD) prune(now);
      bucket = { tokens: limit, updatedAt: now };
      buckets.set(key, bucket);
    } else {
      refill(bucket, now);
    }
    if (bucket.tokens < 1) {
      const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000));
      if (
        onLimited !== undefined &&
        (bucket.notifiedAt === undefined || now - bucket.notifiedAt >= windowMs)
      ) {
        bucket.notifiedAt = now;
        // A hook that fails must not become the caller's problem: an unhandled rejection here
        // leaves the preHandler as a 500, which replaces the 429 and its retry-after with an
        // error body on the one path whose job is to record abuse. Marked notified before the
        // attempt either way, so a hook that fails every time cannot be turned into the write
        // amplifier the coalescing exists to prevent.
        try {
          await onLimited(req);
        } catch (err) {
          req.log.error({ err }, 'rate limit onLimited hook failed');
        }
      }
      return reply.code(429).header('retry-after', String(retryAfterSec)).send({ error: refusal });
    }
    bucket.tokens -= 1;
  } as RateLimiter;

  // Gives back the token a request already spent above, for a caller whose limiter is meant to
  // throttle a specific OUTCOME (e.g. failed logins) rather than the attempt rate itself, once
  // that outcome is known not to have happened. Capped at `limit`, same as refill(); a no-op if
  // no bucket exists yet for this key (the preHandler above always creates one before any caller
  // could reach a point where refunding makes sense, so this is defensive, not expected).
  handler.refund = async (req: FastifyRequest): Promise<void> => {
    const key = await keyFn(req);
    const bucket = buckets.get(key);
    if (bucket === undefined) return;
    refill(bucket, Date.now());
    bucket.tokens = Math.min(limit, bucket.tokens + 1);
  };

  return handler;
}
