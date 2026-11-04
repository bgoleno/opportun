// Postings waiting for the discovery budget are ranked on a later budget day, oldest first
// (https://github.com/bgoleno/opportun/issues/214, the owner's decision 2 on #190: nothing is ever
// skipped for budget). The wait lives on the result (rank_deferred_at), not in a queued job, so a
// restart, a failed job or a long outage loses nothing.
//
// A schedule runs the sweep every hour. Cron here follows the server's time zone and the budget
// day is UTC, so an hourly sweep is what makes "the next budget day" true in every zone; it costs
// one query, and queues work only for a user with postings waiting and room in the budget. Each
// user's drain ranks one posting at a time, so it adds one call in flight at most, and it stops as
// soon as the budget is spent. Until #218 brings pre-filter scores, oldest first means by date.
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import type { UserCtx } from '../repos/base';
import {
  clearRankDeferred,
  listWaitingResultIds,
  usersWithWaitingResults,
} from '../repos/discovery';
import { discoveryBudgetHasRoom } from '../repos/discoveryBudget';
import { rankResult } from './discoveryRank';
import { requireService, type JobHandler } from './registry';
import { enqueue } from './runner';

export const RANK_WAITING_KIND = 'discovery.rank_waiting';
export const RANK_WAITING_SWEEP_KIND = 'discovery.rank_waiting_sweep';
export const RANK_WAITING_SWEEP_CRON = '5 * * * *';

/** One unfinished drain per user: a second enqueue while one is queued or running does nothing. */
export async function enqueueRankWaiting(db: Db, ctx: UserCtx): Promise<void> {
  await enqueue(
    db,
    RANK_WAITING_KIND,
    {},
    { dedupeKey: `${RANK_WAITING_KIND}:${ctx.userId}`, userId: ctx.userId },
  );
}

/** Queues a drain for each user with postings waiting and room in their budget today. */
export async function sweepWaitingResults(db: Db): Promise<{ queued: number }> {
  let queued = 0;
  for (const userId of await usersWithWaitingResults(db)) {
    const ctx: UserCtx = { userId, isAdmin: false };
    if (await discoveryBudgetHasRoom(db, ctx)) {
      await enqueueRankWaiting(db, ctx);
      queued += 1;
    }
  }
  return { queued };
}

export interface DrainOutcome {
  ranked: number;
  /** Threw on this posting: it keeps waiting, and those behind it still go. */
  failed: number;
  /** Why the drain stopped early; everything not yet ranked keeps waiting. */
  stopped: 'budget_exceeded' | 'no_key' | 'provider_error' | null;
}

/** Ranks the caller's waiting postings, oldest first, until they run out or the budget does. */
export async function drainWaitingResults(
  db: Db,
  ctx: UserCtx,
  log?: FastifyBaseLogger,
): Promise<DrainOutcome> {
  const outcome: DrainOutcome = { ranked: 0, failed: 0, stopped: null };
  for (const id of await listWaitingResultIds(db, ctx)) {
    let run;
    try {
      run = await rankResult(db, ctx, id);
    } catch (err) {
      // One posting must not hold back the ones behind it; the next sweep tries it again.
      log?.error({ err, resultId: id }, 'ranking a waiting posting failed');
      outcome.failed += 1;
      continue;
    }
    if (run.status === 'ranked') {
      outcome.ranked += 1;
      continue;
    }
    // Not this posting's fault, and true of the ones behind it too: they all keep waiting.
    if (
      run.reason === 'budget_exceeded' ||
      run.reason === 'no_key' ||
      run.reason === 'provider_error'
    ) {
      outcome.stopped = run.reason;
      return outcome;
    }
    // It cannot be ranked (the model's answer was unusable, no prompt, or it was decided
    // meanwhile), so it no longer waits for budget. Its card says why, as #210 does.
    await clearRankDeferred(db, ctx, id);
  }
  return outcome;
}

export const rankWaitingJob: JobHandler<Record<string, never>> = {
  kind: RANK_WAITING_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    if (ctx.userId === null) throw new Error(`${RANK_WAITING_KIND} needs a user`);
    await ctx.setResult(
      await drainWaitingResults(
        db,
        { userId: ctx.userId, isAdmin: false },
        requireService(ctx, 'log'),
      ),
    );
  },
};

export const rankWaitingSweepJob: JobHandler<Record<string, never>> = {
  kind: RANK_WAITING_SWEEP_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    await ctx.setResult(await sweepWaitingResults(db));
  },
};
