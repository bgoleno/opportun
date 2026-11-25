// Messages whose classification met a spent budget or an outage are classified later, newest first
// (https://github.com/bgoleno/opportun/issues/1050). As ranking's waiting postings are
// (discoveryRankWaiting.ts): the wait is on the row, a sweep every hour makes "the next budget day"
// true in every time zone, and each user's drain makes one call at a time.
import type { FastifyBaseLogger } from 'fastify';
import { AiUnavailableError } from '@opportun/ai';
import type { ClassifyWait } from '@opportun/core';
import { z } from 'zod';
import { lockScope, withTransaction, type Db } from '../db/client';
import { enqueue } from '../lib/jobQueue';
import { CLASSIFY_WAITING_KIND } from '../lib/mailClassifyQueue';
import { racePoint } from '../lib/racePoints';
import type { Storage } from '../lib/storage';
import type { UserCtx } from '../repos/base';
import {
  beginClassifyTry,
  classifyKeyRejected,
  classifyWaitingHasRoom,
  clearClassifyKeyRejected,
  listWaitingMessageIds,
  setClassifyWait,
  usersWithWaitingMessages,
  writeClassifyKeyChangedAt,
} from '../repos/classifyWait';
import { keyChangeScope } from '../repos/discoveryBudget';
import {
  bodyRefetchFor,
  classifyCommunication,
  type BodyRefetch,
  type ClassifyRun,
} from './classify';
import { requireService, type JobHandler } from './registry';

export const CLASSIFY_WAITING_SWEEP_KIND = 'comms.classify_waiting_sweep';
/** On a minute of its own among the hourly ones. */
export const CLASSIFY_WAITING_SWEEP_CRON = '35 * * * *';

/** Provider errors in a row that count as an outage, as ranking's (discoveryRankWaiting.ts). */
const OUTAGE_AFTER_ERRORS = 3;

/** Queues the user's drain (at most one unfinished one per user). */
export async function enqueueClassifyWaiting(db: Db, ctx: UserCtx): Promise<string> {
  return await enqueue(
    db,
    CLASSIFY_WAITING_KIND,
    {},
    { dedupeKey: `${CLASSIFY_WAITING_KIND}:${ctx.userId}`, userId: ctx.userId },
  );
}

/** Queues a drain for each user with messages waiting, room, and no key the provider refused. */
export async function sweepWaitingMessages(db: Db): Promise<{ queued: number }> {
  let queued = 0;
  for (const userId of await usersWithWaitingMessages(db)) {
    const ctx: UserCtx = { userId, isAdmin: false };
    if (await classifyKeyRejected(db, ctx)) continue;
    if (!(await classifyWaitingHasRoom(db, ctx))) continue;
    await enqueueClassifyWaiting(db, ctx);
    queued += 1;
  }
  return { queued };
}

/**
 * What the caller's mail is classified with has changed (a key added, removed or found good again, or
 * the task's model policy): what a refused key left is tried again, now if there is room. If it is
 * refused still, the first call finds that out and it stops again, at the cost of that call.
 */
export async function resumeClassifyAfterKeyChange(db: Db, ctx: UserCtx): Promise<void> {
  await racePoint('classify.resume');
  await withTransaction(
    db,
    async (tx) => {
      // The user's lock before any row, as for what else writes several of a user's messages, and
      // after the key's: nothing takes these two the other way (the order is at submissionScope).
      await lockScope(tx, `user:${ctx.userId}`);
      const now = Date.now();
      await writeClassifyKeyChangedAt(tx, ctx, now);
      await clearClassifyKeyRejected(tx, ctx, now);
    },
    { scope: keyChangeScope(ctx) },
  );
  if ((await listWaitingMessageIds(db, ctx)).length === 0) return;
  if (await classifyWaitingHasRoom(db, ctx)) await enqueueClassifyWaiting(db, ctx);
}

export interface ClassifyDrainOutcome {
  classified: number;
  /** Not classified by its turn, for a reason that is its own: those behind it still go. */
  left: number;
  stopped:
    | 'no_room'
    | 'budget_exceeded'
    | 'no_key'
    | 'no_prompt'
    | 'key_rejected'
    | 'provider_error'
    | 'shutdown'
    | null;
}

/**
 * Classifies the caller's waiting messages, one at a time, until they run out or a reason that is true
 * of those behind it too. Each has one try a drain, its row read at its own turn.
 */
export async function drainWaitingMessages(
  db: Db,
  ctx: UserCtx,
  storage: Storage,
  opts: {
    refetch?: BodyRefetch;
    log?: FastifyBaseLogger | undefined;
    stopping?: () => boolean;
  } = {},
): Promise<ClassifyDrainOutcome> {
  const outcome: ClassifyDrainOutcome = { classified: 0, left: 0, stopped: null };
  const tried = new Set<string>();
  let errorsInARow = 0;
  for (;;) {
    const ids = (await listWaitingMessageIds(db, ctx)).filter((id) => !tried.has(id));
    if (ids.length === 0) return outcome;
    for (const id of ids) {
      // The runner's stop, and a demo server's reset, wait for the job in flight: for this one call.
      if (opts.stopping?.() === true) return { ...outcome, stopped: 'shutdown' };
      // New mail's share of the day (CLASSIFY_WAITING_SHARE), asked before every call.
      if (!(await classifyWaitingHasRoom(db, ctx))) return { ...outcome, stopped: 'no_room' };
      tried.add(id);
      const said = await beginClassifyTry(db, ctx, id, Date.now());
      // Rejected, corrected, classified or queued since the list was read.
      if (said === null) continue;
      await racePoint('classifyWaiting.begun');
      const leaveAs = (wait: ClassifyWait) => setClassifyWait(db, ctx, id, wait);
      let run: ClassifyRun;
      try {
        run = await classifyCommunication(db, ctx, storage, id, undefined, opts.refetch);
      } catch (err) {
        outcome.left += 1;
        if (!(err instanceof AiUnavailableError)) {
          // One message must not hold back the ones behind it.
          opts.log?.error(
            { err, 'opportun.communication.id': id },
            'classifying a waiting message failed',
          );
          await leaveAs('failed');
          continue;
        }
        if (err.reason === 'invalid_output') {
          // The answer is about this message: no later try.
          await leaveAs('invalid_output');
          errorsInARow = 0;
          continue;
        }
        await leaveAs('provider_error');
        errorsInARow += 1;
        if (errorsInARow >= OUTAGE_AFTER_ERRORS) return { ...outcome, stopped: 'provider_error' };
        continue;
      }
      if (run.status === 'classified') {
        outcome.classified += 1;
        errorsInARow = 0;
        continue;
      }
      // The row says why (classifyCommunication), and it is true of those behind it too.
      if (run.status === 'skipped') {
        switch (run.reason) {
          case 'budget_exceeded':
          case 'no_key':
          case 'key_rejected':
            return { ...outcome, left: outcome.left + 1, stopped: run.reason };
          case 'no_prompt':
            await leaveAs(said);
            return { ...outcome, left: outcome.left + 1, stopped: run.reason };
          case 'key_changed':
            // A 401 from before the key changed: the next read tries it with the new one. Two clock
            // readings are compared, and a stored time ahead of the clock would look stale every
            // time, so it counts as an error too, as ranking's does.
            await leaveAs('provider_error');
            tried.delete(id);
            errorsInARow += 1;
            if (errorsInARow >= OUTAGE_AFTER_ERRORS) {
              return { ...outcome, stopped: 'provider_error' };
            }
            continue;
          default:
            // Rejected, classified or blocked by the time it was read: nothing was sent.
            outcome.left += 1;
            continue;
        }
      }
      // A digest, which makes leads and no call. Marked by it; put back if it was not one after all.
      await leaveAs(said);
      errorsInARow = 0;
    }
  }
}

const Empty = z.object({}).strict() as unknown as z.ZodType<Record<string, never>>;

export const classifyWaitingJob: JobHandler<Record<string, never>> = {
  kind: CLASSIFY_WAITING_KIND,
  payloadSchema: Empty,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    if (ctx.userId === null) throw new Error(`${CLASSIFY_WAITING_KIND} needs a user`);
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    await ctx.setResult(
      await drainWaitingMessages(db, user, requireService(ctx, 'storage'), {
        refetch: bodyRefetchFor(db, user, ctx.services),
        log: ctx.services.log,
        stopping: ctx.stopping,
      }),
    );
  },
};

export const classifyWaitingSweepJob: JobHandler<Record<string, never>> = {
  kind: CLASSIFY_WAITING_SWEEP_KIND,
  payloadSchema: Empty,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    await ctx.setResult(await sweepWaitingMessages(db));
  },
};
