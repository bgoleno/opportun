// Pruning completed job rows (issue #272). Nothing ever removed a done or dead row once it
// had served its purpose: on the owner's live instance, 2,948 rows accumulated in 31 hours,
// growing without bound. This closes that gap with two separate retention windows, not one:
//
//   done rows: kept 14 days, deliberately not 7. The owner's scheduled kinds include four
//   weekly ones (comms.refine_prompt, company.ats_reverify, company.suggest,
//   discovery.refine_prompt): at a 7-day window, a weekly job's single done row would be
//   pruned at almost exactly the moment its next run comes due, so Settings > Jobs would show
//   zero rows for that kind, indistinguishable from "this was never scheduled" — the exact
//   confusion that let #270 sit unnoticed for days. 14 days is 2x the longest scheduled
//   interval, which fixes that for free: at the observed roughly 1,000 rows a day that is
//   about 14,000 rows, trivial for either engine.
//
//   dead rows: kept 30 days. A dead row's payload, lastError and attempt count are the
//   diagnostic record a failure left behind (issue #258 added a log line for the same
//   failure, but an operator who was not watching, or whose logs have since rotated, has only
//   this row left to look at). Dead rows are also a small share of daily volume, so the
//   longer window barely affects the overall growth bound.
//
// Measured against updatedAt, not createdAt: runner.ts's finish() sets updatedAt alongside
// the status transition to 'done' or 'dead', and nothing ever writes a terminal row again
// afterward, so updatedAt on a terminal row is exactly the moment it became terminal. createdAt
// would understate that for any job retried with backoff before it finished.
//
// pending and running rows are never touched, at any age: this prunes history, not work.
//
// No new index: jobs_status_run_at_idx leads on status, but that does not help here — once
// most rows are done, `status = 'done'` is the LEAST selective predicate in the table, so this
// is effectively a scan of every done row regardless. No migration anyway, because the table
// is small and this runs nightly off any latency-sensitive path, not because the existing
// index happens to fit.
//
// Scheduled at 04:00, after the 03:00 backup (jobs/backup.ts BACKUP_CRON), and that ordering
// is a safety property, not a convenience: every row this prunes exists in at least one backup
// snapshot before it is deleted. Moving this earlier than the backup would silently start
// deleting rows that were never backed up.
//
// Deletes are batched (BATCH_SIZE): every write in this app serializes behind the SQLite write
// gate, and the first run on an instance that has been accumulating since inception prunes the
// whole historical backlog at once, not one day's worth. A single unbatched DELETE of that
// backlog would hold the gate for its entire duration; looping in small batches lets other
// writes interleave between them. Every run after the first only has a day's increment to
// prune and finishes in one or two batches regardless.
import { and, eq, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import { jobs } from '../db/schema';
import type { Db } from '../db/client';
import { audit } from '../lib/audit';
import type { JobHandler } from './registry';

export const JOB_PRUNE_JOB_KIND = 'jobs.prune';
export const JOB_PRUNE_CRON = '0 4 * * *';
export const JOB_PRUNE_DONE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const JOB_PRUNE_DEAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;

export interface JobPruneResult {
  donePruned: number;
  deadPruned: number;
}

/** Deletes every row of `status` older than `cutoff`, a batch at a time, so a large first run
 * does not hold the write gate for the whole backlog at once. The delete's own WHERE repeats
 * the select's predicate (not just the id list), so a row that changed status in between
 * (e.g. an admin revived a dead job) is naturally excluded rather than raced away. */
async function pruneStatus(
  db: Db,
  status: 'done' | 'dead',
  cutoff: number,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const matching = (
      await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.status, status), lt(jobs.updatedAt, cutoff)))
        .limit(batchSize)
        .all()
    ).map((row) => row.id);
    if (matching.length === 0) break;
    const deleted = await db
      .delete(jobs)
      .where(and(inArray(jobs.id, matching), eq(jobs.status, status), lt(jobs.updatedAt, cutoff)))
      .returning({ id: jobs.id })
      .all();
    total += deleted.length;
    if (matching.length < batchSize) break;
  }
  return total;
}

export async function pruneCompletedJobs(
  db: Db,
  opts: {
    now?: number;
    doneRetentionMs?: number;
    deadRetentionMs?: number;
    /** Override for tests; production always uses BATCH_SIZE. */
    batchSize?: number;
  } = {},
): Promise<JobPruneResult> {
  const now = opts.now ?? Date.now();
  const doneCutoff = now - (opts.doneRetentionMs ?? JOB_PRUNE_DONE_RETENTION_MS);
  const deadCutoff = now - (opts.deadRetentionMs ?? JOB_PRUNE_DEAD_RETENTION_MS);
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const donePruned = await pruneStatus(db, 'done', doneCutoff, batchSize);
  const deadPruned = await pruneStatus(db, 'dead', deadCutoff, batchSize);
  return { donePruned, deadPruned };
}

export const jobPruneJob: JobHandler<Record<string, never>> = {
  kind: JOB_PRUNE_JOB_KIND,
  payloadSchema: z.object({}).strict() as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    const result = await pruneCompletedJobs(db);
    await ctx.setResult(result);
    // Issue #272's own evidence came from a manual row count; this is the durable, queryable
    // record of what the job itself did on every run, the same reasoning as attachments.swept.
    await audit(db, 'jobs.pruned', { detail: { ...result } });
  },
};
