// #186: a performance baseline at the data scale the owner is actually at tonight (4,504
// communications, 145 opportunities, 272 pending discovery results, on Postgres), not an
// empty database. CI exercises every route against a database created fresh for the test;
// what it never exercises is one that has been in use, so a query that is fine on ten rows
// and quadratic on ten thousand passes every check that already exists.
//
// Measurement only, per the issue's own instruction: nothing here is a fix, and nothing here
// skips the dedupe heuristic or any other real code path to make a number look better. If
// something here is quadratic, it gets filed with the evidence in a separate issue, not fixed
// in this diff.
//
// Opt-in, not part of the default suite: seeding thousands of rows would slow every run down
// for a check that is not a correctness gate, and the project is actively minimizing CI cost
// tonight. Run with:
//   RUN_SCALE_BASELINE=1 npx vitest run test/scaleBaseline.test.ts
//   DB_DIALECT=postgres TEST_DB_DIALECT=postgres TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
//     RUN_SCALE_BASELINE=1 npx vitest run test/scaleBaseline.test.ts
//
// Issue #72 (flaky timing assertions under a loaded machine) applies here as much as anywhere
// a wall clock is read: a single run is not a measurement. Every number reported on #186 was
// taken more than once, including once that reproduced #72's own contention signature (a
// run 10-20x slower than every other run of the same test, on the same machine, moments
// apart) and was discarded for exactly that reason rather than averaged in or cherry-picked
// around.
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  communications,
  companies,
  discoveryResults,
  discoveryRuns,
  discoverySources,
  opportunities,
} from '../src/db/schema';
import { listCommunications } from '../src/repos/communications';
import { listResults } from '../src/repos/discovery';
import { createOpportunity, listOpportunities } from '../src/repos/opportunities';
import { indexOpportunity, search } from '../src/repos/search';
import type { Db } from '../src/db/client';
import { registerTwoUsers, type TestClient } from './isolation';
import { testApp } from './helpers';
import { expectLinearAsync } from './scaling';
import {
  buildScaleDataset,
  hotCompanyName,
  randomTitle,
  type ScaleDataset,
} from './scaleBaseline/seedData';

const RUN = process.env.RUN_SCALE_BASELINE === '1';
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

/**
 * node-postgres and better-sqlite3 both reject a statement with too many bound parameters
 * well before a few hundred thousand; chunking keeps every insert clear of either limit
 * regardless of how wide a row is, rather than tuning the chunk size per table.
 */
async function insertChunked<T>(
  db: Db,
  table: Parameters<Db['insert']>[0],
  rows: readonly T[],
  chunk = 300,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    // values() accepts this table's own row shape; the generic Db/table pairing this helper
    // exists to cover is not expressible without the cast below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db.insert(table) as any).values(rows.slice(i, i + chunk)).run();
  }
}

/** Seeds one source + one run (discovery_results.run_id's FK chain) and the dataset's
 *  companies/opportunities/discoveryResults/communications, bulk-inserted directly rather
 *  than through createOpportunity/upsertInbound: this is seeding, not the thing being
 *  measured, and going through the real repo functions would spend real time running
 *  detectDedupeCandidates on every one of the 145 seeded opportunities against each other,
 *  which is exactly the cost this file isolates and measures separately, deliberately, later.
 */
async function seed(db: Db, userId: string, dataset: ScaleDataset): Promise<void> {
  if (dataset.companies.length > 0) await insertChunked(db, companies, dataset.companies);
  if (dataset.opportunities.length > 0) {
    await insertChunked(db, opportunities, dataset.opportunities);
  }
  if (dataset.discoveryResults.length > 0) {
    const sourceId = newIdFor('source');
    const runId = dataset.discoveryResults[0]?.runId;
    if (runId !== undefined) {
      const now = Date.now();
      await db
        .insert(discoverySources)
        .values({
          id: sourceId,
          userId,
          kind: 'manual',
          config: {},
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await db
        .insert(discoveryRuns)
        .values({ id: runId, userId, sourceId, startedAt: now, finishedAt: now })
        .run();
    }
    await insertChunked(db, discoveryResults, dataset.discoveryResults);
  }
  if (dataset.communications.length > 0) {
    await insertChunked(db, communications, dataset.communications);
  }
  // search_index is populated at write time by the real ingest/create paths; bulk inserts
  // above skip it, so the search benchmark below would find nothing without this. Scoped to
  // the opportunities corpus only (issue #186 asks for search's shape, not a second seeding
  // pass over several thousand communications whose own cost is not what search measures).
  const ctx = ctxOf({ userId } as TestClient);
  for (const o of dataset.opportunities) {
    await indexOpportunity(db, ctx, { id: o.id, title: o.title, descriptionMd: null });
  }
}

let idCounter = 0;
function newIdFor(label: string): string {
  idCounter += 1;
  return `seed-${label}-${idCounter}`;
}

async function boot(): Promise<{ app: FastifyInstance; a: TestClient }> {
  const { app } = await testApp();
  const { a } = await registerTwoUsers(app);
  return { app, a };
}

describe.skipIf(!RUN)('performance baseline at realistic data scale (issue #186)', () => {
  it("createOpportunity (accept's own dedupe scan) grows with the user's total opportunity count, not with a constant", async () => {
    const smallApp = await boot();
    const largeApp = await boot();
    try {
      await seed(
        smallApp.app.db,
        smallApp.a.userId,
        buildScaleDataset(smallApp.a.userId, 0.25, 11),
      );
      await seed(largeApp.app.db, largeApp.a.userId, buildScaleDataset(largeApp.a.userId, 1, 12));

      let n = 0;
      const smallMs: number[] = [];
      const largeMs: number[] = [];
      // hotCompanyName(0) deliberately lands in the seeded cluster every time, so
      // findMatches' companyMatchKey check hits and titleOverlap actually runs, the cost this
      // is measuring; location carries the counter so dedupeKey can never collide with a
      // seeded row or an earlier repetition, title and company otherwise do not need to vary
      // at all for that.
      async function createOne(app: FastifyInstance, a: TestClient, into: number[]): Promise<void> {
        n += 1;
        const started = performance.now();
        await createOpportunity(app.db, ctxOf(a), {
          companyName: hotCompanyName(0),
          title: randomTitle(0),
          location: `Baseline measurement ${n}`,
          sourceKind: 'manual',
        });
        into.push(performance.now() - started);
      }
      await expectLinearAsync({
        label: "createOpportunity against a seeded opportunity list (findMatches' own loop)",
        factor: 4,
        ceilingMs: 20_000,
        runs: 3,
        small: () => createOne(smallApp.app, smallApp.a, smallMs),
        large: () => createOne(largeApp.app, largeApp.a, largeMs),
      });
      console.log(
        `[#186] createOpportunity / dialect ${process.env.TEST_DB_DIALECT ?? 'sqlite'}: ` +
          `~36 opportunities ${Math.min(...smallMs).toFixed(1)} ms, ~145 opportunities ${Math.min(...largeMs).toFixed(1)} ms ` +
          `(ratio ${(Math.min(...largeMs) / Math.min(...smallMs)).toFixed(2)}x for a 4x increase in opportunity count)`,
      );
    } finally {
      await smallApp.app.close();
      await largeApp.app.close();
    }
  }, 120_000);

  it("a single accept over HTTP, at the owner's real opportunity count, costs this many ms", async () => {
    const { app, a } = await boot();
    try {
      const dataset = buildScaleDataset(a.userId, 1, 21);
      await seed(app.db, a.userId, dataset);
      // Spare pending results reserved for this test's own repeated accept calls, kept out of
      // the 272 counted toward the realistic queue size above (accept mutates disposition, so
      // the same result id cannot be reused across repetitions).
      const runId = dataset.discoveryResults[0]!.runId;
      const spareIds = [0, 1, 2].map((i) => `spare-accept-${i}`);
      await insertChunked(
        app.db,
        discoveryResults,
        spareIds.map((id, i) => ({
          ...dataset.discoveryResults[i % dataset.discoveryResults.length]!,
          id,
          runId,
        })),
      );

      const ms: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const started = performance.now();
        const res = await a.request({
          method: 'POST',
          url: `/api/v1/discovery/results/spare-accept-${i}/accept`,
          payload: {},
        });
        ms.push(performance.now() - started);
        expect(res.statusCode, res.body).toBe(200);
      }
      const fastest = Math.min(...ms);
      console.log(
        `[#186] single accept at 145 opportunities / dialect ${process.env.TEST_DB_DIALECT ?? 'sqlite'}: ${fastest.toFixed(1)} ms (reps: ${ms.map((m) => m.toFixed(1)).join(', ')})`,
      );
      expect(fastest).toBeLessThan(5_000);
    } finally {
      await app.close();
    }
  }, 60_000);

  it("a single dismiss over HTTP, at the owner's real queue size, costs this many ms", async () => {
    const { app, a } = await boot();
    try {
      const dataset = buildScaleDataset(a.userId, 1, 22);
      await seed(app.db, a.userId, dataset);
      for (let i = 0; i < 3; i += 1) {
        await insertChunked(app.db, discoveryResults, [
          {
            ...dataset.discoveryResults[i % dataset.discoveryResults.length]!,
            id: `spare-dismiss-${i}`,
            runId: dataset.discoveryResults[0]!.runId,
          },
        ]);
      }
      const ms: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const started = performance.now();
        const res = await a.request({
          method: 'POST',
          url: `/api/v1/discovery/results/spare-dismiss-${i}/dismiss`,
          payload: { reason: 'role_fit' },
        });
        ms.push(performance.now() - started);
        expect(res.statusCode, res.body).toBe(200);
      }
      const fastest = Math.min(...ms);
      console.log(
        `[#186] single dismiss at 272-item queue / dialect ${process.env.TEST_DB_DIALECT ?? 'sqlite'}: ${fastest.toFixed(1)} ms`,
      );
      expect(fastest).toBeLessThan(5_000);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('the discovery review queue listing stays linear from a quarter of real volume to all of it', async () => {
    const smallApp = await boot();
    const largeApp = await boot();
    try {
      await seed(
        smallApp.app.db,
        smallApp.a.userId,
        buildScaleDataset(smallApp.a.userId, 0.25, 31),
      );
      await seed(largeApp.app.db, largeApp.a.userId, buildScaleDataset(largeApp.a.userId, 1, 32));
      await expectLinearAsync({
        label: 'listResults (review queue, page of 50, default -ai_score sort)',
        factor: 4,
        ceilingMs: 5_000,
        small: () => listResults(smallApp.app.db, ctxOf(smallApp.a), { limit: 50, offset: 0 }),
        large: () => listResults(largeApp.app.db, ctxOf(largeApp.a), { limit: 50, offset: 0 }),
      });
    } finally {
      await smallApp.app.close();
      await largeApp.app.close();
    }
  }, 60_000);

  it('the inbox listing stays linear from a quarter of real volume to all of it', async () => {
    const smallApp = await boot();
    const largeApp = await boot();
    try {
      await seed(
        smallApp.app.db,
        smallApp.a.userId,
        buildScaleDataset(smallApp.a.userId, 0.25, 41),
      );
      await seed(largeApp.app.db, largeApp.a.userId, buildScaleDataset(largeApp.a.userId, 1, 42));
      await expectLinearAsync({
        label: 'listCommunications (inbox, "all" view, page of 50)',
        factor: 4,
        ceilingMs: 5_000,
        small: () =>
          listCommunications(smallApp.app.db, ctxOf(smallApp.a), {
            view: 'all',
            limit: 50,
            offset: 0,
          }),
        large: () =>
          listCommunications(largeApp.app.db, ctxOf(largeApp.a), {
            view: 'all',
            limit: 50,
            offset: 0,
          }),
      });
    } finally {
      await smallApp.app.close();
      await largeApp.app.close();
    }
  }, 60_000);

  it('the pipeline listing stays linear from a quarter of real volume to all of it', async () => {
    const smallApp = await boot();
    const largeApp = await boot();
    try {
      await seed(
        smallApp.app.db,
        smallApp.a.userId,
        buildScaleDataset(smallApp.a.userId, 0.25, 51),
      );
      await seed(largeApp.app.db, largeApp.a.userId, buildScaleDataset(largeApp.a.userId, 1, 52));
      await expectLinearAsync({
        label: 'listOpportunities (pipeline, page of 50)',
        factor: 4,
        ceilingMs: 5_000,
        small: () =>
          listOpportunities(smallApp.app.db, ctxOf(smallApp.a), { limit: 50, offset: 0 }),
        large: () =>
          listOpportunities(largeApp.app.db, ctxOf(largeApp.a), { limit: 50, offset: 0 }),
      });
    } finally {
      await smallApp.app.close();
      await largeApp.app.close();
    }
  }, 60_000);

  it('search over the realistic opportunity corpus costs this many ms', async () => {
    const { app, a } = await boot();
    try {
      const dataset = buildScaleDataset(a.userId, 1, 61);
      await seed(app.db, a.userId, dataset);
      const q = randomTitle(1).split(' ')[0] ?? 'Engineer';
      const ms: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const started = performance.now();
        await search(app.db, ctxOf(a), q, { limit: 20, offset: 0 });
        ms.push(performance.now() - started);
      }
      const fastest = Math.min(...ms);
      console.log(
        `[#186] search over 145 opportunities / dialect ${process.env.TEST_DB_DIALECT ?? 'sqlite'}: ${fastest.toFixed(1)} ms`,
      );
      expect(fastest).toBeLessThan(5_000);
    } finally {
      await app.close();
    }
  }, 60_000);

  /**
   * #184's own number: a synchronous bulk accept, cap items in one request, each one paying
   * findMatches' full-table scan against a baseline that grows by one with every create this
   * same batch has already landed. There is no bulk endpoint yet to call over HTTP, so this
   * calls createOpportunity directly, cap times in a row, which is exactly the loop a
   * synchronous bulk endpoint would run.
   */
  it('a 50-item bulk accept, simulated directly against the real 145-opportunity baseline, costs this in total', async () => {
    const { app, a } = await boot();
    try {
      const dataset = buildScaleDataset(a.userId, 1, 71);
      await seed(app.db, a.userId, dataset);
      const CAP = 50;
      const perItemMs: number[] = [];
      const batchStarted = performance.now();
      for (let i = 0; i < CAP; i += 1) {
        const started = performance.now();
        await createOpportunity(app.db, ctxOf(a), {
          companyName: hotCompanyName(0),
          title: randomTitle(0),
          location: `Bulk simulation ${i}`,
          sourceKind: 'manual',
        });
        perItemMs.push(performance.now() - started);
      }
      const totalMs = performance.now() - batchStarted;
      const first10Avg = perItemMs.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
      const last10Avg = perItemMs.slice(-10).reduce((a, b) => a + b, 0) / 10;
      console.log(
        `[#186] simulated bulk accept, ${CAP} items / dialect ${process.env.TEST_DB_DIALECT ?? 'sqlite'}: ` +
          `${totalMs.toFixed(0)} ms total, ${(totalMs / CAP).toFixed(1)} ms/item average, ` +
          `first 10 avg ${first10Avg.toFixed(1)} ms, last 10 avg ${last10Avg.toFixed(1)} ms ` +
          `(baseline grew from 145 to ${145 + CAP} opportunities over the batch)`,
      );
      expect(totalMs).toBeLessThan(30_000);
    } finally {
      await app.close();
    }
  }, 60_000);
});
