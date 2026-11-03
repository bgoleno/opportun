// Resume sends (https://github.com/bgoleno/opportun/issues/158, the owner's option A): which
// resume, base or tailored, was sent for an opportunity, when and how. One row per send, and
// a send never writes the resume row: a base stays the parent its tailored copies point to,
// attached to no opportunity, and can be recorded as sent for any number of them.
//
// The resume's status and submitted_at/submitted_to as every reader sees them come from one
// function here, effectiveSubmission: the later of the resume's newest send and its own stored
// record (the manual "Submitted to..." status control), so neither hides the other (tl's ruling
// on #158). Readers fetch the newest send per resume with latestSends, one query per page.
//
// Locks: `resume:<id>` (resumeScope) is taken before any row write, in the order documented at
// submissionScope (repos/submissionReview.ts): after an attempt's lock, before the user's.
// recordResumeSend and deleteResume take it first; assisted apply's attest takes it right after
// the attempt's lock. So a delete either sees the send and archives, or runs first and the
// send's writer finds the resume gone.
import { newId } from '@opportun/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { lockScope, withTransaction } from '../db/client';
import { companies, opportunities, resumes, resumeSends } from '../db/schema';
import { HttpError, notFound } from '../lib/errors';
import { racePoint } from '../lib/racePoints';
import type { Db, Exec, UserCtx } from './base';
import type { ResumeRow } from './resumes';

export type ResumeSendRow = typeof resumeSends.$inferSelect;

/** The advisory lock a resume's sends and its deletion share. */
export const resumeScope = (resumeId: string): string => `resume:${resumeId}`;

/** How far ahead of the server's clock a user's "when" may be (a browser clock runs fast). */
const CLOCK_SKEW_MS = 60 * 1000;

/** A resume's newest send, as its summary shows it. */
export interface LatestSend {
  sentAt: number;
  /** "<sent_via> / <company>", with the company's name as it is now (tl on #158). */
  submittedTo: string;
}

export interface EffectiveSubmission {
  status: ResumeRow['status'];
  submittedAt: number | null;
  submittedTo: string | null;
}

/**
 * The one derivation of a resume's status and "where and when it was submitted" (FR-R3).
 *
 * Two separate facts (tl on https://github.com/bgoleno/opportun/pull/164): the stored status is
 * the document's workflow state, and a send is a record of where it went. So:
 * - status: a stored `draft` or `in_review` stands, sends or not (a resume sent and then
 *   tailored again has edits nobody has reviewed, and assisted apply must refuse it); a stored
 *   `final` or `submitted` reads `submitted` once the resume has a send;
 * - where and when: whichever is later, the newest send or the stored manual record (the
 *   "Submitted to" control), whatever the status.
 */
export function effectiveSubmission(
  row: Pick<ResumeRow, 'status' | 'submittedAt' | 'submittedTo'>,
  latest: LatestSend | undefined,
): EffectiveSubmission {
  const stored = { status: row.status, submittedAt: row.submittedAt, submittedTo: row.submittedTo };
  if (latest === undefined) return stored;
  const status = row.status === 'draft' || row.status === 'in_review' ? row.status : 'submitted';
  if (row.submittedAt !== null && row.submittedAt > latest.sentAt) return { ...stored, status };
  return { status, submittedAt: latest.sentAt, submittedTo: latest.submittedTo };
}

/**
 * The newest send of each of these resumes, in one query: every send of theirs, newest first,
 * keeping the first per resume. A page of resumes is at most 200, and each one's sends are
 * the user's own applications, so the rows read stay small.
 */
export async function latestSends(
  exec: Exec,
  ctx: UserCtx,
  resumeIds: readonly string[],
): Promise<Map<string, LatestSend>> {
  const latest = new Map<string, LatestSend>();
  if (resumeIds.length === 0) return latest;
  const rows = await exec
    .select({
      resumeId: resumeSends.resumeId,
      sentAt: resumeSends.sentAt,
      sentVia: resumeSends.sentVia,
      company: companies.name,
    })
    .from(resumeSends)
    .innerJoin(opportunities, eq(opportunities.id, resumeSends.opportunityId))
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(and(eq(resumeSends.userId, ctx.userId), inArray(resumeSends.resumeId, [...resumeIds])))
    .orderBy(desc(resumeSends.sentAt), desc(resumeSends.createdAt), desc(resumeSends.id))
    .all();
  for (const r of rows) {
    if (latest.has(r.resumeId)) continue;
    latest.set(r.resumeId, { sentAt: r.sentAt, submittedTo: `${r.sentVia} / ${r.company}` });
  }
  return latest;
}

/** Whether a resume has any send; callers hold resumeScope when they act on the answer. */
export async function hasSend(exec: Exec, ctx: UserCtx, resumeId: string): Promise<boolean> {
  const row = await exec
    .select({ id: resumeSends.id })
    .from(resumeSends)
    .where(and(eq(resumeSends.userId, ctx.userId), eq(resumeSends.resumeId, resumeId)))
    .limit(1)
    .get();
  return row !== undefined;
}

/** A send as the opportunity and resume pages list it. */
export interface ResumeSendListed {
  id: string;
  opportunityId: string;
  opportunityTitle: string;
  companyName: string;
  resumeId: string;
  resumeTitle: string;
  resumeKind: ResumeRow['kind'];
  sentAt: number;
  sentVia: string;
  submissionId: string | null;
  createdAt: number;
}

async function listWhere(
  exec: Exec,
  ctx: UserCtx,
  by: { opportunityId: string } | { resumeId: string },
): Promise<ResumeSendListed[]> {
  return await exec
    .select({
      id: resumeSends.id,
      opportunityId: resumeSends.opportunityId,
      opportunityTitle: opportunities.title,
      companyName: companies.name,
      resumeId: resumeSends.resumeId,
      resumeTitle: resumes.title,
      resumeKind: resumes.kind,
      sentAt: resumeSends.sentAt,
      sentVia: resumeSends.sentVia,
      submissionId: resumeSends.submissionId,
      createdAt: resumeSends.createdAt,
    })
    .from(resumeSends)
    .innerJoin(opportunities, eq(opportunities.id, resumeSends.opportunityId))
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .innerJoin(resumes, eq(resumes.id, resumeSends.resumeId))
    .where(
      and(
        eq(resumeSends.userId, ctx.userId),
        'opportunityId' in by
          ? eq(resumeSends.opportunityId, by.opportunityId)
          : eq(resumeSends.resumeId, by.resumeId),
      ),
    )
    .orderBy(desc(resumeSends.sentAt), desc(resumeSends.createdAt), desc(resumeSends.id))
    .all();
}

export async function listOpportunitySends(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
): Promise<ResumeSendListed[]> {
  await ownedOpportunity(db, ctx, opportunityId);
  return await listWhere(db, ctx, { opportunityId });
}

export async function listResumeSends(
  db: Db,
  ctx: UserCtx,
  resumeId: string,
): Promise<ResumeSendListed[]> {
  await ownedResume(db, ctx, resumeId);
  return await listWhere(db, ctx, { resumeId });
}

async function ownedOpportunity(exec: Exec, ctx: UserCtx, id: string): Promise<void> {
  const row = await exec
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, id)))
    .get();
  // Another user's opportunity reads exactly like a missing one.
  if (row === undefined) throw notFound();
}

async function ownedResume(exec: Exec, ctx: UserCtx, id: string): Promise<ResumeRow> {
  const row = await exec
    .select()
    .from(resumes)
    .where(and(eq(resumes.userId, ctx.userId), eq(resumes.id, id)))
    .get();
  if (row === undefined) throw notFound();
  return row;
}

export interface RecordSendInput {
  resumeId: string;
  sentVia: string;
  /** When it was sent, if not now; never in the future. */
  sentAt?: number | undefined;
}

/**
 * "I sent this resume for this opportunity": one new row, and nothing else changes. Any of the
 * user's resumes that is not archived, base or tailored, attached anywhere or nowhere.
 */
export async function recordResumeSend(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  input: RecordSendInput,
): Promise<ResumeSendListed> {
  const now = Date.now();
  const sentAt = input.sentAt ?? now;
  if (sentAt > now + CLOCK_SKEW_MS) {
    throw new HttpError(422, 'sent_at_in_future', 'That time has not happened yet.');
  }
  // Ownership first, outside any lock: another user's resume is a 404 and takes no lock in
  // their scope (sec on #164; #129's rule for the submission routes).
  await ownedResume(db, ctx, input.resumeId);
  const id = await withTransaction(db, async (tx) => {
    await lockScope(tx, resumeScope(input.resumeId));
    // Read under the lock: a delete that went first has removed it, and this is a 404.
    const resume = await ownedResume(tx, ctx, input.resumeId);
    if (resume.archivedAt !== null) {
      throw new HttpError(422, 'resume_archived', 'An archived resume cannot be recorded as sent.');
    }
    await ownedOpportunity(tx, ctx, opportunityId);
    await racePoint('resumeSends.record.locked');
    return await insertSend(tx, ctx, {
      opportunityId,
      resumeId: resume.id,
      sentAt,
      sentVia: input.sentVia,
      submissionId: null,
    });
  });
  const listed = (await listWhere(db, ctx, { opportunityId })).find((s) => s.id === id);
  // Only a concurrent delete of the opportunity or resume, after this committed, gets here.
  if (listed === undefined) throw notFound();
  return listed;
}

/**
 * The row insert every send goes through. The caller holds resumeScope(resumeId) and has read
 * the resume and the opportunity as the user's own in the same transaction.
 */
export async function insertSend(
  tx: Exec,
  ctx: UserCtx,
  input: Pick<ResumeSendRow, 'opportunityId' | 'resumeId' | 'sentAt' | 'sentVia' | 'submissionId'>,
): Promise<string> {
  const id = newId();
  await tx
    .insert(resumeSends)
    .values({ ...input, id, userId: ctx.userId, createdAt: Date.now() })
    .run();
  return id;
}

/** Removes one send of this opportunity; the resume is untouched. A second remove is a 404. */
export async function removeResumeSend(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  sendId: string,
): Promise<void> {
  const gone = await db
    .delete(resumeSends)
    .where(
      and(
        eq(resumeSends.userId, ctx.userId),
        eq(resumeSends.opportunityId, opportunityId),
        eq(resumeSends.id, sendId),
      ),
    )
    .returning({ id: resumeSends.id })
    .get();
  if (gone === undefined) throw notFound();
}
