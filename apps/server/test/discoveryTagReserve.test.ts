// Tagging keeps a share of the discovery budget (https://github.com/bgoleno/opportun/issues/299,
// slice a of #222): while a company waits for an industry tag, ranking starts a call only while
// today's spend is under 90% of the budget, so a ranking backlog cannot spend the whole day before
// the nightly tagging runs. The other covered tasks may use it up to 100%. The provider is mocked,
// and every posting and company is made up.
//
// The numbers are binary fractions (a call of 1/16 of a dollar against a budget of one dollar), so
// the sums are exact and no comparison here depends on floating-point rounding. A call that dear is
// a sixteenth of the budget, so the reserve's floor of RESERVE_FLOOR_CALLS calls (#317), 5/16, is
// more than the tenth, and ranking's line here is 1 - 5/16 = 0.6875: 10 calls make 0.625, the 11th
// starts and ends at 0.6875, and the 12th does not start. Ranking spend is written one call to a
// ledger row, as the router writes it, since the floor is priced from the day's average call. The
// #317 tests at the end use calls a usual size, where the line is 90%.
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
import { rankBudgetHasRoom } from '../src/jobs/rankBudget';
import { enqueue, runNextJob } from '../src/jobs/runner';
import { setRaceHook } from '../src/lib/racePoints';
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
/** And with one waiting: it stops once spend reaches the line (the floor's, here; see above). */
const RESERVED = 11;

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

/** `n` ranking calls on today's ledger, one row each. */
async function rankCalls(app: FastifyInstance, c: TestClient, n: number) {
  for (let i = 0; i < n; i++) await spend(app, c, CALL_USD, 'discovery.rank');
}

/**
 * Tops today's spend up to `total` dollars with ranking calls of CALL_USD, one row each as the
 * router writes them, and the part of one call left over, whatever the day holds already.
 */
async function spendUpTo(app: FastifyInstance, c: TestClient, total: number) {
  let left = total - (await spentToday(app, c));
  for (; left >= CALL_USD; left -= CALL_USD) await spend(app, c, CALL_USD, 'discovery.rank');
  if (left > 0) await spend(app, c, left, 'discovery.rank');
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
    // 11 calls of 16 are spent (this posting's own, and the rest): at the line, before the whole
    // budget.
    await rankCalls(app, a, RESERVED - 1);
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
    // 0.95 spent of a budget of 1: over the line.
    await spendUpTo(app, a, 0.95);
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

    // Raised to 2: spend is under the line of that, so ranking has room and the drain is queued.
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
    await rankCalls(app, a, WHOLE - 1);
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

  /** One company waiting for a tag and a budget of one; the tests then spend past the line. */
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
    await spendUpTo(app, a, 0.625); // under the line: the call goes ahead
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
    await spendUpTo(app, a, 0.625);
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

// https://github.com/bgoleno/opportun/issues/317 (qa and tl on #315). discovery.rank has no
// concurrency cap of its own, so on a first run up to the worker pool's 4 rank calls pass the check
// together, and a reserve smaller than those calls is spent by them: qa saw no room for tagging at a
// $0.20 budget. So the reserve has a floor of RESERVE_FLOOR_CALLS ranking calls' worth, priced from
// the day's own ranking calls. Calls here cost 1/64 of a dollar, so the sums stay exact.
describe('#317: at a small budget, the calls that start together leave tagging room', () => {
  const SMALL_CALL = 1 / 64;
  const SMALL_BUDGET = 0.25;

  /** Today's ranking spend as `n` calls of `usd` each, so the day's average call is `usd`. */
  async function rankCallsToday(app: FastifyInstance, c: TestClient, n: number, usd: number) {
    for (let i = 0; i < n; i++) await spend(app, c, usd, 'discovery.rank');
  }

  it('at a small budget, ranking stops a few calls short of the 90% line while a company waits', async () => {
    const { app, a } = await boot();
    await suggested(app, a, 'Suggested 1');
    await writeDiscoveryBudget(app.db, ctxOf(a), SMALL_BUDGET);
    // 0.171875 spent: under 90% (0.225), but within 5 calls (0.078125) of the budget.
    await rankCallsToday(app, a, 11, SMALL_CALL);
    expect(await rankBudgetHasRoom(app.db, ctxOf(a))).toBe(false);
    // With no company waiting, ranking may still use the whole budget.
    await app.db.delete(companies).where(eq(companies.userId, a.userId)).run();
    expect(await rankBudgetHasRoom(app.db, ctxOf(a))).toBe(true);
  });

  it('at the $1.00 default and a usual call cost, the line stays at 90%, as before', async () => {
    const { app, a } = await boot();
    await suggested(app, a, 'Suggested 1');
    await writeDiscoveryBudget(app.db, ctxOf(a), BUDGET_USD);
    // Calls of 1/128 dollar, about what a ranking call costs: 5 of them are well under a tenth.
    await rankCallsToday(app, a, 115, 1 / 128); // 0.8984375: just under the line
    expect(await rankBudgetHasRoom(app.db, ctxOf(a))).toBe(true);
    await rankCallsToday(app, a, 1, 1 / 128); // 0.90625: at or over it
    expect(await rankBudgetHasRoom(app.db, ctxOf(a))).toBe(false);
  });

  // tl on https://github.com/bgoleno/opportun/pull/333: with calls dear enough that five cost more
  // than the budget, the floor alone puts the line below nothing, and ranking never starts while a
  // company waits for a tag; a company the model keeps failing on waits for good. Ranking keeps at
  // least half the budget.
  it('when five calls cost more than the budget, ranking still has half of it', async () => {
    const { app, a } = await boot();
    await suggested(app, a, 'Suggested 1');
    const budget = 1 / 16;
    const call = 1 / 64; // five of these are 5/64, more than the budget
    await writeDiscoveryBudget(app.db, ctxOf(a), budget);
    await rankCallsToday(app, a, 1, call);
    expect(await rankBudgetHasRoom(app.db, ctxOf(a))).toBe(true);
    await rankCallsToday(app, a, 1, call); // half the budget: the bound
    expect(await rankBudgetHasRoom(app.db, ctxOf(a))).toBe(false);
  });

  it('before any ranking call today there is no price to go by, and the line is 90%, as before', async () => {
    const { app, a } = await boot();
    await suggested(app, a, 'Suggested 1');
    await writeDiscoveryBudget(app.db, ctxOf(a), SMALL_BUDGET);
    await spend(app, a, 0.2, 'discovery.company_suggest');
    expect(await rankBudgetHasRoom(app.db, ctxOf(a))).toBe(true);
  });

  it("qa's run: a board's first run, its rank calls four at a time, and the night's tagging still has room", async () => {
    const { app, a } = await boot();
    await suggested(app, a, 'Suggested 1');
    await writeDiscoveryBudget(app.db, ctxOf(a), SMALL_BUDGET);
    const calls: string[] = [];
    vi.mocked(runStructured).mockImplementation(async (_deps, task, opts) => {
      calls.push(task);
      await spend(app, a, SMALL_CALL, task);
      if (task === 'discovery.company_tags') {
        const system = (opts as { system: string }).system;
        const refs = [...system.matchAll(/^ref: (c\d+)$/gm)].map(([, ref]) => ref ?? '');
        return { tags: refs.map((ref) => ({ ref, code: '5132' })) } as never;
      }
      return { score: 60, rationale: 'A fair match.', disqualifiers: [] } as never;
    });
    // Each batch of 4 rank calls passes the budget check before any of them is on the ledger, as
    // the default pool of 4 workers does on a first run.
    let waiting: (() => void)[] = [];
    let timer: NodeJS.Timeout | undefined;
    setRaceHook(async (point) => {
      if (point !== 'discoveryRank.budget_checked') return;
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        const go = () => {
          clearTimeout(timer);
          const batch = waiting;
          waiting = [];
          for (const release of batch) release();
        };
        clearTimeout(timer);
        if (waiting.length >= 4) go();
        else timer = setTimeout(go, 100);
      });
    });

    registerSource({
      kind: 'ats_lever',
      async *fetchPostings() {
        for (let i = 1; i <= 30; i++) yield { posting: posting(i), nextCursor: null };
      },
    } satisfies DiscoverySource);
    const src = await createSource(app.db, ctxOf(a), {
      kind: 'ats_lever',
      config: { org: 'initech' },
      roleTargetId: null,
    });
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await runNextJob(app.db, { services: app.jobs.services });
    const worker = () => runNextJob(app.db, { services: app.jobs.services });
    while ((await Promise.all([worker(), worker(), worker(), worker()])).some(Boolean));
    setRaceHook(undefined);

    // Ranking stopped short of the budget, by enough for the tagging call.
    expect(await spentToday(app, a)).toBeLessThan(SMALL_BUDGET);
    const tagged = await tagCompanies(app.db, ctxOf(a));
    expect(tagged).toMatchObject({ tagged: 1, stopped: null });
    expect(await untagged(app, a)).toEqual([]);
    expect(await spentToday(app, a)).toBeLessThanOrEqual(SMALL_BUDGET);
  });
});
