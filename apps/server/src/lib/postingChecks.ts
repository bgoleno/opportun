// A posting check that ended without writing its outcome, so the posting still says `searching`
// and its page still says it is being checked (https://github.com/bgoleno/opportun/issues/869, tl's
// design there). Two callers, one way to settle it: the check's job died (its handler's onDead,
// jobs/postingReconcile.ts), or at boot nothing is left that could finish it. Also what the check
// asks when it fails: whether its opportunity is still there at all
// (https://github.com/bgoleno/opportun/issues/897).
import type { FastifyBaseLogger } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { runCount, type Db } from '../db/client';
import { opportunities } from '../db/schema';
import { ownedBy, type UserCtx } from '../repos/base';
import { unfinishedDedupeKeys } from '../repos/jobs';
import { POSTING_RECONCILE_KIND } from './jobKinds';
import { flag } from './postingReconcile';

const NOT_FINISHED =
  "The check of the company's board did not finish. Use Find posting to check again.";

/** Whether the user's opportunity is gone: deleted, or merged into another. */
export async function opportunityGone(db: Db, ctx: UserCtx, id: string): Promise<boolean> {
  const row = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(and(eq(opportunities.id, id), ownedBy(opportunities.userId, ctx)))
    .get();
  return row === undefined;
}

/**
 * Ends one check that will not finish: the posting reads "the check did not finish", which offers
 * Find posting, and the timeline says so. Nothing is done while another check of it is pending or
 * running (a re-capture queued one), or once the posting is no longer `searching` (the UPDATE's own
 * condition: something else has settled it). Returns whether it settled it.
 */
export async function settleUnfinishedCheck(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
): Promise<boolean> {
  const key = `${POSTING_RECONCILE_KIND}:${opportunityId}`;
  if ((await unfinishedDedupeKeys(db, ctx, POSTING_RECONCILE_KIND, [key])).length > 0) return false;
  const settled = await runCount(
    db
      .update(opportunities)
      .set({
        postingState: 'needs_review',
        postingStateDetail: 'failed',
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(opportunities.id, opportunityId),
          ownedBy(opportunities.userId, ctx),
          eq(opportunities.postingState, 'searching'),
        ),
      ),
  );
  if (settled === 0) return false;
  await flag(db, ctx, opportunityId, 'failed', NOT_FINISHED);
  return true;
}

/**
 * At boot: ends every check nothing is left to finish (its job died on an older version, was pruned,
 * or was lost to a crash before it was queued). Before any request, so no capture can be between
 * its `searching` and its job. A job still marked running counts as unfinished here; the runner's
 * recovery deals with it next, through onDead. One that cannot be settled is logged, and the boot
 * goes on. Returns how many it ended.
 */
export async function settleAbandonedChecks(db: Db, log: FastifyBaseLogger): Promise<number> {
  const searching = await db
    .select({ id: opportunities.id, userId: opportunities.userId })
    .from(opportunities)
    .where(eq(opportunities.postingState, 'searching'))
    .all();
  let settled = 0;
  for (const { id, userId } of searching) {
    try {
      if (await settleUnfinishedCheck(db, { userId, isAdmin: false }, id)) settled += 1;
    } catch (err) {
      log.warn({ err, 'opportun.opportunity.id': id }, 'unfinished posting check not settled');
    }
  }
  return settled;
}
