// Whether a ranking goes in a batch (#441), and the batch client to send it with. A leaf beside
// jobs/rankBatch.ts, so the rank job can ask without importing the batch jobs (which import it).
import {
  AiUnavailableError,
  batchProviderFor,
  type BatchProvider,
  type ModelPolicy,
} from '@opportun/ai';
import type { Db } from '../db/client';
import { buildAiDeps } from '../lib/ai';
import type { UserCtx } from '../repos/base';
import { readRankBatching } from '../repos/rankBatches';
import { RANK_BATCH_SEND_KIND } from './discoveryKinds';
import type { JobServices } from './registry';
import { enqueue } from './runner';

export { RANK_BATCH_SEND_KIND };

/** What finds a provider's batch client: batchProviderFor, or a fake in tests. */
export type BatchProviderFactory = typeof batchProviderFor;

/**
 * How long a posting waits for others to join its batch before the submit job runs: the rest of a
 * discovery run's postings reach ranking within this, so a run goes in one batch.
 */
export const SUBMIT_GATHER_MS = 5 * 60_000;

/**
 * The batch client for the caller's ranking, or null: no key for the provider in use, or the
 * provider has no batches. `policy` is the batch's own, when collecting one already sent.
 */
export async function rankBatchClient(
  db: Db,
  ctx: UserCtx,
  services: Partial<JobServices>,
  policy?: ModelPolicy,
): Promise<{ provider: BatchProvider; policy: ModelPolicy; perTaskDailyUsd: number } | null> {
  const deps = await buildAiDeps(db, ctx);
  const used = policy ?? (await deps.policyFor('discovery.rank'));
  let apiKey: string;
  try {
    apiKey = await deps.getKey(used.provider);
  } catch (err) {
    if (err instanceof AiUnavailableError) return null;
    throw err;
  }
  const factory = services.rankBatchProvider ?? batchProviderFor;
  const provider = factory({ policy: used, apiKey, providerFetch: deps.providerFetch });
  return provider === null
    ? null
    : // The router's per-task daily limit, which a batch is bound by as a live call is (tl on #444).
      { provider, policy: used, perTaskDailyUsd: deps.budget.perTaskDailyUsd };
}

/**
 * Whether a ranking the user did not click for goes in a batch: batching is on, and the provider in
 * use has batches. Otherwise it is ranked live, as before (with batching off, nothing else is read).
 */
export async function ranksInBatch(
  db: Db,
  ctx: UserCtx,
  services: Partial<JobServices>,
): Promise<boolean> {
  if (!(await readRankBatching(db, ctx))) return false;
  return (await rankBatchClient(db, ctx, services)) !== null;
}

/** One unfinished submit per user; `runAt` lets postings gather first (SUBMIT_GATHER_MS). */
export async function enqueueRankBatchSubmit(db: Db, ctx: UserCtx, runAt?: number): Promise<void> {
  await enqueue(
    db,
    RANK_BATCH_SEND_KIND,
    {},
    {
      dedupeKey: `${RANK_BATCH_SEND_KIND}:${ctx.userId}`,
      userId: ctx.userId,
      ...(runAt === undefined ? {} : { runAt }),
    },
  );
}
