// Two overlapping runs of one source store each posting once, and make one ranking call for it
// (https://github.com/bgoleno/opportun/issues/267). ingest checks then inserts and
// discovery_results has no unique index: on Postgres only a scope lock keeps the two apart
// (SQLite's write gate already does). Since https://github.com/bgoleno/opportun/issues/269 the
// runner no longer lets two discovery.run jobs of one source run at once: the later one records a
// Skipped run. So the lockstep tests here call the run directly, two at once, to keep #267's lock
// tested on its own; the queued ones go through the runner and check that the second is skipped
// and every posting is still stored and ranked once. The provider is mocked and every posting is
// made up.
import { runStructured } from '@opportun/ai';
import { newId, type NormalizedPosting } from '@opportun/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSource, resetSources } from '../src/adapters/discoverySource';
import { withTransaction } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import { discoveryResults, discoveryRuns, jobs } from '../src/db/schema';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import {
  DISCOVERY_RUN_KIND,
  FIRST_RUN_RANK_CAP,
  MULTI_POSTED_PREFIX,
  runDiscoverySource,
} from '../src/jobs/discoveryRun';
import { enqueue, runNextJob, startRunner } from '../src/jobs/runner';
import type { UserCtx } from '../src/repos/base';
import { createSource } from '../src/repos/discovery';
import { useApi } from './api';
import { sqliteOnly } from './db';
import type { TestClient } from './isolation';
import { settledOrWaiting } from './race';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

const posting = (i: number): NormalizedPosting => ({
  company: 'Initech',
  title: `Engineer ${String(i).padStart(3, '0')}`,
  descriptionMd: 'Own the platform.',
  postingUrl: `https://boards.example.com/initech/${i}`,
  externalId: `gh-${i}`,
});

/** Called before each posting is handed over, with the number of the run asking (1, 2, ...). */
type BeforePosting = (run: number, i: number) => Promise<void>;

function board(count: number, before: BeforePosting = async () => undefined): void {
  let runs = 0;
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      runs += 1;
      const run = runs;
      for (let i = 1; i <= count; i++) {
        await before(run, i);
        yield { posting: posting(i), nextCursor: null };
      }
    },
  });
}

/** Neither of two runs gets a posting until the other has asked for the same one. */
function inLockstep(): BeforePosting {
  const waiting = new Map<number, () => void>();
  return async (_run, i) => {
    const other = waiting.get(i);
    if (other !== undefined) {
      waiting.delete(i);
      other();
      return;
    }
    await new Promise<void>((resolve) => waiting.set(i, resolve));
  };
}

/** The first run stops after `stored` postings until a second run has started. */
function firstWaitsForSecondAfter(stored: number): {
  midway: Promise<void>;
  before: BeforePosting;
  /** Lets the first run go without a second, so a failing test can still stop the runner. */
  letFirstGo: () => void;
} {
  let reachedMidway!: () => void;
  const midway = new Promise<void>((resolve) => (reachedMidway = resolve));
  let secondAsked!: () => void;
  const secondStarted = new Promise<void>((resolve) => (secondAsked = resolve));
  return {
    midway,
    letFirstGo: () => secondAsked(),
    before: async (run, i) => {
      if (run === 2) secondAsked();
      if (run === 1 && i === stored + 1) {
        reachedMidway();
        await secondStarted;
      }
    },
  };
}

const aSource = (app: FastifyInstance, c: TestClient, org = 'initech') =>
  createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org },
    roleTargetId: null,
  });

/**
 * A source past its first run, so every posting is ranked: a first run sends only so many
 * (https://github.com/bgoleno/opportun/issues/215), and 'two first runs' below covers that.
 */
async function aSourceThatHasRun(app: FastifyInstance, c: TestClient) {
  const source = await aSource(app, c);
  const at = Date.now() - 86_400_000;
  await app.db
    .insert(discoveryRuns)
    .values({
      id: newId(),
      userId: c.userId,
      sourceId: source.id,
      startedAt: at,
      finishedAt: at,
      stats: null,
      error: null,
    })
    .run();
  return source;
}

/** Queues a run the way Run now does; `key` keeps a second one from being deduped into the first. */
const queueRun = (
  app: FastifyInstance,
  c: TestClient,
  sourceId: string,
  key: string,
  // Older than the rank jobs a run in progress has queued, so runNextJob takes this first.
  runAt = Date.now() - 60_000,
) =>
  enqueue(
    app.db,
    DISCOVERY_RUN_KIND,
    { sourceId },
    { dedupeKey: `${DISCOVERY_RUN_KIND}:${key}:${sourceId}`, userId: c.userId, runAt },
  );

const startRun = (app: FastifyInstance) => runNextJob(app.db, { services: app.jobs.services });

/**
 * A run of the source called directly, not through the runner, which since #269 would skip a
 * second one: two of these at once are the overlap #267's ingest lock has to hold against.
 */
const runDirectly = (app: FastifyInstance, c: TestClient, sourceId: string) =>
  runDiscoverySource(app.db, ctxOf(c), sourceId, {
    fetch: app.jobs.services.sourceFetch!,
    log: app.log,
  });

const statusesOf = async (app: FastifyInstance, ids: string[]) =>
  (await app.db.select().from(jobs).where(inArray(jobs.id, ids)).all()).map((r) => r.result);

/** Every posting stored once, one rank job for it, and one provider call once they have run. */
async function expectEachPostingOnce(
  app: FastifyInstance,
  c: TestClient,
  runIds: string[],
  count: number,
): Promise<void> {
  const titles = Array.from({ length: count }, (_, i) => posting(i + 1).title);
  const rows = await app.db
    .select({ posting: discoveryResults.posting })
    .from(discoveryResults)
    .where(eq(discoveryResults.userId, c.userId))
    .all();
  expect(rows.map((r) => r.posting.title).sort()).toEqual(titles);

  if (runIds.length > 0) {
    const runs = await app.db.select().from(jobs).where(inArray(jobs.id, runIds)).all();
    expect(runs.map((r) => r.status)).toEqual(runIds.map(() => 'done'));
  }

  const rankJobs = await app.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, DISCOVERY_RANK_KIND), eq(jobs.userId, c.userId)))
    .all();
  expect(rankJobs).toHaveLength(count);

  await app.jobs.drain();
  expect(vi.mocked(runStructured).mock.calls).toHaveLength(count);
}

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockResolvedValue({
    score: 60,
    rationale: 'A fair match.',
    disqualifiers: [],
  } as never);
});
afterEach(() => resetSources());

describe('#267: overlapping runs of one source', () => {
  it('in lockstep, each checking for each posting while the other does', async () => {
    const COUNT = 40;
    const { app, a } = await boot();
    board(COUNT, inLockstep());
    const src = await aSourceThatHasRun(app, a);

    const outcomes = await Promise.all([runDirectly(app, a, src.id), runDirectly(app, a, src.id)]);
    expect(outcomes.map((o) => o.status)).toEqual(['done', 'done']);

    await expectEachPostingOnce(app, a, [], COUNT);
  });

  it('with the second queued partway through the first, and catching it up', async () => {
    const COUNT = 60;
    const STORED_BEFORE_SECOND = 15;
    const { app, a } = await boot();
    const { midway, before, letFirstGo } = firstWaitsForSecondAfter(STORED_BEFORE_SECOND);
    board(COUNT, before);
    const src = await aSourceThatHasRun(app, a);
    const first = await queueRun(app, a, src.id, 'scheduled');
    const firstRun = startRun(app);
    await midway;
    const second = await queueRun(app, a, src.id, 'now');

    // Since #269 the second does not read the board: it records a Skipped run and ends.
    await startRun(app);
    expect(await statusesOf(app, [second])).toEqual([{ status: 'skipped', reason: 'in_progress' }]);
    letFirstGo();
    await firstRun;

    await expectEachPostingOnce(app, a, [first, second], COUNT);
  });

  it('two first runs in lockstep: each posting stored once, and 25 sent between them', async () => {
    const COUNT = 40;
    const { app, a } = await boot();
    board(COUNT, inLockstep());
    const src = await aSource(app, a);

    const outcomes = await Promise.all([runDirectly(app, a, src.id), runDirectly(app, a, src.id)]);
    // Neither died: one dying would still leave these counts.
    expect(outcomes.map((o) => o.status)).toEqual(['done', 'done']);

    const rows = await app.db
      .select({ reason: discoveryResults.rankSkipReason })
      .from(discoveryResults)
      .where(eq(discoveryResults.userId, a.userId))
      .all();
    expect(rows).toHaveLength(COUNT);
    expect(rows.filter((r) => r.reason === 'below_cut')).toHaveLength(COUNT - FIRST_RUN_RANK_CAP);
    const rankJobs = await app.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, DISCOVERY_RANK_KIND), eq(jobs.userId, a.userId)))
      .all();
    expect(rankJobs).toHaveLength(FIRST_RUN_RANK_CAP);
  });

  // What https://github.com/bgoleno/opportun/issues/263 makes reachable: the pool picks up Run now
  // during a scheduled run, where it used to wait for that run to end.
  it('through the real runner, with the second queued during the first', async () => {
    const COUNT = 60;
    const { app, a } = await boot();
    const { midway, before, letFirstGo } = firstWaitsForSecondAfter(15);
    board(COUNT, before);
    const src = await aSourceThatHasRun(app, a);
    const first = await queueRun(app, a, src.id, 'scheduled');
    const runner = startRunner(app.db, { services: app.jobs.services, intervalMs: 5 });
    let second: string;
    try {
      await midway;
      second = await queueRun(app, a, src.id, 'now');
      // Since #269 the second ends Skipped while the first is still going, without reading the
      // board; the first then goes on.
      const end = performance.now() + 15_000;
      const waitFor = async (ids: string[], what: string) => {
        for (;;) {
          const runs = await app.db
            .select({ status: jobs.status })
            .from(jobs)
            .where(inArray(jobs.id, ids))
            .all();
          if (runs.every((r) => r.status === 'done')) return;
          if (performance.now() > end) throw new Error(what);
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      await waitFor([second], 'the second run did not end');
      expect(await statusesOf(app, [second])).toEqual([
        { status: 'skipped', reason: 'in_progress' },
      ]);
      letFirstGo();
      await waitFor([first, second], 'the two runs did not finish');
    } finally {
      letFirstGo();
      await runner.stop();
    }

    await expectEachPostingOnce(app, a, [first, second], COUNT);
  });

  it('two sources with the same postings: one of each pair is the multi-posted one', async () => {
    const COUNT = 20;
    const { app, a } = await boot();
    board(COUNT, inLockstep());
    const one = await aSource(app, a, 'initech');
    const other = await aSource(app, a, 'initech-careers');
    await queueRun(app, a, one.id, 'now');
    await queueRun(app, a, other.id, 'now');

    await Promise.all([startRun(app), startRun(app)]);

    const rows = await app.db
      .select({ posting: discoveryResults.posting, rationale: discoveryResults.aiRationale })
      .from(discoveryResults)
      .where(eq(discoveryResults.userId, a.userId))
      .all();
    expect(rows).toHaveLength(2 * COUNT);
    const multiPosted = rows.filter((r) => r.rationale === MULTI_POSTED_PREFIX);
    expect(multiPosted.map((r) => r.posting.title).sort()).toEqual(
      Array.from({ length: COUNT }, (_, i) => posting(i + 1).title),
    );
  });

  // What the scope holds back, and what it must not. SQLite's write gate holds back everything, so
  // this is about the lock Postgres takes.
  describe.runIf(!sqliteOnly)('the lock, on Postgres', () => {
    it('a first run waits for the first-run lock before it decides whether it was first', async () => {
      const { app, a } = await boot();
      onSlowTransaction(() => undefined);
      board(1);
      const src = await aSource(app, a);
      let letGo!: () => void;
      const held = new Promise<void>((resolve) => (letGo = resolve));
      let locked!: () => void;
      const hasLock = new Promise<void>((resolve) => (locked = resolve));
      const holder = withTransaction(
        app.db,
        async () => {
          locked();
          await held;
        },
        { scope: `discovery.first_run:${src.id}` },
      );
      try {
        await hasLock;
        await queueRun(app, a, src.id, 'now');
        const run = startRun(app);
        expect(await settledOrWaiting(app, run)).toBe('waiting');
        letGo();
        await run;
      } finally {
        letGo();
        await holder;
      }
    });

    it('holds back that user’s runs and no other user’s', async () => {
      const { app, a, b } = await boot();
      // A transaction left open across event-loop turns on purpose.
      onSlowTransaction(() => undefined);
      board(1);
      const ofA = await aSource(app, a);
      const ofB = await aSource(app, b);
      await queueRun(app, b, ofB.id, 'now');
      let letGo!: () => void;
      const held = new Promise<void>((resolve) => (letGo = resolve));
      let locked!: () => void;
      const hasLock = new Promise<void>((resolve) => (locked = resolve));
      const holder = withTransaction(
        app.db,
        async () => {
          locked();
          await held;
        },
        { scope: `discovery.ingest:${a.userId}` },
      );
      try {
        await hasLock;
        await startRun(app);
        const ofBRows = await app.db
          .select({ id: discoveryResults.id })
          .from(discoveryResults)
          .where(eq(discoveryResults.userId, b.userId))
          .all();
        expect(ofBRows).toHaveLength(1);

        await queueRun(app, a, ofA.id, 'now');
        const runOfA = startRun(app);
        expect(await settledOrWaiting(app, runOfA)).toBe('waiting');
        letGo();
        await runOfA;
        const ofARows = await app.db
          .select({ id: discoveryResults.id })
          .from(discoveryResults)
          .where(eq(discoveryResults.userId, a.userId))
          .all();
        expect(ofARows).toHaveLength(1);
      } finally {
        letGo();
        await holder;
      }
    });
  });
});
