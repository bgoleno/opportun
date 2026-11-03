// Discovery's ranking cost and each board's posting volume, read from the app's own records
// (https://github.com/bgoleno/opportun/issues/209, #190 slice 1; tl's ruling on the issue).
// Read-only over task_runs and discovery_runs: no AI call, no outbound request, nothing stored.
// Every figure below is on fixed fixtures at a fixed "now". All data is made up.
import { newId } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { discoveryRuns, taskRuns } from '../src/db/schema';
import type { UserCtx } from '../src/repos/base';
import { createSource } from '../src/repos/discovery';
import { discoveryCostFigures } from '../src/repos/discoveryFigures';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

async function board(app: FastifyInstance, c: TestClient, org: string) {
  return await createSource(app.db, ctxOf(c), { kind: 'ats_lever', config: { org } });
}

/** A finished run of `sourceId`, started `daysAgo` before NOW, with the engine's stats. */
async function run(
  app: FastifyInstance,
  c: TestClient,
  sourceId: string,
  daysAgo: number,
  stats: { fetched: number; inserted: number } | null,
  error: string | null = null,
) {
  const startedAt = NOW - daysAgo * DAY;
  await app.db
    .insert(discoveryRuns)
    .values({
      id: newId(),
      userId: c.userId,
      sourceId,
      startedAt,
      finishedAt: startedAt + 60_000,
      stats: stats === null ? null : { ...stats, duplicates: 0, invalid: 0, suppressed: 0 },
      error,
    })
    .run();
}

/** One discovery.rank (or other) call, `daysAgo` before NOW. */
async function call(
  app: FastifyInstance,
  c: TestClient,
  daysAgo: number,
  input: number,
  output: number,
  cost: number,
  opts: { status?: 'ok' | 'error'; taskKey?: string } = {},
) {
  await app.db
    .insert(taskRuns)
    .values({
      id: newId(),
      userId: c.userId,
      taskKey: opts.taskKey ?? 'discovery.rank',
      provider: 'anthropic',
      model: 'placeholder-model',
      inputTokens: input,
      outputTokens: output,
      estCost: cost,
      status: opts.status ?? 'ok',
      createdAt: NOW - daysAgo * DAY,
    })
    .run();
}

describe('#209: discovery.rank over the last 7 and 30 days', () => {
  it('no calls: zero calls, and no percentile or average invented', async () => {
    const { app, a } = await boot();
    const figures = await discoveryCostFigures(app.db, ctxOf(a), NOW);
    expect(figures.rank).toEqual([
      {
        days: 7,
        calls: 0,
        errors: 0,
        inputTokens: null,
        outputTokens: null,
        avgCostUsd: null,
        totalCostUsd: 0,
      },
      {
        days: 30,
        calls: 0,
        errors: 0,
        inputTokens: null,
        outputTokens: null,
        avgCostUsd: null,
        totalCostUsd: 0,
      },
    ]);
  });

  it('calls, errors, median and 90th percentile tokens, the ok-only average and the total cost', async () => {
    const { app, a, b } = await boot();
    for (const [i, cost] of [0.001, 0.002, 0.003, 0.004].entries()) {
      await call(app, a, 1 + i, (i + 1) * 100, (i + 1) * 10, cost);
    }
    await call(app, a, 2, 50, 0, 0.0005, { status: 'error' }); // spends, but is not a ranking
    await call(app, a, 20, 1000, 100, 0.01); // inside 30 days only
    await call(app, a, 40, 9999, 999, 9); // outside both windows
    await call(app, a, 1, 9999, 999, 9, { taskKey: 'comms.classify' }); // another task
    await call(app, b, 1, 9999, 999, 9); // another user
    const [d7, d30] = (await discoveryCostFigures(app.db, ctxOf(a), NOW)).rank;
    expect(d7).toMatchObject({
      days: 7,
      calls: 5,
      errors: 1,
      inputTokens: { median: 250, p90: 400 },
      outputTokens: { median: 25, p90: 40 },
    });
    expect(d7!.avgCostUsd).toBeCloseTo(0.0025, 10);
    expect(d7!.totalCostUsd).toBeCloseTo(0.0105, 10);
    expect(d30).toMatchObject({
      days: 30,
      calls: 6,
      errors: 1,
      inputTokens: { median: 300, p90: 1000 },
      outputTokens: { median: 30, p90: 100 },
    });
    expect(d30!.avgCostUsd).toBeCloseTo(0.004, 10);
    expect(d30!.totalCostUsd).toBeCloseTo(0.0205, 10);
  });

  it('one call: it is its own median and 90th percentile', async () => {
    const { app, a } = await boot();
    await call(app, a, 3, 700, 70, 0.002);
    const [d7] = (await discoveryCostFigures(app.db, ctxOf(a), NOW)).rank;
    expect(d7).toMatchObject({
      calls: 1,
      inputTokens: { median: 700, p90: 700 },
      outputTokens: { median: 70, p90: 70 },
      avgCostUsd: 0.002,
    });
  });
});

describe('#209: each board source, over the last 14 days', () => {
  it('a source with runs before and inside the window: a full 14 days, its first run long gone', async () => {
    const { app, a } = await boot();
    const s = await board(app, a, 'initech');
    await run(app, a, s.id, 30, { fetched: 400, inserted: 400 }); // first run: the backfill
    await run(app, a, s.id, 20, { fetched: 110, inserted: 50 }); // older than the window
    await run(app, a, s.id, 10, { fetched: 115, inserted: 4 });
    await run(app, a, s.id, 5, { fetched: 118, inserted: 2 });
    await run(app, a, s.id, 1, { fetched: 120, inserted: 1 });
    await call(app, a, 2, 100, 10, 0.004); // 30-day average cost per call: 0.004
    const [row] = (await discoveryCostFigures(app.db, ctxOf(a), NOW)).sources;
    expect(row).toMatchObject({ sourceId: s.id, kind: 'ats_lever', openJobs: 120, days: 14 });
    expect(row!.newPerDay).toBeCloseTo(7 / 14, 10);
    expect(row!.rankCallsPerDay).toBeCloseTo(7 / 14, 10);
    expect(row!.costPerDayUsd).toBeCloseTo((7 / 14) * 0.004, 10);
  });

  it('a source first run 6 days ago: its backfill is left out, and the window is 6 days', async () => {
    const { app, a } = await boot();
    const s = await board(app, a, 'globex');
    await run(app, a, s.id, 6, { fetched: 300, inserted: 300 });
    await run(app, a, s.id, 3, { fetched: 304, inserted: 6 });
    await run(app, a, s.id, 1, { fetched: 306, inserted: 3 });
    const [row] = (await discoveryCostFigures(app.db, ctxOf(a), NOW)).sources;
    expect(row).toMatchObject({ openJobs: 306, days: 6 });
    expect(row!.newPerDay).toBeCloseTo(9 / 6, 10);
    // No ranking calls in 30 days: no cost per day can be said.
    expect(row!.costPerDayUsd).toBeNull();
  });

  it('a source with only its first run: open jobs, but no rate yet', async () => {
    const { app, a } = await boot();
    const s = await board(app, a, 'hooli');
    await run(app, a, s.id, 2, { fetched: 80, inserted: 80 });
    await call(app, a, 2, 100, 10, 0.004);
    const [row] = (await discoveryCostFigures(app.db, ctxOf(a), NOW)).sources;
    expect(row).toEqual({
      sourceId: s.id,
      kind: 'ats_lever',
      openJobs: 80,
      newPerDay: null,
      days: 0,
      rankCallsPerDay: null,
      costPerDayUsd: null,
    });
  });

  it('a source with no runs: nothing at all, never a zero', async () => {
    const { app, a } = await boot();
    const s = await board(app, a, 'umbrella');
    const [row] = (await discoveryCostFigures(app.db, ctxOf(a), NOW)).sources;
    expect(row).toEqual({
      sourceId: s.id,
      kind: 'ats_lever',
      openJobs: null,
      newPerDay: null,
      days: 0,
      rankCallsPerDay: null,
      costPerDayUsd: null,
    });
  });

  // A failed run finishes with the stats it reached and an error, as discoveryRun.ts's catch
  // block writes it (tl on #212), never with no stats.
  it('open jobs come from the newest run that succeeded, past a failed one', async () => {
    const { app, a } = await boot();
    const s = await board(app, a, 'vandelay');
    await run(app, a, s.id, 4, { fetched: 90, inserted: 90 });
    await run(app, a, s.id, 2, { fetched: 92, inserted: 2 });
    await run(app, a, s.id, 1, { fetched: 0, inserted: 0 }, 'the board answered 503');
    const [row] = (await discoveryCostFigures(app.db, ctxOf(a), NOW)).sources;
    expect(row).toMatchObject({ openJobs: 92, days: 4 });
    expect(row!.newPerDay).toBeCloseTo(2 / 4, 10);
  });

  it('a failed first run, then the real backfill: the backfill and all before it are left out (tl on #212)', async () => {
    const { app, a } = await boot();
    const s = await board(app, a, 'acme');
    await run(app, a, s.id, 10, { fetched: 3, inserted: 3 }, 'the board stopped answering');
    await run(app, a, s.id, 8, { fetched: 300, inserted: 297 }); // the backfill
    await run(app, a, s.id, 4, { fetched: 304, inserted: 5 });
    await run(app, a, s.id, 1, { fetched: 305, inserted: 2 });
    const [row] = (await discoveryCostFigures(app.db, ctxOf(a), NOW)).sources;
    expect(row).toMatchObject({ openJobs: 305, days: 8 });
    expect(row!.newPerDay).toBeCloseTo(7 / 8, 10);
  });

  it('a source whose runs have all failed: no open jobs and no rate', async () => {
    const { app, a } = await boot();
    const s = await board(app, a, 'cyberdyne');
    await run(app, a, s.id, 3, { fetched: 0, inserted: 0 }, 'the board answered 404');
    await run(app, a, s.id, 1, { fetched: 12, inserted: 12 }, 'the board stopped answering');
    const [row] = (await discoveryCostFigures(app.db, ctxOf(a), NOW)).sources;
    expect(row).toMatchObject({ openJobs: null, newPerDay: null, days: 0 });
  });

  it("only board sources are listed, and only the caller's", async () => {
    const { app, a, b } = await boot();
    const mine = await board(app, a, 'initech');
    await createSource(app.db, ctxOf(a), { kind: 'manual', config: {} });
    await board(app, b, 'globex');
    const figures = await discoveryCostFigures(app.db, ctxOf(a), NOW);
    expect(figures.sources.map((s) => s.sourceId)).toEqual([mine.id]);
  });
});

describe('#209: GET /discovery/cost-figures', () => {
  it("answers the caller's figures, and never another user's", async () => {
    const { app, a, b } = await boot();
    const s = await board(app, a, 'initech');
    await board(app, b, 'globex');
    const res = await a.request({ method: 'GET', url: '/api/v1/discovery/cost-figures' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ rank: { days: number }[]; sources: { sourceId: string }[] }>();
    expect(body.rank.map((r) => r.days)).toEqual([7, 30]);
    expect(body.sources.map((x) => x.sourceId)).toEqual([s.id]);
  });
});
