// Vendor checks (ATS detection and the board probe) placed in line per user, so one user cannot hold
// up another's (https://github.com/bgoleno/opportun/issues/321; tl's design on
// https://github.com/bgoleno/opportun/issues/321#issuecomment-6767502359, as changed on
// https://github.com/bgoleno/opportun/pull/330#issuecomment-6768955332).
import { and, eq, gte, inArray, min, ne, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { jobs } from '../db/schema';
import type { UserCtx } from '../repos/base';
import { enqueue } from './runner';

/**
 * The job kinds that read ATS vendors' public pages: atsDetect.ts and companyBoardProbe.ts. Spelled
 * here, not imported, because both of those import this module; test/vendorCheckQueue.test.ts pins
 * them to ATS_DETECT_KIND and BOARD_PROBE_KIND.
 */
export const VENDOR_CHECK_KINDS = ['company.ats_detect', 'company.board_probe'] as const;
export type VendorCheckKind = (typeof VENDOR_CHECK_KINDS)[number];

/**
 * Per user: how many vendor checks go ahead of other users' waiting ones, counting those pending,
 * running, or made in the last VENDOR_CHECK_WINDOW_MS whatever became of them. The window makes it a
 * budget over time: a user who queued one more each time one finished stayed under a cap of pending
 * and running alone, and went ahead every time, so another user's backlog was never reached (sec on
 * https://github.com/bgoleno/opportun/pull/330, B2; tl ruled the window).
 */
export const VENDOR_CHECK_CAP = 3;
export const VENDOR_CHECK_WINDOW_MS = 10 * 60_000;

/** Per app (a Db), per user: the tail of that user's enqueues, so each counts after the last inserts. */
const lines = new WeakMap<Db, Map<string, Promise<unknown>>>();

/**
 * Runs `fn` after the user's earlier enqueues have finished, so the count and the insert of one are
 * never interleaved with another's: enqueues for one user at the same moment otherwise each counted
 * before any inserted, and all went ahead (sec on #330). In-process: it orders one server process's
 * enqueues, which is the deployment (single node, like the capture slot in lib/captureLimit.ts and
 * every limiter here). Two processes on one database could each place up to the cap ahead.
 */
function inUsersLine<T>(db: Db, userId: string, fn: () => Promise<T>): Promise<T> {
  let users = lines.get(db);
  if (users === undefined) {
    users = new Map();
    lines.set(db, users);
  }
  const before = users.get(userId) ?? Promise.resolve();
  const mine = before.then(fn);
  // The tail never rejects, so a refused enqueue does not stop the next one for that user.
  const tail = mine.then(
    () => undefined,
    () => undefined,
  );
  users.set(userId, tail);
  void tail.then(() => {
    if (users.get(userId) === tail) users.delete(userId);
  });
  return mine;
}

/**
 * Queues one vendor check for the user, and decides its place in line. The runner claims by run_at,
 * then created_at.
 * - Under VENDOR_CHECK_CAP of the user's checks pending, running or made within the window: due
 *   just before the earliest vendor check any other user has waiting (or now, if none waits or now
 *   is earlier). So a user's first few checks in a window go ahead of another user's backlog,
 *   however long it has waited, behind only what is running.
 * - At or over it: due now, the back of the line. So a user alone is never slowed: 30 follows are
 *   all due at once, as before.
 * Nothing is refused: every check runs in its turn. Dedupe keys are the caller's (per company), as
 * before: a company already queued keeps its place and its job id.
 */
export async function enqueueVendorCheck(
  db: Db,
  ctx: UserCtx,
  kind: VendorCheckKind,
  payload: unknown,
  dedupeKey: string,
): Promise<string> {
  return await inUsersLine(db, ctx.userId, async () => {
    const now = Date.now();
    const mine = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.userId, ctx.userId),
          inArray(jobs.kind, [...VENDOR_CHECK_KINDS]),
          or(
            inArray(jobs.status, ['pending', 'running']),
            gte(jobs.createdAt, now - VENDOR_CHECK_WINDOW_MS),
          ),
        ),
      )
      .limit(VENDOR_CHECK_CAP)
      .all();
    let runAt = now;
    if (mine.length < VENDOR_CHECK_CAP) {
      const others = await db
        .select({ earliest: min(jobs.runAt) })
        .from(jobs)
        .where(
          and(
            ne(jobs.userId, ctx.userId),
            inArray(jobs.kind, [...VENDOR_CHECK_KINDS]),
            eq(jobs.status, 'pending'),
          ),
        )
        .get();
      const earliest = others?.earliest == null ? null : Number(others.earliest);
      if (earliest !== null) runAt = Math.min(now, earliest - 1);
    }
    return await enqueue(db, kind, payload, { dedupeKey, userId: ctx.userId, runAt });
  });
}
