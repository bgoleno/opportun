// The discovery budget (https://github.com/bgoleno/opportun/issues/214, #190 N1a; the owner's
// decision 2): a budget the user sets, default $1 a day. Over it a posting waits and is ranked on
// the next budget day, oldest first; nothing is ever skipped for budget. The provider is mocked
// and every posting is made up.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import { newId, type NormalizedPosting } from '@opportun/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { discoveryResults, jobs, taskRuns } from '../src/db/schema';
import { DISCOVERY_RANK_KIND, rankResult } from '../src/jobs/discoveryRank';
import {
  drainWaitingResults,
  RANK_WAITING_KIND,
  sweepWaitingResults,
} from '../src/jobs/discoveryRankWaiting';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import { enqueue, runNextJob, startRunner } from '../src/jobs/runner';
import type { UserCtx } from '../src/repos/base';
import { createSource, listResults, setDisposition, setRanking } from '../src/repos/discovery';
import { DEFAULT_DISCOVERY_DAILY_USD, writeDiscoveryBudget } from '../src/repos/discoveryBudget';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { holdAt } from './race';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
const PAGE = { limit: 200, offset: 0 };
const DAY = 86_400_000;
const CALL_USD = 0.01;

beforeEach(() => vi.mocked(runStructured).mockReset());
afterEach(() => {
  vi.useRealTimers();
  resetSources();
});

const posting = (i: number): NormalizedPosting => ({
  company: 'Initech',
  title: `Engineer ${String(i).padStart(3, '0')}`,
  descriptionMd: 'Own the platform.',
  postingUrl: `https://boards.example.com/initech/${i}`,
  externalId: `gh-${i}`,
});

/** Stores `count` postings, and leaves their rank jobs queued. */
async function discoverQueued(app: FastifyInstance, c: TestClient, count: number): Promise<void> {
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      for (let i = 1; i <= count; i++) yield { posting: posting(i), nextCursor: null };
    },
  } satisfies DiscoverySource);
  const src = await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: 'initech' },
    roleTargetId: null,
  });
  await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: c.userId });
  await runNextJob(app.db, { services: app.jobs.services });
}

async function discover(app: FastifyInstance, c: TestClient, count = 1): Promise<void> {
  await discoverQueued(app, c, count);
  await app.jobs.drain();
}

const results = async (app: FastifyInstance, c: TestClient) =>
  (await listResults(app.db, ctxOf(c), PAGE)).items;

/** A recorded ranking call, as the router writes one. */
async function spend(app: FastifyInstance, c: TestClient, usd: number, at = Date.now()) {
  await app.db
    .insert(taskRuns)
    .values({
      id: newId(),
      userId: c.userId,
      taskKey: DISCOVERY_RANK_KIND,
      provider: 'openai',
      model: 'placeholder-model',
      inputTokens: 100,
      outputTokens: 10,
      estCost: usd,
      fallbackPricing: false,
      durationMs: 1,
      status: 'ok',
      error: null,
      createdAt: at,
    })
    .run();
}

/** The provider answers after a tick, and the call is on the ledger only when it ends. */
function providerCharges(app: FastifyInstance, c: TestClient): { titles: string[] } {
  const titles: string[] = [];
  vi.mocked(runStructured).mockImplementation(async (_deps, _task, opts) => {
    titles.push(/Title: (.*)/.exec(opts.system)?.[1] ?? '');
    await new Promise((resolve) => setImmediate(resolve));
    await spend(app, c, CALL_USD);
    return { score: 60, rationale: 'A fair match.', disqualifiers: [] } as never;
  });
  return { titles };
}

const getBudget = async (c: TestClient) => {
  const res = await c.request({ method: 'GET', url: '/api/v1/ai/discovery-budget' });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{
    dailyUsd: number;
    spentTodayUsd: number;
    waiting: number;
    perTaskDailyUsd: number;
  }>();
};
const putBudget = (c: TestClient, dailyUsd: unknown) =>
  c.request({ method: 'PUT', url: '/api/v1/ai/discovery-budget', payload: { dailyUsd } });

describe('#214 criterion 1 and 6: the setting and AI usage', () => {
  it('defaults to $1.00 a day, with no spend and nothing waiting', async () => {
    const { a } = await boot();
    expect(DEFAULT_DISCOVERY_DAILY_USD).toBe(1);
    expect(await getBudget(a)).toEqual({
      dailyUsd: 1,
      spentTodayUsd: 0,
      waiting: 0,
      perTaskDailyUsd: 5,
    });
  });

  it('the user sets it, for themselves only', async () => {
    const { a, b } = await boot();
    const res = await putBudget(a, 2.5);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ dailyUsd: number }>().dailyUsd).toBe(2.5);
    expect((await getBudget(a)).dailyUsd).toBe(2.5);
    expect((await getBudget(b)).dailyUsd).toBe(1);
  });

  for (const bad of [0, -1, 100_001, 'lots', null]) {
    it(`refuses ${JSON.stringify(bad)}`, async () => {
      const { a } = await boot();
      expect((await putBudget(a, bad)).statusCode).toBe(400);
      expect((await getBudget(a)).dailyUsd).toBe(1);
    });
  }

  it('needs a session', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'GET', url: '/api/v1/ai/discovery-budget' });
    expect(res.statusCode).toBe(401);
  });

  it("spend today is the caller's discovery.rank on this UTC day", async () => {
    const { app, a, b } = await boot();
    const now = Date.now();
    await spend(app, a, 0.25, now);
    await spend(app, a, 0.5, Math.floor(now / DAY) * DAY); // the day's first moment
    await spend(app, a, 9, Math.floor(now / DAY) * DAY - 1); // yesterday
    await spend(app, b, 9, now); // another user
    await spend(app, a, 0.125, now); // another task:
    await app.db
      .update(taskRuns)
      .set({ taskKey: 'comms.classify' })
      .where(eq(taskRuns.estCost, 0.125))
      .run();
    expect((await getBudget(a)).spentTodayUsd).toBeCloseTo(0.75, 10);
  });

  it('waiting counts distinct postings: one deferred twice is one', async () => {
    const { app, a } = await boot();
    await spend(app, a, 1);
    await discover(app, a);
    const [r] = await results(app, a);
    const first = r!.rankDeferredAt;
    expect(first).not.toBeNull();
    await enqueue(app.db, DISCOVERY_RANK_KIND, { resultId: r!.id }, { userId: a.userId });
    await app.jobs.drain();
    expect((await getBudget(a)).waiting).toBe(1);
    // It keeps its first deferral.
    expect((await results(app, a))[0]!.rankDeferredAt).toBe(first);
  });
});

describe('#214 criterion 2 and 5: running out defers, never skips', () => {
  it('with the budget spent: no provider call, no ledger row, and the posting waits', async () => {
    const { app, a } = await boot();
    await spend(app, a, 1);
    await discover(app, a);
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
    const [r] = await results(app, a);
    expect(r).toMatchObject({ aiScore: null, disposition: 'pending', rankSkipReason: null });
    expect(r!.rankDeferredAt).toEqual(expect.any(Number));
    const ledger = await app.db.select().from(taskRuns).where(eq(taskRuns.userId, a.userId)).all();
    expect(ledger).toHaveLength(1); // only the spend this test seeded
    // The API carries it to the card.
    const listed = await a.request({
      method: 'GET',
      url: '/api/v1/discovery/results?disposition=pending',
    });
    expect(listed.json().items[0].rankDeferredAt).toEqual(expect.any(Number));
  });

  it('just under the budget, the call goes ahead', async () => {
    const { app, a } = await boot();
    await spend(app, a, 0.99);
    providerCharges(app, a);
    await discover(app, a);
    expect((await results(app, a))[0]).toMatchObject({ aiScore: 60, rankDeferredAt: null });
  });

  it('the $5 per-task hard stop still stands behind a larger budget, and it defers too', async () => {
    const { app, a } = await boot();
    await writeDiscoveryBudget(app.db, ctxOf(a), 20);
    await spend(app, a, 6);
    vi.mocked(runStructured).mockRejectedValueOnce(new AiUnavailableError('budget_exceeded'));
    await discover(app, a);
    expect(vi.mocked(runStructured)).toHaveBeenCalledOnce();
    const [r] = await results(app, a);
    expect(r).toMatchObject({ aiScore: null, rankSkipReason: null, disposition: 'pending' });
    expect(r!.rankDeferredAt).toEqual(expect.any(Number));
  });

  it('other refusals are not budget: the reason is kept and nothing waits', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockRejectedValueOnce(new AiUnavailableError('provider_error'));
    await discover(app, a);
    expect((await results(app, a))[0]).toMatchObject({
      rankSkipReason: 'provider_error',
      rankDeferredAt: null,
    });
    expect((await getBudget(a)).waiting).toBe(0);
  });
});

describe('#214 criterion 3: deferred postings are ranked on the next budget day, oldest first', () => {
  /** Waiting postings, oldest first by a known createdAt, on a day whose budget is spent. */
  async function waitingPostings(app: FastifyInstance, c: TestClient, count: number) {
    const today = Math.floor(Date.now() / DAY) * DAY;
    vi.useFakeTimers({ now: today + 3_600_000, toFake: ['Date'] });
    await writeDiscoveryBudget(app.db, ctxOf(c), 2 * CALL_USD);
    await spend(app, c, 2 * CALL_USD);
    await discover(app, c, count);
    const rows = await results(app, c);
    // Oldest is the highest number here, so the order is not an accident of insertion.
    for (const row of rows) {
      const n = Number(row.posting.title.split(' ')[1]);
      await app.db
        .update(discoveryResults)
        .set({ createdAt: today + 60_000 * (count - n) })
        .where(eq(discoveryResults.id, row.id))
        .run();
    }
    return today;
  }

  it('stays waiting across the day boundary until a sweep, then ranks oldest first up to the budget', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 5);
    const { titles } = providerCharges(app, a);

    // Still today: the sweep has no room, so it queues nothing and calls nothing.
    await sweepWaitingResults(app.db);
    expect(await app.db.select().from(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).all()).toEqual(
      [],
    );
    expect(titles).toEqual([]);

    // The next UTC day: the wait is still there, unchanged, until something ranks it.
    vi.setSystemTime(today + DAY + 60_000);
    expect((await getBudget(a)).waiting).toBe(5);
    expect((await getBudget(a)).spentTodayUsd).toBe(0);
    await sweepWaitingResults(app.db);
    const queued = await app.db.select().from(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).all();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ userId: a.userId, status: 'pending' });

    const first = await drainWaitingResults(app.db, ctxOf(a));
    expect(first).toMatchObject({ ranked: 2, stopped: 'budget_exceeded' });
    expect(titles).toEqual(['Engineer 005', 'Engineer 004']);
    expect((await getBudget(a)).waiting).toBe(3);

    // Each following day takes the next ones, until none has stayed behind.
    vi.setSystemTime(today + 2 * DAY + 60_000);
    await drainWaitingResults(app.db, ctxOf(a));
    vi.setSystemTime(today + 3 * DAY + 60_000);
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: 1, stopped: null });
    expect(titles).toEqual([
      'Engineer 005',
      'Engineer 004',
      'Engineer 003',
      'Engineer 002',
      'Engineer 001',
    ]);
    const after = await results(app, a);
    expect(after.every((r) => r.aiScore === 60 && r.rankDeferredAt === null)).toBe(true);
    expect((await getBudget(a)).waiting).toBe(0);
  });

  it('raising the budget starts ranking the waiting postings the same day', async () => {
    const { app, a } = await boot();
    await waitingPostings(app, a, 3);
    providerCharges(app, a);
    expect((await putBudget(a, 1)).statusCode).toBe(200);
    const queued = await app.db.select().from(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).all();
    expect(queued).toHaveLength(1);
    await app.jobs.drain();
    expect((await getBudget(a)).waiting).toBe(0);
  });

  it('a provider outage or a missing key stops the drain, and everything keeps waiting', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 3);
    vi.setSystemTime(today + DAY + 60_000);
    for (const reason of ['provider_error', 'no_key'] as const) {
      vi.mocked(runStructured).mockReset();
      vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError(reason));
      expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
        ranked: 0,
        stopped: reason,
      });
      expect(vi.mocked(runStructured)).toHaveBeenCalledOnce();
      expect((await getBudget(a)).waiting).toBe(3);
    }
  });

  it('a posting the model cannot rank stops waiting, and the ones behind it go on', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 2);
    vi.setSystemTime(today + DAY + 60_000);
    vi.mocked(runStructured)
      .mockRejectedValueOnce(new AiUnavailableError('invalid_output'))
      .mockResolvedValueOnce({ score: 70, rationale: 'Good.', disqualifiers: [] });
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: 1, stopped: null });
    const byTitle = new Map((await results(app, a)).map((r) => [r.posting.title, r]));
    expect(byTitle.get('Engineer 002')).toMatchObject({
      rankSkipReason: 'invalid_output',
      rankDeferredAt: null,
    });
    expect(byTitle.get('Engineer 001')).toMatchObject({ aiScore: 70, rankDeferredAt: null });
  });

  it('a posting that throws does not block the ones behind it, and keeps waiting', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 2);
    vi.setSystemTime(today + DAY + 60_000);
    vi.mocked(runStructured)
      .mockRejectedValueOnce(new Error('not an AI failure'))
      .mockResolvedValueOnce({ score: 70, rationale: 'Good.', disqualifiers: [] });
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: 1, failed: 1 });
    expect((await getBudget(a)).waiting).toBe(1);
  });

  it('a dismissed posting no longer waits, and is not ranked', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 1);
    const [r] = await results(app, a);
    await setDisposition(app.db, ctxOf(a), r!.id, 'dismissed');
    expect((await getBudget(a)).waiting).toBe(0);
    vi.setSystemTime(today + DAY + 60_000);
    providerCharges(app, a);
    await sweepWaitingResults(app.db);
    expect(await app.db.select().from(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).all()).toEqual(
      [],
    );
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: 0 });
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
  });

  it("the sweep is per user: another user's room does not rank this user's postings", async () => {
    const { app, a, b } = await boot();
    const today = await waitingPostings(app, a, 1);
    await writeDiscoveryBudget(app.db, ctxOf(b), 1);
    vi.setSystemTime(today + DAY + 60_000);
    await sweepWaitingResults(app.db);
    const queued = await app.db
      .select({ userId: jobs.userId })
      .from(jobs)
      .where(and(eq(jobs.kind, RANK_WAITING_KIND), inArray(jobs.status, ['pending'])))
      .all();
    expect(queued).toEqual([{ userId: a.userId }]);
  });
});

describe('#214 criterion 4: the limit holds', () => {
  it('a budget of a few calls and a larger queue, on parallel workers: never more than the budget plus the calls in flight', async () => {
    const { app, a } = await boot();
    const BUDGET_CALLS = 3;
    const WORKERS = 4;
    const QUEUE = 30;
    await writeDiscoveryBudget(app.db, ctxOf(a), BUDGET_CALLS * CALL_USD);
    const { titles } = providerCharges(app, a);
    await discoverQueued(app, a, QUEUE);

    const runner = startRunner(app.db, {
      services: app.jobs.services,
      workers: WORKERS,
      intervalMs: 5,
    });
    try {
      await vi.waitFor(
        async () => {
          const open = await app.db
            .select({ id: jobs.id })
            .from(jobs)
            .where(
              and(eq(jobs.kind, DISCOVERY_RANK_KIND), inArray(jobs.status, ['pending', 'running'])),
            )
            .all();
          expect(open).toEqual([]);
        },
        { timeout: 20_000, interval: 20 },
      );
    } finally {
      await runner.stop();
    }

    expect(titles.length).toBeGreaterThanOrEqual(BUDGET_CALLS);
    // The last call that crosses the budget can have WORKERS - 1 others already in flight.
    expect(titles.length).toBeLessThanOrEqual(BUDGET_CALLS + WORKERS - 1);
    expect((await getBudget(a)).spentTodayUsd).toBeLessThanOrEqual(
      (BUDGET_CALLS + WORKERS - 1) * CALL_USD + 1e-9,
    );
    // No posting was lost, and none was ranked twice: each is scored or waiting.
    const rows = await results(app, a);
    expect(rows).toHaveLength(QUEUE);
    const scored = rows.filter((r) => r.aiScore !== null);
    expect(scored).toHaveLength(titles.length);
    expect(new Set(titles).size).toBe(titles.length);
    expect(rows.filter((r) => r.rankDeferredAt !== null)).toHaveLength(QUEUE - titles.length);
  }, 30_000);

  it('two calls past the check together both go (they are in flight); the next one waits', async () => {
    const { app, a } = await boot();
    await writeDiscoveryBudget(app.db, ctxOf(a), CALL_USD);
    await discoverQueued(app, a, 3);
    providerCharges(app, a);
    const [x, y, z] = await results(app, a);
    const barrier = holdAt('discoveryRank.budget_checked', 2);
    const [first, second] = await Promise.all([
      rankResult(app.db, ctxOf(a), x!.id),
      rankResult(app.db, ctxOf(a), y!.id),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect([first.status, second.status]).toEqual(['ranked', 'ranked']);
    expect(await rankResult(app.db, ctxOf(a), z!.id)).toEqual({
      status: 'skipped',
      reason: 'budget_exceeded',
    });
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(2);
  });
});

describe('#214: a scored result never says "Not ranked" (tl on #213)', () => {
  async function scored(app: FastifyInstance, c: TestClient) {
    await discoverQueued(app, c, 1);
    const [r] = await results(app, c);
    await setRanking(app.db, ctxOf(c), r!.id, { aiScore: 70, aiRationale: 'Good.' });
    return r!.id;
  }

  it('refused for budget on a later rank job: the score stays, no skip reason, and a re-rank waits', async () => {
    const { app, a } = await boot();
    const id = await scored(app, a);
    await spend(app, a, 1);
    await app.jobs.drain();
    const [r] = await results(app, a);
    expect(r).toMatchObject({ id, aiScore: 70, rankSkipReason: null });
    expect(r!.rankDeferredAt).toEqual(expect.any(Number));
  });

  for (const reason of ['provider_error', 'no_key', 'invalid_output'] as const) {
    it(`refused with ${reason} on a later rank job: no skip reason on it`, async () => {
      const { app, a } = await boot();
      await scored(app, a);
      vi.mocked(runStructured).mockRejectedValueOnce(new AiUnavailableError(reason));
      await app.jobs.drain();
      expect((await results(app, a))[0]).toMatchObject({ aiScore: 70, rankSkipReason: null });
    });
  }
});
