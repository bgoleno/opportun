// Vendor checks (ATS detection and the board probe) queued per user, so one user cannot hold up
// another's (https://github.com/bgoleno/opportun/issues/321; tl's design on
// https://github.com/bgoleno/opportun/issues/321#issuecomment-6767502359).
import { and, eq, inArray } from 'drizzle-orm';
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
 * Per user: how many vendor checks may be due at once, and how far apart the rest are queued.
 * Adding a handful of companies is due at once, as before; 50 follows take about 16 minutes, and
 * nobody else waits for them.
 */
export const VENDOR_CHECK_CAP = 3;
export const VENDOR_CHECK_SPACING_MS = 20_000;

/**
 * Queues one vendor check for the user. Under VENDOR_CHECK_CAP of the user's checks pending or
 * running, it is due now, as before. At or over it, it is due one spacing after the user's latest
 * pending check (or after now, if that is past). The runner claims by run_at, then created_at, so
 * another user's check, due now, goes ahead of this user's spread-out backlog: each user has at
 * most the cap due at once, and a detection waits behind at most that many of each other user's,
 * through the kind's concurrency limit. Nothing is refused: every check runs in its turn, and the
 * UI's pending states stay true while one waits.
 *
 * Two enqueues for one user at the same moment can both see room and both be due now, one over
 * the cap. That loosens the bound by one job and no more, so it takes no lock. The dedupe key is
 * the caller's (per company), as before: a company already queued keeps its place and its id.
 */
export async function enqueueVendorCheck(
  db: Db,
  ctx: UserCtx,
  kind: VendorCheckKind,
  payload: unknown,
  dedupeKey: string,
): Promise<string> {
  const now = Date.now();
  const queued = await db
    .select({ status: jobs.status, runAt: jobs.runAt })
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, ctx.userId),
        inArray(jobs.kind, [...VENDOR_CHECK_KINDS]),
        inArray(jobs.status, ['pending', 'running']),
      ),
    )
    .all();
  let runAt = now;
  if (queued.length >= VENDOR_CHECK_CAP) {
    const latest = Math.max(
      now,
      ...queued.filter((j) => j.status === 'pending').map((j) => j.runAt),
    );
    runAt = latest + VENDOR_CHECK_SPACING_MS;
  }
  return await enqueue(db, kind, payload, { dedupeKey, userId: ctx.userId, runAt });
}
