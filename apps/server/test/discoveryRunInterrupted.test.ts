// A run a server stop cut short (https://github.com/bgoleno/opportun/issues/323): its row in Run
// history was left unfinished, so it read "Running" for good, though the source was not stuck and
// later runs worked. When a runner starts, a run row still unfinished was left by the process that
// died: it is ended as interrupted. A run that is going now, one a live job of its source is
// working on, is left alone. Every source and run is made up.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSources } from '../src/adapters/discoverySource';
import { discoveryRuns, jobs } from '../src/db/schema';
import { INTERRUPTED, finishInterruptedRuns } from '../src/jobs/interruptedRuns';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryKinds';
import { enqueue, recoverStaleJobs, startRunner } from '../src/jobs/runner';
import { createRun, createSource, listRuns } from '../src/repos/discovery';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
afterEach(() => {
  vi.useRealTimers();
  resetSources();
});

const board = (app: FastifyInstance, c: TestClient, org: string) =>
  createSource(app.db, ctxOf(c), { kind: 'ats_lever', config: { org } });

/** The run a killed process left: a row with no finish, and its job still marked running. */
async function killedMidRun(app: FastifyInstance, c: TestClient, sourceId: string) {
  const run = await createRun(app.db, ctxOf(c), { sourceId });
  // Due far in the future, so the restarted runner does not start it again while the test looks.
  const jobId = await enqueue(
    app.db,
    DISCOVERY_RUN_KIND,
    { sourceId },
    { userId: c.userId, runAt: Date.now() + 86_400_000 },
  );
  await app.db
    .update(jobs)
    .set({ status: 'running', lockedBy: 'the-killed-process', lockedAt: 1 })
    .where(eq(jobs.id, jobId))
    .run();
  return { run, jobId };
}

/** What a runner's startup does: orphaned jobs go back to pending, then orphaned runs are ended. */
const restart = async (app: FastifyInstance): Promise<number> => {
  await recoverStaleJobs(app.db);
  return await finishInterruptedRuns(app.db);
};

const runRow = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(discoveryRuns).where(eq(discoveryRuns.id, id)).get())!;

describe('#323: a run the server stop cut short is ended, not Running for good', () => {
  it('a restart ends the run it left unfinished as interrupted, and the job goes back to pending', async () => {
    const { app, a } = await boot();
    const src = await board(app, a, 'initech');
    const { run, jobId } = await killedMidRun(app, a, src.id);
    expect((await runRow(app, run.id)).finishedAt).toBeNull();

    // The restart: a runner starts, and its startup puts orphaned jobs back and ends orphaned runs.
    const runner = startRunner(app.db, { services: app.jobs.services, intervalMs: 1_000_000 });
    await runner.stop();

    const ended = await runRow(app, run.id);
    expect(ended.finishedAt).not.toBeNull();
    expect(ended.error).toContain('Interrupted');
    expect(ended.stats).toEqual({ interrupted: INTERRUPTED });
    expect((await app.db.select().from(jobs).where(eq(jobs.id, jobId)).get())!.status).toBe(
      'pending',
    );
    // As Run history reads it: ended, with the reason, and not "Running" (no finish, no error).
    const listed = (await listRuns(app.db, ctxOf(a), src.id, { limit: 10, offset: 0 })).items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: run.id, stats: { interrupted: INTERRUPTED } });
    expect(listed[0]!.finishedAt).not.toBeNull();
  });

  it('every source and every user: all that were left are ended', async () => {
    const { app, a, b } = await boot();
    const one = await killedMidRun(app, a, (await board(app, a, 'initech')).id);
    const two = await killedMidRun(app, a, (await board(app, a, 'globex')).id);
    const three = await killedMidRun(app, b, (await board(app, b, 'hooli')).id);
    expect(await restart(app)).toBe(3);
    for (const { run } of [one, two, three]) {
      expect((await runRow(app, run.id)).stats).toEqual({ interrupted: INTERRUPTED });
    }
  });

  it('a run that already ended is not touched, whether it succeeded or failed', async () => {
    const { app, a } = await boot();
    const src = await board(app, a, 'initech');
    const done = await createRun(app.db, ctxOf(a), { sourceId: src.id });
    await app.db
      .update(discoveryRuns)
      .set({ finishedAt: 1234, stats: { fetched: 5, inserted: 5 } })
      .where(eq(discoveryRuns.id, done.id))
      .run();
    const failed = await createRun(app.db, ctxOf(a), { sourceId: src.id });
    await app.db
      .update(discoveryRuns)
      .set({ finishedAt: 5678, error: 'board returned 503' })
      .where(eq(discoveryRuns.id, failed.id))
      .run();
    expect(await finishInterruptedRuns(app.db)).toBe(0);
    expect(await runRow(app, done.id)).toMatchObject({
      finishedAt: 1234,
      error: null,
      stats: { fetched: 5, inserted: 5 },
    });
    expect(await runRow(app, failed.id)).toMatchObject({
      finishedAt: 5678,
      error: 'board returned 503',
    });
  });

  it('a run that is going now, with a job of its source running, is left alone', async () => {
    const { app, a } = await boot();
    const live = await board(app, a, 'initech');
    const orphan = await board(app, a, 'globex');
    // The live source: a run row with no finish, and its job running, as a run in progress is.
    const liveRun = await createRun(app.db, ctxOf(a), { sourceId: live.id });
    const jobId = await enqueue(
      app.db,
      DISCOVERY_RUN_KIND,
      { sourceId: live.id },
      { userId: a.userId },
    );
    await app.db
      .update(jobs)
      .set({ status: 'running', lockedBy: 'this-process', lockedAt: Date.now() })
      .where(eq(jobs.id, jobId))
      .run();
    // Another source's run was left by a process that died: no job of it is running.
    const gone = await createRun(app.db, ctxOf(a), { sourceId: orphan.id });

    expect(await finishInterruptedRuns(app.db)).toBe(1);
    expect((await runRow(app, liveRun.id)).finishedAt).toBeNull();
    expect((await runRow(app, gone.id)).finishedAt).not.toBeNull();
  });

  it('a run that starts after the restart is not ended by it', async () => {
    const { app, a } = await boot();
    const src = await board(app, a, 'initech');
    const runner = startRunner(app.db, { services: app.jobs.services, intervalMs: 1_000_000 });
    await runner.stop();
    // A run begun once the runner is up: its row has no finish until it ends, and nothing ends it.
    const live = await createRun(app.db, ctxOf(a), { sourceId: src.id });
    expect((await runRow(app, live.id)).finishedAt).toBeNull();
  });

  it('the interrupted run is not a success, and the first run still holds its cut', async () => {
    const { app, a } = await boot();
    const src = await board(app, a, 'initech');
    const { run } = await killedMidRun(app, a, src.id);
    await restart(app);
    const { hasSucceededRun } = await import('../src/repos/discovery');
    expect(await hasSucceededRun(app.db, ctxOf(a), src.id)).toBe(false);
    expect((await runRow(app, run.id)).error).not.toBeNull();
  });
});
