// comms.classify_backfill job. Messages synced while the user had no AI key were skipped by the
// classifier (reason no_key) and stay unclassified; when an ai_api_key secret is added, this job
// queues comms.classify for each of them. It reads in (createdAt, id) order, 100 at a time, and
// only rows with classification IS NULL. Classify jobs are deduped per message, so a second key
// add while earlier ones are still pending queues nothing new.
import { and, asc, eq, gt, isNull, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { communications } from '../db/schema';
import type { UserCtx } from '../repos/base';
import { enqueueClassify } from './gmailSync';
import type { JobHandler } from './registry';
import { enqueue } from './runner';

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
 * A keyset cursor on id alone would be correct only while a row inserted after pagination begins
 * can never receive an id that sorts below one already passed -- true today because every id is
 * a uuidv7, but not a property this table's own schema promises (issue #286). createdAt is the
 * column actually meant to carry creation order, so the cursor is a tuple on it, with id only as
 * a tiebreak for two rows stamped in the same millisecond.
 *
 * No new index backs (createdAt, id): neither it nor the old id-only cursor is covered by one of
 * communications' existing indexes (all keyed on user_id, channel/thread or opportunity_id, none
 * on classification or createdAt), so this is the same filter-then-sort plan as before, not a
 * regression. Worth a migration if this job ever stops being trigger-driven and batched.
 */
type Cursor = { createdAt: number; id: string } | null;

/** Enqueues comms.classify for every unclassified message of the user; returns how many. */
export async function backfillClassify(db: Db, ctx: UserCtx): Promise<number> {
  let after: Cursor = null;
  let queued = 0;
  for (;;) {
    const batch = await db
      .select({ id: communications.id, createdAt: communications.createdAt })
      .from(communications)
      .where(
        and(
          eq(communications.userId, ctx.userId),
          isNull(communications.classification),
          // Stage 1 blocked these, so they have no classification and never will. Without this
          // they stay eligible forever and the next key add sends every blocked sender's From
          // header to the model: the body is gone, but "this user hears from a clinic" is
          // exactly the fact the filter exists to keep local.
          or(isNull(communications.triageDecision), ne(communications.triageDecision, 'filtered')),
          after === null
            ? undefined
            : or(
                gt(communications.createdAt, after.createdAt),
                and(eq(communications.createdAt, after.createdAt), gt(communications.id, after.id)),
              ),
        ),
      )
      .orderBy(asc(communications.createdAt), asc(communications.id))
      .limit(CLASSIFY_BACKFILL_BATCH)
      .all();
    for (const row of batch) {
      await enqueueClassify(db, ctx, row.id);
      queued += 1;
    }
    const last = batch.at(-1);
    if (last === undefined || batch.length < CLASSIFY_BACKFILL_BATCH) return queued;
    after = { createdAt: last.createdAt, id: last.id };
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
