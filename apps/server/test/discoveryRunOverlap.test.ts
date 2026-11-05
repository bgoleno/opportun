// Two overlapping runs of one source store each posting once, and make one ranking call for it
// (https://github.com/bgoleno/opportun/issues/267). Run now and the schedule have different dedupe
// keys, so neither stops the other. ingest checks then inserts and discovery_results has no unique
// index: on Postgres only a scope lock keeps the two apart (SQLite's write gate already does).
// runNextJob starts each run here, so the overlap does not depend on when the pool looks for work.
// The provider is mocked and every posting is made up.
import { runStructured } from '@opportun/ai';
import type { NormalizedPosting } from '@opportun/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSource, resetSources } from '../src/adapters/discoverySource';
import { withTransaction } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import { discoveryResults, jobs } from '../src/db/schema';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import { enqueue, runNextJob } from '../src/jobs/runner';
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

const aSource = (app: FastifyInstance, c: TestClient) =>
  createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: 'initech' },
    roleTargetId: null,
  });

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

  const runs = await app.db.select().from(jobs).where(inArray(jobs.id, runIds)).all();
  expect(runs.map((r) => r.status)).toEqual(runIds.map(() => 'done'));

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
    // Neither run gets a posting until the other has asked for the same one.
    const waiting = new Map<number, () => void>();
    board(COUNT, async (_run, i) => {
      const other = waiting.get(i);
      if (other !== undefined) {
        waiting.delete(i);
        other();
        return;
      }
      await new Promise<void>((resolve) => waiting.set(i, resolve));
    });
    const src = await aSource(app, a);
    const ids = [
      await queueRun(app, a, src.id, 'now'),
      await queueRun(app, a, src.id, 'scheduled'),
    ];

    await Promise.all([startRun(app), startRun(app)]);

    await expectEachPostingOnce(app, a, ids, COUNT);
  });

  it('with the second queued partway through the first, and catching it up', async () => {
    const COUNT = 60;
    const STORED_BEFORE_SECOND = 15;
    const { app, a } = await boot();
    let reachedMidway!: () => void;
    const midway = new Promise<void>((resolve) => (reachedMidway = resolve));
    let secondAsked!: () => void;
    const secondStarted = new Promise<void>((resolve) => (secondAsked = resolve));
    board(COUNT, async (run, i) => {
      if (run === 2) secondAsked();
      if (run === 1 && i === STORED_BEFORE_SECOND + 1) {
        reachedMidway();
        await secondStarted;
      }
    });
    const src = await aSource(app, a);
    const first = await queueRun(app, a, src.id, 'scheduled');
    const firstRun = startRun(app);
    await midway;
    const second = await queueRun(app, a, src.id, 'now');

    await Promise.all([firstRun, startRun(app)]);

    await expectEachPostingOnce(app, a, [first, second], COUNT);
  });

  // What the scope holds back, and what it must not. SQLite's write gate holds back everything, so
  // this is about the lock Postgres takes.
  describe.runIf(!sqliteOnly)('the lock, on Postgres', () => {
    it('holds back that user’s runs, of any source, and no other user’s', async () => {
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
