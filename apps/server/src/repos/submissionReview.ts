// The review gate and the handoff (assisted apply M1c, https://github.com/bgoleno/opportun/issues/116;
// design Part A 3.4, 4.3, 4.5, 5.2, 6.1, 7.6). Every function takes the caller's UserCtx and
// filters by it (FR-S5), except the expiry sweep, which acts on each row as its own user.
//
// What the gate guarantees, server-side:
// - A review binds to the exact state the user saw (lib/submissionDigest.ts). The handoff
//   recomputes the digest and refuses if anything changed, if the review expired, or if the
//   attempt is not reviewed; a refusal changes nothing, not even the audit log.
// - At most N reviews per user in a rolling 24 hours (the instance value, which the user may
//   lower), counted from the audit log under the user's scope lock, so a restart or a deleted
//   opportunity does not reset it and two concurrent reviews on Postgres cannot both count the
//   same entries.
// - The handoff returns the pinned destination and never fetches it. The destination must be
//   https, never LinkedIn or Indeed, and a recognised posting URL for this requisition on its
//   own board or tenant.
// - Every write to one attempt (edit, cancel, review, handoff) takes its lock and checks the row
//   it re-read under it, so concurrent requests serialize: one transition and one audit entry,
//   the other caller gets the current state back, and an edit cannot slip between a check and
//   the write it guards.
//
// Opportun never transmits an application: nothing here contacts an employer or an ATS.
import { and, eq, gt, lte, max, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Submission } from '@opportun/core';
import { DEFAULT_DAILY_REVIEW_CAP, MAX_DAILY_REVIEW_CAP, type Config } from '../config';
import { lockScope, withTransaction } from '../db/client';
import { jsonText } from '../db/dialect';
import { applicationSubmissions, auditLog } from '../db/schema';
import { boardFromUrl } from '../jobs/atsDetect';
import { extractAtsJobRefs } from '../lib/atsJobRef';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';
import { racePoint } from '../lib/racePoints';
import { isPageFetchProhibited } from '../lib/safeFetch';
import { submissionDigest } from '../lib/submissionDigest';
import type { Db, Exec, UserCtx } from './base';
import {
  getRow,
  notNow,
  owned,
  snapshotBlocksReview,
  view,
  type SubmissionRow,
} from './submissions';
import { readUserSetting } from './userSettings';

/** How long a review may be handed off: a fixed "valid until", never a countdown. */
export const REVIEW_TTL_MS = 30 * 60 * 1000;
/** A handoff with no outcome after this long is abandoned by the sweep (design 4.3). */
export const HANDOFF_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
/** The window the daily review cap counts over. */
export const REVIEW_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The user's own cap (userSettings), 1 up to the instance value; the route comes with M1d. */
export const DAILY_REVIEW_CAP_SETTING = 'submissions.dailyReviewCap';
export const SUBMISSION_EXPIRE_JOB_KIND = 'submission.expire';

const userScope = (ctx: UserCtx): string => `user:${ctx.userId}`;
/**
 * One lock per attempt, taken first by every write to it (edit, cancel, review, handoff), so
 * each re-reads the row after the lock and checks the state it is about to change. Lock order is
 * this scope, then the user's.
 */
export const submissionScope = (id: string): string => `submission:${id}`;

const SNAPSHOT_BLOCK_MESSAGES = new Map([
  ['snapshot_pending', 'The saved copy of your resume is still being prepared.'],
  ['snapshot_failed', 'Opportun could not save a copy of your resume. Choose it again to retry.'],
] as const);

/** The cap that applies to this user: their own value if lower, else the instance's. */
async function dailyCap(
  exec: Exec,
  ctx: UserCtx,
  cfg: Pick<Config, 'dailyReviewCap'>,
): Promise<number> {
  const instance = cfg.dailyReviewCap ?? DEFAULT_DAILY_REVIEW_CAP;
  const own = await readUserSetting(
    exec,
    ctx,
    DAILY_REVIEW_CAP_SETTING,
    z.number().int().min(1).max(MAX_DAILY_REVIEW_CAP).nullable(),
    null,
  );
  return own === null ? instance : Math.min(own, instance);
}

/**
 * The attempts this user reviewed in the window, other than `exceptId`, each with the time of
 * its latest review in the window, oldest first. Counted from `submission.reviewed` audit
 * entries rather than submission rows: deleting an opportunity cascades its attempts away but
 * leaves the audit log, so a deletion cannot free a place under the cap. One attempt reviewed
 * several times counts once.
 */
async function reviewsInWindow(
  exec: Exec,
  ctx: UserCtx,
  now: number,
  exceptId: string,
): Promise<number[]> {
  const submissionId = jsonText(auditLog.detail, 'submissionId');
  const rows = await exec
    .select({ submissionId, at: max(auditLog.createdAt) })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, ctx.userId),
        eq(auditLog.event, 'submission.reviewed'),
        gt(auditLog.createdAt, now - REVIEW_CAP_WINDOW_MS),
      ),
    )
    .groupBy(submissionId)
    .all();
  return rows
    .filter((r) => r.submissionId !== exceptId && r.at !== null)
    .map((r) => r.at as number)
    .sort((a, b) => a - b);
}

const reviewStale = (): HttpError =>
  new HttpError(
    409,
    'review_stale',
    'This application changed since you reviewed it. Review it again.',
  );

export interface ReviewInput {
  reviewDigest: string;
}

type ReviewOutcome = { kind: 'reviewed'; row: SubmissionRow } | { kind: 'capped'; resetAt: number };

/**
 * Reviews a draft whose digest matches the state the client rendered. A repeat with the same
 * digest while the review is valid (a double click, or the loser of a race) answers the
 * reviewed attempt unchanged. An expired review with the same digest is reviewed again: it
 * gets a new valid-until and counts under the cap as a fresh review.
 *
 * Every check runs inside the transaction, on the row re-read under the attempt's lock, so an
 * edit cannot land between the digest check and the write (#129).
 */
export async function reviewSubmission(
  db: Db,
  ctx: UserCtx,
  cfg: Pick<Config, 'dailyReviewCap'>,
  id: string,
  input: ReviewInput,
): Promise<Submission> {
  // Ownership first, outside any lock: another user's id is a 404 and takes no lock.
  await getRow(db, ctx, id);
  // Every caller before its transaction (test/submissionReview.test.ts races).
  await racePoint('submissions.review');

  const outcome = await withTransaction(db, async (tx): Promise<ReviewOutcome> => {
    await lockScope(tx, submissionScope(id));
    const row = await getRow(tx, ctx, id);
    const now = Date.now();
    const sameDigest = row.reviewDigest === input.reviewDigest;
    if (row.status === 'reviewed' && sameDigest && (row.reviewExpiresAt ?? 0) > now) {
      return { kind: 'reviewed', row };
    }
    const refresh = row.status === 'reviewed' && sameDigest;
    if (row.status !== 'draft' && !refresh) throw notNow(row, 'reviewed');
    // The resume snapshot (#115): review waits while it is pending, and refuses a failed one
    // until the user chooses the resume again. Ready, or unsupported (the user attaches a file
    // themselves, and the review shows that), may go ahead. Under the lock, like every check.
    const blocked = snapshotBlocksReview(row);
    if (blocked !== null) {
      throw new HttpError(409, blocked, SNAPSHOT_BLOCK_MESSAGES.get(blocked), {
        submissionId: row.id,
      });
    }
    if (submissionDigest(row) !== input.reviewDigest) throw reviewStale();

    await lockScope(tx, userScope(ctx));
    const cap = await dailyCap(tx, ctx, cfg);
    const used = await reviewsInWindow(tx, ctx, now, id);
    if (used.length >= cap) {
      // The cap frees a place when enough of the oldest reviews leave the window for the count
      // to drop below it: the (n - cap + 1)th oldest.
      const resetAt = (used[used.length - cap] ?? now) + REVIEW_CAP_WINDOW_MS;
      await audit(tx, 'submission.review_cap_hit', {
        userId: ctx.userId,
        detail: { submissionId: id, opportunityId: row.opportunityId, cap, resetAt },
      });
      return { kind: 'capped', resetAt };
    }
    const [updated] = await tx
      .update(applicationSubmissions)
      .set({
        status: 'reviewed',
        reviewDigest: input.reviewDigest,
        reviewedAt: now,
        reviewExpiresAt: now + REVIEW_TTL_MS,
        updatedAt: now,
      })
      .where(and(owned(ctx, id), eq(applicationSubmissions.status, row.status)))
      .returning();
    // Unreachable while every writer takes the attempt's lock; kept as a guard.
    if (updated === undefined) throw notNow(await getRow(tx, ctx, id), 'reviewed');
    await audit(tx, 'submission.reviewed', {
      userId: ctx.userId,
      detail: { submissionId: id, opportunityId: row.opportunityId, atsKind: row.atsKind },
    });
    return { kind: 'reviewed', row: updated };
  });

  if (outcome.kind === 'reviewed') return view(outcome.row);
  throw new HttpError(
    429,
    'daily_review_cap',
    'You reached the most applications you can review in 24 hours.',
    { resetAt: outcome.resetAt },
  );
}

export interface HandoffResult {
  /** The employer's posting, for the browser to open. The server never fetches it. */
  destinationUrl: string;
  /** When an unfinished handoff lapses (the sweep abandons it after this). */
  expiresAt: number;
}

const handedOff = (row: SubmissionRow): HandoffResult => ({
  destinationUrl: row.destinationUrl,
  expiresAt: (row.handedOffAt ?? 0) + HANDOFF_IDLE_MS,
});

/**
 * Whether `destination` may be opened for this requisition (design 7.2): https only, no
 * credentials, never a LinkedIn or Indeed host, and a recognised ATS posting URL for this very
 * requisition: the same ATS, the same requisition id, and the same board or tenant where the
 * URL names one (a Workday requisition id is only unique within its tenant). A company career
 * page that embeds an ATS board is not accepted: nothing here can tell the company's own host
 * from a lookalike, which needs the M3 company-domain check.
 */
export function destinationAllowed(
  destination: string,
  sub: Pick<SubmissionRow, 'atsKind' | 'atsExternalId' | 'atsRef'>,
): boolean {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  if (isPageFetchProhibited(url.hostname)) return false;
  // A recognised ATS board host, never a page that merely embeds a board: extractAtsJobRefs
  // also reads `gh_jid` on any host, which is how a lookalike could name this requisition.
  const board = boardFromUrl(url.href);
  if (board === null || board.kind !== sub.atsKind) return false;
  // atsRef is the board the draft was created from (repos/submissions.ts): the same tenant.
  if (sub.atsRef !== null && board.slug.toLowerCase() !== sub.atsRef.toLowerCase()) return false;
  return extractAtsJobRefs(url.href).some(
    (r) => r.kind === sub.atsKind && r.externalId === sub.atsExternalId,
  );
}

/**
 * Hands off a reviewed attempt: the user is about to open the employer's form. Audit only, no
 * timeline entry (design 5.2). A repeat answers the same destination and writes nothing.
 *
 * Every check runs inside the transaction, on the row re-read under the attempt's lock: an edit
 * and re-review that lands while a handoff is in flight is either fully before it (and the
 * handoff hands off what was reviewed) or fully after it (and finds the attempt handed off).
 */
export async function handoffSubmission(db: Db, ctx: UserCtx, id: string): Promise<HandoffResult> {
  await getRow(db, ctx, id);
  await racePoint('submissions.handoff');

  return await withTransaction(db, async (tx) => {
    await lockScope(tx, submissionScope(id));
    const row = await getRow(tx, ctx, id);
    if (row.status === 'handed_off') return handedOff(row);
    if (row.status !== 'reviewed') throw notNow(row, 'handed_off');
    const now = Date.now();
    if (row.reviewExpiresAt === null || row.reviewExpiresAt <= now) {
      throw new HttpError(409, 'review_expired', 'This review has expired. Review it again.');
    }
    if (row.reviewDigest === null || submissionDigest(row) !== row.reviewDigest) {
      throw reviewStale();
    }
    if (!destinationAllowed(row.destinationUrl, row)) {
      throw new HttpError(
        422,
        'destination_not_allowed',
        "This application's destination is not the employer's posting for this requisition.",
      );
    }
    const [updated] = await tx
      .update(applicationSubmissions)
      .set({ status: 'handed_off', handedOffAt: now, updatedAt: now })
      .where(
        and(
          owned(ctx, id),
          eq(applicationSubmissions.status, 'reviewed'),
          eq(applicationSubmissions.reviewDigest, row.reviewDigest),
        ),
      )
      .returning();
    // Unreachable while every writer takes the attempt's lock; kept as a guard.
    if (updated === undefined) throw notNow(await getRow(tx, ctx, id), 'handed_off');
    await audit(tx, 'submission.handed_off', {
      userId: ctx.userId,
      detail: {
        submissionId: id,
        opportunityId: row.opportunityId,
        atsKind: row.atsKind,
        host: new URL(row.destinationUrl).hostname,
      },
    });
    return handedOff(updated);
  });
}

/**
 * The expiry sweep (design 4.3): a review not handed off within REVIEW_TTL_MS, and a handoff
 * with no outcome after HANDOFF_IDLE_MS, become abandoned. Each row changes only if it is still
 * in the state that expired, so a user acting at the same moment wins. Returns how many changed.
 */
export async function sweepSubmissions(db: Db, now: number = Date.now()): Promise<number> {
  const due = await db
    .select()
    .from(applicationSubmissions)
    .where(
      or(
        and(
          eq(applicationSubmissions.status, 'reviewed'),
          lte(applicationSubmissions.reviewExpiresAt, now),
        ),
        and(
          eq(applicationSubmissions.status, 'handed_off'),
          lte(applicationSubmissions.handedOffAt, now - HANDOFF_IDLE_MS),
        ),
      ),
    )
    .all();
  let changed = 0;
  for (const row of due) {
    const expiredReview =
      row.status === 'reviewed' && row.reviewExpiresAt !== null && row.reviewExpiresAt <= now;
    const idleHandoff =
      row.status === 'handed_off' &&
      row.handedOffAt !== null &&
      row.handedOffAt <= now - HANDOFF_IDLE_MS;
    if (!expiredReview && !idleHandoff) continue;
    const ctx: UserCtx = { userId: row.userId, isAdmin: false };
    const done = await withTransaction(db, async (tx) => {
      const [updated] = await tx
        .update(applicationSubmissions)
        .set({
          status: 'abandoned',
          failureReason: expiredReview ? 'review_expired' : 'handoff_idle',
          updatedAt: now,
        })
        .where(
          and(
            owned(ctx, row.id),
            eq(applicationSubmissions.status, row.status),
            expiredReview
              ? lte(applicationSubmissions.reviewExpiresAt, now)
              : lte(applicationSubmissions.handedOffAt, now - HANDOFF_IDLE_MS),
          ),
        )
        .returning();
      if (updated === undefined) return false;
      await audit(tx, 'submission.abandoned', {
        userId: row.userId,
        detail: {
          submissionId: row.id,
          opportunityId: row.opportunityId,
          reason: expiredReview ? 'review_expired' : 'handoff_idle',
        },
      });
      return true;
    });
    if (done) changed += 1;
  }
  return changed;
}
