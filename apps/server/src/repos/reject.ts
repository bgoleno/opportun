// Reject as out of scope (spec D4).
//
// Brian: "I don't want to track it in 'dismissed', I want to kick it out altogether."
// `dismissed` is a pipeline state meaning considered and declined. Rejection means the thing
// should never have been in scope, so the two must not share a bucket: dismissing teaches the
// ranker, rejecting teaches the filter.
//
// What survives is the minimum that stops the next sync bringing it back — sender, date, and
// the provider's id — plus the reason code. What goes is everything that says what the message
// was about: subject, snippet, body, and the search-index rows that would otherwise keep the
// text findable after the row stopped showing it.
import { senderAddress } from '../lib/mailAddress';
import { invalidateTriageContext } from '../lib/triageContext';
import { newId, parseMailPattern } from '@opportun/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { withTransaction } from '../db/client';
import { communications, dismissalFeedback } from '../db/schema';
import type { RejectionReason } from '../db/schema.shared';
import { HttpError } from '../lib/errors';
import { racePoint } from '../lib/racePoints';
import { createRule, updateRule } from './mailFilters';
import type { UserCtx } from './base';
import { removeFromIndex } from './search';

export interface RejectInput {
  reason: RejectionReason;
  /** Shown to the user, never sent anywhere unless `shareNote` is set. */
  note?: string | null | undefined;
  /** Opts this ONE note in to prompt refinement. Off by default. */
  shareNote?: boolean | undefined;
  /** Add a deny rule so this sender is never fetched again. */
  neverIngest?: 'address' | 'domain' | undefined;
  /**
   * The opportunity the message was linked to when the user chose to reject it (null: unlinked).
   * The reject goes through only if that is still its link (#666): a message another session
   * linked meanwhile is not erased. Required, so no caller can skip the check.
   */
  expectedOpportunityId: string | null;
}

/** Why `neverIngest` was asked for but a deny rule could not be put in force. */
export type BlockFailureReason = 'unparseable_sender';

export interface RejectResult {
  /** Null when `neverIngest` was not asked for. True only once a deny rule is confirmed active. */
  blocked: boolean | null;
  blockFailureReason?: BlockFailureReason;
}

const NOTE_MAX = 1000;

/**
 * Makes sure an active deny rule exists for `from`'s address or domain, and reports whether it
 * does. Run every time `neverIngest` is asked for, independent of whether this call is the one
 * that tombstoned the message (issue #145): the two outcomes the caller promises, "removed" and
 * "removed and blocked", are different promises, and only idempotency-guarding the first one
 * meant a failed or partial attempt at the second was never retried.
 *
 * `createRule`'s own uniqueness is on (user, effect, pattern), not `enabled`, so a 409 duplicate
 * can mean a rule that already blocks this sender, or one that matches but is currently
 * disabled (a `job_sender` default the user turned off, or a rule disabled for an unrelated
 * reason). Either way mail is still flowing unless it is explicitly re-enabled here; "a rule
 * exists" is not the guarantee the user asked for, "a rule is in force" is.
 */
async function ensureSenderBlocked(
  db: Db,
  ctx: UserCtx,
  from: string,
  scope: 'address' | 'domain',
): Promise<RejectResult> {
  const address = senderAddress(from);
  const parsed = address === '' ? null : parseMailPattern(address);
  if (parsed === null) return { blocked: false, blockFailureReason: 'unparseable_sender' };

  const pattern = scope === 'domain' ? `*@${parsed.domain}` : address;
  try {
    await createRule(db, ctx, {
      pattern,
      effect: 'deny',
      note: `Rejected ${new Date().toISOString().slice(0, 10)}`,
      source: 'rejection',
    });
  } catch (err) {
    if (!(err instanceof HttpError) || err.code !== 'duplicate') throw err;
    const existingId = err.details?.existingId;
    if (typeof existingId !== 'string') throw err;
    await updateRule(db, ctx, existingId, { enabled: true });
  }
  invalidateTriageContext(ctx.userId);
  return { blocked: true };
}

/**
 * Rejects one message. Idempotent: rejecting an already-rejected message writes no second
 * feedback row, so a double click or a retried request is harmless, but `neverIngest` is
 * always (re)attempted regardless, since a prior call's block may not have landed.
 */
export async function rejectCommunication(
  db: Db,
  ctx: UserCtx,
  id: string,
  input: RejectInput,
): Promise<RejectResult> {
  const row = await db
    .select()
    .from(communications)
    .where(and(eq(communications.userId, ctx.userId), eq(communications.id, id)))
    .get();
  if (row === undefined)
    throw new HttpError(404, 'not_found', 'No such message', undefined, { userFacing: true });
  // After the read, before the erase (#678): a test links the message here to show the link check
  // is the erasing UPDATE's, not this read's.
  await racePoint('reject.read');

  if (row.rejectedAt === null) {
    const now = Date.now();
    const erased = await withTransaction(db, async (tx) => {
      // The condition is in the erasing UPDATE itself, not a read before it (tl on #666): a link
      // that commits first leaves this updating nothing, and on Postgres a concurrent one waits
      // on the row and the WHERE is checked again, so there is no window between check and erase.
      const updated = await tx
        .update(communications)
        .set({
          subject: null,
          snippet: null,
          bodyRef: null,
          rejectedAt: now,
          rejectionReason: input.reason,
          // A rejected message is not a classification the user is correcting, so the
          // classifier's own verdict goes with the content it was about.
          needsReview: false,
          proposedTransition: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(communications.userId, ctx.userId),
            eq(communications.id, id),
            isNull(communications.rejectedAt),
            input.expectedOpportunityId === null
              ? isNull(communications.opportunityId)
              : eq(communications.opportunityId, input.expectedOpportunityId),
          ),
        )
        .returning({ id: communications.id })
        .all();
      if (updated.length === 0) return false;
      // The row no longer carries the text, so an index entry for it would be a searchable
      // copy of something the user asked to be rid of.
      await removeFromIndex(tx, ctx, 'communication', id);
      await tx
        .insert(dismissalFeedback)
        .values({
          id: newId(),
          userId: ctx.userId,
          kind: 'rejection',
          communicationId: id,
          opportunityId: input.expectedOpportunityId,
          reason: input.reason,
          note: input.note?.slice(0, NOTE_MAX) ?? null,
          shareNote: input.shareNote === true,
          at: now,
        })
        .run();
      return true;
    });
    if (!erased) {
      // Changed since the user saw it (linked elsewhere, or relinked): left exactly as it is,
      // and no block is added on the strength of a reject that did not happen.
      throw new HttpError(
        409,
        'message_changed',
        'This message was linked or moved somewhere else since you saw it, so it was left as it is.',
        undefined,
        { userFacing: true },
      );
    }
  }

  if (input.neverIngest === undefined) return { blocked: null };
  return await ensureSenderBlocked(db, ctx, row.from, input.neverIngest);
}
