// Postings waiting for the discovery budget are ranked on a later budget day, oldest first
// (https://github.com/bgoleno/opportun/issues/214, the owner's decision 2 on #190: nothing is ever
// skipped for budget). The wait lives on the result (rank_deferred_at), not in a queued job, so a
// restart, a failed job or a long outage loses nothing.
//
// A schedule runs the sweep every hour. Cron here follows the server's time zone and the budget
// day is UTC, so an hourly sweep is what makes "the next budget day" true in every zone; it costs
// one query, and queues work only for a user with postings waiting and room in the budget. Each
// user's drain ranks one posting at a time, so it adds one call in flight at most, and it stops as
// soon as the budget is spent. The best pre-filter match goes first, then the oldest:
// listWaitingResultIds has the order, and why a posting that failed goes behind the others.
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { withTransaction, type Db } from '../db/client';
import { jobs } from '../db/schema';
import { HttpError } from '../lib/errors';
import type { UserCtx } from '../repos/base';
import {
  clearRankDeferred,
  clearWaitingKeyReasons,
  countWaitingResults,
  getResult,
  listWaitingResultIds,
  setRankTurnUsed,
  setRankWaitingIfUnranked,
  setWaitingNoKey,
  usersWithRejectedKey,
  usersWithWaitingResults,
  type DiscoveryResultView,
} from '../repos/discovery';
import {
  discoveryBudgetHasRoom,
  keyChangeScope,
  writeKeyChangedAt,
} from '../repos/discoveryBudget';
import { DISCOVERY_RANK_KIND, enqueueRankWaiting, rankResult } from './discoveryRank';
import { enqueueFollowUps } from './discoveryRun';
import { RANK_WAITING_KIND } from './discoveryKinds';
import { requireService, type JobHandler } from './registry';

export { enqueueRankWaiting, RANK_WAITING_KIND };

export const RANK_WAITING_SWEEP_KIND = 'discovery.rank_waiting_sweep';
export const RANK_WAITING_SWEEP_CRON = '5 * * * *';

/**
 * Queues a drain for each user with postings waiting and room in their budget today, except one
 * whose key the provider rejected: a failed call costs nothing, so the budget would never stop
 * those calls, and each one sends a posting (https://github.com/bgoleno/opportun/issues/261). A hard
 * stop, not a slower retry. A provider that is merely out rarely answers 401, so it keeps being
 * tried. resumeAfterKeyChange ends the stop, and so does a new posting that ranks.
 */
export async function sweepWaitingResults(db: Db): Promise<{ queued: number }> {
  let queued = 0;
  const stopped = await usersWithRejectedKey(db);
  for (const userId of await usersWithWaitingResults(db)) {
    if (stopped.has(userId)) continue;
    const ctx: UserCtx = { userId, isAdmin: false };
    if (await discoveryBudgetHasRoom(db, ctx)) {
      await enqueueRankWaiting(db, ctx);
      queued += 1;
    }
  }
  return { queued };
}

/**
 * Something about the user's key changed: postings waiting behind a missing or rejected key must no
 * longer say so, and with room in the budget they need not wait for the sweep. If the key still does
 * not work, the drain finds that out and says so, at the cost of one call. That also makes a re-check
 * of a key the ranking does not use harmless.
 */
export async function resumeAfterKeyChange(db: Db, ctx: UserCtx): Promise<void> {
  await withTransaction(
    db,
    async (tx) => {
      await writeKeyChangedAt(tx, ctx, Date.now());
      await clearWaitingKeyReasons(tx, ctx);
    },
    { scope: keyChangeScope(ctx) },
  );
  if ((await countWaitingResults(db, ctx)) > 0 && (await discoveryBudgetHasRoom(db, ctx))) {
    await enqueueRankWaiting(db, ctx);
  }
}

/**
 * Postings just restored by Undo (https://github.com/bgoleno/opportun/issues/274). A rank job that
 * ran while one was dismissed ended without ranking it, and a denylisted one never had a job, so
 * with no reason, no wait and no job nothing would ever rank it. Call after the restore has
 * committed, so a job claimed from here on sees it pending.
 *
 * It joins the budget wait, with a drain queued if there is room: the wait lives on the result, so
 * it does not depend on a job, and it brings the budget and every way of saying why. A new rank job
 * would not do: it could dedupe onto one already running that has read the posting as dismissed. A
 * pending rank job is left to run, or the posting would be ranked twice. Anything with a score, a
 * reason or a wait already says what it needs to.
 */
export async function resumeAfterUndo(db: Db, ctx: UserCtx, ids: string[]): Promise<void> {
  let joined = false;
  for (const id of ids) {
    let result: DiscoveryResultView;
    try {
      result = await getResult(db, ctx, id);
    } catch (err) {
      // Gone since the restore committed, with its source. The restore still happened.
      if (err instanceof HttpError && err.statusCode === 404) continue;
      throw err;
    }
    if (result.disposition !== 'pending') continue;
    if (result.aiScore !== null || result.rankSkipReason !== null) continue;
    if (result.rankDeferredAt !== null) continue;
    if (result.resolution === 'needs_capture') {
      // Ranking waits for the lead to be as complete as it will get.
      await enqueueFollowUps(db, ctx, result);
      continue;
    }
    const pendingJob = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, `${DISCOVERY_RANK_KIND}:${id}`), eq(jobs.status, 'pending')))
      .get();
    if (pendingJob !== undefined) continue;
    await setRankWaitingIfUnranked(db, ctx, id);
    joined = true;
  }
  if (joined && (await discoveryBudgetHasRoom(db, ctx))) await enqueueRankWaiting(db, ctx);
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
  stopped:
    | 'budget_exceeded'
    | 'no_key'
    | 'key_rejected'
    | 'key_changed'
    | 'provider_error'
    | 'shutdown'
    | null;
}

/**
 * Ranks the caller's waiting postings, oldest first, until they run out or the budget does. Reads
 * the list again when it is done, because a rank job that runs during a drain goes behind the older
 * postings and its enqueue dedupes onto this drain: only this drain can pick it up, short of the
 * next sweep (https://github.com/bgoleno/opportun/issues/263). Each posting gets one try per drain:
 * one the provider refused still waits, and would otherwise come straight back on the next read.
 */
export async function drainWaitingResults(
  db: Db,
  ctx: UserCtx,
  opts: { log?: FastifyBaseLogger; stopping?: () => boolean } = {},
): Promise<DrainOutcome> {
  const outcome: DrainOutcome = { ranked: 0, failed: 0, stopped: null };
  const tried = new Set<string>();
  let errorsInARow = 0;
  for (;;) {
    const ids = (await listWaitingResultIds(db, ctx)).filter((id) => !tried.has(id));
    if (ids.length === 0) return outcome;
    for (const id of ids) {
      // A backlog can take hours, and the runner's stop waits for the job in flight: shutting down
      // waits for this one call, as it does for any other job. The rest keep waiting.
      if (opts.stopping?.() === true) {
        outcome.stopped = 'shutdown';
        return outcome;
      }
      tried.add(id);
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
      // The first is enough, unlike a provider error: a 401 is about the key, not this posting.
      // rankResult has marked what waits.
      if (run.reason === 'key_rejected') {
        outcome.stopped = run.reason;
        return outcome;
      }
      // A 401 from before the key changed: the next read tries it with the new key. If that is
      // refused too, the call began after the change, so the stop comes back. This compares two
      // clock readings, and a stored time ahead of the clock would look stale every time, so it
      // counts as an error too, or a drain could call for ever with nothing done by anyone.
      if (run.reason === 'key_changed') {
        tried.delete(id);
        errorsInARow += 1;
        if (errorsInARow >= OUTAGE_AFTER_ERRORS) {
          outcome.stopped = run.reason;
          return outcome;
        }
        continue;
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
      // Decided since the list was read, or gone. A dismissed posting already does not wait, and
      // its wait must survive: Undo puts it back in line (tl on #230).
      if (run.reason === 'not_pending' || run.reason === 'missing') continue;
      errorsInARow = 0;
      // It cannot be ranked, so it no longer waits for budget. An unusable answer says why on its
      // card, as #210 does. No prompt sets no reason, as it does for any posting ranked without one.
      await clearRankDeferred(db, ctx, id);
    }
  }
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
