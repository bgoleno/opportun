// At most one discovery.run in progress per source, however it started
// (https://github.com/bgoleno/opportun/issues/269). Run now and a source's schedule queue their
// runs under different dedupe keys, so before this fix one could start while the other ran: the
// board was read twice at once, and nothing told the user. Now a run that finds another of its
// source in progress records a Skipped run and reads nothing, and Run now during a run is refused
// with 409 run_in_progress. Every posting is made up.
import type { NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { discoveryRuns, jobs } from '../src/db/schema';
import { DISCOVERY_RUN_KIND, sourceScheduleName } from '../src/jobs/discoveryRun';
import { enqueue, runNextJob } from '../src/jobs/runner';
import { newId } from '@opportun/core';
import type { UserCtx } from '../src/repos/base';
import { createSource, getSourceRow, hasSucceededRun, listResults } from '../src/repos/discovery';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { holdAt } from './race';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

afterEach(() => resetSources());

const posting = (i: number): NormalizedPosting => ({
  company: 'Initech',
  title: `Engineer ${i}`,
  descriptionMd: 'Own the platform.',
  postingUrl: `https://boards.example.com/initech/${i}`,
  externalId: `gh-${i}`,
});

/**
 * A board whose first read is held open until release(), as a long run of a large board would be.
 * Every later read goes straight through. `reads` counts every time the board was read.
 */
function slowBoard() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const firstStarted = new Promise<void>((r) => (started = r));
  const state = { reads: 0 };
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      state.reads += 1;
      if (state.reads === 1) {
        started();
        await gate;
      }
      yield { posting: posting(state.reads), nextCursor: null };
    },
  } satisfies DiscoverySource);
  return { state, firstStarted, release };
}

const runOne = (app: FastifyInstance) => runNextJob(app.db, { services: app.jobs.services });

/** The source's schedule queues its occurrence under this key (runner materializeSchedules). */
const scheduled = (app: FastifyInstance, c: TestClient, sourceId: string) =>
  enqueue(
    app.db,
    DISCOVERY_RUN_KIND,
    { sourceId },
    { dedupeKey: `schedule:${sourceScheduleName(sourceId)}`, userId: c.userId },
  );

const runNow = (c: TestClient, sourceId: string) =>
  c.request({ method: 'POST', url: `/api/v1/discovery/sources/${sourceId}/run` });

const runsOf = (app: FastifyInstance, sourceId: string) =>
  app.db.select().from(discoveryRuns).where(eq(discoveryRuns.sourceId, sourceId)).all();

const pendingRuns = (app: FastifyInstance) =>
  app.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, DISCOVERY_RUN_KIND), eq(jobs.status, 'pending')))
    .all();

async function board(app: FastifyInstance, c: TestClient) {
  return await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: 'initech' },
    roleTargetId: null,
  });
}

describe('#269 criterion 1: one run in progress per source, however it started', () => {
  it('a scheduled run during a Run now reads nothing, and says it was skipped', async () => {
    const { app, a } = await boot();
    const slow = slowBoard();
    const src = await board(app, a);
    expect((await runNow(a, src.id)).statusCode).toBe(202);
    const first = runOne(app);
    await slow.firstStarted;

    const second = await scheduled(app, a, src.id);
    expect(await runOne(app)).toBe(true);
    expect(slow.state.reads).toBe(1);
    expect(await app.db.select().from(jobs).where(eq(jobs.id, second)).get()).toMatchObject({
      status: 'done',
      result: { status: 'skipped', reason: 'in_progress' },
    });
    const skipped = (await runsOf(app, src.id)).filter((r) => r.stats?.skipped !== undefined);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      stats: { skipped: 'run_in_progress' },
      error: 'Skipped: a run of this source was already in progress.',
    });
    expect(skipped[0]!.finishedAt).not.toBeNull();

    slow.release();
    await first;
    // The run that was going finished as usual, and stored its posting once.
    expect((await listResults(app.db, ctxOf(a), { limit: 50, offset: 0 })).total).toBe(1);
    expect(await hasSucceededRun(app.db, ctxOf(a), src.id)).toBe(true);
    expect(await getSourceRow(app.db, ctxOf(a), src.id)).toMatchObject({ status: 'ok' });
  });

  it('two runs of one source started at the same moment: only one reads the board', async () => {
    const { app, a } = await boot();
    const slow = slowBoard();
    const src = await board(app, a);
    await scheduled(app, a, src.id);
    expect((await runNow(a, src.id)).statusCode).toBe(202);
    // Both have been claimed and both reach the check together.
    const both = holdAt('discoveryRun.one_per_source', 2);
    const one = runOne(app);
    const two = runOne(app);
    await slow.firstStarted;
    slow.release();
    await Promise.all([one, two]);
    expect(both.arrived()).toBe(2);
    expect(slow.state.reads).toBe(1);
    const runs = await runsOf(app, src.id);
    expect(runs.map((r) => r.stats?.skipped ?? 'ran').sort()).toEqual(['ran', 'run_in_progress']);
  });

  it('a run left unfinished by a crash does not keep the source from running', async () => {
    const { app, a } = await boot();
    const slow = slowBoard();
    slow.release();
    const src = await board(app, a);
    // What a process killed mid-run leaves: a run row with no finish, and no job running.
    await app.db
      .insert(discoveryRuns)
      .values({ id: newId(), userId: a.userId, sourceId: src.id, startedAt: Date.now() - 60_000 })
      .run();
    await scheduled(app, a, src.id);
    await runOne(app);
    expect(slow.state.reads).toBe(1);
    expect((await listResults(app.db, ctxOf(a), { limit: 50, offset: 0 })).total).toBe(1);
  });

  it("another source's run does not hold this one back", async () => {
    const { app, a } = await boot();
    const slow = slowBoard();
    const one = await board(app, a);
    const other = await createSource(app.db, ctxOf(a), {
      kind: 'ats_lever',
      config: { org: 'initech-other' },
      roleTargetId: null,
    });
    await scheduled(app, a, one.id);
    const first = runOne(app);
    await slow.firstStarted;
    await scheduled(app, a, other.id);
    await runOne(app);
    expect(slow.state.reads).toBe(2);
    slow.release();
    await first;
  });
});

describe('#269 criterion 2: Run now during a run says so, and starts nothing', () => {
  it('Run now during a scheduled run of the same source: 409 run_in_progress, nothing queued', async () => {
    const { app, a } = await boot();
    const slow = slowBoard();
    const src = await board(app, a);
    await scheduled(app, a, src.id);
    const first = runOne(app);
    await slow.firstStarted;

    const res = await runNow(a, src.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'run_in_progress' } });
    expect(await pendingRuns(app)).toEqual([]);

    slow.release();
    await first;
    // Once it is done, Run now works again.
    expect((await runNow(a, src.id)).statusCode).toBe(202);
  });

  it('Run now during a Run now of the same source: refused the same way', async () => {
    const { app, a } = await boot();
    const slow = slowBoard();
    const src = await board(app, a);
    expect((await runNow(a, src.id)).statusCode).toBe(202);
    const first = runOne(app);
    await slow.firstStarted;
    const res = await runNow(a, src.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'run_in_progress' } });
    slow.release();
    await first;
  });

  // tl on https://github.com/bgoleno/opportun/pull/322 (https://github.com/bgoleno/opportun/issues/327):
  // the refusal is for that source only.
  it("Run now on one source while another of the user's sources runs: 202, and it runs", async () => {
    const { app, a } = await boot();
    const slow = slowBoard();
    const busy = await board(app, a);
    const other = await createSource(app.db, ctxOf(a), {
      kind: 'ats_lever',
      config: { org: 'initech-other' },
      roleTargetId: null,
    });
    await scheduled(app, a, busy.id);
    const first = runOne(app);
    await slow.firstStarted;
    const res = await runNow(a, other.id);
    expect(res.statusCode, res.body).toBe(202);
    await runOne(app);
    expect(slow.state.reads).toBe(2);
    slow.release();
    await first;
  });

  it("another user's run of a source of their own does not refuse this user's Run now", async () => {
    const { app, a, b } = await boot();
    const slow = slowBoard();
    const theirs = await board(app, b);
    const mine = await board(app, a);
    await scheduled(app, b, theirs.id);
    const first = runOne(app);
    await slow.firstStarted;
    expect((await runNow(a, mine.id)).statusCode).toBe(202);
    slow.release();
    await first;
  });
});
