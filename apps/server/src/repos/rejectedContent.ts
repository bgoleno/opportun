// What a rejected message loses (spec D4), in one place: the reject clears it, and so does the job
// that tidies the messages rejected before it did (jobs/tidyRejected.ts), so the two cannot differ.
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import type { Exec } from '../db/client';
import { activities, communications, dismissalFeedback, jobs, opportunities } from '../db/schema';
import { CLASSIFY_JOB_KIND, classifyDedupeKey } from '../lib/mailClassifyQueue';
import type { UserCtx } from './base';
import { ownedBy } from './base';
import { indexActivity, removeFromIndex } from './search';

/**
 * What the row loses: what the message said, and what was said of it. What stays is what it is (the
 * sender, the recipients, the date, the identifiers, the channel), its links, the filter's verdict
 * and the reason it was rejected for.
 */
export const CLEARED_ON_REJECT = {
  subject: null,
  snippet: null,
  bodyRef: null,
  atsJobRefs: null,
  classification: null,
  outreachKind: null,
  mismatchReason: null,
  confidence: null,
  bodySource: null,
  needsReview: false,
  proposedTransition: null,
} as const satisfies Partial<typeof communications.$inferInsert>;

/** How acceptProposal began its note while it said which message the suggestion came from. */
export const STAGE_NOTE = 'Proposed by message: ';
/** What followed: the message's subject, cut. */
export const stageNoteSubject = (subject: string | null): string =>
  (subject ?? '').trim().slice(0, 120);

/** The title of a timeline entry whose message was rejected. */
export const REJECTED_ENTRY_TITLE = 'Message (rejected)';

export interface RejectedMessage {
  id: string;
  channel: string;
  externalId: string;
  from: string;
  sentAt: number;
}

export interface ClearedCopies {
  entriesBlanked: number;
  /** Entries the user edited, theirs now, and those that may be another message's: left. */
  entriesLeft: number;
  notesCleared: number;
}

/** Where a message made an opportunity: what applyClassification stores in its source_ref. */
export const sourceRefOf = (m: Pick<RejectedMessage, 'channel' | 'externalId'>): string =>
  `${m.channel}:${m.externalId}`.slice(0, 500);

/**
 * The message_ref entries this message made: `mine`, and those that may be its own or another
 * message's, which stay. An entry holds no id of its message: it is known by the sender and the
 * moment. Where another message has the same two, the opportunity's source_ref says whose it is;
 * where that names neither (a merge), it is not this one's while the other message is there.
 */
async function entriesOf(
  tx: Exec,
  ctx: UserCtx,
  message: RejectedMessage,
): Promise<{ mine: string[]; unsure: number }> {
  const alike = await tx
    .select({
      id: activities.id,
      title: activities.title,
      bodyMd: activities.bodyMd,
      participants: activities.participants,
      externalUrl: activities.externalUrl,
      sourceRef: opportunities.sourceRef,
    })
    .from(activities)
    .innerJoin(
      opportunities,
      and(eq(opportunities.id, activities.opportunityId), ownedBy(opportunities.userId, ctx)),
    )
    .where(
      and(
        ownedBy(activities.userId, ctx),
        eq(activities.kind, 'message_ref'),
        eq(activities.occurredAt, message.sentAt),
      ),
    )
    .all();
  const entries = alike.filter(
    (e) =>
      e.externalUrl === null &&
      e.participants.length === 1 &&
      e.participants[0] === message.from &&
      // Not one that has been blanked: by a message of the same sender and moment.
      !(e.title === REJECTED_ENTRY_TITLE && e.bodyMd === null),
  );
  if (entries.length === 0) return { mine: [], unsure: 0 };
  const others = await tx
    .select({
      channel: communications.channel,
      externalId: communications.externalId,
      rejectedAt: communications.rejectedAt,
    })
    .from(communications)
    .where(
      and(
        ownedBy(communications.userId, ctx),
        ne(communications.id, message.id),
        eq(communications.from, message.from),
        eq(communications.sentAt, message.sentAt),
      ),
    )
    .all();
  const own = sourceRefOf(message);
  const theirs = new Set(others.map(sourceRefOf));
  const there = others.some((m) => m.rejectedAt === null);
  const mine: string[] = [];
  let unsure = 0;
  for (const e of entries) {
    if (e.sourceRef === own) mine.push(e.id);
    else if (e.sourceRef !== null && theirs.has(e.sourceRef)) continue;
    else if (there) unsure += 1;
    else mine.push(e.id);
  }
  return { mine, unsure };
}

/**
 * Clears the copies of a message that is being, or was, rejected: the body a classification of it
 * still carries, the note of the user's correction, and its timeline entry, which stays as an entry
 * without what it said. In the caller's transaction, under the user's lock, the message's row
 * written; the search rows last (the order at submissionScope).
 */
export async function clearCopies(
  tx: Exec,
  ctx: UserCtx,
  message: RejectedMessage,
): Promise<ClearedCopies> {
  const notes = await tx
    .update(dismissalFeedback)
    .set({ note: null })
    .where(
      and(
        ownedBy(dismissalFeedback.userId, ctx),
        eq(dismissalFeedback.communicationId, message.id),
        eq(dismissalFeedback.kind, 'classification'),
        isNotNull(dismissalFeedback.note),
      ),
    )
    .returning({ id: dismissalFeedback.id })
    .all();

  const entries = await entriesOf(tx, ctx, message);
  // The condition is in the UPDATE, as an edit of the entry takes no lock of the user's: one that
  // commits meanwhile is kept. updated_at stays: it says whether the user edited the entry, and this
  // is not the user.
  const blanked =
    entries.mine.length === 0
      ? []
      : await tx
          .update(activities)
          .set({ title: REJECTED_ENTRY_TITLE, bodyMd: null })
          .where(
            and(
              ownedBy(activities.userId, ctx),
              inArray(activities.id, entries.mine),
              eq(activities.updatedAt, activities.createdAt),
            ),
          )
          .returning({ id: activities.id })
          .all();

  // Pending, or running: a run that fails is tried again with what the row holds.
  await tx
    .update(jobs)
    .set({ payload: { communicationId: message.id } })
    .where(
      and(
        ownedBy(jobs.userId, ctx),
        eq(jobs.kind, CLASSIFY_JOB_KIND),
        eq(jobs.dedupeKey, classifyDedupeKey(message.id)),
        inArray(jobs.status, ['pending', 'running']),
      ),
    )
    .run();

  for (const { id } of blanked) {
    await indexActivity(tx, ctx, { id, title: REJECTED_ENTRY_TITLE, bodyMd: null });
  }
  await removeFromIndex(tx, ctx, 'communication', message.id);
  return {
    entriesBlanked: blanked.length,
    entriesLeft: entries.mine.length - blanked.length + entries.unsure,
    notesCleared: notes.length,
  };
}
