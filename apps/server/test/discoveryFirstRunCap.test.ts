// A board's first run ranks at most 25 postings; the rest wait below the cut until the user sends
// them through the budget (https://github.com/bgoleno/opportun/issues/215, #190 N1b). The provider
// is mocked and every posting is made up.
import { runStructured } from '@opportun/ai';
import { newId, type NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerSource,
  resetSources,
  SourceConfigError,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { discoveryResults, discoveryRuns, jobs, taskRuns } from '../src/db/schema';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import {
  DISCOVERY_RUN_KIND,
  FIRST_RUN_RANK_CAP,
  insertLeads,
  rankBelowCut,
} from '../src/jobs/discoveryRun';
import { LEAD_RESOLVE_KIND } from '../src/jobs/leadResolve';
import { enqueue, runNextJob } from '../src/jobs/runner';
import { setRaceHook } from '../src/lib/racePoints';
import type { UserCtx } from '../src/repos/base';
import { createCompany } from '../src/repos/companies';
import { createSource, listResults, setDisposition } from '../src/repos/discovery';
import { discoveryCostFigures } from '../src/repos/discoveryFigures';
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
const JAN_1 = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
});
afterEach(() => resetSources());

/** Posting `i`, posted `i` days after January 1, so a higher number is newer. */
const posting = (i: number, over: Partial<NormalizedPosting> = {}): NormalizedPosting => ({
  company: 'Initech',
  title: `Engineer ${String(i).padStart(3, '0')}`,
  descriptionMd: 'Own the platform.',
  postingUrl: `https://boards.example.com/initech/${i}`,
  externalId: `gh-${i}`,
  postedAt: JAN_1 + i * DAY,
  ...over,
});

/** The numbers 1 to `n`, in an order that is neither newest first nor oldest first. */
const shuffled = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => i + 1).sort((x, y) => ((x * 7) % n) - ((y * 7) % n));

interface Feed {
  postings: NormalizedPosting[];
  /** Thrown after every posting has been yielded. */
  fail?: Error | null;
  /** Runs after every posting has been yielded, before the run finishes. */
  during?: (() => Promise<void>) | null;
}

function feedSource(feed: Feed, kind: DiscoverySource['kind'] = 'ats_lever'): void {
  registerSource({
    kind,
    async *fetchPostings() {
      for (const p of feed.postings) yield { posting: p, nextCursor: null };
      await feed.during?.();
      if (feed.fail != null) throw feed.fail;
    },
  } satisfies DiscoverySource);
}

async function board(app: FastifyInstance, c: TestClient) {
  return await createSource(app.db, ctxOf(c), { kind: 'ats_lever', config: { org: 'initech' } });
}

/**
 * Runs the source's job once, and leaves anything it queued unrun. Due before anything else, so a
 * later run goes ahead of the rank jobs an earlier one left queued.
 */
async function runOnce(app: FastifyInstance, c: TestClient, sourceId: string): Promise<void> {
  await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId }, { userId: c.userId, runAt: 0 });
  await runNextJob(app.db, { services: app.jobs.services });
}

/** The titles of the postings that have a pending job of `kind`. */
async function queuedTitles(
  app: FastifyInstance,
  c: TestClient,
  kind: string = DISCOVERY_RANK_KIND,
): Promise<string[]> {
  const queued = await app.db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.kind, kind), eq(jobs.status, 'pending')))
    .all();
  const ids = new Set(queued.map((j) => (j.payload as { resultId: string }).resultId));
  return (await results(app, c))
    .filter((r) => ids.has(r.id))
    .map((r) => r.posting.title)
    .sort();
}

const results = async (app: FastifyInstance, c: TestClient) =>
  (await listResults(app.db, ctxOf(c), PAGE)).items;

const belowCutTitles = async (app: FastifyInstance, c: TestClient) =>
  (await results(app, c))
    .filter((r) => r.disposition === 'pending' && r.rankSkipReason === 'below_cut')
    .map((r) => r.posting.title)
    .sort();

const titles = (numbers: number[]): string[] =>
  numbers.map((i) => `Engineer ${String(i).padStart(3, '0')}`).sort();

/** The range low..high, inclusive. */
const range = (low: number, high: number): number[] =>
  Array.from({ length: high - low + 1 }, (_, i) => low + i);

const figuresFor = async (app: FastifyInstance, c: TestClient, sourceId: string) => {
  const figures = await discoveryCostFigures(app.db, ctxOf(c));
  return figures.sources.find((s) => s.sourceId === sourceId);
};

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

const postRankBelowCut = (c: TestClient, sourceId: string, payload: unknown) =>
  c.request({
    method: 'POST',
    url: `/api/v1/discovery/sources/${sourceId}/rank-below-cut`,
    payload: payload as Record<string, unknown>,
  });

describe('#215 criterion 1: the cap on a first run', () => {
  it('the cap is 25', () => {
    expect(FIRST_RUN_RANK_CAP).toBe(25);
  });

  it('queues exactly the 25 newest by posting date, whatever order the board lists them in', async () => {
    const { app, a } = await boot();
    feedSource({ postings: shuffled(40).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a)).toEqual(titles(range(16, 40)));
  });

  it('a posting with no date goes after every dated one', async () => {
    const { app, a } = await boot();
    feedSource({
      postings: [
        ...range(1, 5).map((i) => posting(i, { postedAt: null })),
        ...range(6, 30).map((i) => posting(i)),
      ],
    });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a)).toEqual(titles(range(6, 30)));
  });

  it('25 or fewer are all queued, with nothing below the cut', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 25).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a)).toHaveLength(25);
    expect(await belowCutTitles(app, a)).toEqual([]);
  });

  it('a duplicate does not take a place', async () => {
    const { app, a } = await boot();
    // The last two have one dedupe key, and are the newest: the second is not stored.
    feedSource({
      postings: [
        ...range(1, 30).map((i) => posting(i)),
        posting(30, { externalId: 'gh-30b', postedAt: JAN_1 + 99 * DAY }),
      ],
    });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a)).toEqual(titles(range(6, 30)));
    expect(await results(app, a)).toHaveLength(30);
  });

  it('a posting from a denied company does not take a place, and is never sent', async () => {
    const { app, a } = await boot();
    await createCompany(app.db, ctxOf(a), { name: 'Globex', status: 'denied' });
    feedSource({
      postings: [
        ...range(1, 30).map((i) => posting(i)),
        // The newest of all.
        posting(31, { company: 'Globex', postedAt: JAN_1 + 99 * DAY }),
      ],
    });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a)).toEqual(titles(range(6, 30)));
    expect(await belowCutTitles(app, a)).toEqual(titles(range(1, 5)));
    expect((await figuresFor(app, a, s.id))?.belowCut).toBe(5);
  });

  it('a partial lead takes a place, and goes through lead resolution first', async () => {
    const { app, a } = await boot();
    feedSource({
      postings: [...range(1, 29).map((i) => posting(i)), posting(30, { descriptionMd: null })],
    });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a, LEAD_RESOLVE_KIND)).toEqual(titles([30]));
    expect(await queuedTitles(app, a)).toEqual(titles(range(6, 29)));
  });

  it('job-alert leads are never capped', async () => {
    const { app, a } = await boot();
    const alert = await createSource(app.db, ctxOf(a), { kind: 'alert_email', config: {} });
    await insertLeads(
      app.db,
      ctxOf(a),
      range(1, 30).map((i) => posting(i)),
      alert.id,
    );
    expect(await queuedTitles(app, a)).toHaveLength(30);
    expect(await belowCutTitles(app, a)).toEqual([]);
  });

  it('an MCP source is not a board, and is never capped', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 30).map((i) => posting(i)) }, 'mcp');
    const s = await createSource(app.db, ctxOf(a), {
      kind: 'mcp',
      config: {
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        tool: 'jobs',
        queryArgs: {},
        mapping: { company: 'company', title: 'title' },
        itemsPath: '',
      },
    });
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a)).toHaveLength(30);
    expect(await belowCutTitles(app, a)).toEqual([]);
  });

  it('does not rank the 25 until the run has succeeded, so a failed first run sends none', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 30).map((i) => posting(i)), fail: new Error('board down') });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a)).toEqual([]);
    expect(await belowCutTitles(app, a)).toHaveLength(30);
  });

  it('retries of a failed first run add up to 25, over the postings of every attempt', async () => {
    const { app, a } = await boot();
    const feed: Feed = {
      postings: range(1, 30).map((i) => posting(i)),
      fail: new Error('board down'),
    };
    feedSource(feed);
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    await runOnce(app, a, s.id);
    // The attempt that succeeds finds more postings, and the newest of both are the ones sent.
    feed.postings = range(31, 40).map((i) => posting(i));
    feed.fail = null;
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a)).toEqual(titles(range(16, 40)));
    expect(await belowCutTitles(app, a)).toEqual(titles(range(1, 15)));
  });

  it('the run is on record before any of the 25 is queued, so a stop between cannot send 50', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 30).map((i) => posting(i)) });
    const s = await board(app, a);
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: s.id }, { userId: a.userId });
    // The hook sees every enqueue, the runner's own schedules among them, so it goes by the rank
    // jobs already in the table: from the second of them on, the run must be on record.
    const seen: { rankJobs: number; finishedAt: number | null }[] = [];
    setRaceHook(async (point) => {
      if (point !== 'jobs.enqueue') return;
      const [run] = await app.db
        .select()
        .from(discoveryRuns)
        .where(eq(discoveryRuns.sourceId, s.id))
        .all();
      const rankJobs = await app.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.kind, DISCOVERY_RANK_KIND), eq(jobs.userId, a.userId)))
        .all();
      seen.push({ rankJobs: rankJobs.length, finishedAt: run?.finishedAt ?? null });
    });
    try {
      await runNextJob(app.db, { services: app.jobs.services });
    } finally {
      setRaceHook(undefined);
    }
    const whileQueueing = seen.filter((x) => x.rankJobs > 0);
    expect(whileQueueing.length).toBeGreaterThanOrEqual(24);
    expect(whileQueueing.every((x) => x.finishedAt !== null)).toBe(true);
  });

  it('a run alongside one that succeeded first sends none: that one sent the 25', async () => {
    const { app, a } = await boot();
    const s = await board(app, a);
    feedSource({
      postings: range(1, 30).map((i) => posting(i)),
      // The other run (a schedule and Run now each have a job) finishes while this one fetches.
      during: async () => {
        await app.db
          .insert(discoveryRuns)
          .values({
            id: newId(),
            userId: a.userId,
            sourceId: s.id,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            stats: null,
            error: null,
          })
          .run();
      },
    });
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a)).toEqual([]);
    expect(await belowCutTitles(app, a)).toHaveLength(30);
  });

  it('a source whose config failed has not had its first run', async () => {
    const { app, a } = await boot();
    const feed: Feed = { postings: [], fail: new SourceConfigError('unknown org') };
    feedSource(feed);
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    feed.postings = range(1, 30).map((i) => posting(i));
    feed.fail = null;
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a)).toHaveLength(25);
  });
});

describe('#215 criterion 2: the rest', () => {
  it('are stored, pending, unscored, and say why', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 30).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    const all = await results(app, a);
    expect(all).toHaveLength(30);
    expect(await belowCutTitles(app, a)).toEqual(titles(range(1, 5)));
    for (const r of all) {
      expect(r.disposition).toBe('pending');
      expect(r.aiScore).toBeNull();
    }
    expect(all.filter((r) => r.rankSkipReason === null)).toHaveLength(25);
  });

  it('are in the API with their reason', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 26).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    const res = await a.request({ method: 'GET', url: '/api/v1/discovery/results?limit=200' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ items: { rankSkipReason: string | null }[] }>();
    expect(body.items.filter((r) => r.rankSkipReason === 'below_cut')).toHaveLength(1);
  });

  it("the run's stats count every stored posting, so #209's figures read as before", async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 30).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    const [run] = await app.db
      .select()
      .from(discoveryRuns)
      .where(eq(discoveryRuns.sourceId, s.id))
      .all();
    expect(run?.stats).toEqual({
      fetched: 30,
      inserted: 30,
      duplicates: 0,
      invalid: 0,
      suppressed: 0,
    });
    expect((await figuresFor(app, a, s.id))?.openJobs).toBe(30);
  });
});

describe('#215 criterion 3: Rank these', () => {
  it('the figures hold the count, and the cost at the average cost per call', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 35).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    await spend(app, a, 0.02);
    await spend(app, a, 0.04);
    const row = await figuresFor(app, a, s.id);
    expect(row?.belowCut).toBe(10);
    expect(row?.belowCutCostUsd).toBeCloseTo(10 * 0.03, 10);
  });

  it('with no ranking calls to go by, the count stands and the cost is unknown, not zero', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 30).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    const row = await figuresFor(app, a, s.id);
    expect(row?.belowCut).toBe(5);
    expect(row?.belowCutCostUsd).toBeNull();
  });

  it('one dismissed and then restored is back below the cut, ready to send', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 30).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    const [held] = (await results(app, a)).filter((r) => r.rankSkipReason === 'below_cut');
    await setDisposition(app.db, ctxOf(a), held!.id, 'dismissed');
    await setDisposition(app.db, ctxOf(a), held!.id, 'pending');
    expect((await figuresFor(app, a, s.id))?.belowCut).toBe(5);
  });

  it('counts only pending postings: one the user decided is not sent', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 30).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    const held = (await results(app, a)).filter((r) => r.rankSkipReason === 'below_cut');
    await setDisposition(app.db, ctxOf(a), held[0]!.id, 'dismissed');
    expect((await figuresFor(app, a, s.id))?.belowCut).toBe(4);
    const res = await postRankBelowCut(a, s.id, { count: 100 });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ queued: 4 });
    expect(await queuedTitles(app, a)).not.toContain(held[0]!.posting.title);
  });

  it('queues the rest for ranking and takes away the reason, so the count falls to none', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 30).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    const res = await postRankBelowCut(a, s.id, { count: 5 });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ queued: 5 });
    expect(await queuedTitles(app, a)).toEqual(titles(range(1, 30)));
    expect(await belowCutTitles(app, a)).toEqual([]);
    expect((await figuresFor(app, a, s.id))?.belowCut).toBe(0);
  });

  it('never sends more than the count the user saw, newest first', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 35).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    const res = await postRankBelowCut(a, s.id, { count: 3 });
    expect(res.json()).toEqual({ queued: 3 });
    expect(await belowCutTitles(app, a)).toEqual(titles(range(1, 7)));
  });

  it('sending twice sends nothing more', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 30).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    await postRankBelowCut(a, s.id, { count: 5 });
    const before = (await queuedTitles(app, a)).length;
    const again = await postRankBelowCut(a, s.id, { count: 5 });
    expect(again.json()).toEqual({ queued: 0 });
    expect(await queuedTitles(app, a)).toHaveLength(before);
  });

  it('a partial lead goes through lead resolution, as it would have', async () => {
    const { app, a } = await boot();
    feedSource({
      postings: [posting(1, { descriptionMd: null }), ...range(2, 30).map((i) => posting(i))],
    });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    await postRankBelowCut(a, s.id, { count: 5 });
    expect(await queuedTitles(app, a, LEAD_RESOLVE_KIND)).toEqual(titles([1]));
  });

  it('they go through the budget: over it they wait, and the provider is not called', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockResolvedValue({
      score: 60,
      rationale: 'A fair match.',
      disqualifiers: [],
    } as never);
    feedSource({ postings: range(1, 28).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    await app.jobs.drain();
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(25);

    await writeDiscoveryBudget(app.db, ctxOf(a), 0.01);
    await spend(app, a, 0.01);
    await postRankBelowCut(a, s.id, { count: 3 });
    await app.jobs.drain();
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(25);
    const sent = (await results(app, a)).filter((r) => r.aiScore === null);
    expect(sent).toHaveLength(3);
    for (const r of sent) {
      expect(r.rankDeferredAt).not.toBeNull();
      expect(r.rankSkipReason).toBeNull();
    }
    expect((await figuresFor(app, a, s.id))?.belowCut).toBe(0);
  });

  it('with room in the budget they are ranked', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockResolvedValue({
      score: 60,
      rationale: 'A fair match.',
      disqualifiers: [],
    } as never);
    feedSource({ postings: range(1, 28).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    await postRankBelowCut(a, s.id, { count: 3 });
    await app.jobs.drain();
    const all = await results(app, a);
    expect(all.filter((r) => r.aiScore === 60)).toHaveLength(28);
    expect(all.filter((r) => r.rankSkipReason !== null)).toEqual([]);
  });

  it('a job that answers before the reason is cleared keeps its answer', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 26).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    const [held] = (await results(app, a)).filter((r) => r.rankSkipReason === 'below_cut');
    // As the job is queued, it runs and finds no key: between the enqueue and the clear.
    setRaceHook(async (point) => {
      if (point !== 'jobs.enqueue') return;
      await app.db
        .update(discoveryResults)
        .set({ rankSkipReason: 'no_key' })
        .where(eq(discoveryResults.id, held!.id))
        .run();
    });
    try {
      expect(await rankBelowCut(app.db, ctxOf(a), s.id, 5)).toBe(1);
    } finally {
      setRaceHook(undefined);
    }
    const after = (await results(app, a)).find((r) => r.id === held!.id);
    expect(after?.rankSkipReason).toBe('no_key');
  });

  it('a posting dismissed as it is sent stays below the cut, so Undo can still send it', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 26).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    const [held] = (await results(app, a)).filter((r) => r.rankSkipReason === 'below_cut');
    // Dismissed after the list was read and before the reason goes: its job will end not_pending.
    setRaceHook(async (point) => {
      if (point !== 'jobs.enqueue') return;
      await setDisposition(app.db, ctxOf(a), held!.id, 'dismissed');
    });
    try {
      await rankBelowCut(app.db, ctxOf(a), s.id, 5);
    } finally {
      setRaceHook(undefined);
    }
    await setDisposition(app.db, ctxOf(a), held!.id, 'pending');
    const after = (await results(app, a)).find((r) => r.id === held!.id);
    expect(after?.rankSkipReason).toBe('below_cut');
    expect((await figuresFor(app, a, s.id))?.belowCut).toBe(1);
  });

  it("another user's source is not found, and nothing of theirs moves", async () => {
    const { app, a, b } = await boot();
    feedSource({ postings: range(1, 30).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    const res = await postRankBelowCut(b, s.id, { count: 5 });
    expect(res.statusCode, res.body).toBe(404);
    expect(await belowCutTitles(app, a)).toHaveLength(5);
  });

  it('with no session it is refused, and nothing moves', async () => {
    const { app, a } = await boot();
    feedSource({ postings: range(1, 30).map((i) => posting(i)) });
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/discovery/sources/${s.id}/rank-below-cut`,
      payload: { count: 5 },
    });
    // No cookie means no CSRF token either, and that check comes first.
    expect(res.statusCode).toBe(403);
    expect(await belowCutTitles(app, a)).toHaveLength(5);
  });

  it.each([[{}], [{ count: 0 }], [{ count: -1 }], [{ count: 1.5 }], [{ count: '5' }]])(
    'refuses the count in %j',
    async (payload) => {
      const { app, a } = await boot();
      feedSource({ postings: range(1, 30).map((i) => posting(i)) });
      const s = await board(app, a);
      await runOnce(app, a, s.id);
      const res = await postRankBelowCut(a, s.id, payload);
      expect(res.statusCode, res.body).toBe(400);
      expect(await belowCutTitles(app, a)).toHaveLength(5);
    },
  );
});

describe('#215 criterion 4: later runs', () => {
  it('are not capped', async () => {
    const { app, a } = await boot();
    const feed: Feed = { postings: range(1, 10).map((i) => posting(i)) };
    feedSource(feed);
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    feed.postings = range(11, 50).map((i) => posting(i));
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a)).toEqual(titles([...range(1, 10), ...range(11, 50)]));
    expect(await belowCutTitles(app, a)).toEqual([]);
  });

  it('a first run that found nothing still counts as the first', async () => {
    const { app, a } = await boot();
    const feed: Feed = { postings: [] };
    feedSource(feed);
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    feed.postings = range(1, 30).map((i) => posting(i));
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a)).toHaveLength(30);
  });

  it('leave the postings already below the cut there, and send no more of them', async () => {
    const { app, a } = await boot();
    const feed: Feed = { postings: range(1, 30).map((i) => posting(i)) };
    feedSource(feed);
    const s = await board(app, a);
    await runOnce(app, a, s.id);
    feed.postings = range(31, 33).map((i) => posting(i));
    await runOnce(app, a, s.id);
    expect(await queuedTitles(app, a)).toEqual(titles(range(6, 33)));
    expect(await belowCutTitles(app, a)).toEqual(titles(range(1, 5)));
  });

  it('a second board has a first run of its own', async () => {
    const { app, a } = await boot();
    const feed: Feed = { postings: range(1, 30).map((i) => posting(i)) };
    feedSource(feed);
    const first = await board(app, a);
    await runOnce(app, a, first.id);
    feed.postings = range(31, 60).map((i) => posting(i));
    const second = await createSource(app.db, ctxOf(a), {
      kind: 'ats_lever',
      config: { org: 'globex' },
    });
    await runOnce(app, a, second.id);
    expect(await queuedTitles(app, a)).toEqual(titles([...range(6, 30), ...range(36, 60)]));
  });
});
