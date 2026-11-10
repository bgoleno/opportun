// Tagging keeps a share of the discovery budget (https://github.com/bgoleno/opportun/issues/299,
// slice a of #222): while a company waits for an industry tag, ranking starts a call only while
// today's spend is under 90% of the budget, so a ranking backlog cannot spend the whole day before
// the nightly tagging runs. The other covered tasks may use it up to 100%. The provider is mocked,
// and every posting and company is made up.
//
// The numbers are binary fractions (a call of 1/16 of a dollar against a budget of one dollar), so
// the sums are exact and no comparison here depends on floating-point rounding. Ranking starts
// calls while spend is under 0.9: 14 calls make 0.875, the 15th starts and ends at 0.9375, and the
// 16th does not start. What is left, 1/16, is one tagging call.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import { newId, type NormalizedPosting } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { companies, discoveryResults, jobs, taskRuns } from '../src/db/schema';
import { tagCompanies } from '../src/jobs/companyTags';
import { DISCOVERY_RANK_KIND, rankResult } from '../src/jobs/discoveryRank';
import {
  drainWaitingResults,
  RANK_WAITING_KIND,
  resumeAfterKeyChange,
  resumeAfterUndo,
  sweepWaitingResults,
} from '../src/jobs/discoveryRankWaiting';
import { DISCOVERY_RUN_KIND, FIRST_RUN_RANK_CAP } from '../src/jobs/discoveryRun';
import { enqueue, runNextJob } from '../src/jobs/runner';
import type { UserCtx } from '../src/repos/base';
import { createCompany } from '../src/repos/companies';
import { countWaitingResults, createSource, listResults } from '../src/repos/discovery';
import {
  discoverySpentTodayUsd,
  writeDiscoveryBudget,
  writeKeyChangedAt,
} from '../src/repos/discoveryBudget';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
const PAGE = { limit: 200, offset: 0 };
const DAY = 86_400_000;
const CALL_USD = 0.0625;
const BUDGET_USD = 1;
/** Calls ranking makes with no company waiting for a tag: the whole budget. */
const WHOLE = 16;
/** And with one waiting: it stops once spend is at or over 90% of the budget. */
const RESERVED = 15;

// The same pinned clock as discoveryBudget.test.ts: no weekly schedule falls inside the days these
// tests move through (https://github.com/bgoleno/opportun/issues/289).
const PINNED_NOW = Date.UTC(2026, 10, 12, 7);
const TODAY = Math.floor(PINNED_NOW / DAY) * DAY;

beforeEach(() => {
  vi.useFakeTimers({ now: PINNED_NOW, toFake: ['Date'], shouldAdvanceTime: true });
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

async function discover(app: FastifyInstance, c: TestClient, count: number): Promise<void> {
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
  await app.jobs.drain();
}

/** A recorded call, as the router writes one. */
async function spend(app: FastifyInstance, c: TestClient, usd: number, taskKey: string) {
  await app.db
    .insert(taskRuns)
    .values({
      id: newId(),
      userId: c.userId,
      taskKey,
      provider: 'openai',
      model: 'placeholder-model',
      inputTokens: 100,
      outputTokens: 10,
      estCost: usd,
      fallbackPricing: false,
      durationMs: 1,
      status: 'ok',
      error: null,
      createdAt: Date.now(),
    })
    .run();
}

/** The provider answers a ranking with a score and a tagging with a code, and charges either. */
function providerCharges(app: FastifyInstance, c: TestClient) {
  const calls: string[] = [];
  vi.mocked(runStructured).mockImplementation(async (_deps, task, opts) => {
    calls.push(task);
    await new Promise((resolve) => setImmediate(resolve));
    await spend(app, c, CALL_USD, task);
    if (task === 'discovery.company_tags') {
      const system = (opts as { system: string }).system;
      const refs = [...system.matchAll(/^ref: (c\d+)$/gm)].map(([, ref]) => ref ?? '');
      return { tags: refs.map((ref) => ({ ref, code: '5132' })) } as never;
    }
    return { score: 60, rationale: 'A fair match.', disqualifiers: [] } as never;
  });
  return calls;
}

const suggested = (app: FastifyInstance, c: TestClient, name: string) =>
  createCompany(app.db, ctxOf(c), { name, status: 'suggested' });

const untagged = async (app: FastifyInstance, c: TestClient) =>
  (await app.db.select().from(companies).where(eq(companies.userId, c.userId)).all()).filter(
    (r) => r.industryAt === null,
  );

/**
 * The day's budget is spent, `count` postings arrive and wait, and then the next UTC day begins:
 * a backlog larger than the budget, with a whole day's budget in front of it.
 */
async function backlog(app: FastifyInstance, c: TestClient, count: number): Promise<void> {
  vi.useFakeTimers({ now: TODAY + 3_600_000, toFake: ['Date'] });
  await writeDiscoveryBudget(app.db, ctxOf(c), BUDGET_USD);
  await spend(app, c, BUDGET_USD, 'discovery.rank');
  await discover(app, c, count);
  vi.setSystemTime(TODAY + DAY + 60_000);
}

const spentToday = (app: FastifyInstance, c: TestClient) =>
  discoverySpentTodayUsd(app.db, ctxOf(c));

/** Tops today's spend up to `total` dollars with ranking calls, whatever the day holds already. */
async function spendUpTo(app: FastifyInstance, c: TestClient, total: number) {
  await spend(app, c, total - (await spentToday(app, c)), 'discovery.rank');
}

describe('#299 criteria 1 and 4: ranking leaves the last tenth for tagging while companies wait', () => {
  it('a backlog larger than the budget, and untagged candidates: the candidates end the day tagged, within the budget', async () => {
    const { app, a } = await boot();
    for (let i = 1; i <= 3; i++) await suggested(app, a, `Suggested ${i}`);
    await backlog(app, a, 30);
    const calls = providerCharges(app, a);

    // The hourly drain gets there first, as it does after midnight UTC.
    const drained = await drainWaitingResults(app.db, ctxOf(a));
    expect(drained).toMatchObject({ ranked: RESERVED, stopped: 'budget_exceeded' });
    expect(await spentToday(app, a)).toBe(RESERVED * CALL_USD);

    // The nightly tagging then has room, and tags every candidate in its one call.
    const tagged = await tagCompanies(app.db, ctxOf(a));
    expect(tagged).toMatchObject({ tagged: 3, calls: 1, stopped: null });
    expect(await untagged(app, a)).toEqual([]);
    expect(calls.filter((t) => t === 'discovery.company_tags')).toHaveLength(1);
    // Within the budget: nothing past it, and what is left of the backlog still waits. (A board's
    // first run sends 25 postings to be ranked, the rest are held below the cut: 30 arrive, 25 wait.)
    expect(await spentToday(app, a)).toBeLessThanOrEqual(BUDGET_USD);
    expect(await countWaitingResults(app.db, ctxOf(a))).toBe(FIRST_RUN_RANK_CAP - RESERVED);
  });

  it('the same with no company waiting: ranking uses the whole budget, as before (criterion 2)', async () => {
    const { app, a } = await boot();
    await backlog(app, a, 30);
    const calls = providerCharges(app, a);

    const drained = await drainWaitingResults(app.db, ctxOf(a));
    expect(drained).toMatchObject({ ranked: WHOLE, stopped: 'budget_exceeded' });
    expect(await spentToday(app, a)).toBe(BUDGET_USD);
    expect(calls.every((t) => t === 'discovery.rank')).toBe(true);
  });

  it('a company that is followed, denied or already tagged does not hold the reserve', async () => {
    const { app, a } = await boot();
    await createCompany(app.db, ctxOf(a), { name: 'Followed Co', status: 'followed' });
    await createCompany(app.db, ctxOf(a), { name: 'Denied Co', status: 'denied' });
    const done = await suggested(app, a, 'Tagged Co');
    await app.db
      .update(companies)
      .set({ naicsCode: '5132', industrySource: 'ai', industryAt: Date.now() })
      .where(eq(companies.id, done.id))
      .run();
    await backlog(app, a, 30);
    providerCharges(app, a);

    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: WHOLE });
  });

  it("another user's untagged company does not hold this user's reserve", async () => {
    const { app, a, b } = await boot();
    await suggested(app, b, 'Their Company');
    await backlog(app, a, 30);
    providerCharges(app, a);

    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: WHOLE });
  });
});

describe('#299 criterion 4: the reserve is released once the last candidate is tagged', () => {
  it('ranking goes on to the whole budget when nothing waits for a tag any more', async () => {
    const { app, a } = await boot();
    const company = await suggested(app, a, 'Suggested 1');
    await backlog(app, a, 30);
    providerCharges(app, a);

    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: RESERVED });
    // The sweep, too, holds back while the candidate waits.
    expect(await sweepWaitingResults(app.db)).toEqual({ queued: 0 });

    // The candidate is tagged (here by hand: the nightly call is not the point).
    await app.db
      .update(companies)
      .set({ naicsCode: '5132', industrySource: 'ai', industryAt: Date.now() })
      .where(eq(companies.id, company.id))
      .run();

    expect(await sweepWaitingResults(app.db)).toEqual({ queued: 1 });
    const next = await drainWaitingResults(app.db, ctxOf(a));
    expect(next.ranked).toBe(WHOLE - RESERVED);
    expect(await spentToday(app, a)).toBe(BUDGET_USD);
  });

  it('a company the model could not place is tagged-or-tried, and releases it too', async () => {
    const { app, a } = await boot();
    const company = await suggested(app, a, 'Suggested 1');
    await backlog(app, a, 30);
    providerCharges(app, a);
    // Tried with no code: it has an answer, and is not asked again until job titles arrive.
    await app.db
      .update(companies)
      .set({ industryAt: Date.now() })
      .where(eq(companies.id, company.id))
      .run();

    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: WHOLE });
  });
});

describe('#299 criterion 3: every path that checks for room before a rank call', () => {
  it('a rank job for one posting waits at the reserve, and goes ahead with no candidate', async () => {
    const { app, a } = await boot();
    await writeDiscoveryBudget(app.db, ctxOf(a), BUDGET_USD);
    providerCharges(app, a);
    await discover(app, a, 1);
    const [row] = (await listResults(app.db, ctxOf(a), PAGE)).items;
    await app.db
      .update(discoveryResults)
      .set({ aiScore: null, rankDeferredAt: null, rankSkipReason: null })
      .where(eq(discoveryResults.id, row!.id))
      .run();
    // 15 calls of 16 are spent (this posting's own, and the rest): past the 90% line, before the
    // whole budget.
    await spend(app, a, (RESERVED - 1) * CALL_USD, 'discovery.rank');
    await suggested(app, a, 'Suggested 1');
    vi.mocked(runStructured).mockClear();

    expect(await rankResult(app.db, ctxOf(a), row!.id)).toMatchObject({
      status: 'skipped',
      reason: 'budget_exceeded',
    });
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();

    // With the candidate tagged, the same call goes ahead.
    await app.db
      .update(companies)
      .set({ industryAt: Date.now() })
      .where(eq(companies.userId, a.userId))
      .run();
    expect(await rankResult(app.db, ctxOf(a), row!.id)).toMatchObject({ status: 'ranked' });
  });

  it('raising the budget queues a drain only when ranking has room under the reserve', async () => {
    const { app, a } = await boot();
    await backlog(app, a, 3);
    await suggested(app, a, 'Suggested 1');
    // 0.95 spent of a budget of 1: over the 90% line.
    await spend(app, a, 0.95, 'discovery.rank');
    const queued = async () =>
      await app.db.select().from(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).all();
    expect(await queued()).toEqual([]);

    // Set to the same value: room for tagging, none for ranking, so nothing is queued.
    const res = await a.request({
      method: 'PUT',
      url: '/api/v1/ai/discovery-budget',
      payload: { dailyUsd: BUDGET_USD },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await queued()).toEqual([]);

    // Raised to 2: spend is under 90% of that, so ranking has room and the drain is queued.
    expect(
      (
        await a.request({
          method: 'PUT',
          url: '/api/v1/ai/discovery-budget',
          payload: { dailyUsd: 2 },
        })
      ).statusCode,
    ).toBe(200);
    expect(await queued()).toHaveLength(1);
  });
});

describe('#299: the other covered tasks use the budget up to 100%', () => {
  it('tagging goes ahead up to the whole budget, on the share ranking left it', async () => {
    const { app, a } = await boot();
    for (let i = 1; i <= 25; i++) await suggested(app, a, `Suggested ${i}`);
    // Spend is already past the ranking line, with room for exactly one more call.
    await spend(app, a, RESERVED * CALL_USD, 'discovery.rank');
    providerCharges(app, a);

    const run = await tagCompanies(app.db, ctxOf(a));
    // One call of 20 (the batch), then the budget is spent: the other 5 wait for tomorrow.
    expect(run).toMatchObject({ tagged: 20, calls: 1, stopped: 'budget_exceeded' });
    expect(await spentToday(app, a)).toBe(BUDGET_USD);
  });
});

/**
 * The paths that queue the drain of postings waiting for the budget, which must not queue it while
 * the reserve holds ranking back: a drain started there would end at its first posting, and ask the
 * whole queue about it every hour.
 */
describe('#299 criterion 3: the paths that queue the drain', () => {
  const queuedDrains = async (app: FastifyInstance) =>
    await app.db.select().from(jobs).where(eq(jobs.kind, RANK_WAITING_KIND)).all();

  /** One company waiting for a tag, a budget of one, and 0.95 of it spent: past the ranking line. */
  async function pastTheLine(app: FastifyInstance, c: TestClient, candidate: boolean) {
    await writeDiscoveryBudget(app.db, ctxOf(c), BUDGET_USD);
    if (candidate) await suggested(app, c, 'Suggested 1');
  }

  /** The caller's results, scores cleared, so they are postings nothing has ranked yet. */
  async function unrankedResults(app: FastifyInstance, c: TestClient, count: number) {
    providerCharges(app, c);
    await discover(app, c, count);
    await app.db
      .update(discoveryResults)
      .set({ aiScore: null, aiRationale: null, rankDeferredAt: null, rankSkipReason: null })
      .where(eq(discoveryResults.userId, c.userId))
      .run();
    vi.mocked(runStructured).mockReset();
    return (await listResults(app.db, ctxOf(c), PAGE)).items;
  }

  const bothWays = async (
    app: FastifyInstance,
    c: TestClient,
    act: () => Promise<unknown>,
  ): Promise<void> => {
    // A company waits for a tag: past the line, nothing is queued.
    await act();
    expect(await queuedDrains(app)).toEqual([]);
    // Its tag arrives: the same call queues the drain.
    await app.db
      .update(companies)
      .set({ industryAt: Date.now() })
      .where(eq(companies.userId, c.userId))
      .run();
    await act();
    expect(await queuedDrains(app)).toHaveLength(1);
  };

  it('a key change queues the drain only when ranking has room (resumeAfterKeyChange)', async () => {
    const { app, a } = await boot();
    await backlog(app, a, 3);
    await pastTheLine(app, a, true);
    await spendUpTo(app, a, 0.95);
    await bothWays(app, a, () => resumeAfterKeyChange(app.db, ctxOf(a)));
  });

  it('Undo queues the drain only when ranking has room (resumeAfterUndo)', async () => {
    const { app, a } = await boot();
    await pastTheLine(app, a, true);
    const [row] = await unrankedResults(app, a, 1);
    await spendUpTo(app, a, 0.95);
    // The first call marks the posting as waiting; a posting restored by Undo is not yet.
    const restore = async () => {
      await app.db
        .update(discoveryResults)
        .set({ rankDeferredAt: null, rankSkipReason: null })
        .where(eq(discoveryResults.id, row!.id))
        .run();
      await resumeAfterUndo(app.db, ctxOf(a), [row!.id]);
    };
    await bothWays(app, a, restore);
  });

  it('a rank job that goes behind an older waiting posting queues the drain only with room', async () => {
    const { app, a } = await boot();
    await pastTheLine(app, a, true);
    const [first, second] = await unrankedResults(app, a, 2);
    // `first` is the older posting, and waits.
    await app.db
      .update(discoveryResults)
      .set({ createdAt: 1000, rankDeferredAt: 1000 })
      .where(eq(discoveryResults.id, first!.id))
      .run();
    await spendUpTo(app, a, 0.95);
    await bothWays(app, a, async () => {
      await enqueue(
        app.db,
        DISCOVERY_RANK_KIND,
        { resultId: second!.id },
        { userId: a.userId, dedupeKey: `${DISCOVERY_RANK_KIND}:${second!.id}:${newId()}` },
      );
      await runNextJob(app.db, { services: app.jobs.services });
    });
  });

  it('a rank call that crosses the line, with the key changed during it, queues no drain', async () => {
    const { app, a } = await boot();
    await pastTheLine(app, a, true);
    const [row] = await unrankedResults(app, a, 1);
    await spendUpTo(app, a, 0.85); // under the line: the call goes ahead
    vi.mocked(runStructured).mockImplementation(async () => {
      await spend(app, a, 0.1, 'discovery.rank'); // and ends past it
      await writeKeyChangedAt(app.db, ctxOf(a), Date.now() + 60_000);
      throw new AiUnavailableError('provider_error', 'HTTP 401', { keyRejected: true });
    });
    await enqueue(
      app.db,
      DISCOVERY_RANK_KIND,
      { resultId: row!.id },
      { userId: a.userId, dedupeKey: `${DISCOVERY_RANK_KIND}:${row!.id}:${newId()}` },
    );
    await runNextJob(app.db, { services: app.jobs.services });
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(1);
    expect(await queuedDrains(app)).toEqual([]);
  });

  it('a rank call that crosses the line, with the posting changed during it, queues no drain', async () => {
    const { app, a } = await boot();
    await pastTheLine(app, a, true);
    const [row] = await unrankedResults(app, a, 1);
    await spendUpTo(app, a, 0.85);
    vi.mocked(runStructured).mockImplementation(async () => {
      await spend(app, a, 0.1, 'discovery.rank');
      await app.db
        .update(discoveryResults)
        .set({ posting: { ...row!.posting, descriptionMd: 'New text, found on the board.' } })
        .where(eq(discoveryResults.id, row!.id))
        .run();
      return { score: 60, rationale: 'A fair match.', disqualifiers: [] } as never;
    });
    await enqueue(
      app.db,
      DISCOVERY_RANK_KIND,
      { resultId: row!.id },
      { userId: a.userId, dedupeKey: `${DISCOVERY_RANK_KIND}:${row!.id}:${newId()}` },
    );
    await runNextJob(app.db, { services: app.jobs.services });
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(1);
    expect(await queuedDrains(app)).toEqual([]);
  });
});
