// Confirmation email matching, the wiring (assisted apply M2b,
// https://github.com/bgoleno/opportun/issues/119; design Part A 5.3, tl's cut on #119).
//
// Mail ingest (jobs/mailIngest.ts) reads the candidates before its transaction, runs the pure
// matcher (lib/submissionMatch.ts), and on a single match calls confirmFromEmail inside the
// transaction that stores the message, after taking the attempt's lock first. The body is read
// there and never stored: what an attempt keeps is the message's id and the names of the signals
// that matched (NFR-PRV5). An email confirmation changes no stage, and the user can undo it
// (unlinkConfirmation): signal B is the sender's unauthenticated address (sec on #128).
import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { lockScope, withTransaction } from '../db/client';
import {
  applicationSubmissions,
  communications,
  companies,
  nextSteps,
  opportunities,
} from '../db/schema';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';
import {
  CONFIRMATION_SKEW_MS,
  CONFIRMATION_WINDOW_MS,
  type ConfirmationCandidate,
  type ConfirmationSignal,
} from '../lib/submissionMatch';
import { senderAddress } from '../adapters/sources/alertEmail';
import type { Db, Exec, UserCtx } from './base';
import { submissionScope } from './submissionReview';
import { getRow, notNow, owned, view, type SubmissionRow } from './submissions';
import type { Submission } from '@opportun/core';

/** The attempts an email may confirm: submitted or with no confirmation seen. */
const AWAITING = ['submitted', 'unknown'] as const;

/** What an email confirmation stores: signal names, and whether it linked the message. */
export interface EmailConfirmationBasis {
  signals: ConfirmationSignal[];
  /** True when this confirmation set the message's opportunity, so an unlink clears it. */
  linkedMessage: boolean;
}

function emailBasis(value: unknown): EmailConfirmationBasis | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<EmailConfirmationBasis>;
  if (!Array.isArray(v.signals)) return null;
  return { signals: v.signals, linkedMessage: v.linkedMessage === true };
}

/**
 * The user's attempts awaiting a confirmation whose window (D) covers a message sent at
 * `sentAt`: submitted no later than 5 minutes after it and no earlier than 14 days before it.
 * One query, read before ingest's transaction; confirmFromEmail re-checks the status under the
 * attempt's lock.
 */
export async function confirmationCandidates(
  exec: Exec,
  ctx: UserCtx,
  sentAt: number,
): Promise<ConfirmationCandidate[]> {
  const rows = await exec
    .select({
      id: applicationSubmissions.id,
      atsKind: applicationSubmissions.atsKind,
      atsRef: applicationSubmissions.atsRef,
      atsExternalId: applicationSubmissions.atsExternalId,
      submittedAt: applicationSubmissions.submittedAt,
      roleTitle: opportunities.title,
      companyName: companies.name,
      companyDomain: companies.domain,
    })
    .from(applicationSubmissions)
    .innerJoin(opportunities, eq(opportunities.id, applicationSubmissions.opportunityId))
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(
      and(
        eq(applicationSubmissions.userId, ctx.userId),
        inArray(applicationSubmissions.status, [...AWAITING]),
        lte(applicationSubmissions.submittedAt, sentAt + CONFIRMATION_SKEW_MS),
        gte(applicationSubmissions.submittedAt, sentAt - CONFIRMATION_WINDOW_MS),
      ),
    )
    .all();
  return rows.flatMap((r) =>
    r.submittedAt === null ? [] : [{ ...r, submittedAt: r.submittedAt }],
  );
}

/**
 * Confirms one attempt from a matched email, inside ingest's transaction. The caller has taken
 * `submission:<id>` before anything else in that transaction (the order at submissionScope).
 * Returns false, writing nothing, when the attempt no longer awaits a confirmation (the user
 * recorded an outcome first): then the message is not linked either (tl on #119).
 */
export async function confirmFromEmail(
  tx: Exec,
  ctx: UserCtx,
  submissionId: string,
  communicationId: string,
  signals: ConfirmationSignal[],
  now: number,
): Promise<boolean> {
  const current = await tx
    .select()
    .from(applicationSubmissions)
    .where(owned(ctx, submissionId))
    .get();
  if (current === undefined || !(AWAITING as readonly string[]).includes(current.status)) {
    return false;
  }
  const basis: EmailConfirmationBasis = { signals: [...signals], linkedMessage: false };
  const [updated] = await tx
    .update(applicationSubmissions)
    .set({
      status: 'confirmed',
      confirmedAt: now,
      confirmationKind: 'email',
      confirmationCommId: communicationId,
      confirmationBasis: basis,
      updatedAt: now,
    })
    .where(and(owned(ctx, submissionId), eq(applicationSubmissions.status, current.status)))
    .returning();
  if (updated === undefined) return false;
  // The message joins the opportunity's timeline, unless the user or the classifier already put
  // it somewhere: a confirmation never moves a message.
  const linked = await tx
    .update(communications)
    .set({ opportunityId: current.opportunityId, updatedAt: now })
    .where(
      and(
        eq(communications.userId, ctx.userId),
        eq(communications.id, communicationId),
        isNull(communications.opportunityId),
      ),
    )
    .returning({ id: communications.id })
    .get();
  if (linked !== undefined) {
    await tx
      .update(applicationSubmissions)
      .set({ confirmationBasis: { ...basis, linkedMessage: true } })
      .where(owned(ctx, submissionId))
      .run();
  }
  // The follow-up's "Check whether…" step has its answer (#148's rule): done if still open; a
  // step the user completed keeps its own time.
  if (current.followupNextStepId !== null) {
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
  await audit(tx, 'submission.confirmed', {
    userId: ctx.userId,
    detail: {
      submissionId,
      opportunityId: current.opportunityId,
      from: current.status,
      kind: 'email',
      communicationId,
      signals: [...signals],
    },
  });
  return true;
}

/**
 * "Not this application": an email confirmation undone (#119 criterion 5). Only an attempt an
 * email confirmed; it returns to `submitted`, its confirmation fields cleared, and the message
 * leaves the opportunity's timeline only if this confirmation put it there.
 */
export async function unlinkConfirmation(db: Db, ctx: UserCtx, id: string): Promise<Submission> {
  await getRow(db, ctx, id); // another user's id is a 404 and takes no lock
  const row = await withTransaction(db, async (tx) => {
    await lockScope(tx, submissionScope(id));
    const current = await getRow(tx, ctx, id);
    if (current.status !== 'confirmed' || current.confirmationKind !== 'email') {
      throw new HttpError(
        409,
        'not_email_confirmed',
        'Only an application confirmed by an email can be unlinked from it.',
        { submissionId: id, status: current.status },
      );
    }
    const now = Date.now();
    const [updated] = await tx
      .update(applicationSubmissions)
      .set({
        status: 'submitted',
        confirmedAt: null,
        confirmationKind: null,
        confirmationCommId: null,
        confirmationBasis: null,
        updatedAt: now,
      })
      .where(and(owned(ctx, id), eq(applicationSubmissions.status, 'confirmed')))
      .returning();
    if (updated === undefined) throw notNow(await getRow(tx, ctx, id), 'submitted');
    const basis = emailBasis(current.confirmationBasis);
    let unlinkedMessage = false;
    if (basis?.linkedMessage === true && current.confirmationCommId !== null) {
      const cleared = await tx
        .update(communications)
        .set({ opportunityId: null, updatedAt: now })
        .where(
          and(
            eq(communications.userId, ctx.userId),
            eq(communications.id, current.confirmationCommId),
            eq(communications.opportunityId, current.opportunityId),
          ),
        )
        .returning({ id: communications.id })
        .get();
      unlinkedMessage = cleared !== undefined;
    }
    await audit(tx, 'submission.confirmation_unlinked', {
      userId: ctx.userId,
      detail: {
        submissionId: id,
        opportunityId: current.opportunityId,
        communicationId: current.confirmationCommId,
        unlinkedMessage,
      },
    });
    return updated;
  });
  return await detailView(db, ctx, row);
}

/**
 * GET /submissions/:id's view: the attempt, and for an email confirmation what its evidence card
 * shows (subject, the sender's address without its display name, when, which signals).
 */
export async function detailView(
  exec: Exec,
  ctx: UserCtx,
  row: SubmissionRow,
): Promise<Submission> {
  const base = view(row);
  if (row.confirmationKind !== 'email' || row.confirmationCommId === null) {
    return { ...base, confirmationEmail: null };
  }
  const message = await exec
    .select({
      id: communications.id,
      subject: communications.subject,
      from: communications.from,
      sentAt: communications.sentAt,
    })
    .from(communications)
    .where(
      and(eq(communications.userId, ctx.userId), eq(communications.id, row.confirmationCommId)),
    )
    .get();
  if (message === undefined) return { ...base, confirmationEmail: null };
  return {
    ...base,
    confirmationEmail: {
      communicationId: message.id,
      subject: message.subject,
      fromAddress: senderAddress(message.from),
      sentAt: message.sentAt,
      signals: emailBasis(row.confirmationBasis)?.signals ?? [],
    },
  };
}
