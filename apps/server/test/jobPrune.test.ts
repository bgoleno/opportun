// Pruning completed job rows (issue #272): the jobs table otherwise grows without bound.
// done and dead rows get different retention windows (#258: a dead row is the diagnostic
// record a failure left behind, kept longer than a done row's bookkeeping); pending and
// running rows are never touched regardless of age.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { newId } from '@opportun/core';
import { auditLog, jobs } from '../src/db/schema';
import {
  JOB_PRUNE_DEAD_RETENTION_MS,
  JOB_PRUNE_DONE_RETENTION_MS,
  JOB_PRUNE_JOB_KIND,
  pruneCompletedJobs,
} from '../src/jobs/jobPrune';
import { enqueue } from '../src/jobs/runner';
import { useApi } from './api';

const boot = useApi();

async function insertJob(
  app: Awaited<ReturnType<typeof boot>>['app'],
  status: 'pending' | 'running' | 'done' | 'dead',
  updatedAt: number,
): Promise<string> {
  const id = newId();
  await app.db
    .insert(jobs)
    .values({
      id,
      kind: 'test.prune-fixture',
      payload: {},
      runAt: updatedAt,
      attempts: status === 'dead' ? 3 : 0,
      maxAttempts: 3,
      status,
      dedupeKey: null,
      userId: null,
      createdAt: updatedAt,
      updatedAt,
    })
    .run();
  return id;
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('pruneCompletedJobs (issue #272)', () => {
  it('prunes a done row past the done retention window', async () => {
    const { app } = await boot();
    const now = Date.now();
    const id = await insertJob(app, 'done', now - JOB_PRUNE_DONE_RETENTION_MS - DAY_MS);
    const result = await pruneCompletedJobs(app.db, { now });
    expect(result).toEqual({ donePruned: 1, deadPruned: 0 });
    expect(await app.db.select().from(jobs).where(eq(jobs.id, id)).get()).toBeUndefined();
  });

  it('leaves a done row inside the retention window alone', async () => {
    const { app } = await boot();
    const now = Date.now();
    const id = await insertJob(app, 'done', now - JOB_PRUNE_DONE_RETENTION_MS + DAY_MS);
    const result = await pruneCompletedJobs(app.db, { now });
    expect(result).toEqual({ donePruned: 0, deadPruned: 0 });
    expect(await app.db.select().from(jobs).where(eq(jobs.id, id)).get()).toBeDefined();
  });

  it('prunes a dead row past the dead retention window', async () => {
    const { app } = await boot();
    const now = Date.now();
    const id = await insertJob(app, 'dead', now - JOB_PRUNE_DEAD_RETENTION_MS - DAY_MS);
    const result = await pruneCompletedJobs(app.db, { now });
    expect(result).toEqual({ donePruned: 0, deadPruned: 1 });
    expect(await app.db.select().from(jobs).where(eq(jobs.id, id)).get()).toBeUndefined();
  });

  it('keeps a dead row past the done window but within the dead window: the longer window wins', async () => {
    const { app } = await boot();
    const now = Date.now();
    expect(JOB_PRUNE_DEAD_RETENTION_MS).toBeGreaterThan(JOB_PRUNE_DONE_RETENTION_MS);
    const id = await insertJob(app, 'dead', now - JOB_PRUNE_DONE_RETENTION_MS - DAY_MS);
    const result = await pruneCompletedJobs(app.db, { now });
    expect(result).toEqual({ donePruned: 0, deadPruned: 0 });
    expect(await app.db.select().from(jobs).where(eq(jobs.id, id)).get()).toBeDefined();
  });

  it('deletes past a single batch (issue #272: the first run can be the whole backlog)', async () => {
    const { app } = await boot();
    const now = Date.now();
    const old = now - JOB_PRUNE_DONE_RETENTION_MS - DAY_MS;
    const ids = await Promise.all([1, 2, 3, 4, 5].map(() => insertJob(app, 'done', old)));
    const result = await pruneCompletedJobs(app.db, { now, batchSize: 2 });
    expect(result).toEqual({ donePruned: 5, deadPruned: 0 });
    for (const id of ids) {
      expect(await app.db.select().from(jobs).where(eq(jobs.id, id)).get()).toBeUndefined();
    }
  });

  it('never touches pending or running rows, however old', async () => {
    const { app } = await boot();
    const now = Date.now();
    const ancient = now - 10 * JOB_PRUNE_DEAD_RETENTION_MS;
    const pendingId = await insertJob(app, 'pending', ancient);
    const runningId = await insertJob(app, 'running', ancient);
    const result = await pruneCompletedJobs(app.db, { now });
    expect(result).toEqual({ donePruned: 0, deadPruned: 0 });
    expect(await app.db.select().from(jobs).where(eq(jobs.id, pendingId)).get()).toBeDefined();
    expect(await app.db.select().from(jobs).where(eq(jobs.id, runningId)).get()).toBeDefined();
  });
});

describe('jobPruneJob: reports what it did (issue #272, design principle 6)', () => {
  it('records the result on the job row and writes an audit entry with the same counts', async () => {
    const { app } = await boot();
    const now = Date.now();
    await insertJob(app, 'done', now - JOB_PRUNE_DONE_RETENTION_MS - DAY_MS);
    await insertJob(app, 'dead', now - JOB_PRUNE_DEAD_RETENTION_MS - DAY_MS);

    const jobId = await enqueue(app.db, JOB_PRUNE_JOB_KIND, {});
    await app.jobs.drain();

    const row = await app.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(row?.status).toBe('done');
    expect(row?.result).toMatchObject({ donePruned: 1, deadPruned: 1 });

    const entries = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'jobs.pruned'))
      .all();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toMatchObject({ donePruned: 1, deadPruned: 1 });
  });
});
