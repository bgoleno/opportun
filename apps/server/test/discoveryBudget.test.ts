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
import { auditLog, discoveryResults, jobs, taskRuns } from '../src/db/schema';
import { DISCOVERY_RANK_KIND, enqueueRankWaiting, rankResult } from '../src/jobs/discoveryRank';
import {
  drainWaitingResults,
  RANK_WAITING_KIND,
  RANK_WAITING_SWEEP_CRON,
  RANK_WAITING_SWEEP_KIND,
  sweepWaitingResults,
} from '../src/jobs/discoveryRankWaiting';
import { DISCOVERY_RUN_KIND, FIRST_RUN_RANK_CAP } from '../src/jobs/discoveryRun';
import { enqueue, readSchedules, runNextJob, startRunner } from '../src/jobs/runner';
import type { UserCtx } from '../src/repos/base';
import {
  createSource,
  listResults,
  setDisposition,
  setRankDeferred,
  setRanking,
} from '../src/repos/discovery';
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

// Braces matter: a function returned from beforeEach is run as a cleanup hook, here the mock.
beforeEach(() => {
  vi.mocked(runStructured).mockReset();
});
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
async function discoverQueued(
  app: FastifyInstance,
  c: TestClient,
  count: number,
  first = 1,
): Promise<void> {
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      for (let i = first; i < first + count; i++) yield { posting: posting(i), nextCursor: null };
    },
  } satisfies DiscoverySource);
  const src = await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: `initech-${first}` },
    roleTargetId: null,
  });
  await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: c.userId });
  await runNextJob(app.db, { services: app.jobs.services });
}

async function discover(app: FastifyInstance, c: TestClient, count = 1, first = 1): Promise<void> {
  await discoverQueued(app, c, count, first);
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

  it('a posting that failed earlier and then waits drops the old reason', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockRejectedValueOnce(new AiUnavailableError('provider_error'));
    await discover(app, a);
    const [r] = await results(app, a);
    expect(r!.rankSkipReason).toBe('provider_error');
    await spend(app, a, 1);
    await enqueue(app.db, DISCOVERY_RANK_KIND, { resultId: r!.id }, { userId: a.userId });
    await app.jobs.drain();
    const [after] = await results(app, a);
    expect(after).toMatchObject({ rankSkipReason: null });
    expect(after!.rankDeferredAt).toEqual(expect.any(Number));
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

  /** The provider refuses these titles, and answers and charges for the rest. */
  function providerFailsFor(app: FastifyInstance, c: TestClient, failing: string[]) {
    const titles: string[] = [];
    vi.mocked(runStructured).mockImplementation(async (_deps, _task, opts) => {
      const title = /Title: (.*)/.exec(opts.system)?.[1] ?? '';
      titles.push(title);
      if (failing.includes(title)) throw new AiUnavailableError('provider_error');
      await spend(app, c, CALL_USD);
      return { score: 60, rationale: 'A fair match.', disqualifiers: [] } as never;
    });
    return { titles };
  }
  const byTitle = async (app: FastifyInstance, c: TestClient) =>
    new Map((await results(app, c)).map((r) => [r.posting.title, r]));

  it('a missing key stops the drain at once, and every waiting card says why', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 3);
    vi.setSystemTime(today + DAY + 60_000);
    vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
      ranked: 0,
      stopped: 'no_key',
    });
    expect(vi.mocked(runStructured)).toHaveBeenCalledOnce();
    expect((await getBudget(a)).waiting).toBe(3);
    const after = await results(app, a);
    expect(after.map((r) => r.rankSkipReason)).toEqual(['no_key', 'no_key', 'no_key']);
  });

  it('once a key works, no waiting card still says AI is not set up', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 4);
    vi.setSystemTime(today + DAY + 60_000);
    vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
    await drainWaitingResults(app.db, ctxOf(a));
    vi.mocked(runStructured).mockReset();
    const { titles } = providerCharges(app, a);
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
      ranked: 2,
      stopped: 'budget_exceeded',
    });
    expect(titles).toEqual(['Engineer 004', 'Engineer 003']);
    // Engineer 002 was refused for budget, which clears its own reason. This one was not reached.
    expect((await byTitle(app, a)).get('Engineer 001')).toMatchObject({
      aiScore: null,
      rankSkipReason: null,
      rankDeferredAt: expect.any(Number),
    });
  });

  describe('the no-key reason ends when a key works (qa and tl on #230)', () => {
    const addKey = async (c: TestClient) => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in this test')));
      const res = await c.request({
        method: 'POST',
        url: '/api/v1/secrets',
        payload: { kind: 'ai_api_key', label: 'openai', value: 'made-up-key-for-a-test' },
      });
      expect(res.statusCode, res.body).toBe(201);
    };
    afterEach(() => {
      vi.unstubAllGlobals();
    });
    const noSweepDue = (app: FastifyInstance) =>
      app.db
        .delete(jobs)
        .where(and(eq(jobs.kind, RANK_WAITING_SWEEP_KIND), eq(jobs.status, 'pending')))
        .run();
    /** Postings waiting, then a drain finds no key: every card says so. */
    async function markedNoKey(app: FastifyInstance, c: TestClient, count: number) {
      const today = await waitingPostings(app, c, count);
      vi.setSystemTime(today + DAY + 60_000);
      vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
      await drainWaitingResults(app.db, ctxOf(c));
      vi.mocked(runStructured).mockReset();
      expect((await results(app, c)).every((r) => r.rankSkipReason === 'no_key')).toBe(true);
      return today;
    }

    it('qa’s sequence: the key added, then new postings every day: older ones first', async () => {
      const { app, a } = await boot();
      // A budget of 2 calls, smaller than the 3 new postings' spend each day.
      const today = await markedNoKey(app, a, 4);
      const { titles } = providerCharges(app, a);
      await addKey(a);
      expect((await results(app, a)).map((r) => r.rankSkipReason)).toEqual([
        null,
        null,
        null,
        null,
      ]);
      await noSweepDue(app);
      await discover(app, a, 3, 100);
      expect(titles).toEqual(['Engineer 004', 'Engineer 003']);
      vi.setSystemTime(today + 2 * DAY + 10_000);
      await noSweepDue(app);
      await discover(app, a, 3, 200);
      expect(titles).toEqual(['Engineer 004', 'Engineer 003', 'Engineer 002', 'Engineer 001']);
      vi.setSystemTime(today + 3 * DAY + 10_000);
      await noSweepDue(app);
      await discover(app, a, 3, 300);
      expect(titles.slice(4).every((t) => /Engineer 10\d/.test(t))).toBe(true);
      const after = await byTitle(app, a);
      expect(
        ['Engineer 004', 'Engineer 003', 'Engineer 002', 'Engineer 001'].map(
          (t) => after.get(t)!.aiScore,
        ),
      ).toEqual([60, 60, 60, 60]);
      expect([...after.values()].some((r) => r.rankSkipReason === 'no_key')).toBe(false);
    });

    it('adding a key queues a drain when there is room, and it ranks what waits', async () => {
      const { app, a } = await boot();
      await markedNoKey(app, a, 2);
      await noSweepDue(app);
      await addKey(a);
      const queued = await app.db.select().from(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).all();
      expect(queued.filter((j) => j.status === 'pending')).toHaveLength(1);
      const { titles } = providerCharges(app, a);
      await app.jobs.drain();
      expect(titles).toEqual(['Engineer 002', 'Engineer 001']);
    });

    it('with nothing waiting, adding a key queues no drain', async () => {
      const { app, a } = await boot();
      await addKey(a);
      expect(
        await app.db.select().from(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).all(),
      ).toEqual([]);
    });

    it('with no room, adding a key still corrects the cards, and queues no drain', async () => {
      const { app, a } = await boot();
      await markedNoKey(app, a, 2);
      await noSweepDue(app);
      await spend(app, a, 1);
      await app.db.delete(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).run();
      await addKey(a);
      expect((await results(app, a)).map((r) => r.rankSkipReason)).toEqual([null, null]);
      expect(
        await app.db.select().from(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).all(),
      ).toEqual([]);
    });

    it('adding a key leaves another user’s cards alone, and another kind of secret does nothing', async () => {
      const { app, a, b } = await boot();
      await markedNoKey(app, a, 1);
      await addKey(b);
      expect((await results(app, a))[0]!.rankSkipReason).toBe('no_key');
      const other = await a.request({
        method: 'POST',
        url: '/api/v1/secrets',
        payload: { kind: 'oauth_token', label: 'not-a-key', value: 'made-up-value-for-a-test' },
      });
      expect(other.statusCode, other.body).toBe(201);
      expect((await results(app, a))[0]!.rankSkipReason).toBe('no_key');
    });

    it('a key that comes back another way: the first ranking on any path corrects the cards', async () => {
      const { app, a } = await boot();
      await markedNoKey(app, a, 3);
      await noSweepDue(app);
      const { titles } = providerCharges(app, a);
      // A rank job, not a drain: no key was added, so nothing has cleared the reason yet.
      await discover(app, a, 1, 100);
      expect(titles).toEqual(['Engineer 100']);
      expect((await byTitle(app, a)).get('Engineer 003')).toMatchObject({
        rankSkipReason: null,
        rankDeferredAt: expect.any(Number),
      });
      // So the backlog holds the next new posting back again.
      await noSweepDue(app);
      await discover(app, a, 1, 200);
      expect(titles.slice(0, 2)).toEqual(['Engineer 100', 'Engineer 003']);
    });

    it('while the key is still missing, a new posting says so and queues no drain', async () => {
      const { app, a } = await boot();
      await markedNoKey(app, a, 2);
      await noSweepDue(app);
      vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
      await discover(app, a, 1, 100);
      expect((await byTitle(app, a)).get('Engineer 100')).toMatchObject({
        rankSkipReason: 'no_key',
        rankDeferredAt: null,
      });
      expect(vi.mocked(runStructured)).toHaveBeenCalledOnce();
      expect(
        await app.db.select().from(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).all(),
      ).toEqual([]);
    });
  });

  it('a posting an outage touched gets its place back the next day: new postings cannot starve it', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 1);
    vi.setSystemTime(today + DAY + 60_000);
    providerFailsFor(app, a, ['Engineer 001']);
    await drainWaitingResults(app.db, ctxOf(a));
    expect((await results(app, a))[0]!.rankSkipReason).toBe('provider_error');
    // The provider is back. A source just after the next UTC day starts, before any sweep, with a
    // budget of 2 calls smaller than its 3 new postings' spend.
    vi.setSystemTime(today + 2 * DAY + 10_000);
    await app.db
      .delete(jobs)
      .where(and(eq(jobs.kind, RANK_WAITING_SWEEP_KIND), eq(jobs.status, 'pending')))
      .run();
    const { titles } = providerCharges(app, a);
    await discover(app, a, 3, 100);
    expect(titles[0]).toBe('Engineer 001');
    expect((await byTitle(app, a)).get('Engineer 001')).toMatchObject({
      aiScore: 60,
      rankSkipReason: null,
      rankDeferredAt: null,
    });
  });

  it('a budget refusal on a waiting posting drops its old reason and keeps its first time', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 1);
    const [before] = await results(app, a);
    vi.setSystemTime(today + DAY + 60_000);
    vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
    await drainWaitingResults(app.db, ctxOf(a));
    expect((await results(app, a))[0]!.rankSkipReason).toBe('no_key');
    await spend(app, a, 1);
    expect(await rankResult(app.db, ctxOf(a), before!.id)).toMatchObject({
      reason: 'budget_exceeded',
    });
    expect((await results(app, a))[0]).toMatchObject({
      rankSkipReason: null,
      rankDeferredAt: before!.rankDeferredAt,
    });
  });

  it('a provider outage stops the drain after a few errors in a row, and everything keeps waiting', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 5);
    vi.setSystemTime(today + DAY + 60_000);
    vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('provider_error'));
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
      ranked: 0,
      stopped: 'provider_error',
    });
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(3);
    expect((await getBudget(a)).waiting).toBe(5);
  });

  it('one posting that always gets a provider error does not hold back the ones behind it', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 3);
    await writeDiscoveryBudget(app.db, ctxOf(a), 1);
    vi.setSystemTime(today + DAY + 60_000);
    providerFailsFor(app, a, ['Engineer 003']);
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: 2, stopped: null });
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: 0, stopped: null });
    const after = await byTitle(app, a);
    expect(after.get('Engineer 002')).toMatchObject({ aiScore: 60, rankDeferredAt: null });
    expect(after.get('Engineer 001')).toMatchObject({ aiScore: 60, rankDeferredAt: null });
    expect(after.get('Engineer 003')).toMatchObject({
      aiScore: null,
      rankSkipReason: 'provider_error',
      rankDeferredAt: expect.any(Number),
    });
  });

  it('a ranking between errors means no outage: errors must be in a row to stop the drain', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 5);
    await writeDiscoveryBudget(app.db, ctxOf(a), 1);
    vi.setSystemTime(today + DAY + 60_000);
    const { titles } = providerFailsFor(app, a, ['Engineer 005', 'Engineer 004', 'Engineer 002']);
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: 2, stopped: null });
    expect(titles).toHaveLength(5);
  });

  it('more failing postings than an outage takes cannot block the backlog for ever', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 6);
    await writeDiscoveryBudget(app.db, ctxOf(a), 1);
    vi.setSystemTime(today + DAY + 60_000);
    const { titles } = providerFailsFor(app, a, [
      'Engineer 006',
      'Engineer 005',
      'Engineer 004',
      'Engineer 003',
    ]);
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
      ranked: 0,
      stopped: 'provider_error',
    });
    expect(titles).toEqual(['Engineer 006', 'Engineer 005', 'Engineer 004']);
    // The next drain takes the postings that have not failed first, so the good ones get ranked.
    titles.length = 0;
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: 2 });
    expect(titles.slice(0, 3)).toEqual(['Engineer 003', 'Engineer 002', 'Engineer 001']);
    expect((await getBudget(a)).waiting).toBe(4);
  });

  it('a posting that failed is ranked once the provider recovers, and loses the reason', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 2);
    vi.setSystemTime(today + DAY + 60_000);
    providerFailsFor(app, a, ['Engineer 002']);
    await drainWaitingResults(app.db, ctxOf(a));
    expect((await byTitle(app, a)).get('Engineer 002')!.rankSkipReason).toBe('provider_error');
    vi.setSystemTime(today + 2 * DAY + 60_000);
    providerFailsFor(app, a, []);
    await drainWaitingResults(app.db, ctxOf(a));
    expect((await byTitle(app, a)).get('Engineer 002')).toMatchObject({
      aiScore: 60,
      rankSkipReason: null,
      rankDeferredAt: null,
    });
  });

  it('scored postings whose new ranking keeps failing do not hold back an unscored one', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 4);
    await writeDiscoveryBudget(app.db, ctxOf(a), 1);
    for (const r of await results(app, a)) {
      if (r.posting.title === 'Engineer 001') continue;
      await app.db
        .update(discoveryResults)
        .set({ aiScore: 50 })
        .where(eq(discoveryResults.id, r.id))
        .run();
    }
    vi.setSystemTime(today + DAY + 60_000);
    const { titles } = providerFailsFor(app, a, ['Engineer 004', 'Engineer 003', 'Engineer 002']);
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: 1 });
    expect(titles[0]).toBe('Engineer 001');
  });

  describe('new postings do not go ahead of older waiting ones (tl on #230)', () => {
    /**
     * Moving the clock makes the sweep the runner had already scheduled overdue, and it would run
     * first. In the case under test the source runs before the day's first sweep, so none is due.
     */
    const noSweepDue = (app: FastifyInstance) =>
      app.db
        .delete(jobs)
        .where(and(eq(jobs.kind, RANK_WAITING_SWEEP_KIND), eq(jobs.status, 'pending')))
        .run();

    it('a new posting joins the wait, and the drain it queues ranks the older ones first', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 3);
      vi.setSystemTime(today + DAY + 60_000);
      const { titles } = providerCharges(app, a);
      await noSweepDue(app);
      await discover(app, a, 1, 100);
      expect(titles).toEqual(['Engineer 003', 'Engineer 002']);
      const after = await byTitle(app, a);
      expect(after.get('Engineer 100')).toMatchObject({
        aiScore: null,
        rankDeferredAt: expect.any(Number),
      });
      expect((await getBudget(a)).waiting).toBe(2);
    });

    it('sources that run just after the UTC day starts cannot starve older ones, day after day', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 4);
      const { titles } = providerCharges(app, a);
      vi.setSystemTime(today + DAY + 10_000);
      await noSweepDue(app);
      await discover(app, a, 3, 100);
      expect(titles).toEqual(['Engineer 004', 'Engineer 003']);
      vi.setSystemTime(today + 2 * DAY + 10_000);
      await noSweepDue(app);
      await discover(app, a, 3, 200);
      expect(titles).toEqual(['Engineer 004', 'Engineer 003', 'Engineer 002', 'Engineer 001']);
      vi.setSystemTime(today + 3 * DAY + 10_000);
      await noSweepDue(app);
      await discover(app, a, 3, 300);
      // Now the first day's new postings, still ahead of the ones that came after them.
      expect(titles.slice(4).every((t) => /Engineer 10\d/.test(t))).toBe(true);
      expect(titles).toHaveLength(6);
    });

    it('with no room, a new posting joins the wait and no drain is queued', async () => {
      const { app, a } = await boot();
      await waitingPostings(app, a, 1);
      await noSweepDue(app);
      await discover(app, a, 1, 100);
      expect((await getBudget(a)).waiting).toBe(2);
      expect(
        await app.db.select().from(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).all(),
      ).toEqual([]);
    });

    it('a posting that already failed its turn does not keep new postings waiting', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 1);
      vi.setSystemTime(today + DAY + 60_000);
      const { titles } = providerFailsFor(app, a, ['Engineer 001']);
      await drainWaitingResults(app.db, ctxOf(a));
      titles.length = 0;
      await noSweepDue(app);
      await discover(app, a, 1, 100);
      // Ranked by its own job: no drain ran, so the failed posting was not tried again.
      expect(titles).toEqual(['Engineer 100']);
      expect((await byTitle(app, a)).get('Engineer 100')).toMatchObject({
        aiScore: 60,
        rankDeferredAt: null,
      });
    });
  });

  it('shutting down during a drain waits for the call in flight, not the whole backlog', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 5);
    await writeDiscoveryBudget(app.db, ctxOf(a), 1);
    vi.setSystemTime(today + DAY + 60_000);
    await sweepWaitingResults(app.db);
    let callStarted!: () => void;
    const inCall = new Promise<void>((resolve) => (callStarted = resolve));
    let finishCall!: () => void;
    const held = new Promise<void>((resolve) => (finishCall = resolve));
    vi.mocked(runStructured).mockImplementation(async () => {
      callStarted();
      await held;
      return { score: 60, rationale: 'A fair match.', disqualifiers: [] } as never;
    });
    const runner = startRunner(app.db, {
      services: app.jobs.services,
      workers: 1,
      intervalMs: 5,
    });
    await inCall;
    const stopped = runner.stop();
    finishCall();
    await stopped;
    expect(vi.mocked(runStructured)).toHaveBeenCalledOnce();
    // Nothing is lost: the rest keep waiting for the next sweep.
    expect((await getBudget(a)).waiting).toBe(4);
  });

  // https://github.com/bgoleno/opportun/issues/263 criterion 7, qa's finding on
  // https://github.com/bgoleno/opportun/pull/265: rank jobs now run during a drain, so they defer
  // behind it, and its enqueue dedupes onto it. Only the drain can pick them up.
  describe('a posting that joins the wait while a drain runs', () => {
    /** The newest posting is not waiting yet. The first provider call makes it join. */
    async function joinsDuringFirstCall(app: FastifyInstance, c: TestClient, title: string) {
      const joiner = (await byTitle(app, c)).get(title)!;
      await app.db
        .update(discoveryResults)
        .set({ rankDeferredAt: null })
        .where(eq(discoveryResults.id, joiner.id))
        .run();
      const provider = vi.mocked(runStructured).getMockImplementation()!;
      let joined = false;
      vi.mocked(runStructured).mockImplementation(async (...args) => {
        if (!joined) {
          joined = true;
          await setRankDeferred(app.db, ctxOf(c), joiner.id);
        }
        return provider(...args);
      });
    }

    it('a board run during a real drain: that drain ranks its postings, after the older ones', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 3);
      await writeDiscoveryBudget(app.db, ctxOf(a), 1);
      vi.setSystemTime(today + DAY + 60_000);
      // Only this drain and what follows: nothing else a day's jump has made due.
      await app.db.delete(jobs).where(eq(jobs.status, 'pending')).run();
      const { titles } = providerCharges(app, a);
      const provider = vi.mocked(runStructured).getMockImplementation()!;
      let callStarted!: () => void;
      const inCall = new Promise<void>((resolve) => (callStarted = resolve));
      let finishCall!: () => void;
      const held = new Promise<void>((resolve) => (finishCall = resolve));
      vi.mocked(runStructured).mockImplementationOnce(async (...args) => {
        callStarted();
        await held;
        return provider(...args);
      });
      await enqueueRankWaiting(app.db, ctxOf(a));
      const runner = startRunner(app.db, { services: app.jobs.services, intervalMs: 5 });
      const until = async (cond: () => Promise<boolean>) => {
        const end = performance.now() + 5000;
        while (!(await cond())) {
          if (performance.now() > end) throw new Error('timed out waiting');
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      try {
        await inCall;
        await discoverQueued(app, a, 2, 100);
        // Both rank jobs have run and gone behind the older postings, with the drain still held.
        await until(
          async () =>
            [...(await byTitle(app, a)).values()].filter(
              (r) => r.posting.title.startsWith('Engineer 10') && r.rankDeferredAt !== null,
            ).length === 2,
        );
        finishCall();
        await until(async () => (await getBudget(a)).waiting === 0);
      } finally {
        finishCall();
        await runner.stop();
      }
      expect(titles.slice(0, 3)).toEqual(['Engineer 003', 'Engineer 002', 'Engineer 001']);
      expect(titles.slice(3).sort()).toEqual(['Engineer 100', 'Engineer 101']);
      const drains = await app.db.select().from(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).all();
      expect(drains.map((j) => j.status)).toEqual(['done']);
    });

    it('it is ranked once the list is done, and the drain then ends', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 3);
      await writeDiscoveryBudget(app.db, ctxOf(a), 1);
      vi.setSystemTime(today + DAY + 60_000);
      const { titles } = providerCharges(app, a);
      await joinsDuringFirstCall(app, a, 'Engineer 001');
      expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
        ranked: 3,
        stopped: null,
      });
      expect(titles).toEqual(['Engineer 003', 'Engineer 002', 'Engineer 001']);
    });

    it('a posting the provider refuses is tried once in that drain, on either read', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 3);
      await writeDiscoveryBudget(app.db, ctxOf(a), 1);
      vi.setSystemTime(today + DAY + 60_000);
      const { titles } = providerFailsFor(app, a, ['Engineer 003', 'Engineer 001']);
      await joinsDuringFirstCall(app, a, 'Engineer 001');
      expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
        ranked: 1,
        stopped: null,
      });
      expect(titles).toEqual(['Engineer 003', 'Engineer 002', 'Engineer 001']);
    });

    it('over budget the drain stops at once, and it keeps waiting', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 3);
      vi.setSystemTime(today + DAY + 60_000);
      const { titles } = providerCharges(app, a);
      await joinsDuringFirstCall(app, a, 'Engineer 001');
      // A budget of 2 calls: the two older postings use it, so the second read finds no room.
      expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
        ranked: 2,
        stopped: 'budget_exceeded',
      });
      expect(titles).toEqual(['Engineer 003', 'Engineer 002']);
      expect((await byTitle(app, a)).get('Engineer 001')).toMatchObject({
        aiScore: null,
        rankDeferredAt: expect.any(Number),
      });
    });

    it('errors in a row carry across reads, so an outage still stops the drain', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 3);
      await writeDiscoveryBudget(app.db, ctxOf(a), 1);
      vi.setSystemTime(today + DAY + 60_000);
      providerFailsFor(app, a, ['Engineer 003', 'Engineer 002', 'Engineer 001']);
      await joinsDuringFirstCall(app, a, 'Engineer 001');
      expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
        ranked: 0,
        stopped: 'provider_error',
      });
    });

    it('a shutdown stops the drain before the next read’s postings', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 3);
      await writeDiscoveryBudget(app.db, ctxOf(a), 1);
      vi.setSystemTime(today + DAY + 60_000);
      const { titles } = providerCharges(app, a);
      await joinsDuringFirstCall(app, a, 'Engineer 001');
      expect(
        await drainWaitingResults(app.db, ctxOf(a), { stopping: () => titles.length >= 2 }),
      ).toMatchObject({ ranked: 2, stopped: 'shutdown' });
      expect(titles).toEqual(['Engineer 003', 'Engineer 002']);
    });
  });

  // https://github.com/bgoleno/opportun/issues/261, tl's ruling at
  // https://github.com/bgoleno/opportun/issues/261#issuecomment-6653083102.
  describe('a key the provider rejects', () => {
    const rejected = () =>
      new AiUnavailableError('provider_error', 'HTTP 401', { keyRejected: true });
    const noSweepDue = (app: FastifyInstance) =>
      app.db
        .delete(jobs)
        .where(and(eq(jobs.kind, RANK_WAITING_SWEEP_KIND), eq(jobs.status, 'pending')))
        .run();
    const reasons = async (app: FastifyInstance, c: TestClient) =>
      (await results(app, c)).map((r) => r.rankSkipReason);
    const drainsQueued = async (app: FastifyInstance, c: TestClient) =>
      (
        await app.db
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.kind, RANK_WAITING_KIND),
              eq(jobs.userId, c.userId),
              eq(jobs.status, 'pending'),
            ),
          )
          .all()
      ).length;
    /** `count` postings waiting, on a day with room in the budget, and the first drain rejected. */
    async function stopped(app: FastifyInstance, c: TestClient, count: number) {
      const today = await waitingPostings(app, c, count);
      await writeDiscoveryBudget(app.db, ctxOf(c), 1);
      vi.setSystemTime(today + DAY + 60_000);
      vi.mocked(runStructured).mockRejectedValue(rejected());
      expect(await drainWaitingResults(app.db, ctxOf(c))).toMatchObject({
        ranked: 0,
        stopped: 'key_rejected',
      });
      vi.mocked(runStructured).mockClear();
      await noSweepDue(app);
      return today;
    }
    /** The provider now answers, and the postings are ranked. */
    const providerWorks = () =>
      vi.mocked(runStructured).mockResolvedValue({
        score: 60,
        rationale: 'A fair match.',
        disqualifiers: [],
      } as never);

    it('the drain stops at the first, every waiting card says why, and nothing is lost', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 3);
      await writeDiscoveryBudget(app.db, ctxOf(a), 1);
      vi.setSystemTime(today + DAY + 60_000);
      vi.mocked(runStructured).mockRejectedValue(rejected());
      expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
        ranked: 0,
        stopped: 'key_rejected',
      });
      expect(vi.mocked(runStructured)).toHaveBeenCalledOnce();
      for (const r of await results(app, a)) {
        expect(r).toMatchObject({
          rankSkipReason: 'key_rejected',
          aiScore: null,
          disposition: 'pending',
          rankDeferredAt: expect.any(Number),
        });
      }
      expect((await getBudget(a)).waiting).toBe(3);
    });

    it('an outage marks nothing, and the sweep keeps trying', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 3);
      await writeDiscoveryBudget(app.db, ctxOf(a), 1);
      vi.setSystemTime(today + DAY + 60_000);
      vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('provider_error'));
      await drainWaitingResults(app.db, ctxOf(a));
      expect(await reasons(app, a)).not.toContain('key_rejected');
      expect(await sweepWaitingResults(app.db)).toEqual({ queued: 1 });

      // And it recovers with nothing done by the user, on the next budget day.
      vi.setSystemTime(today + 2 * DAY + 60_000);
      providerWorks();
      await drainWaitingResults(app.db, ctxOf(a));
      expect((await results(app, a)).map((r) => r.aiScore)).toEqual([60, 60, 60]);
    });

    it('the sweep passes over that user, and no other', async () => {
      const { app, a, b } = await boot();
      const today = await stopped(app, a, 2);
      expect(await sweepWaitingResults(app.db)).toEqual({ queued: 0 });
      expect(await drainsQueued(app, a)).toBe(0);

      vi.setSystemTime(today);
      await spend(app, b, 2 * CALL_USD);
      await writeDiscoveryBudget(app.db, ctxOf(b), 2 * CALL_USD);
      await discover(app, b, 1);
      expect((await results(app, b))[0]!.rankDeferredAt).not.toBeNull();
      vi.setSystemTime(today + DAY + 60_000);
      expect(await sweepWaitingResults(app.db)).toEqual({ queued: 1 });
      expect(await drainsQueued(app, a)).toBe(0);
      expect(await drainsQueued(app, b)).toBe(1);
    });

    // sec on https://github.com/bgoleno/opportun/pull/275: one user's dead key must not stop another
    // user's ranking, whoever was waiting first.
    it('both users waiting, and a rejected key of one: the other is untouched', async () => {
      const { app, a, b } = await boot();
      const today = await waitingPostings(app, a, 2);
      await waitingPostings(app, b, 2);
      await writeDiscoveryBudget(app.db, ctxOf(a), 1);
      await writeDiscoveryBudget(app.db, ctxOf(b), 1);
      vi.setSystemTime(today + DAY + 60_000);
      vi.mocked(runStructured).mockRejectedValue(rejected());
      await drainWaitingResults(app.db, ctxOf(a));

      expect(await reasons(app, a)).toEqual(['key_rejected', 'key_rejected']);
      expect(await reasons(app, b)).toEqual([null, null]);
      expect(await sweepWaitingResults(app.db)).toEqual({ queued: 1 });
      expect(await drainsQueued(app, a)).toBe(0);
      expect(await drainsQueued(app, b)).toBe(1);
    });

    it('a later budget day does not bring them back in line', async () => {
      const { app, a } = await boot();
      const today = await stopped(app, a, 2);
      vi.setSystemTime(today + 5 * DAY);
      expect(await sweepWaitingResults(app.db)).toEqual({ queued: 0 });
    });

    it('with a scored posting waiting too, any marked one still stops the sweep', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 2);
      await writeDiscoveryBudget(app.db, ctxOf(a), 1);
      const scored = (await byTitle(app, a)).get('Engineer 002')!;
      await setRanking(app.db, ctxOf(a), scored.id, { aiScore: 40, aiRationale: 'Older score.' });
      await setRankDeferred(app.db, ctxOf(a), scored.id);
      vi.setSystemTime(today + DAY + 60_000);
      vi.mocked(runStructured).mockRejectedValue(rejected());
      await drainWaitingResults(app.db, ctxOf(a));

      const after = await byTitle(app, a);
      expect(after.get('Engineer 002')).toMatchObject({ aiScore: 40, rankSkipReason: null });
      expect(after.get('Engineer 001')!.rankSkipReason).toBe('key_rejected');
      expect(await sweepWaitingResults(app.db)).toEqual({ queued: 0 });
    });

    // A known limit, tl's ruling: a scored posting is never marked, so nothing says the stop is on.
    it('with only scored postings waiting, one call a sweep and no more', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 1);
      await writeDiscoveryBudget(app.db, ctxOf(a), 1);
      const only = (await results(app, a))[0]!;
      await setRanking(app.db, ctxOf(a), only.id, { aiScore: 40, aiRationale: 'Older score.' });
      await setRankDeferred(app.db, ctxOf(a), only.id);
      vi.setSystemTime(today + DAY + 60_000);
      vi.mocked(runStructured).mockRejectedValue(rejected());
      for (let sweep = 1; sweep <= 3; sweep++) {
        expect(await sweepWaitingResults(app.db)).toEqual({ queued: 1 });
        expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
          stopped: 'key_rejected',
        });
        expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(sweep);
      }
      expect((await results(app, a))[0]).toMatchObject({ aiScore: 40, rankSkipReason: null });
    });

    it('a rank job that gets it joins the wait, so the posting is ranked once a key works', async () => {
      const { app, a } = await boot();
      vi.mocked(runStructured).mockRejectedValue(rejected());
      await discover(app, a, 1);
      expect((await results(app, a))[0]).toMatchObject({
        rankSkipReason: 'key_rejected',
        aiScore: null,
        rankDeferredAt: expect.any(Number),
      });
      providerWorks();
      await addKey(a);
      await app.jobs.drain();
      expect((await results(app, a))[0]).toMatchObject({
        aiScore: 60,
        rankSkipReason: null,
        rankDeferredAt: null,
      });
    });

    // tl on https://github.com/bgoleno/opportun/pull/275: the sweep stops, so the older cards must
    // say why too, not that the provider was unavailable.
    it('a rank job that gets it marks what waits, as the drain does', async () => {
      const { app, a } = await boot();
      const today = await waitingPostings(app, a, 2);
      await writeDiscoveryBudget(app.db, ctxOf(a), 1);
      vi.setSystemTime(today + DAY + 60_000);
      vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('provider_error'));
      await drainWaitingResults(app.db, ctxOf(a));
      expect(await reasons(app, a)).toEqual(['provider_error', 'provider_error']);

      vi.mocked(runStructured).mockRejectedValue(rejected());
      await noSweepDue(app);
      await discover(app, a, 1, 100);
      expect(await reasons(app, a)).toEqual(['key_rejected', 'key_rejected', 'key_rejected']);
    });

    // Known limit D in tl's ruling, and the way back: each new posting is one call.
    it('during the stop a new posting makes one call, and its success ends the stop', async () => {
      const { app, a } = await boot();
      await stopped(app, a, 2);
      vi.mocked(runStructured).mockRejectedValue(rejected());
      await discover(app, a, 1, 100);
      expect(vi.mocked(runStructured)).toHaveBeenCalledOnce();
      expect((await byTitle(app, a)).get('Engineer 100')!.rankSkipReason).toBe('key_rejected');
      await noSweepDue(app);
      expect(await sweepWaitingResults(app.db)).toEqual({ queued: 0 });

      providerWorks();
      await discover(app, a, 1, 200);
      expect((await byTitle(app, a)).get('Engineer 200')!.aiScore).toBe(60);
      expect(await reasons(app, a)).not.toContain('key_rejected');
      await noSweepDue(app);
      expect(await sweepWaitingResults(app.db)).toEqual({ queued: 1 });
      await app.jobs.drain();
      expect([...(await byTitle(app, a)).values()].map((r) => r.aiScore)).toEqual([60, 60, 60, 60]);
      expect((await getBudget(a)).waiting).toBe(0);
    });

    describe('the ways back', () => {
      const secretId = (res: { json: <T>() => T }) => res.json<{ id: string }>().id;
      /** Adds an OpenAI key. Its validation fails here, with the network off. */
      const addKeyId = async (c: TestClient) => {
        const res = await c.request({
          method: 'POST',
          url: '/api/v1/secrets',
          payload: { kind: 'ai_api_key', label: 'openai', value: 'made-up-key-for-a-test' },
        });
        expect(res.statusCode, res.body).toBe(201);
        return secretId(res);
      };
      const recheck = (c: TestClient, id: string) =>
        c.request({ method: 'POST', url: `/api/v1/ai/keys/${id}/validate` });
      const modelList = (status: number) =>
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(status === 200 ? { data: [] } : { error: 'bad key' }), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      const putPolicy = (c: TestClient, task: string) =>
        c.request({
          method: 'PUT',
          url: `/api/v1/ai/policies/${task}`,
          payload: { provider: 'openai', model: 'placeholder-model', maxOutputTokens: 500 },
        });

      beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in this test')));
      });
      afterEach(() => {
        vi.unstubAllGlobals();
      });

      /** Cards clear, a drain is queued, and it ranks them all: no posting was lost. */
      async function resumed(app: FastifyInstance, c: TestClient, count: number) {
        expect(await reasons(app, c)).toEqual(Array.from({ length: count }, () => null));
        expect(await drainsQueued(app, c)).toBe(1);
        providerWorks();
        await app.jobs.drain();
        const after = await results(app, c);
        expect(after.map((r) => r.aiScore)).toEqual(Array.from({ length: count }, () => 60));
        expect((await getBudget(c)).waiting).toBe(0);
      }

      it('a key added', async () => {
        const { app, a } = await boot();
        await stopped(app, a, 2);
        await addKeyId(a);
        await noSweepDue(app);
        await resumed(app, a, 2);
      });

      it('a re-check in Settings that succeeds', async () => {
        const { app, a } = await boot();
        await stopped(app, a, 2);
        const id = await addKeyId(a);
        await rejectedAgain(app, a);
        vi.stubGlobal('fetch', modelList(200));
        const res = await recheck(a, id);
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json<{ ok: boolean }>().ok).toBe(true);
        await noSweepDue(app);
        await resumed(app, a, 2);
      });

      it('a re-check that fails clears nothing and queues nothing', async () => {
        const { app, a } = await boot();
        await stopped(app, a, 2);
        const id = await addKeyId(a);
        await rejectedAgain(app, a);
        vi.stubGlobal('fetch', modelList(401));
        const res = await recheck(a, id);
        expect(res.json<{ ok: boolean }>().ok).toBe(false);
        expect(await reasons(app, a)).toEqual(['key_rejected', 'key_rejected']);
        expect(await drainsQueued(app, a)).toBe(0);
      });

      it('another user’s re-check leaves this user stopped', async () => {
        const { app, a, b } = await boot();
        await stopped(app, a, 2);
        const id = await addKeyId(b);
        vi.stubGlobal('fetch', modelList(200));
        expect((await recheck(b, id)).statusCode).toBe(200);
        expect(await reasons(app, a)).toEqual(['key_rejected', 'key_rejected']);
        expect(await drainsQueued(app, a)).toBe(0);
      });

      it('a ranking policy set or removed', async () => {
        const { app, a } = await boot();
        await stopped(app, a, 2);
        const put = await putPolicy(a, 'discovery.rank');
        expect(put.statusCode, put.body).toBe(200);
        await noSweepDue(app);
        expect(await reasons(app, a)).toEqual([null, null]);
        expect(await drainsQueued(app, a)).toBe(1);

        // Stopped again by that drain, then the override goes.
        vi.mocked(runStructured).mockRejectedValue(rejected());
        await app.jobs.drain();
        expect(await reasons(app, a)).toEqual(['key_rejected', 'key_rejected']);
        const del = await a.request({
          method: 'DELETE',
          url: '/api/v1/ai/policies/discovery.rank',
        });
        expect(del.statusCode, del.body).toBe(204);
        await noSweepDue(app);
        await resumed(app, a, 2);
      });

      it('another task’s policy leaves them stopped', async () => {
        const { app, a } = await boot();
        await stopped(app, a, 2);
        const put = await putPolicy(a, 'resume.match');
        expect(put.statusCode, put.body).toBe(200);
        const del = await a.request({ method: 'DELETE', url: '/api/v1/ai/policies/resume.match' });
        expect(del.statusCode, del.body).toBe(204);
        expect(await reasons(app, a)).toEqual(['key_rejected', 'key_rejected']);
        expect(await drainsQueued(app, a)).toBe(0);
      });

      // Deleting the newest key puts an older one in use, or leaves none and the card says that.
      it('a key deleted', async () => {
        const { app, a } = await boot();
        await stopped(app, a, 2);
        const id = await addKeyId(a);
        await rejectedAgain(app, a);
        const res = await a.request({ method: 'DELETE', url: `/api/v1/secrets/${id}` });
        expect(res.statusCode, res.body).toBe(204);
        await noSweepDue(app);
        await resumed(app, a, 2);
      });

      // tl on https://github.com/bgoleno/opportun/pull/275: a dismissed posting's wait survives for
      // Undo, as #230 ruled, but its reason must not, or Undo turns the stop back on.
      it('a posting dismissed during the stop is clean after Undo, with a working key', async () => {
        const { app, a } = await boot();
        await stopped(app, a, 3);
        const dismissed = (await byTitle(app, a)).get('Engineer 001')!;
        await setDisposition(app.db, ctxOf(a), dismissed.id, 'dismissed');
        await addKeyId(a);
        await noSweepDue(app);
        providerWorks();
        await app.jobs.drain();
        expect((await getBudget(a)).waiting).toBe(0);

        await setDisposition(app.db, ctxOf(a), dismissed.id, 'pending');
        expect((await byTitle(app, a)).get('Engineer 001')).toMatchObject({
          rankSkipReason: null,
          aiScore: null,
          rankDeferredAt: expect.any(Number),
        });
        await noSweepDue(app);
        expect(await sweepWaitingResults(app.db)).toEqual({ queued: 1 });
        await app.jobs.drain();
        expect((await byTitle(app, a)).get('Engineer 001')!.aiScore).toBe(60);
      });

      // qa on https://github.com/bgoleno/opportun/pull/275, on a real server, and tl's ruling at
      // https://github.com/bgoleno/opportun/pull/275#issuecomment-6653670141: a 401 from a call that
      // began before the latest key change says nothing about the new key.
      describe('a 401 landing after the key changed', () => {
        /**
         * The provider's first answer: the key changes while that call is in flight, then it lands
         * as a 401. Only Date is faked, so the clock moves here and nowhere else.
         */
        function changedInFlight(change: () => Promise<void>, then: 'works' | 'refused') {
          const titles: string[] = [];
          let first = true;
          vi.mocked(runStructured).mockImplementation(async (_deps, _task, opts) => {
            titles.push(/Title: (.*)/.exec(opts.system)?.[1] ?? '');
            if (first) {
              first = false;
              vi.setSystemTime(Date.now() + 1000);
              await change();
              vi.setSystemTime(Date.now() + 1000);
              throw rejected();
            }
            if (then === 'refused') throw rejected();
            return { score: 60, rationale: 'A fair match.', disqualifiers: [] } as never;
          });
          return titles;
        }
        /** The ways back, each done for real through its route. */
        const ways: [
          string,
          (app: FastifyInstance, c: TestClient) => Promise<() => Promise<void>>,
        ][] = [
          ['a key added', async (_app, c) => async () => void (await addKeyId(c))],
          [
            'Validate that succeeds',
            async (app, c) => {
              const id = await addKeyId(c);
              await rejectedAgain(app, c);
              return async () => {
                vi.stubGlobal('fetch', modelList(200));
                expect((await recheck(c, id)).json<{ ok: boolean }>().ok).toBe(true);
              };
            },
          ],
          [
            'a ranking policy saved',
            async (_app, c) => async () => {
              expect((await putPolicy(c, 'discovery.rank')).statusCode).toBe(200);
            },
          ],
          [
            'a key deleted',
            async (app, c) => {
              const id = await addKeyId(c);
              await rejectedAgain(app, c);
              return async () => {
                const res = await c.request({ method: 'DELETE', url: `/api/v1/secrets/${id}` });
                expect(res.statusCode).toBe(204);
              };
            },
          ],
        ];

        for (const [name, prepare] of ways) {
          it(`in a drain, after ${name}: nothing is marked, and that drain tries it again`, async () => {
            const { app, a } = await boot();
            await stopped(app, a, 2);
            const change = await prepare(app, a);
            await app.db.delete(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).run();
            const titles = changedInFlight(change, 'works');
            expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
              ranked: 2,
              stopped: null,
            });
            expect(titles).toEqual(['Engineer 002', 'Engineer 001', 'Engineer 002']);
            expect(await reasons(app, a)).toEqual([null, null]);
            expect((await getBudget(a)).waiting).toBe(0);
          });
        }

        it('in a rank job: it joins the wait unmarked, and a drain ranks it', async () => {
          const { app, a } = await boot();
          const change = async () => void (await addKeyId(a));
          changedInFlight(change, 'works');
          await discover(app, a, 1);
          expect((await results(app, a))[0]).toMatchObject({
            aiScore: 60,
            rankSkipReason: null,
            rankDeferredAt: null,
          });
        });

        it('in a rank job, with no room in the budget: it waits, unmarked, with no drain', async () => {
          const { app, a } = await boot();
          const change = async () => {
            await addKeyId(a);
            await writeDiscoveryBudget(app.db, ctxOf(a), 2 * CALL_USD);
            await spend(app, a, 2 * CALL_USD);
          };
          changedInFlight(change, 'works');
          await discover(app, a, 1);
          expect((await results(app, a))[0]).toMatchObject({
            aiScore: null,
            rankSkipReason: null,
            rankDeferredAt: expect.any(Number),
          });
          // Any status: the queue has run, so a drain queued wrongly would have finished by now.
          expect(
            await app.db.select().from(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).all(),
          ).toEqual([]);
        });

        it('a new key refused too brings the stop back after one more call', async () => {
          const { app, a } = await boot();
          await stopped(app, a, 2);
          const titles = changedInFlight(async () => void (await addKeyId(a)), 'refused');
          await app.db.delete(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).run();
          expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
            ranked: 0,
            stopped: 'key_rejected',
          });
          expect(titles).toEqual(['Engineer 002', 'Engineer 001']);
          expect(await reasons(app, a)).toEqual(['key_rejected', 'key_rejected']);
        });

        it('a key changed before the call began says nothing: the 401 marks them', async () => {
          const { app, a } = await boot();
          await stopped(app, a, 2);
          await addKeyId(a);
          await app.db.delete(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).run();
          vi.setSystemTime(Date.now() + 1000);
          vi.mocked(runStructured).mockRejectedValue(rejected());
          expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
            stopped: 'key_rejected',
          });
          expect(vi.mocked(runStructured)).toHaveBeenCalledOnce();
        });

        it('another user’s key change does not stop this user’s 401 marking', async () => {
          const { app, a, b } = await boot();
          const today = await waitingPostings(app, a, 2);
          await writeDiscoveryBudget(app.db, ctxOf(a), 1);
          vi.setSystemTime(today + DAY + 60_000);
          changedInFlight(async () => void (await addKeyId(b)), 'refused');
          expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({
            stopped: 'key_rejected',
          });
          expect(await reasons(app, a)).toEqual(['key_rejected', 'key_rejected']);
        });
      });

      it('another kind of secret leaves them stopped', async () => {
        const { app, a } = await boot();
        await stopped(app, a, 2);
        const res = await a.request({
          method: 'POST',
          url: '/api/v1/secrets',
          payload: { kind: 'device_token', label: 'a device', value: 'made-up-token' },
        });
        expect(res.statusCode, res.body).toBe(201);
        expect(await reasons(app, a)).toEqual(['key_rejected', 'key_rejected']);
        expect(await drainsQueued(app, a)).toBe(0);
        const gone = await a.request({ method: 'DELETE', url: `/api/v1/secrets/${secretId(res)}` });
        expect(gone.statusCode, gone.body).toBe(204);
        expect(await reasons(app, a)).toEqual(['key_rejected', 'key_rejected']);
        expect(await drainsQueued(app, a)).toBe(0);
      });

      it('with no room in the budget: the cards clear, and no drain until there is', async () => {
        const { app, a } = await boot();
        await stopped(app, a, 2);
        await spend(app, a, 1);
        await addKeyId(a);
        expect(await reasons(app, a)).toEqual([null, null]);
        expect(await drainsQueued(app, a)).toBe(0);
      });

      // sec on https://github.com/bgoleno/opportun/pull/275: the action has happened, so it is on
      // the record even if what follows it fails.
      describe('the audit row comes first, if resuming fails', () => {
        const audited = async (app: FastifyInstance, c: TestClient, event: string) =>
          (
            await app.db
              .select({ id: auditLog.id })
              .from(auditLog)
              .where(and(eq(auditLog.userId, c.userId), eq(auditLog.event, event)))
              .all()
          ).length;
        /** Resuming counts what waits, and nothing before the audit row reads a count of that name. */
        const resumingFails = (app: FastifyInstance) => {
          const select = app.db.select.bind(app.db);
          return vi.spyOn(app.db, 'select').mockImplementation(((fields?: object) => {
            if (fields !== undefined && 'n' in fields) throw new Error('read failed');
            return select(fields as never);
          }) as never);
        };
        afterEach(() => {
          vi.restoreAllMocks();
        });

        it('a key deleted', async () => {
          const { app, a } = await boot();
          const id = await addKeyId(a);
          const failing = resumingFails(app);
          const res = await a.request({ method: 'DELETE', url: `/api/v1/secrets/${id}` });
          expect(failing).toHaveBeenCalled();
          expect(res.statusCode).toBe(500);
          expect(await audited(app, a, 'secret.deleted')).toBe(1);
        });

        it('a ranking policy set', async () => {
          const { app, a } = await boot();
          const failing = resumingFails(app);
          const res = await putPolicy(a, 'discovery.rank');
          expect(failing).toHaveBeenCalled();
          expect(res.statusCode).toBe(500);
          expect(await audited(app, a, 'ai.policy.updated')).toBe(1);
        });

        it('a re-check that succeeds', async () => {
          const { app, a } = await boot();
          const id = await addKeyId(a);
          vi.stubGlobal('fetch', modelList(200));
          const failing = resumingFails(app);
          const res = await recheck(a, id);
          expect(failing).toHaveBeenCalled();
          expect(res.statusCode).toBe(500);
          expect(await audited(app, a, 'ai.key.validated')).toBe(1);
        });
      });

      it('with nothing waiting: a re-check queues no drain', async () => {
        const { app, a } = await boot();
        const id = await addKeyId(a);
        vi.stubGlobal('fetch', modelList(200));
        expect((await recheck(a, id)).statusCode).toBe(200);
        expect(await drainsQueued(app, a)).toBe(0);
      });

      /** Adding the key resumed them. The key that was added is rejected too: stopped again. */
      async function rejectedAgain(app: FastifyInstance, c: TestClient) {
        vi.mocked(runStructured).mockRejectedValue(rejected());
        await noSweepDue(app);
        await app.jobs.drain();
        vi.mocked(runStructured).mockClear();
        await noSweepDue(app);
        expect(await reasons(app, c)).toEqual(['key_rejected', 'key_rejected']);
        expect(await drainsQueued(app, c)).toBe(0);
      }
    });

    const addKey = async (c: TestClient) => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in this test')));
      const res = await c.request({
        method: 'POST',
        url: '/api/v1/secrets',
        payload: { kind: 'ai_api_key', label: 'openai', value: 'made-up-key-for-a-test' },
      });
      vi.unstubAllGlobals();
      expect(res.statusCode, res.body).toBe(201);
    };
  });

  it('a posting dismissed while a drain runs keeps its wait, and waits again when restored', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 2);
    const newer = (await byTitle(app, a)).get('Engineer 001')!;
    vi.setSystemTime(today + DAY + 60_000);
    vi.mocked(runStructured).mockImplementationOnce(async () => {
      await setDisposition(app.db, ctxOf(a), newer.id, 'dismissed');
      return { score: 60, rationale: 'A fair match.', disqualifiers: [] } as never;
    });
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: 1 });
    expect((await getBudget(a)).waiting).toBe(0);
    await setDisposition(app.db, ctxOf(a), newer.id, 'pending');
    expect((await getBudget(a)).waiting).toBe(1);
  });

  it('a dismissed result the migration moved to the wait is ranked after Undo', async () => {
    const { app, a } = await boot();
    const today = await waitingPostings(app, a, 1);
    const [r] = await results(app, a);
    // What the migration leaves for a result dismissed after a budget refusal.
    await setDisposition(app.db, ctxOf(a), r!.id, 'dismissed');
    vi.setSystemTime(today + DAY + 60_000);
    const undo = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-undo-dismiss',
      payload: { ids: [r!.id] },
    });
    expect(undo.statusCode, undo.body).toBe(200);
    expect((await getBudget(a)).waiting).toBe(1);
    providerCharges(app, a);
    await sweepWaitingResults(app.db);
    await app.jobs.drain();
    expect((await results(app, a))[0]).toMatchObject({ aiScore: 60, rankDeferredAt: null });
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

  it("another user's waiting postings are not counted, and not ranked", async () => {
    const { app, a, b } = await boot();
    const today = await waitingPostings(app, a, 2);
    expect((await getBudget(b)).waiting).toBe(0);
    vi.setSystemTime(today + DAY + 60_000);
    providerCharges(app, b);
    expect(await drainWaitingResults(app.db, ctxOf(b))).toMatchObject({ ranked: 0, failed: 0 });
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
    expect((await getBudget(a)).waiting).toBe(2);
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

describe('#214: the sweep is scheduled', () => {
  it('hourly, so the next UTC day is reached in every server time zone', async () => {
    const { app } = await boot();
    const schedules = await readSchedules(app.db);
    expect(schedules.find((x) => x.kind === RANK_WAITING_SWEEP_KIND)?.schedule).toEqual({
      cron: RANK_WAITING_SWEEP_CRON,
      enabled: true,
    });
    expect(RANK_WAITING_SWEEP_CRON).toBe('5 * * * *');
  });

  it('the sweep job and the drain job run from the queue', async () => {
    const { app, a } = await boot();
    await writeDiscoveryBudget(app.db, ctxOf(a), 2 * CALL_USD);
    await spend(app, a, 2 * CALL_USD);
    await discover(app, a, 2);
    await app.db
      .update(taskRuns)
      .set({ createdAt: Date.now() - 2 * DAY })
      .run();
    providerCharges(app, a);
    await enqueue(app.db, RANK_WAITING_SWEEP_KIND, {});
    await app.jobs.drain();
    expect((await results(app, a)).every((r) => r.aiScore === 60)).toBe(true);
  });
});

describe('#214 criterion 4: the limit holds', () => {
  it('a budget of a few calls and a larger queue, on parallel workers: never more than the budget plus the calls in flight', async () => {
    const { app, a } = await boot();
    const BUDGET_CALLS = 3;
    const WORKERS = 4;
    // All of a board's first run that goes to ranking (#215), and far more than the budget.
    const QUEUE = FIRST_RUN_RANK_CAP;
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
