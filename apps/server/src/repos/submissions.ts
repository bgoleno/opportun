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
  type SubmissionStatus,
} from '@opportun/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { isUniqueViolation, withTransaction } from '../db/client';
import { applicationSubmissions, opportunities, resumes } from '../db/schema';
import { HttpError, notFound } from '../lib/errors';
import type { Db, Exec, UserCtx } from './base';
import { countWhere, type ListOpts, type Page } from './list';

type SubmissionRow = typeof applicationSubmissions.$inferSelect;

/** An opportunity can start an attempt only at these stages (#114 criterion 1). */
export const SUBMISSION_ELIGIBLE_STAGES = ['interested', 'preparing', 'applied'] as const;

/** Why an opportunity, or the chosen resume, cannot start an attempt: the 422 codes. */
export type IneligibleReason =
  | 'no_ats_identity'
  | 'stage_not_eligible'
  | 'destination_not_https'
  | 'resume_not_found'
  | 'resume_not_final';

const INELIGIBLE_MESSAGES = new Map<IneligibleReason, string>([
  [
    'no_ats_identity',
    "This opportunity is not linked to a posting on the company's own job board yet.",
  ],
  ['stage_not_eligible', 'Applying is available at Interested, Preparing or Applied.'],
  ['destination_not_https', "The posting's address is not https."],
  ['resume_not_found', 'That resume was not found.'],
  ['resume_not_final', 'Choose a resume marked final.'],
]);

/** 422 with the reason as its code (the message is server-side context; clients map codes). */
const ineligible = (reason: IneligibleReason): HttpError =>
  new HttpError(422, reason, INELIGIBLE_MESSAGES.get(reason));

/** The live statuses, as the partial unique index names them. */
const LIVE: SubmissionStatus[] = ['draft', 'reviewed', 'handed_off'];

function view(row: SubmissionRow): Submission {
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
    fields: row.fields,
    answers: row.answers,
    reviewExpiresAt: row.reviewExpiresAt,
    reviewedAt: row.reviewedAt,
    handedOffAt: row.handedOffAt,
    submittedAt: row.submittedAt,
    confirmedAt: row.confirmedAt,
    confirmationKind: row.confirmationKind,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const owned = (ctx: UserCtx, id: string) =>
  and(eq(applicationSubmissions.userId, ctx.userId), eq(applicationSubmissions.id, id));

async function getRow(exec: Exec, ctx: UserCtx, id: string): Promise<SubmissionRow> {
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
  if (resume.status !== 'final') throw ineligible('resume_not_final');
  return resume;
}

export interface CreateDraftInput {
  idempotencyKey: string;
  resumeId: string;
}

/**
 * Starts a draft for one opportunity, or returns the one this key already created
 * (`replayed`). Eligible (#114 criterion 1): the opportunity has an ATS identity (a confirmed
 * posting on the company's own board), is at Interested, Preparing or Applied, and the resume is
 * the caller's and marked final. One live attempt per opportunity: the partial unique index
 * enforces it, and the check here only turns it into a readable 409.
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
    // A key belongs to one attempt; reusing it for another opportunity is a client bug.
    if (prior.opportunityId !== opportunityId) {
      throw new HttpError(
        409,
        'idempotency_key_reused',
        'That key was used for another application.',
      );
    }
    return { submission: view(prior), replayed: true };
  };

  const prior = await replay();
  if (prior !== null) return prior;

  const opp = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, opportunityId)))
    .get();
  if (opp === undefined) throw notFound();
  const ref = opp.atsJobRef;
  if (ref === null || ref === undefined) throw ineligible('no_ats_identity');
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
  if (live !== undefined) throw liveExists(live);

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
        fields: {},
        answers: [],
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { submission: view(row as SubmissionRow), replayed: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost a race: either the same key (a double click) or another live attempt.
    const raced = await replay();
    if (raced !== null) return raced;
    const winner = await liveFor(db, ctx, opportunityId);
    if (winner !== undefined) throw liveExists(winner);
    throw err;
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
const notNow = (row: SubmissionRow, to: SubmissionStatus): HttpError =>
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
 * Edits a draft: its resume, fields or answers. M1a allows edits only while it is a draft (a
 * reviewed attempt returning to draft on edit arrives with the review gate, M1c). The update is
 * conditional on the status, so a concurrent change wins cleanly instead of being overwritten.
 */
export async function updateSubmissionDraft(
  db: Db,
  ctx: UserCtx,
  id: string,
  patch: SubmissionPatch,
): Promise<Submission> {
  return await withTransaction(db, async (tx) => {
    const row = await getRow(tx, ctx, id);
    if (row.status !== 'draft') throw notNow(row, 'draft');
    applySubmissionTransition(row, 'draft');
    const resume = patch.resumeId === undefined ? null : await finalResume(tx, ctx, patch.resumeId);
    const [updated] = await tx
      .update(applicationSubmissions)
      .set({
        ...(resume === null
          ? {}
          : {
              resumeId: resume.id,
              resumeTitle: resume.title,
              resumeStore: resume.store,
              resumeDocRef: resume.docRef,
              // A different resume invalidates any snapshot of the previous one (M1b).
              resumeAttachmentId: null,
              resumeSha256: null,
              resumeRevision: null,
            }),
        ...(patch.fields === undefined ? {} : { fields: patch.fields }),
        ...(patch.answers === undefined ? {} : { answers: patch.answers }),
        reviewDigest: null,
        updatedAt: Date.now(),
      })
      .where(and(owned(ctx, id), eq(applicationSubmissions.status, 'draft')))
      .returning();
    if (updated === undefined) throw notNow(await getRow(tx, ctx, id), 'draft');
    return view(updated);
  });
}

/**
 * Cancels a live attempt (draft, reviewed or handed off): it becomes abandoned, by the user.
 * Cancelling one the user already cancelled returns it unchanged; anything else that cannot be
 * cancelled is a 409 with its current state.
 */
export async function cancelSubmission(db: Db, ctx: UserCtx, id: string): Promise<Submission> {
  return await withTransaction(db, async (tx) => {
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
