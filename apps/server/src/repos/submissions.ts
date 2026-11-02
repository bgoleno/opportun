// Application submissions (assisted apply M1a, https://github.com/bgoleno/opportun/issues/114;
// design Part A sections 4 and 6). Every function takes the caller's UserCtx and filters by it
// (FR-S5). Opportun never transmits an application: nothing here contacts an employer or an
// ATS, and the destination URL is stored, never fetched.
//
// M1a covers the draft lifecycle only: create a draft for one eligible opportunity (idempotent
// on the client's key), read it, edit it while it is a draft, and cancel it. Review, handoff and
// everything after them arrive with later milestones; their columns already exist and stay
// unset here.
import {
  applySubmissionTransition,
  canSubmissionTransition,
  newId,
  type Submission,
  type SubmissionAnswer,
  type SubmissionFields,
  type SubmissionSnapshotState,
  type SubmissionStatus,
} from '@opportun/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { isUniqueViolation, lockScope, withTransaction } from '../db/client';
import { applicationSubmissions, attachments, opportunities, resumes } from '../db/schema';
import { HttpError, notFound } from '../lib/errors';
import { racePoint } from '../lib/racePoints';
import { submissionDigest } from '../lib/submissionDigest';
import { enqueueSnapshot } from '../jobs/submissionSnapshot';
import type { Db, Exec, UserCtx } from './base';
import { countWhere, type ListOpts, type Page } from './list';

export type SubmissionRow = typeof applicationSubmissions.$inferSelect;

/** An opportunity can start an attempt only at these stages (#114 criterion 1). */
export const SUBMISSION_ELIGIBLE_STAGES = ['interested', 'preparing', 'applied'] as const;

/** Why an opportunity, or the chosen resume, cannot start an attempt: the 422 codes. */
export type IneligibleReason =
  | 'no_ats_identity'
  | 'posting_not_confirmed'
  | 'stage_not_eligible'
  | 'destination_not_https'
  | 'resume_not_found'
  | 'resume_not_final';

const INELIGIBLE_MESSAGES = new Map<IneligibleReason, string>([
  [
    'no_ats_identity',
    "This opportunity is not linked to a posting on the company's own job board yet.",
  ],
  [
    'posting_not_confirmed',
    "This opportunity's posting needs review: confirm it on the opportunity before applying.",
  ],
  ['stage_not_eligible', 'Applying is available at Interested, Preparing or Applied.'],
  ['destination_not_https', "The posting's address is not https."],
  ['resume_not_found', 'That resume was not found.'],
  ['resume_not_final', 'Choose a finished resume: one marked final, or already submitted.'],
]);

/**
 * A finished resume may be used: `final`, or `submitted` (already sent with another
 * application, since one base resume serves many). A draft, or one still in review, may not.
 */
const USABLE_RESUME_STATUSES: readonly string[] = ['final', 'submitted'];

/** 422 with the reason as its code (the message is server-side context; clients map codes). */
const ineligible = (reason: IneligibleReason): HttpError =>
  new HttpError(422, reason, INELIGIBLE_MESSAGES.get(reason));

/** The live statuses, as the partial unique index names them. */
const LIVE: SubmissionStatus[] = ['draft', 'reviewed', 'handed_off'];

export function view(row: SubmissionRow): Submission {
  return {
    id: row.id,
    opportunityId: row.opportunityId,
    resumeId: row.resumeId,
    atsKind: row.atsKind,
    atsRef: row.atsRef,
    atsExternalId: row.atsExternalId,
    destinationUrl: row.destinationUrl,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    resumeSha256: row.resumeSha256,
    resumeTitle: row.resumeTitle,
    resumeStore: row.resumeStore,
    snapshotState: row.snapshotState,
    resumeAttachmentId: row.resumeAttachmentId,
    snapshotError: row.snapshotError,
    fields: row.fields,
    answers: row.answers,
    // The state as it stands now, for the review screen to echo (M1c, design 4.5): computed, not
    // the stored review_digest, which is the state at the moment of the last review.
    reviewDigest: submissionDigest(row),
    reviewExpiresAt: row.reviewExpiresAt,
    reviewedAt: row.reviewedAt,
    handedOffAt: row.handedOffAt,
    submittedAt: row.submittedAt,
    confirmedAt: row.confirmedAt,
    confirmationKind: row.confirmationKind,
    failureReason: row.failureReason,
    reapplyOf: row.reapplyOf,
    reapplyReason: row.reapplyReason,
    submittedActivityId: row.submittedActivityId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const owned = (ctx: UserCtx, id: string) =>
  and(eq(applicationSubmissions.userId, ctx.userId), eq(applicationSubmissions.id, id));

export async function getRow(exec: Exec, ctx: UserCtx, id: string): Promise<SubmissionRow> {
  const row = await exec.select().from(applicationSubmissions).where(owned(ctx, id)).get();
  if (row === undefined) throw notFound();
  return row;
}

async function byKey(exec: Exec, ctx: UserCtx, key: string): Promise<SubmissionRow | undefined> {
  return await exec
    .select()
    .from(applicationSubmissions)
    .where(
      and(
        eq(applicationSubmissions.userId, ctx.userId),
        eq(applicationSubmissions.idempotencyKey, key),
      ),
    )
    .get();
}

async function liveFor(
  exec: Exec,
  ctx: UserCtx,
  opportunityId: string,
): Promise<SubmissionRow | undefined> {
  return await exec
    .select()
    .from(applicationSubmissions)
    .where(
      and(
        eq(applicationSubmissions.userId, ctx.userId),
        eq(applicationSubmissions.opportunityId, opportunityId),
        inArray(applicationSubmissions.status, LIVE),
      ),
    )
    .get();
}

/**
 * Why review must wait for the snapshot, or null when it need not (#115, tl's answers): a
 * pending snapshot is not there yet, and a failed one needs the user first (choosing the resume
 * again retries it). `ready` and `unsupported` may be reviewed: with no PDF from the store the
 * user attaches a file themselves, and the review shows that, never text in its place. The
 * review route (M1c, #116) refuses with 409 and this code.
 */
export function snapshotBlocksReview(row: {
  snapshotState: SubmissionSnapshotState;
}): 'snapshot_pending' | 'snapshot_failed' | null {
  if (row.snapshotState === 'pending') return 'snapshot_pending';
  if (row.snapshotState === 'failed') return 'snapshot_failed';
  return null;
}

/** 409 naming the opportunity's live attempt, so the client can open it instead. */
const liveExists = (live: SubmissionRow): HttpError =>
  new HttpError(
    409,
    'live_submission_exists',
    'This opportunity already has an open application.',
    {
      submissionId: live.id,
    },
  );

/** The chosen resume, owned by the caller, not archived, and marked final; or why not. */
async function finalResume(exec: Exec, ctx: UserCtx, resumeId: string) {
  const resume = await exec
    .select()
    .from(resumes)
    .where(and(eq(resumes.userId, ctx.userId), eq(resumes.id, resumeId)))
    .get();
  // Another user's resume reads exactly like a missing one.
  if (resume === undefined || resume.archivedAt !== null) throw ineligible('resume_not_found');
  if (!USABLE_RESUME_STATUSES.includes(resume.status)) throw ineligible('resume_not_final');
  return resume;
}

export interface CreateDraftInput {
  idempotencyKey: string;
  resumeId: string;
}

/**
 * Starts a draft for one opportunity, or returns the one this key already created
 * (`replayed`). Eligible (#114 criterion 1): the opportunity has an ATS identity whose posting
 * is confirmed (on the company's own board), is at Interested, Preparing or Applied, and the
 * resume is the caller's, not archived, and finished (final or submitted). One live attempt per
 * opportunity: the partial unique index enforces it, and the check here only turns it into a
 * readable 409.
 */
export async function createSubmissionDraft(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  input: CreateDraftInput,
): Promise<{ submission: Submission; replayed: boolean }> {
  const replay = async (): Promise<{ submission: Submission; replayed: boolean } | null> => {
    const prior = await byKey(db, ctx, input.idempotencyKey);
    if (prior === undefined) return null;
    // A key belongs to one attempt. Reusing it for another opportunity, or with another
    // resume, is a client bug: never answer it silently with the first request's choice.
    if (prior.opportunityId !== opportunityId || prior.resumeId !== input.resumeId) {
      throw new HttpError(409, 'idempotency_key_reused', 'That key was used for another request.');
    }
    // A create interrupted between its insert and its enqueue is retried with the same key:
    // queue the snapshot here too (a no-op while it is queued or running; tl on #131).
    if (prior.status === 'draft' && prior.snapshotState === 'pending') {
      await enqueueSnapshot(db, ctx.userId, prior.id, prior.resumeId);
    }
    return { submission: view(prior), replayed: true };
  };

  const prior = await replay();
  if (prior !== null) return prior;
  // Between the key check and the live check another request with the same key can insert its
  // draft (qa's Postgres race on #124): the live check below must still recognise it as ours.
  await racePoint('submissions.create.keyChecked');

  const opp = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, opportunityId)))
    .get();
  if (opp === undefined) throw notFound();
  const ref = opp.atsJobRef;
  if (ref === null || ref === undefined) throw ineligible('no_ats_identity');
  // The ref stays in place when reconcile or an unconfirm moves the posting to needs_review
  // (jobs/postingReconcile.ts, lib/postingConfirm.ts), so the ref alone is not a confirmed
  // identity: the posting state must say so too.
  if (opp.postingState !== 'confirmed') throw ineligible('posting_not_confirmed');
  if (!(SUBMISSION_ELIGIBLE_STAGES as readonly string[]).includes(opp.stage)) {
    throw ineligible('stage_not_eligible');
  }
  // The destination is only ever stored and shown; it is never fetched. Fuller destination checks
  // (a recognised ATS host, never LinkedIn or Indeed) arrive with the handoff (M1c).
  let destination: URL;
  try {
    destination = new URL(ref.url);
  } catch {
    throw ineligible('destination_not_https');
  }
  if (destination.protocol !== 'https:') throw ineligible('destination_not_https');
  const resume = await finalResume(db, ctx, input.resumeId);

  const live = await liveFor(db, ctx, opportunityId);
  if (live !== undefined) {
    // The live draft may be this key's own, inserted by a concurrent request after the key
    // check above (qa's Postgres race on #124): that is a replay, not a conflict. replay()
    // re-reads by key and still refuses a reused key with a different body.
    if (live.idempotencyKey === input.idempotencyKey) {
      const own = await replay();
      if (own !== null) return own;
    }
    throw liveExists(live);
  }
  // Two creates can both pass the checks above; the unique indexes then decide (test/races).
  await racePoint('submissions.create');

  const now = Date.now();
  try {
    const [row] = await db
      .insert(applicationSubmissions)
      .values({
        id: newId(),
        userId: ctx.userId,
        opportunityId,
        resumeId: resume.id,
        atsKind: ref.kind,
        atsRef: ref.org,
        atsExternalId: ref.externalId,
        destinationUrl: destination.href,
        status: 'draft',
        idempotencyKey: input.idempotencyKey,
        resumeTitle: resume.title,
        resumeStore: resume.store,
        resumeDocRef: resume.docRef,
        snapshotState: 'pending',
        fields: {},
        answers: [],
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const created = row as SubmissionRow;
    // The payload names the attempt and the resume by id; the job reads both from storage.
    await enqueueSnapshot(db, ctx.userId, created.id, resume.id);
    return { submission: view(created), replayed: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost a race: either the same key (a double click) or another live attempt.
    const raced = await replay();
    if (raced !== null) return raced;
    const winner = await liveFor(db, ctx, opportunityId);
    if (winner !== undefined) throw liveExists(winner);
    // The row that won was finished in between (cancelled, say). The race is over: the client
    // retries as for any conflict, rather than seeing the raw driver error as a 500.
    throw new HttpError(409, 'conflict', 'Another request changed this application. Try again.');
  }
}

/** The opportunity's attempts, newest first. Never across opportunities. */
export async function listSubmissionsForOpportunity(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  opts: Pick<ListOpts, 'limit' | 'offset'>,
): Promise<Page<Submission>> {
  const opp = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, opportunityId)))
    .get();
  if (opp === undefined) throw notFound();
  const where = and(
    eq(applicationSubmissions.userId, ctx.userId),
    eq(applicationSubmissions.opportunityId, opportunityId),
  );
  const rows = await db
    .select()
    .from(applicationSubmissions)
    .where(where)
    .orderBy(desc(applicationSubmissions.createdAt), desc(applicationSubmissions.id))
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  return { items: rows.map(view), total: await countWhere(db, applicationSubmissions, where) };
}

export async function getSubmission(db: Db, ctx: UserCtx, id: string): Promise<Submission> {
  return view(await getRow(db, ctx, id));
}

/** 409 naming the row and its current status, so the client can reload it and reconcile. */
export const notNow = (row: SubmissionRow, to: SubmissionStatus): HttpError =>
  new HttpError(
    409,
    'invalid_transition',
    `This application is ${row.status.replace('_', ' ')}, so it cannot be changed that way.`,
    { submissionId: row.id, from: row.status, to },
  );

export interface SubmissionPatch {
  resumeId?: string;
  fields?: SubmissionFields;
  answers?: SubmissionAnswer[];
}

/**
 * Edits a draft, or a reviewed attempt: its resume, fields or answers. An edit after review
 * sends the attempt back to draft and clears the review (M1c, design 4.3), so the next handoff
 * is refused until it is reviewed again; reviewed_at stays, so the daily cap still counts the
 * attempt as reviewed (repos/submissionReview.ts). The update is conditional on the status, so
 * a concurrent change wins cleanly instead of being overwritten.
 */
export async function updateSubmissionDraft(
  db: Db,
  ctx: UserCtx,
  id: string,
  patch: SubmissionPatch,
): Promise<Submission> {
  const updated = await withTransaction(db, async (tx) => {
    // The attempt's lock (repos/submissionReview.ts): a review or handoff in flight checks the
    // row after this edit, or this edit waits until it is done.
    await lockScope(tx, `submission:${id}`);
    const row = await getRow(tx, ctx, id);
    if (row.status !== 'draft' && row.status !== 'reviewed') throw notNow(row, 'draft');
    applySubmissionTransition(row, 'draft');
    const resume = patch.resumeId === undefined ? null : await finalResume(tx, ctx, patch.resumeId);
    const [changed] = await tx
      .update(applicationSubmissions)
      .set({
        ...(resume === null
          ? {}
          : {
              resumeId: resume.id,
              resumeTitle: resume.title,
              resumeStore: resume.store,
              resumeDocRef: resume.docRef,
              // Choosing a resume, the same one included, takes a new snapshot (#115): that is
              // also how the user retries a failed one. The old snapshot's attachment row stays
              // with the opportunity; the attempt no longer points at it.
              resumeAttachmentId: null,
              resumeSha256: null,
              resumeRevision: null,
              snapshotState: 'pending' as const,
              snapshotError: null,
            }),
        ...(patch.fields === undefined ? {} : { fields: patch.fields }),
        ...(patch.answers === undefined ? {} : { answers: patch.answers }),
        status: 'draft',
        reviewDigest: null,
        reviewExpiresAt: null,
        updatedAt: Date.now(),
      })
      .where(and(owned(ctx, id), eq(applicationSubmissions.status, row.status)))
      .returning();
    if (changed === undefined) throw notNow(await getRow(tx, ctx, id), 'draft');
    return changed;
  });
  // After the commit, so the job never runs ahead of the row it reads.
  if (patch.resumeId !== undefined) {
    await enqueueSnapshot(db, ctx.userId, id, updated.resumeId);
  }
  return view(updated);
}

/**
 * Cancels a live attempt (draft, reviewed or handed off): it becomes abandoned, by the user.
 * Cancelling one the user already cancelled returns it unchanged; anything else that cannot be
 * cancelled is a 409 with its current state.
 */
export async function cancelSubmission(db: Db, ctx: UserCtx, id: string): Promise<Submission> {
  return await withTransaction(db, async (tx) => {
    // The attempt's lock (repos/submissionReview.ts): a review or handoff in flight checks the
    // row after this edit, or this edit waits until it is done.
    await lockScope(tx, `submission:${id}`);
    const row = await getRow(tx, ctx, id);
    if (row.status === 'abandoned' && row.failureReason === 'cancelled_by_user') return view(row);
    if (!canSubmissionTransition(row.status, 'abandoned')) throw notNow(row, 'abandoned');
    const [updated] = await tx
      .update(applicationSubmissions)
      .set({ status: 'abandoned', failureReason: 'cancelled_by_user', updatedAt: Date.now() })
      .where(and(owned(ctx, id), eq(applicationSubmissions.status, row.status)))
      .returning();
    if (updated === undefined) throw notNow(await getRow(tx, ctx, id), 'abandoned');
    return view(updated);
  });
}

/**
 * The stored snapshot file of the caller's own attempt, for the download route (#115 criterion
 * 5). Another user's attempt reads exactly like a missing one; an attempt with no snapshot
 * (pending, unsupported, failed, or its attachment deleted) is 404 `no_snapshot`.
 */
export async function getSnapshotForDownload(
  db: Db,
  ctx: UserCtx,
  id: string,
): Promise<typeof attachments.$inferSelect> {
  const row = await getRow(db, ctx, id);
  const file =
    row.resumeAttachmentId === null
      ? undefined
      : await db
          .select()
          .from(attachments)
          .where(
            and(eq(attachments.userId, ctx.userId), eq(attachments.id, row.resumeAttachmentId)),
          )
          .get();
  if (file === undefined) {
    throw new HttpError(404, 'no_snapshot', 'This application has no saved resume file.');
  }
  return file;
}
