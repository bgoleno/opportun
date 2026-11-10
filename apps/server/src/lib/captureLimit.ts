// The per-user capture budget (https://github.com/bgoleno/opportun/issues/272). A capture waits
// for the user's discovery ingest lock while holding a pool connection, so one user's large
// burst could fill the pool and make another user's request fail at the 10 s connection
// timeout (sec on https://github.com/bgoleno/opportun/pull/271#issuecomment-6651129713). One
// budget per user, shared by POST /capture (the web app) and POST /connector/capture (every one
// of the user's extension tokens), keeps any burst short. The extension's per-token budget
// (30 per 15 minutes) stays as well: it is the narrower limit for one browser.
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/client';
import { requireUser } from '../repos/base';
import { requireDevice } from './deviceTokens';
import { rateLimit, type RateLimiter } from './rateLimit';

/**
 * 60 captures per user per 15 minutes. Reasoned, not measured from real use: no capture data
 * from a real install was read for this. It rests on four facts.
 * - One extension token may make 30 per 15 minutes, which the guide calls far above normal
 *   use. 60 lets a user use one token to its limit and the web app's dialog for 30 more, or
 *   two browsers to their limits, in the same 15 minutes.
 * - The most a capture session of one person plausibly covers is one alert email's leads, up
 *   to 100 (MAX_ALERT_LEADS), each opened and captured by hand. 60 at once, then one every
 *   15 s, finishes 100 in about 10 minutes, faster than a person reads them.
 * - qa's load run on https://github.com/bgoleno/opportun/pull/285 (8 tokens and thousands of
 *   pastes per user in 150 s) is a stress test, far beyond one person's use, not a pattern
 *   this limit has to admit.
 * - sec measured about 42 ms in the ingest lock at 50,000 rows, so a burst passes the 10 s
 *   connection timeout at about 238 queued captures. 60 at once is about 2.5 s of queue.
 * It is this one constant: change it here if real use says otherwise.
 */
export const CAPTURE_USER_LIMIT = { limit: 60, windowMs: 15 * 60 * 1000 };

const limiters = new WeakMap<Db, RateLimiter>();

/**
 * The capture user of a request: the token's owner on the extension's route (device auth, no
 * session), the signed-in user on the web app's. A 401 when there is neither.
 */
function captureUserId(req: FastifyRequest): string {
  return req.deviceCtx === null || req.deviceCtx === undefined
    ? requireUser(req).userId
    : requireDevice(req).userId;
}

/** This app's per-user capture limiter: one set of buckets for both capture routes. */
export function captureUserLimit(db: Db): RateLimiter {
  let found = limiters.get(db);
  if (found === undefined) {
    found = rateLimit({
      ...CAPTURE_USER_LIMIT,
      reason: 'per_user',
      keyFn: (req) => `capture-user|${captureUserId(req)}`,
    });
    limiters.set(db, found);
  }
  return found;
}
