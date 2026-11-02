// The review gate and the handoff (assisted apply M1c, https://github.com/bgoleno/opportun/issues/116;
// design Part A 3.4, 4.3, 4.5, 5.2, 6.1, 7.6). Every function takes the caller's UserCtx and
// filters by it (FR-S5), except the expiry sweep, which acts on each row as its own user.
//
// What the gate guarantees, server-side:
// - A review binds to the exact state the user saw (lib/submissionDigest.ts). The handoff
//   recomputes the digest and refuses if anything changed, if the review expired, or if the
//   attempt is not reviewed; a refusal changes nothing, not even the audit log.
// - At most N reviews per user in a rolling 24 hours (the instance value, which the user may
//   lower), counted in the database under the user's scope lock, so a restart does not reset
//   it and two concurrent reviews on Postgres cannot both count the same rows.
// - The handoff returns the pinned destination and never fetches it. The destination must be
//   https, never LinkedIn or Indeed, and a recognised posting URL for this requisition or a
//   career page carrying its posting id.
// - Concurrent reviews or handoffs of one attempt produce one transition and one audit entry;
//   the other caller gets the current state back, not an error.
//
// Opportun never transmits an application: nothing here contacts an employer or an ATS.
import { and, eq, gt, lte, min, ne, or, count as sqlCount } from 'drizzle-orm';
import { z } from 'zod';
import type { Submission } from '@opportun/core';
import { DEFAULT_DAILY_REVIEW_CAP, MAX_DAILY_REVIEW_CAP, type Config } from '../config';
import { lockScope, withTransaction } from '../db/client';
import { applicationSubmissions } from '../db/schema';
import { extractAtsJobRefs } from '../lib/atsJobRef';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';
import { racePoint } from '../lib/racePoints';
import { isPageFetchProhibited } from '../lib/safeFetch';
import { submissionDigest } from '../lib/submissionDigest';
import type { Db, Exec, UserCtx } from './base';
import { getRow, notNow, owned, view, type SubmissionRow } from './submissions';
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

const reviewStale = (): HttpError =>
  new HttpError(
    409,
    'review_stale',
    'This application changed since you reviewed it. Review it again.',
  );

export interface ReviewInput {
  reviewDigest: string;
}

type ReviewOutcome =
  { kind: 'reviewed'; row: SubmissionRow } | { kind: 'capped'; resetAt: number } | { kind: 'lost' };

/**
 * Reviews a draft whose digest matches the state the client rendered. A repeat with the same
 * digest (a double click, or the loser of a race) answers the reviewed attempt unchanged.
 */
export async function reviewSubmission(
  db: Db,
  ctx: UserCtx,
  cfg: Pick<Config, 'dailyReviewCap'>,
  id: string,
  input: ReviewInput,
): Promise<Submission> {
  const row = await getRow(db, ctx, id);
  if (row.status === 'reviewed' && row.reviewDigest === input.reviewDigest) return view(row);
  if (row.status !== 'draft') throw notNow(row, 'reviewed');
  if (submissionDigest(row) !== input.reviewDigest) throw reviewStale();
  // Every caller past its checks, none past its write (test/submissionReview.test.ts races).
  await racePoint('submissions.review');

  const outcome = await withTransaction(db, async (tx): Promise<ReviewOutcome> => {
    await lockScope(tx, userScope(ctx));
    const now = Date.now();
    const cap = await dailyCap(tx, ctx, cfg);
    // Attempts reviewed in the window, this one excluded: an edit after review keeps its
    // reviewed_at, so re-reviewing it moves that time rather than counting it twice.
    const inWindow = and(
      eq(applicationSubmissions.userId, ctx.userId),
      gt(applicationSubmissions.reviewedAt, now - REVIEW_CAP_WINDOW_MS),
      ne(applicationSubmissions.id, id),
    );
    const used = await tx
      .select({ n: sqlCount(), oldest: min(applicationSubmissions.reviewedAt) })
      .from(applicationSubmissions)
      .where(inWindow)
      .get();
    if ((used?.n ?? 0) >= cap) {
      const resetAt = (used?.oldest ?? now) + REVIEW_CAP_WINDOW_MS;
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
      .where(and(owned(ctx, id), eq(applicationSubmissions.status, 'draft')))
      .returning();
    if (updated === undefined) return { kind: 'lost' };
    await audit(tx, 'submission.reviewed', {
      userId: ctx.userId,
      detail: { submissionId: id, opportunityId: row.opportunityId, atsKind: row.atsKind },
    });
    return { kind: 'reviewed', row: updated };
  });

  if (outcome.kind === 'reviewed') return view(outcome.row);
  if (outcome.kind === 'capped') {
    throw new HttpError(
      429,
      'daily_review_cap',
      'You reached the most applications you can review in 24 hours.',
      { resetAt: outcome.resetAt },
    );
  }
  // Another request changed the row between the checks and the write.
  const current = await getRow(db, ctx, id);
  if (current.status === 'reviewed' && current.reviewDigest === input.reviewDigest) {
    return view(current);
  }
  throw notNow(current, 'reviewed');
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
 * The query parameter an ATS's embedded job board puts on a company career page to name one
 * posting: Greenhouse's `gh_jid`, Ashby's `ashby_jid`. Lever and Workday postings live on their
 * own hosts, which the recognised-URL branch covers.
 */
const CAREER_PAGE_JOB_PARAM: Readonly<Record<string, string>> = {
  ats_greenhouse: 'gh_jid',
  ats_ashby: 'ashby_jid',
};

/**
 * Whether `destination` may be opened for this requisition (design 7.2): https only, no
 * credentials, never a LinkedIn or Indeed host, and either a recognised ATS posting URL for this
 * very requisition, or a company career page whose ATS job parameter (`gh_jid`, `ashby_jid`)
 * names it. An id merely appearing in a path is not enough: a lookalike host can carry one.
 */
export function destinationAllowed(
  destination: string,
  sub: Pick<SubmissionRow, 'atsKind' | 'atsExternalId'>,
): boolean {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  if (isPageFetchProhibited(url.hostname)) return false;
  const refs = extractAtsJobRefs(url.href);
  if (refs.some((r) => r.kind === sub.atsKind && r.externalId === sub.atsExternalId)) return true;
  // A recognised ATS URL for another requisition: not this posting.
  if (refs.length > 0) return false;
  const param = CAREER_PAGE_JOB_PARAM[sub.atsKind];
  return param !== undefined && url.searchParams.get(param) === sub.atsExternalId;
}

/**
 * Hands off a reviewed attempt: the user is about to open the employer's form. Audit only, no
 * timeline entry (design 5.2). A repeat answers the same destination and writes nothing.
 */
export async function handoffSubmission(db: Db, ctx: UserCtx, id: string): Promise<HandoffResult> {
  const row = await getRow(db, ctx, id);
  if (row.status === 'handed_off') return handedOff(row);
  if (row.status !== 'reviewed') throw notNow(row, 'handed_off');
  const now = Date.now();
  if (row.reviewExpiresAt === null || row.reviewExpiresAt <= now) {
    throw new HttpError(409, 'review_expired', 'This review has expired. Review it again.');
  }
  if (row.reviewDigest === null || submissionDigest(row) !== row.reviewDigest) throw reviewStale();
  if (!destinationAllowed(row.destinationUrl, row)) {
    throw new HttpError(
      422,
      'destination_not_allowed',
      "This application's destination is not the employer's posting for this requisition.",
    );
  }
  await racePoint('submissions.handoff');

  const won = await withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(applicationSubmissions)
      .set({ status: 'handed_off', handedOffAt: now, updatedAt: now })
      .where(
        and(
          owned(ctx, id),
          eq(applicationSubmissions.status, 'reviewed'),
          eq(applicationSubmissions.reviewDigest, row.reviewDigest as string),
        ),
      )
      .returning();
    if (updated === undefined) return undefined;
    await audit(tx, 'submission.handed_off', {
      userId: ctx.userId,
      detail: {
        submissionId: id,
        opportunityId: row.opportunityId,
        atsKind: row.atsKind,
        host: new URL(row.destinationUrl).hostname,
      },
    });
    return updated;
  });
  if (won !== undefined) return handedOff(won);
  const current = await getRow(db, ctx, id);
  if (current.status === 'handed_off') return handedOff(current);
  throw notNow(current, 'handed_off');
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
          // A lapsed handoff has no dedicated reason in SUBMISSION_FAILURE_REASONS: 'other', with
          // the cause in the audit entry.
          failureReason: expiredReview ? 'review_expired' : 'other',
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
