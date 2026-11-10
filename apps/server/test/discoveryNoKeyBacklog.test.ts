// Postings that arrived with no AI key (https://github.com/bgoleno/opportun/issues/262). A rank job
// that finds no key leaves its posting unranked with the reason, outside the budget wait, so before
// this fix nothing ranked it once a key worked and its card said "AI is not set up" for good. Now a
// key that works (added, a policy change, or a ranking that got through) moves those postings into
// the wait, and the drain ranks them under the discovery budget from #214 (tl's shape on #262).
// Below-the-cut and filtered postings are left as they are: the user sends those.
//
// Before any key, the real router runs, so the reason a posting arrives with is the one the app
// writes with no key stored. After that the provider is mocked. Every posting is made up.
import * as ai from '@opportun/ai';
import { runStructured } from '@opportun/ai';
import { newId, type NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { discoveryResults, jobs, taskRuns } from '../src/db/schema';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import { RANK_WAITING_SWEEP_KIND, sweepWaitingResults } from '../src/jobs/discoveryRankWaiting';
import { DISCOVERY_RUN_KIND, FIRST_RUN_RANK_CAP } from '../src/jobs/discoveryRun';
import { enqueue, runNextJob } from '../src/jobs/runner';
import { putSecret } from '../src/lib/secretBox';
import type { UserCtx } from '../src/repos/base';
import { createSource, listResults, setDisposition } from '../src/repos/discovery';
import { writeDiscoveryBudget } from '../src/repos/discoveryBudget';
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
const CALL_USD = 0.01;

// Pinned for the reason discoveryBudget.test.ts gives (#289): no weekly schedule falls in the
// days these tests move through, so no other task calls the mocked provider.
const PINNED_NOW = Date.UTC(2026, 10, 12, 7);

let realRunStructured: typeof runStructured;

beforeEach(async () => {
  vi.useFakeTimers({ now: PINNED_NOW, toFake: ['Date'], shouldAdvanceTime: true });
  realRunStructured = (await vi.importActual<typeof ai>('@opportun/ai')).runStructured;
  vi.mocked(runStructured).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetSources();
});

/** The app's own router, with whatever keys the user has stored: none means no_key. */
function realRouter(): void {
  vi.mocked(runStructured).mockImplementation(realRunStructured);
}

const posting = (i: number): NormalizedPosting => ({
  company: 'Initech',
  title: `Engineer ${String(i).padStart(3, '0')}`,
  descriptionMd: 'Own the platform.',
  postingUrl: `https://boards.example.com/initech/${i}`,
  externalId: `gh-${i}`,
  // Newer the higher the number, so a first run's cut keeps the highest numbers.
  postedAt: Date.UTC(2026, 0, 1) + i * DAY,
});

const title = (i: number) => `Engineer ${String(i).padStart(3, '0')}`;
const range = (low: number, high: number): number[] =>
  Array.from({ length: high - low + 1 }, (_, i) => low + i);

/**
 * A board's run with postings `numbers`, and everything it queued run. Each posting is then
 * given a createdAt that rises with its number, so "oldest first" is not an accident of insertion.
 */
async function discover(
  app: FastifyInstance,
  c: TestClient,
  numbers: number[],
  org = 'initech',
): Promise<string> {
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      for (const i of numbers) yield { posting: posting(i), nextCursor: null };
    },
  } satisfies DiscoverySource);
  const src = await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org },
    roleTargetId: null,
  });
  await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: c.userId });
  await runNextJob(app.db, { services: app.jobs.services });
  await app.jobs.drain();
  for (const row of await results(app, c)) {
    const n = Number(row.posting.title.split(' ')[1]);
    await app.db
      .update(discoveryResults)
      .set({ createdAt: PINNED_NOW - DAY + n * 1000 })
      .where(eq(discoveryResults.id, row.id))
      .run();
  }
  return src.id;
}

const results = async (app: FastifyInstance, c: TestClient) =>
  (await listResults(app.db, ctxOf(c), PAGE)).items;

const byTitle = async (app: FastifyInstance, c: TestClient) =>
  new Map((await results(app, c)).map((r) => [r.posting.title, r]));

/** The titles whose card would say "AI is not set up". */
const sayNoKey = async (app: FastifyInstance, c: TestClient) =>
  (await results(app, c))
    .filter((r) => r.rankSkipReason === 'no_key')
    .map((r) => r.posting.title)
    .sort();

async function spend(app: FastifyInstance, c: TestClient, usd: number) {
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
      createdAt: Date.now(),
    })
    .run();
}

/** The provider answers and charges for each call, and records the titles it was sent. */
function providerCharges(app: FastifyInstance, c: TestClient): { titles: string[] } {
  const titles: string[] = [];
  vi.mocked(runStructured).mockImplementation(async (_deps, _task, opts) => {
    titles.push(/Title: (.*)/.exec(opts.system)?.[1] ?? '');
    await spend(app, c, CALL_USD);
    return { score: 60, rationale: 'A fair match.', disqualifiers: [] } as never;
  });
  return { titles };
}

/** The user adds a key in Settings > AI. Validation cannot reach a provider in a test. */
async function addKey(c: TestClient, provider = 'openai'): Promise<void> {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in this test')));
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/secrets',
    payload: { kind: 'ai_api_key', label: provider, value: 'made-up-key-for-a-test' },
  });
  expect(res.statusCode, res.body).toBe(201);
}

const putRankPolicy = (c: TestClient, provider: string, model: string) =>
  c.request({
    method: 'PUT',
    url: `/api/v1/ai/policies/${DISCOVERY_RANK_KIND}`,
    payload: { provider, model, maxOutputTokens: 4000 },
  });

/** The hourly sweep is not what these tests are about: only what the code under test queues runs. */
const noSweepDue = (app: FastifyInstance) =>
  app.db
    .delete(jobs)
    .where(and(eq(jobs.kind, RANK_WAITING_SWEEP_KIND), eq(jobs.status, 'pending')))
    .run();

describe('#262 criterion 1: postings that arrived with no key are ranked once a key works', () => {
  it('arrived before any key existed: adding one ranks them, oldest first, within the budget', async () => {
    const { app, a } = await boot();
    realRouter();
    await discover(app, a, [1, 2, 3]);
    // The fixture: what a user with no key at all has after a board's run.
    expect((await results(app, a)).map((r) => [r.rankSkipReason, r.rankDeferredAt])).toEqual([
      ['no_key', null],
      ['no_key', null],
      ['no_key', null],
    ]);

    // A budget of two calls (#214), so the third must wait for the next budget day.
    await writeDiscoveryBudget(app.db, ctxOf(a), 2 * CALL_USD);
    const { titles } = providerCharges(app, a);
    await noSweepDue(app);
    await addKey(a);
    expect(await sayNoKey(app, a)).toEqual([]);
    await app.jobs.drain();
    expect(titles).toEqual([title(1), title(2)]);
    expect((await byTitle(app, a)).get(title(3))).toMatchObject({
      aiScore: null,
      rankSkipReason: null,
      rankDeferredAt: expect.any(Number),
    });

    // The next budget day's sweep takes the rest, with nothing more from the user.
    vi.setSystemTime(PINNED_NOW + DAY);
    await sweepWaitingResults(app.db);
    await app.jobs.drain();
    expect(titles).toEqual([title(1), title(2), title(3)]);
    expect((await results(app, a)).every((r) => r.aiScore === 60)).toBe(true);
  });

  // qa on https://github.com/bgoleno/opportun/pull/266#issuecomment-6653126828: before this, the 15
  // sent by Rank these were ranked and the 25 the first run sent stayed on "AI is not set up".
  it("qa's case: no key at a board's first run, then a key and Rank these: every posting is ranked", async () => {
    const { app, a } = await boot();
    realRouter();
    const count = FIRST_RUN_RANK_CAP + 15;
    const sourceId = await discover(app, a, range(1, count));
    expect(await sayNoKey(app, a)).toEqual(range(16, count).map(title).sort());
    const belowCut = (await results(app, a))
      .filter((r) => r.rankSkipReason === 'below_cut')
      .map((r) => r.posting.title)
      .sort();
    expect(belowCut).toEqual(range(1, 15).map(title).sort());

    const { titles } = providerCharges(app, a);
    await noSweepDue(app);
    await addKey(a);
    // Below the cut is left alone: the key sends none of those, and they keep their reason.
    const after = await byTitle(app, a);
    for (const i of range(1, 15)) {
      expect(after.get(title(i))).toMatchObject({
        rankSkipReason: 'below_cut',
        rankDeferredAt: null,
      });
    }
    await app.jobs.drain();
    expect([...titles].sort()).toEqual(range(16, count).map(title).sort());

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/sources/${sourceId}/rank-below-cut`,
      payload: { count: 15 },
    });
    expect(res.statusCode, res.body).toBe(202);
    await app.jobs.drain();
    const final = await results(app, a);
    expect(final.filter((r) => r.aiScore === null).map((r) => r.posting.title)).toEqual([]);
    expect(final.some((r) => r.rankSkipReason !== null)).toBe(false);
  });

  it('a ranking that gets through on any path moves them too, and the sweep ranks them', async () => {
    const { app, a } = await boot();
    realRouter();
    await discover(app, a, [1, 2]);
    // The key came back without passing through Settings: a ranking simply works now.
    const { titles } = providerCharges(app, a);
    await noSweepDue(app);
    await discover(app, a, [100], 'initech-later');
    expect(titles).toEqual([title(100)]);
    expect(await sayNoKey(app, a)).toEqual([]);
    await sweepWaitingResults(app.db);
    await app.jobs.drain();
    expect(titles).toEqual([title(100), title(1), title(2)]);
  });

  it('a filtered posting, another user’s postings, and a decided one are left as they are', async () => {
    const { app, a, b } = await boot();
    realRouter();
    await discover(app, a, [1, 2, 3, 4]);
    await discover(app, b, [9]);
    const rows = await byTitle(app, a);
    await app.db
      .update(discoveryResults)
      .set({ rankSkipReason: 'filtered' })
      .where(eq(discoveryResults.id, rows.get(title(2))!.id))
      .run();
    await setDisposition(app.db, ctxOf(a), rows.get(title(3))!.id, 'accepted');
    await setDisposition(app.db, ctxOf(a), rows.get(title(4))!.id, 'dismissed');

    providerCharges(app, a);
    await noSweepDue(app);
    await addKey(a);
    const after = await byTitle(app, a);
    expect(after.get(title(1))).toMatchObject({
      rankSkipReason: null,
      rankDeferredAt: expect.any(Number),
    });
    expect(after.get(title(2))).toMatchObject({ rankSkipReason: 'filtered', rankDeferredAt: null });
    // Accepted: nothing is left to rank it for, but a key works, so the card no longer says it.
    expect(after.get(title(3))).toMatchObject({ rankSkipReason: null, rankDeferredAt: null });
    // Dismissed: not ranked while dismissed, and with no reason left, Undo puts it in the wait (the
    // next test).
    expect(after.get(title(4))).toMatchObject({ rankSkipReason: null, rankDeferredAt: null });
    expect(await sayNoKey(app, b)).toEqual([title(9)]);
  });

  it('a dismissed posting that arrived with no key is ranked after Undo', async () => {
    const { app, a } = await boot();
    realRouter();
    await discover(app, a, [1]);
    const id = (await results(app, a))[0]!.id;
    await setDisposition(app.db, ctxOf(a), id, 'dismissed');
    const { titles } = providerCharges(app, a);
    await noSweepDue(app);
    await addKey(a);
    await app.jobs.drain();
    expect(titles).toEqual([]);
    const undo = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-undo-dismiss',
      payload: { ids: [id] },
    });
    expect(undo.statusCode, undo.body).toBe(200);
    await sweepWaitingResults(app.db);
    await app.jobs.drain();
    expect(titles).toEqual([title(1)]);
  });
});

describe('#262 criterion 2: "AI is not set up" only while it is true for the current policy', () => {
  it('a policy change to a provider that has a key: no card says it, and they are ranked', async () => {
    const { app, a } = await boot();
    // An OpenAI key is stored, and ranking uses the default provider, which has none.
    await putSecret(app.db, ctxOf(a), 'ai_api_key', 'openai', 'made-up-key-for-a-test');
    realRouter();
    await discover(app, a, [1, 2]);
    expect(await sayNoKey(app, a)).toEqual([title(1), title(2)]);

    const { titles } = providerCharges(app, a);
    await noSweepDue(app);
    const res = await putRankPolicy(a, 'openai', 'gpt-5.5-mini');
    expect(res.statusCode, res.body).toBe(200);
    expect(await sayNoKey(app, a)).toEqual([]);
    await app.jobs.drain();
    expect(titles).toEqual([title(1), title(2)]);
  });

  it('a policy change to a provider with no key either: the cards say so again, after one look', async () => {
    const { app, a } = await boot();
    realRouter();
    await discover(app, a, [1, 2]);
    await noSweepDue(app);
    const res = await putRankPolicy(a, 'openai', 'gpt-5.5-mini');
    expect(res.statusCode, res.body).toBe(200);
    await app.jobs.drain();
    expect(await sayNoKey(app, a)).toEqual([title(1), title(2)]);
    // Still unranked, and still in the wait, so the next key that works ranks them.
    expect((await results(app, a)).every((r) => r.rankDeferredAt !== null)).toBe(true);
  });
});
