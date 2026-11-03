// What happens after the handoff (assisted apply M2a, https://github.com/bgoleno/opportun/issues/118;
// design Part A 3.3 steps 8 to 10, 4.3, 5.2, 5.5). Opportun never transmits an application and
// never learns on its own whether one was sent: the user says so ("I submitted it"), and says
// what the ATS did. This records those words, once, and what follows from them:
//
// - attest: handed_off -> submitted. In one transaction under the attempt's lock: one
//   `application` timeline entry (resume and answered question labels, never field values), the
//   resume's submitted record (FR-R3), and, only when the user left "Move to Applied" ticked, the
//   stage change. A repeat, or a second attest racing the first, changes nothing more.
// - outcome: the user's report of what happened next (confirmed by them, refused by the ATS, or a
//   problem before submitting), each a note on the timeline except the last.
// - follow-up: a submitted attempt with no confirmation after FOLLOWUP_MS becomes `unknown`, with a
//   next step for the user. Nothing is retried, resubmitted or sent.
import {
  canSubmissionTransition,
  canTransition,
  type OpportunityStage,
  type Submission,
  type SubmissionStatus,
} from '@opportun/core';
import { and, eq, isNull, lte } from 'drizzle-orm';
import { lockScope, withTransaction } from '../db/client';
import { applicationSubmissions, companies, nextSteps, opportunities, resumes } from '../db/schema';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';
import { racePoint } from '../lib/racePoints';
import { createActivity, createNextStep } from './activities';
import type { Db, Exec, UserCtx } from './base';
import { afterStageChange, transitionOpportunityIn, type OpportunityView } from './opportunities';
import { updateResume } from './resumes';
import { submissionScope } from './submissionReview';
import { getRow, notNow, owned, view, type SubmissionRow } from './submissions';

/** How long after "I submitted it" a missing confirmation becomes a next step (design 5.5). */
export const FOLLOWUP_MS = 3 * 24 * 60 * 60 * 1000;
/** A submitted time may be this far ahead of the server's clock (the browser's clock differs). */
const CLOCK_SKEW_MS = 60 * 1000;

const ATS_NAMES = new Map<string, string>([
  ['ats_greenhouse', 'Greenhouse'],
  ['ats_lever', 'Lever'],
  ['ats_ashby', 'Ashby'],
  ['ats_workday', 'Workday'],
]);
const atsName = (kind: string): string => ATS_NAMES.get(kind) ?? 'the ATS';

/** Stages before Applied in the pipeline: only these move on the user's "Move to Applied". */
const BEFORE_APPLIED: readonly OpportunityStage[] = ['interested', 'preparing'];

/** The opportunity's facts the timeline entry and the next step name. */
async function opportunityFacts(exec: Exec, ctx: UserCtx, opportunityId: string) {
  const row = await exec
    .select({ title: opportunities.title, stage: opportunities.stage, company: companies.name })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, opportunityId)))
    .get();
  if (row === undefined) throw new HttpError(404, 'not_found');
  return row;
}

/**
 * The application entry's body: what was sent, by name only. Field values stay on the attempt;
 * the timeline says which fields were filled and which questions were answered.
 */
function applicationBody(row: SubmissionRow): string {
  const resume =
    row.resumeTitle === null
      ? null
      : row.resumeSha256 === null
        ? `Resume: ${row.resumeTitle}, attached by you (no saved copy).`
        : `Resume: ${row.resumeTitle} (${row.resumeSha256.slice(0, 8)}), saved copy attached.`;
  const fieldNames = Object.keys(row.fields);
  const answered = row.answers.map((a) => `"${a.label}"`);
  return [
    resume,
    fieldNames.length === 0 ? null : `Filled in: ${fieldNames.join(', ')}.`,
    answered.length === 0 ? null : `Answered: ${answered.join(', ')}.`,
    row.reapplyReason === null ? null : `Applied again: ${row.reapplyReason}`,
    'Basis: you reported submitting this.',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

export interface AttestInput {
  /** Leave the opportunity's stage alone unless the user left this ticked (owner decision 3). */
  moveToApplied: boolean;
  /** When the user submitted, if not now; never in the future. */
  submittedAt?: number | undefined;
}

/**
 * "I submitted it": the user's word, recorded once. Allowed from handed_off only; a repeat on an
 * attempt this already recorded answers it unchanged, and creates nothing.
 */
export async function attestSubmission(
  db: Db,
  ctx: UserCtx,
  id: string,
  input: AttestInput,
): Promise<Submission> {
  // Ownership first, outside any lock: another user's id is a 404 and takes no lock.
  await getRow(db, ctx, id);
  const now = Date.now();
  const submittedAt = input.submittedAt ?? now;
  if (submittedAt > now + CLOCK_SKEW_MS) {
    throw new HttpError(422, 'submitted_at_in_future', 'That time has not happened yet.');
  }
  // Every caller before its transaction (test: two concurrent attests record one application).
  await racePoint('submissions.attest');

  const done = await withTransaction(db, async (tx) => {
    await lockScope(tx, submissionScope(id));
    const row = await getRow(tx, ctx, id);
    if (row.submittedActivityId !== null && row.status !== 'handed_off') {
      return { row, moved: null as OpportunityView | null };
    }
    if (row.status !== 'handed_off') throw notNow(row, 'submitted');
    // Not before the form was opened (tl on #145): the browser's clock may run a little behind.
    if (row.handedOffAt !== null && submittedAt < row.handedOffAt - CLOCK_SKEW_MS) {
      throw new HttpError(
        422,
        'submitted_at_before_handoff',
        'That is before you opened the form. Choose when you pressed Submit.',
      );
    }
    const opp = await opportunityFacts(tx, ctx, row.opportunityId);
    const entry = await createActivity(tx, ctx, row.opportunityId, {
      kind: 'application',
      title: `Applied via ${atsName(row.atsKind)}: ${opp.title}`,
      bodyMd: applicationBody(row),
      occurredAt: submittedAt,
      participants: [],
      externalUrl: row.destinationUrl,
    });
    // The resume's own record (FR-R3). One already submitted elsewhere stays as it is: the
    // per-application fact is this attempt's, not the resume's.
    if (row.resumeId !== null) {
      const resume = await tx
        .select({ status: resumes.status })
        .from(resumes)
        .where(and(eq(resumes.userId, ctx.userId), eq(resumes.id, row.resumeId)))
        .get();
      if (resume !== undefined && resume.status !== 'submitted') {
        await updateResume(tx, ctx, row.resumeId, {
          status: 'submitted',
          submittedTo: `${atsName(row.atsKind)} / ${opp.company}`,
          submittedAt,
        });
      }
    }
    const [updated] = await tx
      .update(applicationSubmissions)
      .set({
        status: 'submitted',
        submittedAt,
        submittedBasis: 'user_attested',
        submittedActivityId: entry.id,
        updatedAt: now,
      })
      .where(and(owned(ctx, id), eq(applicationSubmissions.status, 'handed_off')))
      .returning();
    // Unreachable while every writer takes the attempt's lock; kept as a guard.
    if (updated === undefined) throw notNow(await getRow(tx, ctx, id), 'submitted');
    // Stages never change silently (FR-M2): only on the user's tick, and only forward.
    let moved: OpportunityView | null = null;
    if (
      input.moveToApplied &&
      BEFORE_APPLIED.includes(opp.stage) &&
      canTransition(opp.stage, 'applied')
    ) {
      moved = await transitionOpportunityIn(tx, ctx, row.opportunityId, {
        to: 'applied',
        note: 'Applied via assisted submission',
      });
    }
    await audit(tx, 'submission.attested', {
      userId: ctx.userId,
      detail: {
        submissionId: id,
        opportunityId: row.opportunityId,
        atsKind: row.atsKind,
        movedToApplied: moved !== null,
      },
    });
    return { row: updated, moved };
  });
  if (done.moved !== null) await afterStageChange(db, ctx, done.moved);
  return view(done.row);
}

/** What the user reports after the handoff (design 6.1 `outcome`). */
export const SUBMISSION_OUTCOMES = ['confirmed_by_user', 'ats_refused', 'failed'] as const;
export type SubmissionOutcome = (typeof SUBMISSION_OUTCOMES)[number];

const OUTCOME_TARGET = new Map<SubmissionOutcome, SubmissionStatus>([
  ['confirmed_by_user', 'confirmed'],
  ['ats_refused', 'rejected'],
  ['failed', 'failed'],
]);

/** Whether `row` already records this outcome, so a repeat answers it unchanged. */
function alreadyRecorded(row: SubmissionRow, outcome: SubmissionOutcome): boolean {
  if (outcome === 'confirmed_by_user') {
    return row.status === 'confirmed' && row.confirmationKind === 'user';
  }
  return row.status === OUTCOME_TARGET.get(outcome);
}

/**
 * The user's report of what happened: they saw a confirmation (submitted or unknown ->
 * confirmed, with no evidence attached, and the timeline says so), the ATS refused the form
 * (-> rejected; the stage is not changed), or something went wrong before submitting
 * (handed_off -> failed; audit only, not an application event). The state machine decides which
 * report fits which status.
 */
export async function recordSubmissionOutcome(
  db: Db,
  ctx: UserCtx,
  id: string,
  input: { outcome: SubmissionOutcome; note?: string | undefined },
): Promise<Submission> {
  await getRow(db, ctx, id);
  const to = OUTCOME_TARGET.get(input.outcome) as SubmissionStatus;
  const note = input.note?.trim() ?? '';
  const row = await withTransaction(db, async (tx) => {
    await lockScope(tx, submissionScope(id));
    // Tests hold an outcome here against an email confirmation of the same attempt (#119).
    await racePoint('submissions.outcome.locked');
    const current = await getRow(tx, ctx, id);
    if (alreadyRecorded(current, input.outcome)) return current;
    if (!canSubmissionTransition(current.status, to)) throw notNow(current, to);
    const now = Date.now();
    let activityId: string | null = null;
    if (input.outcome === 'confirmed_by_user') {
      activityId = (
        await createActivity(tx, ctx, current.opportunityId, {
          kind: 'note',
          title: 'Marked confirmed by you (no evidence attached)',
          bodyMd: note,
          occurredAt: now,
          participants: [],
          externalUrl: null,
        })
      ).id;
    } else if (input.outcome === 'ats_refused') {
      await createActivity(tx, ctx, current.opportunityId, {
        kind: 'note',
        title: 'The application site refused the form',
        bodyMd: [note, 'Your stage was not changed.'].filter((l) => l !== '').join('\n'),
        occurredAt: now,
        participants: [],
        externalUrl: null,
      });
    }
    const [updated] = await tx
      .update(applicationSubmissions)
      .set({
        status: to,
        ...(input.outcome === 'confirmed_by_user'
          ? {
              confirmedAt: now,
              confirmationKind: 'user' as const,
              confirmationActivityId: activityId,
            }
          : {}),
        ...(input.outcome === 'failed' ? { failureReason: 'other' as const } : {}),
        updatedAt: now,
      })
      .where(and(owned(ctx, id), eq(applicationSubmissions.status, current.status)))
      .returning();
    if (updated === undefined) throw notNow(await getRow(tx, ctx, id), to);
    // The follow-up's "Check whether…" step has its answer now (#148, tl's design): mark it done,
    // in this transaction. Only if it is still there and still open: a step the user completed
    // keeps its own time, and a deleted one cleared the link (ON DELETE SET NULL).
    if (
      (input.outcome === 'confirmed_by_user' || input.outcome === 'ats_refused') &&
      current.followupNextStepId !== null
    ) {
      await tx
        .update(nextSteps)
        .set({ doneAt: now, updatedAt: now })
        .where(
          and(
            eq(nextSteps.id, current.followupNextStepId),
            eq(nextSteps.userId, ctx.userId),
            isNull(nextSteps.doneAt),
          ),
        )
        .run();
    }
    await audit(tx, `submission.${input.outcome === 'ats_refused' ? 'refused_by_ats' : to}`, {
      userId: ctx.userId,
      detail: {
        submissionId: id,
        opportunityId: current.opportunityId,
        from: current.status,
        ...(input.outcome === 'confirmed_by_user' ? { kind: 'user' } : {}),
      },
    });
    return updated;
  });
  return view(row);
}

/**
 * The follow-up (design 5.5): every attempt the user submitted more than FOLLOWUP_MS ago with no
 * confirmation becomes `unknown`, never "failed", and the user gets a next step to check. One
 * attempt at a time, each in its own conditional update under its lock; nothing is retried,
 * resubmitted or sent, and no one is contacted. Returns how many it marked.
 */
export async function followUpSubmissions(db: Db, now: number = Date.now()): Promise<number> {
  const cutoff = now - FOLLOWUP_MS;
  const due = await db
    .select({ id: applicationSubmissions.id, userId: applicationSubmissions.userId })
    .from(applicationSubmissions)
    .where(
      and(
        eq(applicationSubmissions.status, 'submitted'),
        lte(applicationSubmissions.submittedAt, cutoff),
      ),
    )
    .all();
  let marked = 0;
  for (const { id, userId } of due) {
    const ctx: UserCtx = { userId, isAdmin: false };
    const changed = await withTransaction(db, async (tx) => {
      await lockScope(tx, submissionScope(id));
      const [updated] = await tx
        .update(applicationSubmissions)
        .set({ status: 'unknown', updatedAt: now })
        .where(
          and(
            owned(ctx, id),
            eq(applicationSubmissions.status, 'submitted'),
            lte(applicationSubmissions.submittedAt, cutoff),
          ),
        )
        .returning();
      // Confirmed, reported or cancelled meanwhile: nothing to follow up.
      if (updated === undefined) return false;
      const opp = await opportunityFacts(tx, ctx, updated.opportunityId);
      const step = await createNextStep(tx, ctx, updated.opportunityId, {
        action: `Check whether your application to ${opp.company} was received`,
        dueAt: now,
        owner: 'you',
      });
      // Linked to the attempt, so recording an outcome can close it (#148).
      await tx
        .update(applicationSubmissions)
        .set({ followupNextStepId: step.id })
        .where(owned(ctx, id))
        .run();
      await audit(tx, 'submission.unknown', {
        userId,
        detail: { submissionId: id, opportunityId: updated.opportunityId },
      });
      return true;
    });
    if (changed) marked += 1;
  }
  return marked;
}
