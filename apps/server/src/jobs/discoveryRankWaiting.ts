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
// listWaitingResultIds has the order, and why a posting that failed goes behind the others.
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import type { UserCtx } from '../repos/base';
import {
  clearRankDeferred,
  listWaitingResultIds,
  setRankTurnUsed,
  setWaitingNoKey,
  usersWithWaitingResults,
} from '../repos/discovery';
import { discoveryBudgetHasRoom } from '../repos/discoveryBudget';
import { enqueueRankWaiting, rankResult } from './discoveryRank';
import { RANK_WAITING_KIND } from './discoveryKinds';
import { requireService, type JobHandler } from './registry';

export { enqueueRankWaiting, RANK_WAITING_KIND };

export const RANK_WAITING_SWEEP_KIND = 'discovery.rank_waiting_sweep';
export const RANK_WAITING_SWEEP_CRON = '5 * * * *';

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

/**
 * Provider errors in a row that count as an outage. Any one error can be about that posting alone
 * (a local model's context limit, a gateway's content filter), so a drain moves on after one; a
 * run of them is probably true of everything behind them too, so it stops spending calls on them.
 */
const OUTAGE_AFTER_ERRORS = 3;

export interface DrainOutcome {
  ranked: number;
  /** Threw on this posting: it keeps waiting, and those behind it still go. */
  failed: number;
  /** Why the drain stopped early; everything not yet ranked keeps waiting. */
  stopped: 'budget_exceeded' | 'no_key' | 'provider_error' | 'shutdown' | null;
}

/** Ranks the caller's waiting postings, oldest first, until they run out or the budget does. */
export async function drainWaitingResults(
  db: Db,
  ctx: UserCtx,
  opts: { log?: FastifyBaseLogger; stopping?: () => boolean } = {},
): Promise<DrainOutcome> {
  const outcome: DrainOutcome = { ranked: 0, failed: 0, stopped: null };
  let errorsInARow = 0;
  for (const id of await listWaitingResultIds(db, ctx)) {
    // A backlog can take hours, and the runner's stop waits for the job in flight: shutting down
    // waits for this one call, as it does for any other job. The rest keep waiting.
    if (opts.stopping?.() === true) {
      outcome.stopped = 'shutdown';
      return outcome;
    }
    let run;
    try {
      run = await rankResult(db, ctx, id);
    } catch (err) {
      // One posting must not hold back the ones behind it; the next sweep tries it again.
      opts.log?.error({ err, resultId: id }, 'ranking a waiting posting failed');
      outcome.failed += 1;
      continue;
    }
    if (run.status === 'ranked') {
      outcome.ranked += 1;
      errorsInARow = 0;
      continue;
    }
    // Not this posting's fault, and true of the ones behind it too: they all keep waiting.
    if (run.reason === 'budget_exceeded') {
      outcome.stopped = run.reason;
      return outcome;
    }
    if (run.reason === 'no_key') {
      await setWaitingNoKey(db, ctx);
      outcome.stopped = run.reason;
      return outcome;
    }
    // It keeps waiting with the reason on its card, behind the others for the rest of the day.
    if (run.reason === 'provider_error') {
      await setRankTurnUsed(db, ctx, id);
      errorsInARow += 1;
      if (errorsInARow >= OUTAGE_AFTER_ERRORS) {
        outcome.stopped = run.reason;
        return outcome;
      }
      continue;
    }
    // Decided since the list was read, or gone. A dismissed posting already does not wait, and its
    // wait must survive: Undo puts it back in line (tl on #230).
    if (run.reason === 'not_pending' || run.reason === 'missing') continue;
    errorsInARow = 0;
    // It cannot be ranked, so it no longer waits for budget. An unusable answer says why on its
    // card, as #210 does. No prompt sets no reason, as it does for any posting ranked without one.
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
        { log: requireService(ctx, 'log'), stopping: ctx.stopping },
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
