// comms.classify_backfill job. Messages synced while the user had no AI key were skipped by the
// classifier (reason no_key) and stay unclassified; when an ai_api_key secret is added, this job
// queues comms.classify for each of them. It reads newest first, in (sentAt, id) order, 100 at a time,
// and only rows with classification IS NULL that no later try takes by itself (jobs/classifyWaiting,
// #1050). Classify jobs are deduped per message, so a second key add while earlier ones are still
// pending queues nothing new.
import { enqueueClassify } from '../lib/mailClassifyQueue';
import { enqueue } from '../lib/jobQueue';
import { and, desc, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { communications } from '../db/schema';
import type { UserCtx } from '../repos/base';
import type { JobHandler } from './registry';

export const CLASSIFY_BACKFILL_KIND = 'comms.classify_backfill';
export const CLASSIFY_BACKFILL_BATCH = 100;

export const classifyBackfillDedupeKey = (userId: string): string => `classify_backfill:${userId}`;

/** Queues the backfill for the user (at most one unfinished backfill per user). */
export async function enqueueClassifyBackfill(db: Db, ctx: UserCtx): Promise<string> {
  return enqueue(
    db,
    CLASSIFY_BACKFILL_KIND,
    {},
    { dedupeKey: classifyBackfillDedupeKey(ctx.userId), userId: ctx.userId },
  );
}

/**
 * Newest first, so that what the budget allows today goes to the newest (#1050). The cursor is a tuple
 * on the order's own column, with id as the tiebreak for two messages of one millisecond: an id alone
 * carries an order this table's schema does not promise (issue #286).
 */
type Cursor = { sentAt: number; id: string } | null;

/** Enqueues comms.classify for every unclassified message of the user; returns how many. */
export async function backfillClassify(db: Db, ctx: UserCtx): Promise<number> {
  let after: Cursor = null;
  let queued = 0;
  for (;;) {
    const batch = await db
      .select({ id: communications.id, sentAt: communications.sentAt })
      .from(communications)
      .where(
        and(
          eq(communications.userId, ctx.userId),
          isNull(communications.classification),
          isNull(communications.rejectedAt),
          // Stage 1 blocked these, so they have no classification and never will. Without this
          // they stay eligible forever and the next key add sends every blocked sender's From
          // header to the model: the body is gone, but "this user hears from a clinic" is
          // exactly the fact the filter exists to keep local.
          or(isNull(communications.triageDecision), ne(communications.triageDecision, 'filtered')),
          // Not one that waits, or it would be tried twice; nor one whose key was refused, which the
          // key change ends, nor one the user has blocked since.
          or(
            isNull(communications.classifyWait),
            inArray(communications.classifyWait, ['no_key', 'invalid_output']),
          ),
          after === null
            ? undefined
            : or(
                lt(communications.sentAt, after.sentAt),
                and(eq(communications.sentAt, after.sentAt), lt(communications.id, after.id)),
              ),
        ),
      )
      .orderBy(desc(communications.sentAt), desc(communications.id))
      .limit(CLASSIFY_BACKFILL_BATCH)
      .all();
    for (const row of batch) {
      await enqueueClassify(db, ctx, row.id);
      queued += 1;
    }
    const last = batch.at(-1);
    if (last === undefined || batch.length < CLASSIFY_BACKFILL_BATCH) return queued;
    after = { sentAt: last.sentAt, id: last.id };
  }
}

const PayloadSchema = z.object({}).strict();

export const classifyBackfillJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: CLASSIFY_BACKFILL_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    if (ctx.userId === null) throw new Error('comms.classify_backfill needs a user');
    const queued = await backfillClassify(db, { userId: ctx.userId, isAdmin: false });
    await ctx.setResult({ queued });
  },
};
