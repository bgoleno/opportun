// Durable job runner (NFR-OPS4, design section 8): claim, retry with backoff, dead letters,
// dedupe, graceful stop, the scheduler, and the /jobs API.
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Db } from '../src/db/client';
import { exec } from './db';
import { jobs, settings, users } from '../src/db/schema';
import { registerJob, unregisterJob } from '../src/jobs/registry';
import {
  backoffMs,
  cancelJob,
  enqueue,
  materializeSchedules,
  queueLagMs,
  recoverStaleJobs,
  removeSchedule,
  runDueJobs,
  runNextJob,
  setSchedule,
  startRunner,
} from '../src/jobs/runner';
import { useApi } from './api';
import { captureLogs, openTestDb, testApp } from './helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const kind of [
    'test.echo',
    'test.fail',
    'test.slow',
    'test.flaky',
    'test.tick',
    'test.par.a',
    'test.par.b',
    'test.capped',
  ]) {
    unregisterJob(kind);
  }
  await Promise.all(cleanups.splice(0).map((f) => f()));
});

async function freshDb(): Promise<{ db: Db }> {
  const { handle, close } = await openTestDb();
  cleanups.push(close);
  return handle;
}

async function jobRow(db: Db, id: string) {
  const row = await db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (row === undefined) throw new Error(`job ${id} missing`);
  return row;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('job queue', () => {
  it('enqueues and runs a job with its validated payload', async () => {
    const { db } = await freshDb();
    const seen: { n: number }[] = [];
    registerJob({
      kind: 'test.echo',
      payloadSchema: z.object({ n: z.number() }),
      maxAttempts: 3,
      run: async (_db, payload) => {
        seen.push(payload);
      },
    });
    const id = await enqueue(db, 'test.echo', { n: 7 });
    expect((await jobRow(db, id)).status).toBe('pending');
    expect(await runDueJobs(db)).toBe(1);
    expect(seen).toEqual([{ n: 7 }]);
    const row = await jobRow(db, id);
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(1);
    expect(row.lockedBy).toBeNull();
  });

  it('rejects a payload that does not match the handler schema at enqueue', async () => {
    const { db } = await freshDb();
    registerJob({
      kind: 'test.echo',
      payloadSchema: z.object({ n: z.number() }),
      maxAttempts: 3,
      run: async () => {},
    });
    await expect(enqueue(db, 'test.echo', { n: 'x' })).rejects.toThrow();
    expect(await db.select().from(jobs).all()).toHaveLength(0);
  });

  it('does not run a job before its run_at', async () => {
    const { db } = await freshDb();
    let ran = 0;
    registerJob({
      kind: 'test.echo',
      payloadSchema: z.object({}),
      maxAttempts: 1,
      run: async () => {
        ran += 1;
      },
    });
    await enqueue(db, 'test.echo', {}, { runAt: Date.now() + 60_000 });
    expect(await runDueJobs(db)).toBe(0);
    expect(ran).toBe(0);
  });

  it('retries a failing handler with a growing run_at, then lands it dead', async () => {
    const { db } = await freshDb();
    registerJob({
      kind: 'test.fail',
      payloadSchema: z.object({}),
      maxAttempts: 3,
      run: async () => {
        throw new Error('handler exploded');
      },
    });
    let now = 1_800_000_000_000;
    const opts = { now: () => now, random: () => 0.5 };
    const id = await enqueue(db, 'test.fail', {}, { runAt: now });

    const delays: number[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect(await runNextJob(db, opts)).toBe(true);
      const row = await jobRow(db, id);
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(attempt);
      expect(row.lastError).toContain('handler exploded');
      expect(row.lockedBy).toBeNull();
      delays.push(row.runAt - now);
      // Not due yet: nothing runs until the clock reaches run_at.
      expect(await runNextJob(db, opts)).toBe(false);
      now = row.runAt;
    }
    // 2^attempts * 30s + jitter (random 0.5 of 10s = 5s).
    expect(delays).toEqual([2 * 30_000 + 5_000, 4 * 30_000 + 5_000]);

    expect(await runNextJob(db, opts)).toBe(true);
    const dead = await jobRow(db, id);
    expect(dead.status).toBe('dead');
    expect(dead.attempts).toBe(3);
    expect(await runNextJob(db, opts)).toBe(false);
  });

  // Issue #258: found while investigating #241 -- a failed job used to leave no trace at all
  // in the server's own logs, whether it retried or exhausted its attempts. Driven through a
  // real app (not runDueJobs directly) so this exercises the same services.log the runner
  // gets wired to in production, not a value a lower-level test could leave unset.
  it('logs a retry at warn (issue #258)', async () => {
    registerJob({
      kind: 'test.fail',
      payloadSchema: z.object({}),
      maxAttempts: 2,
      run: async () => {
        throw new Error('handler exploded');
      },
    });
    const logs = captureLogs();
    const { app } = await testApp({ logLevel: 'info' }, { logStream: logs });
    try {
      const id = await enqueue(app.db, 'test.fail', {});
      await app.jobs.drain();
      expect((await jobRow(app.db, id)).status).toBe('pending');
      expect(logs.text()).toContain('"level":40');
      expect(logs.text()).toContain('job failed; will retry');
      expect(logs.text()).toContain(id);
      expect(logs.text()).toContain('handler exploded');
    } finally {
      await app.close();
    }
  });

  it('logs a dead landing at error (issue #258)', async () => {
    registerJob({
      kind: 'test.fail',
      payloadSchema: z.object({}),
      maxAttempts: 1,
      run: async () => {
        throw new Error('handler exploded');
      },
    });
    const logs = captureLogs();
    const { app } = await testApp({ logLevel: 'info' }, { logStream: logs });
    try {
      const id = await enqueue(app.db, 'test.fail', {});
      await app.jobs.drain();
      expect((await jobRow(app.db, id)).status).toBe('dead');
      expect(logs.text()).toContain('"level":50');
      expect(logs.text()).toContain('job exhausted its retries; marked dead');
      expect(logs.text()).toContain(id);
      expect(logs.text()).toContain('handler exploded');
    } finally {
      await app.close();
    }
  });

  it('caps backoff at one hour and keeps jitter within 0-10s', () => {
    expect(backoffMs(1, () => 0)).toBe(60_000);
    expect(backoffMs(1, () => 0.999)).toBeLessThan(70_000);
    expect(backoffMs(3, () => 0)).toBe(240_000);
    expect(backoffMs(7, () => 0.5)).toBe(3_600_000);
    expect(backoffMs(40, () => 1)).toBe(3_600_000);
  });

  it('marks a job with an unknown kind or an invalid stored payload dead', async () => {
    const { db } = await freshDb();
    registerJob({
      kind: 'test.echo',
      payloadSchema: z.object({ n: z.number() }),
      maxAttempts: 5,
      run: async () => {},
    });
    const good = await enqueue(db, 'test.echo', { n: 1 });
    await exec({ db }, `UPDATE jobs SET payload = '{"n":"bad"}' WHERE id = ?`, good);
    unregisterJob('test.echo');
    const orphan = await enqueue(db, 'test.nobody', {});
    registerJob({
      kind: 'test.echo',
      payloadSchema: z.object({ n: z.number() }),
      maxAttempts: 5,
      run: async () => {},
    });
    await runDueJobs(db);
    expect((await jobRow(db, good)).status).toBe('dead');
    expect((await jobRow(db, orphan)).status).toBe('dead');
    expect((await jobRow(db, orphan)).lastError).toMatch(/no handler/);
  });

  it('suppresses a duplicate enqueue while a job with the same kind and dedupeKey is unfinished', async () => {
    const { db } = await freshDb();
    registerJob({
      kind: 'test.echo',
      payloadSchema: z.object({}),
      maxAttempts: 1,
      run: async () => {},
    });
    const first = await enqueue(db, 'test.echo', {}, { dedupeKey: 'k' });
    const second = await enqueue(db, 'test.echo', {}, { dedupeKey: 'k' });
    expect(second).toBe(first);
    const other = await enqueue(db, 'test.echo', {}, { dedupeKey: 'other' });
    expect(other).not.toBe(first);
    expect(await db.select().from(jobs).all()).toHaveLength(2);
    await runDueJobs(db);
    // Finished jobs no longer block the key.
    const third = await enqueue(db, 'test.echo', {}, { dedupeKey: 'k' });
    expect(third).not.toBe(first);
    expect(await db.select().from(jobs).all()).toHaveLength(3);
  });

  it('runner.stop awaits the in-flight job', async () => {
    const { db } = await freshDb();
    const started = deferred();
    const release = deferred();
    registerJob({
      kind: 'test.slow',
      payloadSchema: z.object({}),
      maxAttempts: 1,
      run: async () => {
        started.resolve();
        await release.promise;
      },
    });
    const id = await enqueue(db, 'test.slow', {});
    const runner = startRunner(db, { intervalMs: 5 });
    await started.promise;
    expect((await jobRow(db, id)).status).toBe('running');
    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect((await jobRow(db, id)).status).toBe('done');
  });

  it('a started runner picks up jobs enqueued later', async () => {
    const { db } = await freshDb();
    let ran = 0;
    registerJob({
      kind: 'test.echo',
      payloadSchema: z.object({}),
      maxAttempts: 1,
      run: async () => {
        ran += 1;
      },
    });
    const runner = startRunner(db, { intervalMs: 5 });
    try {
      await enqueue(db, 'test.echo', {});
      await until(() => ran === 1);
    } finally {
      await runner.stop();
    }
  });

  it('returns jobs left running by a crashed process to pending', async () => {
    const { db } = await freshDb();
    const id = await enqueue(db, 'test.echo', {});
    await exec(
      { db },
      `UPDATE jobs SET status = 'running', locked_by = 'gone', locked_at = 1 WHERE id = ?`,
      id,
    );
    await recoverStaleJobs(db);
    const row = await jobRow(db, id);
    expect(row.status).toBe('pending');
    expect(row.lockedBy).toBeNull();
  });

  it('reports queue lag as the age of the oldest due pending job', async () => {
    const { db } = await freshDb();
    const now = 1_800_000_000_000;
    expect(await queueLagMs(db, now)).toBe(0);
    await enqueue(db, 'test.echo', {}, { runAt: now + 60_000 });
    expect(await queueLagMs(db, now)).toBe(0);
    await enqueue(db, 'test.echo', {}, { runAt: now - 4_000 });
    await enqueue(db, 'test.echo', {}, { runAt: now - 9_000 });
    expect(await queueLagMs(db, now)).toBe(9_000);
  });
});

describe('cancelling a pending job (issue #66)', () => {
  it('cancels a pending job straight to dead, stripping any transient payload', async () => {
    const { db } = await freshDb();
    registerJob({
      kind: 'test.echo',
      payloadSchema: z.object({ secret: z.string().optional() }),
      maxAttempts: 3,
      transientPayloadKeys: ['secret'],
      run: async () => {},
    });
    const id = await enqueue(db, 'test.echo', { secret: 'do not keep me' });

    const cancelled = await cancelJob(db, id, 'cancelled: purge was waiting on it');

    expect(cancelled).toMatchObject({
      id,
      status: 'dead',
      lastError: 'cancelled: purge was waiting on it',
    });
    expect(cancelled?.payload).toEqual({});
    expect((await jobRow(db, id)).status).toBe('dead');
  });

  it('does nothing to a job that is not pending', async () => {
    const { db } = await freshDb();
    registerJob({
      kind: 'test.echo',
      payloadSchema: z.object({}),
      maxAttempts: 1,
      run: async () => {},
    });
    const done = await enqueue(db, 'test.echo', {});
    await runNextJob(db);
    expect((await jobRow(db, done)).status).toBe('done');

    expect(await cancelJob(db, done, 'too late')).toBeUndefined();
    expect((await jobRow(db, done)).status).toBe('done');
  });

  it('does not race a worker that already claimed the job', async () => {
    // A job a worker is mid-flight on is left alone: cancelling it out from under that worker,
    // only for the worker's own finish() to overwrite the cancellation when it completes, is
    // exactly the kind of race this stays atomic to avoid.
    const { db } = await freshDb();
    const id = await enqueue(db, 'test.echo', {});
    await exec(
      { db },
      `UPDATE jobs SET status = 'running', locked_by = 'worker-1' WHERE id = ?`,
      id,
    );

    expect(await cancelJob(db, id, 'too slow')).toBeUndefined();

    const row = await jobRow(db, id);
    expect(row.status).toBe('running');
    expect(row.lockedBy).toBe('worker-1');
  });

  it('returns undefined for a job that does not exist', async () => {
    const { db } = await freshDb();
    expect(await cancelJob(db, 'nope', 'reason')).toBeUndefined();
  });
});

describe('scheduler', () => {
  async function pendingTicks(db: Db) {
    return (await db.select().from(jobs).where(eq(jobs.kind, 'test.tick')).all()).filter(
      (j) => j.status === 'pending',
    );
  }

  it('materializes the next occurrence once per schedule row, and again after each run', async () => {
    const { db } = await freshDb();
    let ran = 0;
    registerJob({
      kind: 'test.tick',
      payloadSchema: z.object({}),
      maxAttempts: 1,
      run: async () => {
        ran += 1;
      },
    });
    // 2027-01-01T00:02:00Z
    let now = Date.UTC(2027, 0, 1, 0, 2);
    await setSchedule(db, 'test.tick', { cron: '*/5 * * * *', enabled: true });
    await materializeSchedules(db, now);
    await materializeSchedules(db, now);
    const [first, ...rest] = await pendingTicks(db);
    expect(rest).toHaveLength(0);
    expect(first!.runAt).toBe(Date.UTC(2027, 0, 1, 0, 5));

    now = first!.runAt;
    expect(await runDueJobs(db, { now: () => now })).toBe(1);
    expect(ran).toBe(1);
    const next = await pendingTicks(db);
    expect(next).toHaveLength(1);
    expect(next[0]!.runAt).toBe(Date.UTC(2027, 0, 1, 0, 10));
  });

  it('a disabled schedule row stops future enqueues and drops the pending one', async () => {
    const { db } = await freshDb();
    registerJob({
      kind: 'test.tick',
      payloadSchema: z.object({}),
      maxAttempts: 1,
      run: async () => {},
    });
    const now = Date.UTC(2027, 0, 1, 0, 2);
    await setSchedule(db, 'test.tick', { cron: '*/5 * * * *', enabled: true });
    await materializeSchedules(db, now);
    expect(await pendingTicks(db)).toHaveLength(1);
    await setSchedule(db, 'test.tick', { cron: '*/5 * * * *', enabled: false });
    await materializeSchedules(db, now);
    expect(await pendingTicks(db)).toHaveLength(0);
    expect(await runDueJobs(db, { now: () => now + 3_600_000 })).toBe(0);
    expect(await pendingTicks(db)).toHaveLength(0);
  });

  it('accepts a bare cron string as an enabled schedule and ignores an invalid one', async () => {
    const { db } = await freshDb();
    const now = Date.UTC(2027, 0, 1, 0, 2);
    const at = Date.now();
    await db
      .insert(settings)
      .values([
        { key: 'schedule:test.tick', userId: null, value: '0 * * * *', updatedAt: at },
        { key: 'schedule:test.bad', userId: null, value: 'not a cron', updatedAt: at },
      ])
      .run();
    await materializeSchedules(db, now);
    expect((await pendingTicks(db)).map((j) => j.runAt)).toEqual([Date.UTC(2027, 0, 1, 1, 0)]);
    expect(await db.select().from(jobs).where(eq(jobs.kind, 'test.bad')).all()).toHaveLength(0);
  });

  it('a named schedule row runs its own job kind with its payload for its user', async () => {
    const { db } = await freshDb();
    const seen: { payload: unknown; userId: string | null }[] = [];
    registerJob({
      kind: 'test.tick',
      payloadSchema: z.object({ sourceId: z.string() }),
      maxAttempts: 1,
      run: async (_db, payload, ctx) => {
        seen.push({ payload, userId: ctx.userId });
      },
    });
    const userId = 'u-1';
    const at = Date.now();
    // A user row so the settings and jobs user_id references hold.
    await db
      .insert(users)
      .values({
        id: userId,
        email: 'u1@example.com',
        passwordHash: 'x',
        displayName: 'U',
        createdAt: at,
        updatedAt: at,
      })
      .run();
    const now = Date.UTC(2027, 0, 1, 0, 2);
    await setSchedule(
      db,
      'test.tick:s-1',
      { cron: '*/5 * * * *', enabled: true, kind: 'test.tick', payload: { sourceId: 's-1' } },
      userId,
    );
    await setSchedule(
      db,
      'test.tick:s-2',
      { cron: '*/5 * * * *', enabled: true, kind: 'test.tick', payload: { sourceId: 's-2' } },
      userId,
    );
    await materializeSchedules(db, now);
    await materializeSchedules(db, now);
    const pending = await pendingTicks(db);
    expect(pending.map((j) => j.dedupeKey).sort()).toEqual([
      'schedule:test.tick:s-1',
      'schedule:test.tick:s-2',
    ]);
    expect(pending.every((j) => j.userId === userId)).toBe(true);
    expect(await runDueJobs(db, { now: () => Date.UTC(2027, 0, 1, 0, 5) })).toBe(2);
    expect(seen).toEqual(
      expect.arrayContaining([
        { payload: { sourceId: 's-1' }, userId },
        { payload: { sourceId: 's-2' }, userId },
      ]),
    );
    // Removing one row drops its pending occurrence and leaves the other alone.
    await removeSchedule(db, 'test.tick:s-1');
    expect((await pendingTicks(db)).map((j) => j.dedupeKey)).toEqual(['schedule:test.tick:s-2']);
    await materializeSchedules(db, Date.UTC(2027, 0, 1, 0, 6));
    expect((await pendingTicks(db)).map((j) => j.dedupeKey)).toEqual(['schedule:test.tick:s-2']);
  });

  it('the runner materializes schedules when it starts', async () => {
    const { db } = await freshDb();
    await setSchedule(db, 'test.tick', { cron: '0 0 1 1 *', enabled: true });
    const runner = startRunner(db, { intervalMs: 1000 });
    await runner.stop();
    expect(await pendingTicks(db)).toHaveLength(1);
  });
});

describe('jobs api', () => {
  const boot = useApi();

  it('lists jobs by status for the admin and only their own jobs for a user', async () => {
    const { app, a, b } = await boot();
    const instanceJob = await enqueue(app.db, 'test.echo', {});
    const bJob = await enqueue(app.db, 'test.echo', {}, { userId: b.userId });
    const asAdmin = await a.request({ method: 'GET', url: '/api/v1/jobs?status=pending' });
    expect(asAdmin.statusCode).toBe(200);
    const adminIds = (asAdmin.json().items as { id: string }[]).map((j) => j.id);
    expect(adminIds).toEqual(expect.arrayContaining([instanceJob, bJob]));
    expect(asAdmin.json().items[0]).not.toHaveProperty('payload');

    const asB = await b.request({ method: 'GET', url: '/api/v1/jobs' });
    expect((asB.json().items as { id: string }[]).map((j) => j.id)).toEqual([bJob]);
    const done = await a.request({ method: 'GET', url: '/api/v1/jobs?status=done' });
    expect(done.json().items).toEqual([]);
    const bad = await a.request({ method: 'GET', url: '/api/v1/jobs?status=nope' });
    expect(bad.statusCode).toBe(400);
  });

  it('retry revives a dead job (admin only) and the runner then completes it', async () => {
    const { app, a, b } = await boot();
    let fail = true;
    registerJob({
      kind: 'test.flaky',
      payloadSchema: z.object({}),
      maxAttempts: 1,
      run: async () => {
        if (fail) throw new Error('down');
      },
    });
    const id = await enqueue(app.db, 'test.flaky', {});
    await app.jobs.drain();
    expect((await jobRow(app.db, id)).status).toBe('dead');

    const forbidden = await b.request({ method: 'POST', url: `/api/v1/jobs/${id}/retry` });
    expect(forbidden.statusCode).toBe(403);
    expect((await jobRow(app.db, id)).status).toBe('dead');

    const res = await a.request({ method: 'POST', url: `/api/v1/jobs/${id}/retry` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, status: 'pending', attempts: 0 });

    const again = await a.request({ method: 'POST', url: `/api/v1/jobs/${id}/retry` });
    expect(again.statusCode).toBe(409);
    const missing = await a.request({ method: 'POST', url: '/api/v1/jobs/nope/retry' });
    expect(missing.statusCode).toBe(404);

    fail = false;
    await app.jobs.drain();
    expect((await jobRow(app.db, id)).status).toBe('done');
  });

  it('healthz reports queueLagMs from the oldest due pending job', async () => {
    const { app } = await boot();
    const idle = await app.inject({ method: 'GET', url: '/healthz' });
    expect(idle.json().queueLagMs).toBe(0);
    await enqueue(app.db, 'test.echo', {}, { runAt: Date.now() - 5_000 });
    const lagging = await app.inject({ method: 'GET', url: '/healthz' });
    expect(lagging.statusCode).toBe(200);
    expect(lagging.json().queueLagMs).toBeGreaterThanOrEqual(5_000);
  });
});

describe('claim under concurrent runners', () => {
  it('two runners on one database over 50 jobs run every job exactly once', async () => {
    const { db } = await freshDb();
    const runs = new Map<string, number>();
    registerJob({
      kind: 'test.echo',
      payloadSchema: z.object({ n: z.number() }),
      maxAttempts: 1,
      run: async (_db, payload: { n: number }) => {
        const key = String(payload.n);
        runs.set(key, (runs.get(key) ?? 0) + 1);
        // Yield so the other runner's claim interleaves with this one's work.
        await new Promise((r) => setImmediate(r));
      },
    });
    for (let n = 0; n < 50; n++) await enqueue(db, 'test.echo', { n });
    const [a, b] = await Promise.all([
      runDueJobs(db, { workerId: 'runner-a' }),
      runDueJobs(db, { workerId: 'runner-b' }),
    ]);
    expect((a ?? 0) + (b ?? 0)).toBe(50);
    expect(runs.size).toBe(50);
    expect([...runs.values()].every((count) => count === 1)).toBe(true);
    const done = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, 'done')).all();
    expect(done).toHaveLength(50);
  });
});

describe('DEFAULT_KIND_LIMITS (issue #260)', () => {
  it('caps company.ats_detect: it now fires per enrich attempt, not just 7 times ever, and each run makes several live calls to an external ATS vendor', async () => {
    const { DEFAULT_KIND_LIMITS } = await import('../src/jobs/runner');
    expect(DEFAULT_KIND_LIMITS['company.ats_detect']).toBe(2);
  });
});

describe('job runner concurrency', () => {
  /** A handler that reports when it starts and blocks until released. */
  function gate(kind: string, started: string[], release: Promise<void>) {
    registerJob({
      kind,
      payloadSchema: z.object({}).passthrough(),
      maxAttempts: 1,
      run: async () => {
        started.push(kind);
        await release;
      },
    });
  }

  it('runs two due jobs at the same time', async () => {
    const { db } = await freshDb();
    const started: string[] = [];
    const held = deferred();
    gate('test.par.a', started, held.promise);
    gate('test.par.b', started, held.promise);
    await enqueue(db, 'test.par.a', {});
    await enqueue(db, 'test.par.b', {});

    const runner = startRunner(db, { workers: 2, intervalMs: 5 });
    // Serially, the second job cannot start until the first is released, so this is the
    // whole assertion: both are in flight while neither has finished.
    await until(() => started.length === 2);
    held.resolve();
    await runner.stop();
  });

  it('never runs two jobs of a capped kind at once', async () => {
    const { db } = await freshDb();
    const started: string[] = [];
    const held = deferred();
    gate('test.capped', started, held.promise);
    gate('test.par.b', started, held.promise);
    await enqueue(db, 'test.capped', { n: 1 });
    await enqueue(db, 'test.capped', { n: 2 });
    await enqueue(db, 'test.par.b', {});

    const runner = startRunner(db, {
      workers: 3,
      intervalMs: 5,
      kindLimits: { 'test.capped': 1 },
    });
    // The uncapped kind proves the pool is working while the cap holds the second capped job.
    await until(() => started.includes('test.par.b'));
    expect(started.filter((k) => k === 'test.capped')).toHaveLength(1);
    held.resolve();
    await runner.stop();
  });

  it('stop() waits for every in-flight job, not just one', async () => {
    const { db } = await freshDb();
    const started: string[] = [];
    const held = deferred();
    let finished = 0;
    registerJob({
      kind: 'test.par.a',
      payloadSchema: z.object({}).passthrough(),
      maxAttempts: 1,
      run: async () => {
        started.push('test.par.a');
        await held.promise;
        finished += 1;
      },
    });
    await enqueue(db, 'test.par.a', { n: 1 });
    await enqueue(db, 'test.par.a', { n: 2 });

    const runner = startRunner(db, { workers: 2, intervalMs: 5 });
    await until(() => started.length === 2);
    held.resolve();
    await runner.stop();
    expect(finished).toBe(2);
  });
});
