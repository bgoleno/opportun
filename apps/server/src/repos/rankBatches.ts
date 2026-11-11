// Ranking in batches (#441, slice 1 of https://github.com/bgoleno/opportun/issues/358; tl's design
// issuecomment-6794239917 and ruling on #441): the setting, the wait for the next batch, a batch's
// row and its postings' link to it, and the hold on the discovery budget while it is in flight.
// The jobs that use these are in jobs/rankBatch.ts.
//
// A posting waiting for a batch has the reason batch_waiting and a rank_deferred_at, like a posting
// waiting for budget, so every way a wait is cleared (a ranking, a dismissal's Undo) works on it. The
// live drain does not take it (waitingForBudget leaves the reason out). Once sent, it also points at
// its batch (rank_batch_id) and keeps the fingerprint of the text that was sent, until its result is
// applied: the link is what makes applying a result happen once.
import { createHash } from 'node:crypto';
import type { ModelPolicy } from '@opportun/ai';
import { newId } from '@opportun/core';
import { and, asc, avg, count, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Exec } from '../db/client';
import { descNullsLast } from '../db/dialect';
import { discoveryResults, rankBatches, taskRuns, type RankBatchState } from '../db/schema';
import { readSetting, writeSetting } from '../lib/ai';
import type { UserCtx } from './base';
import { verdictOrder } from './discovery';

export type RankBatchRow = typeof rankBatches.$inferSelect;

/** At most this many postings in one batch (tl's design, point 4). */
export const RANK_BATCH_MAX = 500;

/** A batch still `submitting` this long after it was made never got its id saved (point 7). */
export const SUBMITTING_STALE_MS = 15 * 60_000;

/**
 * How long a batch's estimate is held against the budget, from sending (tl's blocking 1 on #444):
 * a provider ends a batch within a day, and after that the money is spent or it is not. Held for as
 * long as the row is in flight, a batch nobody can collect would keep live ranking and tagging out
 * of budget they have. The real cost is still recorded on the day the batch is collected.
 */
export const HOLD_MS = 24 * 3_600_000;

/** The task whose calls are batched, and whose history sizes a batch's estimate. */
const RANK_TASK = 'discovery.rank';

const HISTORY_MS = 30 * 86_400_000;

const settingKey = (userId: string): string => `discovery_rank_batch:${userId}`;

const StoredSetting = z.object({ on: z.boolean() });

/** Whether the caller ranks discovered postings in batches. Off unless they turned it on. */
export async function readRankBatching(exec: Exec, ctx: UserCtx): Promise<boolean> {
  const parsed = StoredSetting.safeParse(await readSetting(exec, ctx, settingKey(ctx.userId)));
  return parsed.success && parsed.data.on;
}

/** Stores the setting only; jobs/rankBatch.ts setRankBatching also hands the wait back when off. */
export async function writeRankBatching(exec: Exec, ctx: UserCtx, on: boolean): Promise<void> {
  await writeSetting(exec, ctx, settingKey(ctx.userId), { on });
}

/** The fingerprint of a posting's stored text, kept for the text a batch request sent. */
export function basisFingerprint(basis: string): string {
  return createHash('sha256').update(basis).digest('hex');
}

const owned = (ctx: UserCtx, id: string) =>
  and(eq(discoveryResults.userId, ctx.userId), eq(discoveryResults.id, id));

const batchWaiting = eq(discoveryResults.rankSkipReason, 'batch_waiting');

/**
 * The posting waits for the next batch. It keeps a wait it already has (its date), and a scored
 * posting keeps its score while its new ranking waits, as with the budget's wait. Only a pending
 * posting joins. Returns whether it did.
 */
export async function setBatchWaiting(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  now: number = Date.now(),
): Promise<boolean> {
  const rows = await exec
    .update(discoveryResults)
    .set({
      rankDeferredAt: sql`coalesce(${discoveryResults.rankDeferredAt}, ${now})`,
      rankSkipReason: 'batch_waiting',
    })
    .where(and(owned(ctx, id), eq(discoveryResults.disposition, 'pending')))
    .returning({ id: discoveryResults.id })
    .all();
  return rows.length > 0;
}

/** The caller's postings waiting for a batch and in none, in the order the live drain takes its own. */
export async function listBatchWaitingIds(exec: Exec, ctx: UserCtx): Promise<string[]> {
  const rows = await exec
    .select({ id: discoveryResults.id })
    .from(discoveryResults)
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        batchWaiting,
        isNull(discoveryResults.rankBatchId),
        isNotNull(discoveryResults.rankDeferredAt),
        eq(discoveryResults.disposition, 'pending'),
      ),
    )
    .orderBy(
      sql`case when ${discoveryResults.aiScore} is null then 0 else 1 end`,
      verdictOrder,
      descNullsLast(discoveryResults.prefilterScore),
      asc(discoveryResults.createdAt),
      asc(discoveryResults.id),
    )
    .all();
  return rows.map((r) => r.id);
}

/** Users with a posting waiting for a batch and in none (the hourly sweep's list). */
export async function usersWithBatchWaiting(exec: Exec): Promise<string[]> {
  const rows = await exec
    .selectDistinct({ userId: discoveryResults.userId })
    .from(discoveryResults)
    .where(
      and(
        batchWaiting,
        isNull(discoveryResults.rankBatchId),
        eq(discoveryResults.disposition, 'pending'),
      ),
    )
    .all();
  return rows.map((r) => r.userId);
}

/**
 * Postings waiting for a batch and in none go to the live drain's wait instead: batching was turned
 * off, or the provider in use has no batches (tl's ruling 3 on #441). Their date stays, so they keep
 * their place. Returns how many.
 */
export async function releaseBatchWaiting(exec: Exec, ctx: UserCtx): Promise<number> {
  const rows = await exec
    .update(discoveryResults)
    .set({ rankSkipReason: null })
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        batchWaiting,
        isNull(discoveryResults.rankBatchId),
      ),
    )
    .returning({ id: discoveryResults.id })
    .all();
  return rows.length;
}

const IN_FLIGHT: RankBatchState[] = ['submitting', 'submitted'];

/** The caller's batch being sent or sent and not yet collected: one at most (point 4). */
export async function findInFlightBatch(
  exec: Exec,
  ctx: UserCtx,
): Promise<RankBatchRow | undefined> {
  return await exec
    .select()
    .from(rankBatches)
    .where(and(eq(rankBatches.userId, ctx.userId), inArray(rankBatches.state, IN_FLIGHT)))
    .limit(1)
    .get();
}

export async function getBatch(exec: Exec, id: string): Promise<RankBatchRow | undefined> {
  return await exec.select().from(rankBatches).where(eq(rankBatches.id, id)).get();
}

/**
 * What the caller's batches in flight hold against the discovery budget (tl's ruling 2 on #441):
 * each batch's estimate for each of its postings still linked, so applying a result releases that
 * posting's share. Counted today, whichever day the batch was sent.
 */
export async function batchHoldUsd(
  exec: Exec,
  ctx: UserCtx,
  now: number = Date.now(),
): Promise<number> {
  const rows = await exec
    .select({
      est: rankBatches.estCostUsd,
      requests: rankBatches.requestCount,
      linked: count(discoveryResults.id),
    })
    .from(rankBatches)
    .leftJoin(discoveryResults, eq(discoveryResults.rankBatchId, rankBatches.id))
    .where(
      and(
        eq(rankBatches.userId, ctx.userId),
        inArray(rankBatches.state, IN_FLIGHT),
        gte(sql`coalesce(${rankBatches.submittedAt}, ${rankBatches.createdAt})`, now - HOLD_MS),
      ),
    )
    .groupBy(rankBatches.id, rankBatches.estCostUsd, rankBatches.requestCount)
    .all();
  return rows.reduce(
    (sum, r) => sum + (r.requests > 0 ? (Number(r.est) * Number(r.linked)) / r.requests : 0),
    0,
  );
}

/**
 * The output side of a batch request's estimate (tl's ruling 1 on #441): the average output tokens
 * of the caller's successful ranking calls over 30 days, rounded up, and how many there were. Tokens
 * are the same for a live call and a batch result, so a batch's own rows count alike.
 */
export async function rankOutputHistory(
  exec: Exec,
  ctx: UserCtx,
  now: number = Date.now(),
): Promise<{ outputTokens: number | null; calls: number }> {
  const row = await exec
    .select({ tokens: avg(taskRuns.outputTokens), calls: count() })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.userId, ctx.userId),
        eq(taskRuns.taskKey, RANK_TASK),
        eq(taskRuns.status, 'ok'),
        gte(taskRuns.createdAt, now - HISTORY_MS),
      ),
    )
    .get();
  return {
    outputTokens: row?.tokens == null ? null : Math.ceil(Number(row.tokens)),
    calls: Number(row?.calls ?? 0),
  };
}

export interface BatchItem {
  resultId: string;
  /** basisFingerprint of the text the request was built from. */
  fingerprint: string;
  promptId: string;
  /** The request's estimated cost (estimateBatchRequestUsd). */
  estUsd: number;
}

/**
 * The batch's row, in state submitting, and its postings' link to it, in one transaction: a crash
 * after this and before the id is saved leaves a row that markStaleSubmitting finds. A posting is
 * linked only if it still waits for a batch and is in none. Returns the batch's id and how many
 * were linked.
 */
export async function createSubmittingBatch(
  tx: Exec,
  ctx: UserCtx,
  batch: { policy: ModelPolicy; items: readonly BatchItem[] },
  now: number = Date.now(),
): Promise<{ id: string; linked: string[] }> {
  const id = newId();
  const sum = (items: readonly BatchItem[]) => items.reduce((n, i) => n + i.estUsd, 0);
  await tx
    .insert(rankBatches)
    .values({
      id,
      userId: ctx.userId,
      provider: batch.policy.provider,
      policy: batch.policy as unknown as Record<string, unknown>,
      providerBatchId: null,
      state: 'submitting',
      requestCount: batch.items.length,
      estCostUsd: sum(batch.items),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const linked: string[] = [];
  for (const item of batch.items) {
    const rows = await tx
      .update(discoveryResults)
      .set({
        rankBatchId: id,
        rankBatchBasis: item.fingerprint,
        rankBatchPromptId: item.promptId,
      })
      .where(and(owned(ctx, item.resultId), batchWaiting, isNull(discoveryResults.rankBatchId)))
      .returning({ id: discoveryResults.id })
      .all();
    if (rows.length > 0) linked.push(item.resultId);
  }
  // Something took a posting out of the wait since it was read: the batch is what was linked.
  if (linked.length < batch.items.length) {
    const kept = batch.items.filter((i) => linked.includes(i.resultId));
    await tx
      .update(rankBatches)
      .set({ requestCount: kept.length, estCostUsd: sum(kept) })
      .where(eq(rankBatches.id, id))
      .run();
  }
  return { id, linked };
}

/**
 * The posting's batch wait ends without a score: with `reason` on an unscored posting (as a live
 * failure's), and none on a scored one, which keeps its score and must never read "Not ranked".
 * With no reason (no prompt to rank with), it simply stops waiting, as in the drain.
 */
export async function endBatchWait(
  tx: Exec,
  ctx: UserCtx,
  id: string,
  reason: 'invalid_output' | 'provider_error' | null,
): Promise<void> {
  await tx
    .update(discoveryResults)
    .set({ rankDeferredAt: null, rankSkipReason: null })
    .where(owned(ctx, id))
    .run();
  if (reason === null) return;
  await tx
    .update(discoveryResults)
    .set({ rankSkipReason: reason })
    .where(and(owned(ctx, id), isNull(discoveryResults.aiScore)))
    .run();
}

/** Removes a batch made in the same transaction that ended up with no posting linked. */
export async function deleteBatch(tx: Exec, id: string): Promise<void> {
  await tx.delete(rankBatches).where(eq(rankBatches.id, id)).run();
}

export async function markBatchSubmitted(
  exec: Exec,
  id: string,
  providerBatchId: string,
  now: number = Date.now(),
): Promise<void> {
  await exec
    .update(rankBatches)
    .set({ providerBatchId, state: 'submitted', submittedAt: now, updatedAt: now })
    .where(and(eq(rankBatches.id, id), eq(rankBatches.state, 'submitting')))
    .run();
}

export async function setBatchState(
  exec: Exec,
  id: string,
  state: 'collected' | 'failed',
  now: number = Date.now(),
): Promise<void> {
  await exec
    .update(rankBatches)
    .set({ state, updatedAt: now, ...(state === 'collected' ? { collectedAt: now } : {}) })
    .where(eq(rankBatches.id, id))
    .run();
}

export async function touchBatchChecked(
  exec: Exec,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  await exec.update(rankBatches).set({ lastCheckedAt: now }).where(eq(rankBatches.id, id)).run();
}

/**
 * The batch's postings still linked to it go back to waiting: for a later batch, or, with batching
 * off, for the live drain. Their date stays. Returns how many.
 */
export async function unlinkBatch(
  exec: Exec,
  ctx: UserCtx,
  batchId: string,
  opts: { batching: boolean },
): Promise<number> {
  const rows = await exec
    .update(discoveryResults)
    .set({
      rankBatchId: null,
      rankBatchBasis: null,
      rankBatchPromptId: null,
      ...(opts.batching ? {} : { rankSkipReason: null }),
    })
    .where(and(eq(discoveryResults.userId, ctx.userId), eq(discoveryResults.rankBatchId, batchId)))
    .returning({ id: discoveryResults.id })
    .all();
  return rows.length;
}

/**
 * Takes one posting's link to the batch, first thing in the transaction that applies its result:
 * a second collect (after a crash) finds no link and applies nothing. The row as it was linked, or
 * undefined if it is not linked to this batch any more.
 */
export async function takeBatchLink(
  tx: Exec,
  ctx: UserCtx,
  batchId: string,
  resultId: string,
): Promise<{ fingerprint: string | null; promptId: string | null } | undefined> {
  const linked = await tx
    .select({
      fingerprint: discoveryResults.rankBatchBasis,
      promptId: discoveryResults.rankBatchPromptId,
    })
    .from(discoveryResults)
    .where(and(owned(ctx, resultId), eq(discoveryResults.rankBatchId, batchId)))
    .get();
  if (linked === undefined) return undefined;
  const taken = await tx
    .update(discoveryResults)
    .set({ rankBatchId: null, rankBatchBasis: null, rankBatchPromptId: null })
    .where(and(owned(ctx, resultId), eq(discoveryResults.rankBatchId, batchId)))
    .returning({ id: discoveryResults.id })
    .all();
  return taken.length > 0 ? linked : undefined;
}

/**
 * Fails a batch stuck in `submitting`, only if it still is: a send that took longer and has just
 * saved its id must not be failed after it (tl on #444). Returns whether it was.
 */
export async function failIfSubmitting(
  tx: Exec,
  id: string,
  now: number = Date.now(),
): Promise<boolean> {
  const rows = await tx
    .update(rankBatches)
    .set({ state: 'failed', updatedAt: now })
    .where(and(eq(rankBatches.id, id), eq(rankBatches.state, 'submitting')))
    .returning({ id: rankBatches.id })
    .all();
  return rows.length > 0;
}

/** Whether the user has a posting with this id at all, linked or not. */
export async function hasResult(exec: Exec, ctx: UserCtx, id: string): Promise<boolean> {
  const row = await exec
    .select({ id: discoveryResults.id })
    .from(discoveryResults)
    .where(owned(ctx, id))
    .get();
  return row !== undefined;
}

/**
 * Batches left in `submitting` for SUBMITTING_STALE_MS: sent, perhaps, with the id never saved
 * (point 7). The caller fails each and puts its postings back.
 */
export async function listStaleSubmitting(
  exec: Exec,
  now: number = Date.now(),
): Promise<RankBatchRow[]> {
  return await exec
    .select()
    .from(rankBatches)
    .where(
      and(
        eq(rankBatches.state, 'submitting'),
        lt(rankBatches.createdAt, now - SUBMITTING_STALE_MS),
      ),
    )
    .all();
}

/** Every sent batch not yet collected, for the collect sweep to pick the due ones from. */
export async function listSubmittedBatches(exec: Exec): Promise<RankBatchRow[]> {
  return await exec.select().from(rankBatches).where(eq(rankBatches.state, 'submitted')).all();
}
