// The per-user capture budget (https://github.com/bgoleno/opportun/issues/272). A capture waits
// for the user's discovery ingest lock while holding a pool connection, so one user's large
// burst could fill the pool and make another user's request fail at the 10 s connection
// timeout (sec on https://github.com/bgoleno/opportun/pull/271#issuecomment-6651129713). One
// budget per user, shared by POST /capture (the web app) and POST /connector/capture (every one
// of the user's extension tokens), keeps any burst short. The extension's per-token budget
// (30 per 15 minutes) stays as well: it is the narrower limit for one browser.
import type { FastifyRequest } from 'fastify';
import { isLockTimeout, type Db } from '../db/client';
import { requireUser } from '../repos/base';
import { requireDevice } from './deviceTokens';
import { HttpError } from './errors';
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

/**
 * How many of one user's captures may be in their ingest lock at once, and how long a capture
 * waits (https://github.com/bgoleno/opportun/issues/309, tl's design on
 * https://github.com/bgoleno/opportun/issues/309#issuecomment-6765588508). The limit above bounds
 * how many captures a user makes in 15 minutes, not how many wait at once: each capture waiting
 * on the user's ingest lock held a pool connection, so one user's captures behind a slow holder
 * could take every connection, and another user's request failed at the 10 s connection timeout.
 * - One slot per user. The ingest lock already lets one of the user's captures in at a time, so
 *   a second slot would buy nothing but a second connection waiting on that lock.
 * - A capture finding the slot taken waits for it in memory, holding no connection, for up to
 *   waitMs, so two ordinary captures that overlap for the ~42 ms the lock is held both go through.
 * - The capture holding the slot waits for the lock itself (Postgres) for up to lockTimeoutMs,
 *   then gives up and rolls back. That bounds how long it holds its one connection.
 * Each wait stays under the pool's 10 s connection timeout. Change them here.
 */
export const CAPTURE_SLOT = { waitMs: 5_000, lockTimeoutMs: 5_000, retryAfterSec: 5 };

/**
 * 503, not 429: the clients read 429 as the 60-per-15-minutes limit above and would say so. This
 * one is about the moment, so the clients say to try again shortly.
 */
const captureBusy = (): HttpError =>
  new HttpError(503, 'capture_busy', undefined, undefined, {
    retryAfterSec: CAPTURE_SLOT.retryAfterSec,
  });

interface Slot {
  /** Waiters in arrival order; each is handed the slot when the one before it is done. */
  queue: (() => void)[];
}

/** Per app, per user: an entry exists while the user's slot is taken. */
const slots = new WeakMap<Db, Map<string, Slot>>();

async function takeSlot(db: Db, userId: string): Promise<void> {
  let users = slots.get(db);
  if (users === undefined) {
    users = new Map();
    slots.set(db, users);
  }
  const slot = users.get(userId);
  if (slot === undefined) {
    users.set(userId, { queue: [] });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const turn = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      // Gone from the line, so the slot is never handed to a caller that already gave up.
      slot.queue.splice(slot.queue.indexOf(turn), 1);
      reject(captureBusy());
    }, CAPTURE_SLOT.waitMs);
    slot.queue.push(turn);
  });
}

function releaseSlot(db: Db, userId: string): void {
  const users = slots.get(db);
  const slot = users?.get(userId);
  if (users === undefined || slot === undefined) return;
  const next = slot.queue.shift();
  // Handed straight to the next waiter, so no new caller can slip in between.
  if (next === undefined) users.delete(userId);
  else next();
}

/**
 * Runs `fn`, a capture's calls that take the user's ingest lock, in the user's one capture slot.
 * Around those calls and not the request: the fetch and the AI calls before them take seconds and
 * hold no connection, and a slot taken in one request hook and given back in another could be
 * lost on a path that skips the second. try/finally cannot lose it. A slot wait or a lock wait
 * that runs out is a 503 capture_busy with retry-after; fn passes CAPTURE_SLOT.lockTimeoutMs to
 * its locked transactions.
 */
export async function withCaptureSlot<T>(db: Db, userId: string, fn: () => Promise<T>): Promise<T> {
  await takeSlot(db, userId);
  try {
    return await fn();
  } catch (err) {
    if (isLockTimeout(err)) throw captureBusy();
    throw err;
  } finally {
    releaseSlot(db, userId);
  }
}
