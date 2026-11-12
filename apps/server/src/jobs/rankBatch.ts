// Ranking in batches (#441, slice 1 of https://github.com/bgoleno/opportun/issues/358; tl's design
// issuecomment-6794239917 and ruling on #441). With the setting on and a provider that has batches,
// a posting reaching ranking waits for the next batch (the rank job). These jobs send the waiting
// ones as one batch, collect its results, and recover from a crash at any step:
//
// - Submit (after a rank job joins the wait, and hourly from the waiting sweep): one batch in
//   flight for each user, at most RANK_BATCH_MAX postings, as many as the budget has room for at
//   the estimated batch cost. The row and the links are written before the provider is called, so
//   a crash leaves a row in `submitting`; after 15 minutes the sweep fails it and the postings wait
//   again. If the provider had answered and only the id was lost, they are sent once more: bounded
//   by one batch, and logged (point 7).
// - Collect (the sweep every 10 minutes, every 30 after the first hour): each result is applied in
//   one transaction that takes the posting's link first and records its cost, so collecting twice
//   stores and records nothing twice. A succeeded result goes through the live call's parse,
//   validation and storing; an invalid request is a failed ranking; anything else, and a batch the
//   provider no longer has, puts the posting back to wait for a later batch.
//
// No provider has a batch client in this slice: batchProviderFor finds none, so with the setting on
// every ranking is still made live, and the submit job hands any waiting posting to the live drain.
import {
  batchRunRecord,
  estimateBatchRequestUsd,
  parseStructuredText,
  structuredRequest,
  type BatchRequest,
  type BatchResultItem,
  type ModelPolicy,
} from '@opportun/ai';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { withTransaction, type Db } from '../db/client';
import { HttpError } from '../lib/errors';
import { racePoint } from '../lib/racePoints';
import type { UserCtx } from '../repos/base';
import {
  clearWaitingKeyReasons,
  countWaitingResults,
  getResult,
  readPostingBasis,
  type DiscoveryResultView,
} from '../repos/discovery';
import {
  basisFingerprint,
  createSubmittingBatch,
  deleteBatch,
  endBatchWait,
  batchHoldUsd,
  failIfSubmitting,
  findInFlightBatch,
  getBatch,
  hasResult,
  listBatchWaitingIds,
  listStaleSubmitting,
  listSubmittedBatches,
  markBatchSubmitted,
  RANK_BATCH_MAX,
  rankOutputHistory,
  readRankBatching,
  releaseBatchWaiting,
  setBatchState,
  takeBatchLink,
  touchBatchChecked,
  unlinkBatch,
  writeRankBatching,
  type BatchItem,
  type RankBatchRow,
} from '../repos/rankBatches';
import { recordTaskRun, spentTodayUsd } from '../repos/taskRuns';
import {
  buildRankCall,
  enqueueRankWaiting,
  RankOutputSchema,
  storeRankOutput,
} from './discoveryRank';
import { RANK_BATCH_COLLECT_KIND } from './discoveryKinds';
import { enqueueRankBatchSubmit, rankBatchClient, RANK_BATCH_SEND_KIND } from './rankBatchClient';
import { rankBudgetHasRoom, rankBudgetRoomUsd } from './rankBudget';
import { requireService, type JobHandler, type JobServices } from './registry';
import { enqueue } from './runner';

export { RANK_BATCH_COLLECT_KIND, RANK_BATCH_SEND_KIND };

export const RANK_BATCH_SWEEP_KIND = 'discovery.rank_batch_sweep';
export const RANK_BATCH_SWEEP_CRON = '*/10 * * * *';

const MINUTE = 60_000;
/** A batch is looked at every 10 minutes for its first hour, then every 30 (point 6). */
const EARLY_CHECK_MS = 10 * MINUTE;
const LATE_CHECK_MS = 30 * MINUTE;
const EARLY_MS = 60 * MINUTE;
/** A sweep comes every 10 minutes and a check takes a moment, so "due" allows a minute's slack. */
const CHECK_SLACK_MS = MINUTE;
/**
 * A provider keeps a batch's results 29 days (Anthropic's). Past that with no client to ask (the
 * key was removed), the batch is handled as gone, so its postings do not wait for ever (point 8).
 */
const RESULTS_KEPT_MS = 29 * 86_400_000;

const lockFor = (ctx: UserCtx): string => `discovery.rank_batch:${ctx.userId}`;

const RANK_TASK = 'discovery.rank';

/**
 * Postings back in the wait need something to take them: with batching on, a submit (one in
 * flight per user, so this one goes once the last is collected); with it off, the live drain.
 */
async function takeWaiting(db: Db, ctx: UserCtx, batching: boolean): Promise<void> {
  if (!batching) {
    await releaseToLive(db, ctx);
    return;
  }
  if ((await listBatchWaitingIds(db, ctx)).length > 0) await enqueueRankBatchSubmit(db, ctx);
}

/**
 * Postings waiting for a batch go to the live drain's wait, and the drain is queued if there is
 * room. Returns how many were waiting for a batch.
 */
async function releaseToLive(db: Db, ctx: UserCtx): Promise<number> {
  const released = await releaseBatchWaiting(db, ctx);
  if ((await countWaitingResults(db, ctx)) > 0 && (await rankBudgetHasRoom(db, ctx))) {
    await enqueueRankWaiting(db, ctx);
  }
  return released;
}

/**
 * Turns batching on or off for the user. Off: no new batch is sent, a batch in flight is still
 * collected, and postings waiting for a batch go to the live drain (point 9). Not in Settings yet:
 * slice 2 shows it.
 */
export async function setRankBatching(db: Db, ctx: UserCtx, on: boolean): Promise<void> {
  await writeRankBatching(db, ctx, on);
  if (!on) await takeWaiting(db, ctx, false);
}

/**
 * Batches left in `submitting` for 15 minutes fail, and their postings wait again (point 7). The
 * provider may have taken the batch with its id lost: then those postings are paid for twice, once
 * in a batch nobody collects. Accepted (bounded by one batch) and logged.
 */
export async function failStaleSubmitting(
  db: Db,
  log: FastifyBaseLogger | undefined,
  now: number = Date.now(),
): Promise<number> {
  const stale = await listStaleSubmitting(db, now);
  await racePoint('rankBatch.stale_listed');
  let failed = 0;
  for (const batch of stale) {
    const ctx: UserCtx = { userId: batch.userId, isAdmin: false };
    const batching = await readRankBatching(db, ctx);
    const returned = await withTransaction(
      db,
      async (tx) => {
        // Only if it is still being sent: its id may have been saved since it was listed.
        if (!(await failIfSubmitting(tx, batch.id, now))) return null;
        return await unlinkBatch(tx, ctx, batch.id, { batching });
      },
      { scope: lockFor(ctx) },
    );
    if (returned === null) continue;
    failed += 1;
    log?.warn(
      { 'opportun.rank_batch.id': batch.id, 'opportun.count.returned': returned },
      'a ranking batch was never confirmed as sent: its postings wait again, and may be sent twice',
    );
    await takeWaiting(db, ctx, batching);
  }
  // Only those it failed: a batch whose id was saved since it was listed is left, and not counted.
  return failed;
}

export type SubmitOutcome =
  | { status: 'submitted'; batchId: string; requests: number }
  | { status: 'off'; released: number }
  | { status: 'no_batches'; released: number }
  | { status: 'in_flight' }
  | { status: 'nothing_waiting' }
  | { status: 'no_room'; waiting: number }
  | { status: 'provider_error'; returned: number };

/**
 * Sends the user's postings waiting for a batch as one batch, in the live drain's order, as many as
 * the budget has room for at their estimated cost, at most RANK_BATCH_MAX.
 */
export async function submitRankBatch(
  db: Db,
  ctx: UserCtx,
  services: Partial<JobServices>,
): Promise<SubmitOutcome> {
  const log = services.log;
  if (!(await readRankBatching(db, ctx))) {
    // Turned off since this was queued: setRankBatching handed the wait back; anything since goes too.
    return { status: 'off', released: await releaseToLive(db, ctx) };
  }
  await failStaleSubmitting(db, log);
  // Before the in-flight check (tl's blocking 2 on #444): with a batch out and no batch provider
  // now, the waiting postings would otherwise wait for a batch that is never sent.
  const client = await rankBatchClient(db, ctx, services);
  if (client === null) {
    // On, but the provider in use has no batches (or no key): the waiting postings are ranked live
    // (tl's ruling 3 on #441). The drain says so if there is no key.
    return { status: 'no_batches', released: await releaseToLive(db, ctx) };
  }
  if ((await findInFlightBatch(db, ctx)) !== undefined) return { status: 'in_flight' };

  const ids = await listBatchWaitingIds(db, ctx);
  if (ids.length === 0) return { status: 'nothing_waiting' };
  // The room is the discovery budget's, bounded by what is left of the router's per-task daily
  // limit for ranking, holds counted (tl's blocking 4 on #444): a live call stops there too. The
  // hold is 0 here today (a send goes on only with no batch in flight, and only those are held),
  // but it keeps this bound right if that check ever moves: keep it (tl at 1d49105).
  const taskLeft =
    client.perTaskDailyUsd -
    ((await spentTodayUsd(db, ctx, RANK_TASK)) + (await batchHoldUsd(db, ctx)));
  const room = Math.min(await rankBudgetRoomUsd(db, ctx), taskLeft);
  // Where a live call would start, a batch takes at least its first posting (tl's blocking 3): an
  // estimate is an upper bound, and a first batch over the room would otherwise never be sent, so
  // the history that brings the estimate down would never come. That one can pass the room by its
  // estimate's error, as a live call that passed the check can.
  const liveWouldStart = taskLeft > 0 && (await rankBudgetHasRoom(db, ctx));
  const history = await rankOutputHistory(db, ctx);
  const requests: BatchRequest[] = [];
  const items: BatchItem[] = [];
  let held = 0;
  for (const id of ids) {
    if (requests.length >= RANK_BATCH_MAX) break;
    // Read before the posting, as rankResult does: the fingerprint is of text no older than what
    // the request is built from, so a change in between can only refuse the score, never pass it.
    const basis = await readPostingBasis(db, ctx, id);
    if (basis === undefined) continue;
    let result: DiscoveryResultView;
    try {
      result = await getResult(db, ctx, id);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) continue;
      throw err;
    }
    if (result.disposition !== 'pending') continue;
    const call = await buildRankCall(db, ctx, result);
    if (call === undefined) {
      // No prompt to rank with: it no longer waits, as in the drain, with no reason.
      await endBatchWait(db, ctx, id, null);
      continue;
    }
    const request = structuredRequest(client.policy, call.opts);
    const estUsd = estimateBatchRequestUsd(client.policy, request, history);
    if (held + estUsd > room && !(requests.length === 0 && liveWouldStart)) break;
    requests.push({ customId: id, request });
    items.push({
      resultId: id,
      fingerprint: basisFingerprint(basis),
      promptId: call.promptId,
      estUsd,
    });
    held += estUsd;
  }
  if (requests.length === 0) return { status: 'no_room', waiting: ids.length };

  await racePoint('rankBatch.before_create');
  const made = await withTransaction(
    db,
    async (tx) => {
      // One in flight for each user, checked again under the lock: two submits cannot both send.
      if ((await findInFlightBatch(tx, ctx)) !== undefined) return undefined;
      const batch = await createSubmittingBatch(tx, ctx, { policy: client.policy, items });
      if (batch.linked.length === 0) {
        await deleteBatch(tx, batch.id);
        return undefined;
      }
      return batch;
    },
    { scope: lockFor(ctx) },
  );
  if (made === undefined) return { status: 'in_flight' };
  const send = requests.filter((r) => made.linked.includes(r.customId));

  await racePoint('rankBatch.before_submit');
  let providerBatchId: string;
  try {
    ({ batchId: providerBatchId } = await client.provider.submit(send));
  } catch (err) {
    // Refused, or no answer: there is nothing to collect, so the postings wait again now. If the
    // provider took it after all, this is point 7's double send, bounded the same way.
    log?.warn({ err, 'opportun.rank_batch.id': made.id }, 'sending a ranking batch failed');
    const returned = await withTransaction(
      db,
      async (tx) => {
        await setBatchState(tx, made.id, 'failed');
        return await unlinkBatch(tx, ctx, made.id, { batching: true });
      },
      { scope: lockFor(ctx) },
    );
    return { status: 'provider_error', returned };
  }
  await racePoint('rankBatch.provider_answered');
  await markBatchSubmitted(db, made.id, providerBatchId);
  return { status: 'submitted', batchId: made.id, requests: send.length };
}

/**
 * What applying one result did. `unmatched`: no posting of the user's has its id any more (deleted
 * while the batch ran, as deleting a source does) or ever had it.
 */
type Applied =
  | 'ranked'
  | 'changed'
  | 'dropped'
  | 'invalid_output'
  | 'failed'
  | 'returned'
  | 'unmatched'
  | 'done';

/**
 * Applies one result in one transaction: the posting's link is taken first, so a result applied
 * once is never applied again ('done'). A succeeded result's cost is recorded in the same
 * transaction, at the batch price, whatever becomes of its answer: it was paid for.
 */
async function applyBatchResult(
  db: Db,
  ctx: UserCtx,
  batch: RankBatchRow,
  policy: ModelPolicy,
  item: BatchResultItem,
): Promise<Applied> {
  return await withTransaction(db, async (tx) => {
    await racePoint('rankBatch.applying');
    const link = await takeBatchLink(tx, ctx, batch.id, item.customId);
    if (link === undefined) {
      // Applied already (a second collect after a crash), or its posting is gone. The link is what
      // makes a result apply once, and it went with the posting, so a deleted posting's result is
      // not costed: that spend is not recorded (tl on #444, as point 7's double send is accepted).
      // The collect counts and logs it.
      return (await hasResult(tx, ctx, item.customId)) ? 'done' : 'unmatched';
    }
    if (item.kind !== 'succeeded') {
      // A request the provider refused would be refused again: a failed ranking, as a live one is.
      if (item.kind === 'errored' && item.invalidRequest) {
        await endBatchWait(tx, ctx, item.customId, 'provider_error');
        return 'failed';
      }
      // Any other error, expired or canceled: unlinked, it waits for a later batch.
      return 'returned';
    }
    const parsed = parseStructuredText(item.text, RankOutputSchema);
    await recordTaskRun(
      tx,
      ctx,
      batchRunRecord('discovery.rank', policy, item.usage, {
        ...(link.promptId === null ? {} : { promptId: link.promptId }),
        ...(parsed.ok ? {} : { status: 'error' as const, error: parsed.reason }),
      }),
    );
    await racePoint('rankBatch.cost_recorded');
    if (!parsed.ok) {
      await endBatchWait(tx, ctx, item.customId, 'invalid_output');
      return 'invalid_output';
    }
    let result: DiscoveryResultView;
    try {
      result = await getResult(tx, ctx, item.customId);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) return 'dropped';
      throw err;
    }
    // Dismissed or saved while the batch ran: paid for and dropped, as a live call's answer would
    // be. Its wait stays, so Undo puts it back in line (tl on #230).
    if (result.disposition !== 'pending') return 'dropped';
    // Its text changed since it was sent: this answer says nothing about the new text. Unlinked, it
    // waits for a later batch; the change that queued a ranking found it waiting already.
    const basis = await readPostingBasis(tx, ctx, item.customId);
    if (basis === undefined || basisFingerprint(basis) !== link.fingerprint) return 'changed';
    const { stored } = await storeRankOutput(
      tx,
      ctx,
      item.customId,
      parsed.value,
      basis,
      result.aiRationale,
    );
    return stored ? 'ranked' : 'changed';
  });
}

type Counted = Exclude<Applied, 'done'> | 'errors';

export type CollectOutcome =
  | { status: 'not_in_flight' }
  | { status: 'no_client' }
  | { status: 'in_progress' }
  | { status: 'gone'; returned: number }
  | ({ status: 'collected' } & Record<Counted, number>);

/**
 * Looks at one sent batch, and applies its results once it has ended. `userId`: the job's user,
 * which must be the batch's (only the sweep queues this job, and this keeps that true).
 */
export async function collectRankBatch(
  db: Db,
  batchId: string,
  services: Partial<JobServices>,
  opts: { now?: number; userId?: string } = {},
): Promise<CollectOutcome> {
  const now = opts.now ?? Date.now();
  const log = services.log;
  const batch = await getBatch(db, batchId);
  if (
    batch?.state !== 'submitted' ||
    batch.providerBatchId === null ||
    (opts.userId !== undefined && opts.userId !== batch.userId)
  ) {
    return { status: 'not_in_flight' };
  }
  const ctx: UserCtx = { userId: batch.userId, isAdmin: false };
  const policy = batch.policy as unknown as ModelPolicy;
  const batching = await readRankBatching(db, ctx);
  const sentAt = batch.submittedAt ?? batch.createdAt;
  // Past the provider's 29 days the batch ends, whether or not it can be asked about (tl's
  // blocking 1 on #444): a key revoked at the provider makes every state call fail, and the batch
  // would otherwise stay in flight for ever, and no new one would be sent.
  const expired = now - sentAt > RESULTS_KEPT_MS;
  const client = expired ? null : await rankBatchClient(db, ctx, services, policy);
  if (!expired && client === null) {
    // No key now (removed or replaced by none): tried again on a later sweep (point 8).
    await touchBatchChecked(db, batch.id, now);
    return { status: 'no_client' };
  }
  const state = client === null ? 'gone' : await client.provider.state(batch.providerBatchId);
  await touchBatchChecked(db, batch.id, now);
  if (state === 'in_progress') return { status: 'in_progress' };
  if (state === 'gone' || client === null) {
    // The provider no longer has it: its postings wait again, as for an expired result (tl's
    // ruling 7 on #441).
    const returned = await withTransaction(
      db,
      async (tx) => {
        await setBatchState(tx, batch.id, 'failed', now);
        return await unlinkBatch(tx, ctx, batch.id, { batching: true });
      },
      { scope: lockFor(ctx) },
    );
    await takeWaiting(db, ctx, batching);
    return { status: 'gone', returned };
  }

  const items = await client.provider.results(batch.providerBatchId);
  await racePoint('rankBatch.results_read');
  const tally = new Map<Applied | 'errors', number>();
  for (const item of items) {
    let applied: Applied | 'errors';
    try {
      applied = await applyBatchResult(db, ctx, batch, policy, item);
    } catch (err) {
      // One result that cannot be applied does not stop the others (tl's blocking 1): its
      // transaction rolled back, so its posting is still linked, and it waits again below with the
      // ones the provider gave no result for.
      log?.error(
        { err, 'opportun.rank_batch.id': batch.id, 'opportun.discovery_result.id': item.customId },
        'applying a ranking batch result failed',
      );
      applied = 'errors';
      // The rollback took a succeeded result's cost row with it, but the provider charged for it
      // (tl's blocking 1 at 1d49105 on #444): it is recorded on its own, with an error status and
      // no change to the posting, so the money counts against the budget. The posting waits
      // again, and the batch that sends it next records its own charge, as any other call's.
      if (item.kind === 'succeeded') {
        await withTransaction(db, async (tx) => {
          await recordTaskRun(
            tx,
            ctx,
            batchRunRecord('discovery.rank', policy, item.usage, {
              status: 'error',
              error: 'apply_failed',
            }),
          );
        });
      }
    }
    tally.set(applied, (tally.get(applied) ?? 0) + 1);
    await racePoint('rankBatch.result_applied');
  }
  const n = (kind: Applied | 'errors'): number => tally.get(kind) ?? 0;
  const counts: Record<Counted, number> = {
    ranked: n('ranked'),
    changed: n('changed'),
    dropped: n('dropped'),
    invalid_output: n('invalid_output'),
    failed: n('failed'),
    returned: n('returned'),
    unmatched: n('unmatched'),
    errors: n('errors'),
  };
  if (counts.unmatched > 0) {
    log?.warn(
      { 'opportun.rank_batch.id': batch.id, 'opportun.count.unmatched': counts.unmatched },
      'ranking batch results for postings no longer there: their cost is not recorded',
    );
  }
  // Any posting the provider gave no result for waits again too.
  counts.returned += await withTransaction(
    db,
    async (tx) => {
      const left = await unlinkBatch(tx, ctx, batch.id, { batching: true });
      await setBatchState(tx, batch.id, 'collected', now);
      return left;
    },
    { scope: lockFor(ctx) },
  );
  // As after a live call that got through: the key works.
  if (counts.ranked > 0) await clearWaitingKeyReasons(db, ctx);
  await takeWaiting(db, ctx, batching);
  return { status: 'collected', ...counts };
}

/** Whether a sent batch is due for a look: every 10 minutes for its first hour, then every 30. */
function collectDue(batch: RankBatchRow, now: number): boolean {
  if (batch.lastCheckedAt === null) return true;
  const sentAt = batch.submittedAt ?? batch.createdAt;
  const every = now - sentAt < EARLY_MS ? EARLY_CHECK_MS : LATE_CHECK_MS;
  return now - batch.lastCheckedAt >= every - CHECK_SLACK_MS;
}

/** Every 10 minutes: fails batches stuck in `submitting`, and queues a collect for each one due. */
export async function sweepRankBatches(
  db: Db,
  log: FastifyBaseLogger | undefined,
  now: number = Date.now(),
): Promise<{ failed: number; collect: number }> {
  const failed = await failStaleSubmitting(db, log, now);
  let collect = 0;
  for (const batch of await listSubmittedBatches(db)) {
    if (!collectDue(batch, now)) continue;
    await enqueue(
      db,
      RANK_BATCH_COLLECT_KIND,
      { batchId: batch.id },
      { dedupeKey: `${RANK_BATCH_COLLECT_KIND}:${batch.id}`, userId: batch.userId },
    );
    collect += 1;
  }
  return { failed, collect };
}

export const rankBatchSubmitJob: JobHandler<Record<string, never>> = {
  kind: RANK_BATCH_SEND_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    if (ctx.userId === null) throw new Error(`${RANK_BATCH_SEND_KIND} needs a user`);
    await ctx.setResult(
      await submitRankBatch(db, { userId: ctx.userId, isAdmin: false }, ctx.services),
    );
  },
};

const CollectPayload = z.object({ batchId: z.string().min(1).max(64) });

export const rankBatchCollectJob: JobHandler<z.infer<typeof CollectPayload>> = {
  kind: RANK_BATCH_COLLECT_KIND,
  payloadSchema: CollectPayload,
  maxAttempts: 3,
  async run(db, payload, ctx) {
    await ctx.setResult(
      // A job with no user matches no batch, so it does nothing.
      await collectRankBatch(db, payload.batchId, ctx.services, { userId: ctx.userId ?? '' }),
    );
  },
};

export const rankBatchSweepJob: JobHandler<Record<string, never>> = {
  kind: RANK_BATCH_SWEEP_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    await ctx.setResult(await sweepRankBatches(db, requireService(ctx, 'log')));
  },
};
