// The discovery pre-filter switched on for boards (https://github.com/bgoleno/opportun/issues/218,
// N2b on #190; the owner's decision 5): once recall on the user's own decisions holds, a filtered
// board posting gets no ranking call and says why, with Rank anyway. The provider is mocked, and
// every posting and role target is made up.
import { runStructured } from '@opportun/ai';
import type { NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { discoveryResults, jobs, roleTargets, taskRuns } from '../src/db/schema';
import { LEAD_RESOLVE_KIND } from '../src/jobs/discoveryKinds';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import { drainWaitingResults } from '../src/jobs/discoveryRankWaiting';
import { DISCOVERY_RUN_KIND, insertLeads } from '../src/jobs/discoveryRun';
import { enqueue } from '../src/jobs/runner';
import type { UserCtx } from '../src/repos/base';
import {
  clearFiltered,
  createRun,
  createSource,
  insertResult,
  listBelowCut,
  listResults,
  listWaitingResultIds,
  setDisposition,
  setRankDeferred,
  setRankSkip,
} from '../src/repos/discovery';
import { writeDiscoveryBudget } from '../src/repos/discoveryBudget';
import { createRoleTarget } from '../src/repos/profile';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
const PAGE = { limit: 200, offset: 0 };

/** The titles sent to the provider, in order. */
let ranked: string[] = [];

beforeEach(() => {
  ranked = [];
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockImplementation((async (
    _deps: unknown,
    _task: string,
    opts: { system: string },
  ) => {
    ranked.push(/Title: (.*)/.exec(opts.system)?.[1] ?? '');
    return { score: 60, rationale: 'A fair match.', disqualifiers: [] };
  }) as never);
});
afterEach(() => resetSources());

let externalId = 0;
const post = (title: string, over: Partial<NormalizedPosting> = {}): NormalizedPosting => {
  externalId += 1;
  return {
    company: `Company ${externalId}`,
    title,
    descriptionMd: 'Own the platform.',
    postingUrl: `https://boards.example.com/${externalId}`,
    externalId: `gh-${externalId}`,
    ...over,
  };
};
const GOOD = 'Platform Engineer';
const BAD = 'Office Coordinator';

const aTarget = (app: FastifyInstance, c: TestClient, over = {}) =>
  createRoleTarget(app.db, ctxOf(c), {
    name: 'Platform',
    titleFamily: 'Platform Engineering',
    ...over,
  });

/**
 * The user has accepted `kept` board postings the filter passes, and `missed` it would filter. Put
 * in directly, on a source of their own, as if decided long ago.
 */
async function decided(app: FastifyInstance, c: TestClient, kept: number, missed = 0) {
  const src = await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: `decided-${kept}-${missed}` },
    roleTargetId: null,
  });
  const run = await createRun(app.db, ctxOf(c), { sourceId: src.id });
  const titles = [...Array<string>(kept).fill(GOOD), ...Array<string>(missed).fill(BAD)];
  for (const title of titles) {
    const posting = post(title);
    const row = await insertResult(app.db, ctxOf(c), {
      runId: run.id,
      posting,
      dedupeKey: posting.externalId!,
      resolution: 'full',
    });
    await setDisposition(app.db, ctxOf(c), row.id, 'accepted');
  }
}

/** A target, and enough decisions for the filter to act. */
async function filterOn(app: FastifyInstance, c: TestClient) {
  const target = await aTarget(app, c);
  await decided(app, c, 20);
  return target;
}

let org = 0;
/** A board source, with no run yet. */
async function aBoard(
  app: FastifyInstance,
  c: TestClient,
  postings: NormalizedPosting[],
  over: { prefilterEnabled?: boolean } = {},
) {
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      for (const posting of postings) yield { posting, nextCursor: null };
    },
  } satisfies DiscoverySource);
  org += 1;
  return await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: `board-${org}` },
    roleTargetId: null,
    ...over,
  });
}

async function runBoard(
  app: FastifyInstance,
  c: TestClient,
  postings: NormalizedPosting[],
  over: { prefilterEnabled?: boolean } = {},
) {
  const src = await aBoard(app, c, postings, over);
  await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: c.userId });
  await app.jobs.drain();
  return src;
}

const results = async (app: FastifyInstance, c: TestClient) =>
  (await listResults(app.db, ctxOf(c), { ...PAGE, disposition: 'pending' })).items;
const byTitle = async (app: FastifyInstance, c: TestClient) =>
  new Map((await results(app, c)).map((r) => [r.posting.title, r]));
const rankJobs = async (app: FastifyInstance, c: TestClient) =>
  await app.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, DISCOVERY_RANK_KIND), eq(jobs.userId, c.userId)))
    .all();
const jobsOfKind = async (app: FastifyInstance, c: TestClient, kind: string) =>
  await app.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, kind), eq(jobs.userId, c.userId)))
    .all();
const rankAnyway = (c: TestClient, id: string) =>
  c.request({ method: 'POST', url: `/api/v1/discovery/results/${id}/rank-anyway` });
const status = async (c: TestClient) => {
  const res = await c.request({ method: 'GET', url: '/api/v1/discovery/prefilter/recall' });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{
    positives: number;
    kept: number;
    recall: number | null;
    on: boolean;
    neededRecall: number;
    neededPositives: number;
    judged: number;
    filtered: number;
  }>();
};

describe('#218 criterion 1: turned on', () => {
  it('a filtered posting gets no ranking call, and says why; one that passes is ranked', async () => {
    const { app, a } = await boot();
    await filterOn(app, a);
    await runBoard(app, a, [post(GOOD), post(BAD)]);

    expect(ranked).toEqual([GOOD]);
    expect(await rankJobs(app, a)).toHaveLength(1);
    const by = await byTitle(app, a);
    expect(by.get(BAD)).toMatchObject({
      rankSkipReason: 'filtered',
      prefilterOutcome: 'filtered',
      prefilterRule: 'title',
      aiScore: null,
      rankDeferredAt: null,
      disposition: 'pending',
    });
    expect(by.get(GOOD)).toMatchObject({ aiScore: 60, rankSkipReason: null });
  });

  // A first run holds everything until it has succeeded, so this is the path most postings take.
  it('on a later run of a board: a filtered posting gets no rank job, and one that passes does', async () => {
    const { app, a } = await boot();
    await filterOn(app, a);
    const postings: NormalizedPosting[] = [];
    const src = await aBoard(app, a, postings);
    const runIt = async () => {
      await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
      await app.jobs.drain();
    };
    await runIt();
    postings.push(post(GOOD), post(BAD));
    await runIt();

    expect(ranked).toEqual([GOOD]);
    expect(await rankJobs(app, a)).toHaveLength(1);
    expect((await byTitle(app, a)).get(BAD)!.rankSkipReason).toBe('filtered');
  });

  it('on a later run in shadow mode: a filtered posting is still ranked', async () => {
    const { app, a } = await boot();
    await aTarget(app, a);
    const postings: NormalizedPosting[] = [];
    const src = await aBoard(app, a, postings);
    const runIt = async () => {
      await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
      await app.jobs.drain();
    };
    await runIt();
    postings.push(post(BAD));
    await runIt();
    expect(ranked).toEqual([BAD]);
  });

  for (const [rule, over, posting] of [
    ['remote', { remotePref: 'remote' }, post(GOOD, { remote: false })],
    ['location', { locations: ['Austin, TX'] }, post(GOOD, { location: 'Berlin, Germany' })],
  ] as const) {
    it(`a posting filtered by ${rule} is held the same way`, async () => {
      const { app, a } = await boot();
      await aTarget(app, a, over);
      await decided(app, a, 20);
      await runBoard(app, a, [posting]);
      expect(ranked).toEqual([]);
      expect((await results(app, a))[0]).toMatchObject({
        rankSkipReason: 'filtered',
        prefilterRule: rule,
      });
    });
  }

  it('the API carries the reason and the rule to the card', async () => {
    const { app, a } = await boot();
    await filterOn(app, a);
    await runBoard(app, a, [post(BAD)]);
    const res = await a.request({
      method: 'GET',
      url: '/api/v1/discovery/results?disposition=pending',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ items: unknown[] }>().items[0]).toMatchObject({
      rankSkipReason: 'filtered',
      prefilterRule: 'title',
    });
  });

  describe('Rank anyway', () => {
    it('ranks it, and it no longer reads as filtered', async () => {
      const { app, a } = await boot();
      await filterOn(app, a);
      await runBoard(app, a, [post(BAD)]);
      const held = (await results(app, a))[0]!;

      const res = await rankAnyway(a, held.id);
      expect(res.statusCode, res.body).toBe(202);
      expect((await results(app, a))[0]!.rankSkipReason).toBeNull();
      await app.jobs.drain();

      expect(ranked).toEqual([BAD]);
      expect((await results(app, a))[0]).toMatchObject({
        aiScore: 60,
        rankSkipReason: null,
        // What the filter said stays, so a miss can be seen.
        prefilterOutcome: 'filtered',
      });
    });

    it('on a partial lead it queues lead resolution, which then ranks it', async () => {
      const { app, a } = await boot();
      await filterOn(app, a);
      await runBoard(app, a, [post(BAD, { descriptionMd: null })]);
      const held = (await results(app, a))[0]!;
      expect(held).toMatchObject({ rankSkipReason: 'filtered', resolution: 'needs_capture' });
      expect(await jobsOfKind(app, a, LEAD_RESOLVE_KIND)).toEqual([]);

      expect((await rankAnyway(a, held.id)).json<{ queued: number }>().queued).toBe(1);
      expect(await jobsOfKind(app, a, LEAD_RESOLVE_KIND)).toHaveLength(1);
      expect(await rankJobs(app, a)).toEqual([]);
    });

    it('over budget it waits like any other posting', async () => {
      const { app, a } = await boot();
      await filterOn(app, a);
      await runBoard(app, a, [post(BAD)]);
      const held = (await results(app, a))[0]!;
      await writeDiscoveryBudget(app.db, ctxOf(a), 0.01);
      await app.db
        .insert(taskRuns)
        .values({
          id: `spent-${a.userId}`,
          userId: a.userId,
          taskKey: DISCOVERY_RANK_KIND,
          provider: 'openai',
          model: 'placeholder-model',
          inputTokens: 1,
          outputTokens: 1,
          estCost: 1,
          fallbackPricing: false,
          durationMs: 1,
          status: 'ok',
          error: null,
          createdAt: Date.now(),
        })
        .run();
      expect((await rankAnyway(a, held.id)).statusCode).toBe(202);
      await app.jobs.drain();
      expect(ranked).toEqual([]);
      expect((await results(app, a))[0]).toMatchObject({
        aiScore: null,
        rankSkipReason: null,
        rankDeferredAt: expect.any(Number),
      });
    });

    it('asked twice, it queues one job, and the second answers cleanly', async () => {
      const { app, a } = await boot();
      await filterOn(app, a);
      await runBoard(app, a, [post(BAD)]);
      const held = (await results(app, a))[0]!;
      const queued = async () => (await rankAnyway(a, held.id)).json<{ queued: number }>().queued;
      expect(await queued()).toBe(1);
      expect(await queued()).toBe(0);
      await app.jobs.drain();
      expect(await queued()).toBe(0);
      await app.jobs.drain();
      expect(ranked).toEqual([BAD]);
    });

    it('queues nothing for a posting that is not filtered', async () => {
      const { app, a } = await boot();
      await filterOn(app, a);
      await runBoard(app, a, [post(GOOD)]);
      ranked.length = 0;
      const res = await rankAnyway(a, (await results(app, a))[0]!.id);
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json<{ queued: number }>().queued).toBe(0);
      await app.jobs.drain();
      expect(ranked).toEqual([]);
    });

    it('queues nothing for a dismissed one, and it still says why after Undo', async () => {
      const { app, a } = await boot();
      await filterOn(app, a);
      await runBoard(app, a, [post(BAD)]);
      const held = (await results(app, a))[0]!;
      await setDisposition(app.db, ctxOf(a), held.id, 'dismissed');
      expect((await rankAnyway(a, held.id)).json<{ queued: number }>().queued).toBe(0);
      await app.jobs.drain();
      expect(ranked).toEqual([]);
      await setDisposition(app.db, ctxOf(a), held.id, 'pending');
      expect((await results(app, a))[0]!.rankSkipReason).toBe('filtered');
    });

    // The order rankBelowCut uses: queued, then the reason goes. A dismissal between the two is not
    // something a test can place, so this is the second step on its own.
    it('dismissed as it was sent, the reason stays for Undo', async () => {
      const { app, a } = await boot();
      await filterOn(app, a);
      await runBoard(app, a, [post(BAD)]);
      const held = (await results(app, a))[0]!;
      await setDisposition(app.db, ctxOf(a), held.id, 'dismissed');
      await clearFiltered(app.db, ctxOf(a), held.id);
      await setDisposition(app.db, ctxOf(a), held.id, 'pending');
      expect((await results(app, a))[0]!.rankSkipReason).toBe('filtered');
    });

    it('a newer reason written by its job is not cleared', async () => {
      const { app, a } = await boot();
      await filterOn(app, a);
      await runBoard(app, a, [post(BAD)]);
      const held = (await results(app, a))[0]!;
      await setRankSkip(app.db, ctxOf(a), held.id, 'provider_error');
      await clearFiltered(app.db, ctxOf(a), held.id);
      expect((await results(app, a))[0]!.rankSkipReason).toBe('provider_error');
    });

    it('another user gets a 404, and nothing is queued', async () => {
      const { app, a, b } = await boot();
      await filterOn(app, a);
      await runBoard(app, a, [post(BAD)]);
      const held = (await results(app, a))[0]!;
      const before = (await rankJobs(app, a)).length;
      expect((await rankAnyway(b, held.id)).statusCode).toBe(404);
      expect(await rankJobs(app, a)).toHaveLength(before);
      expect((await results(app, a))[0]!.rankSkipReason).toBe('filtered');
    });

    it('needs a session', async () => {
      const { app, a } = await boot();
      await filterOn(app, a);
      await runBoard(app, a, [post(BAD)]);
      const held = (await results(app, a))[0]!;
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/discovery/results/${held.id}/rank-anyway`,
      });
      // The CSRF check answers first, for a POST with no cookies.
      expect(res.statusCode).toBe(403);
      expect((await results(app, a))[0]!.rankSkipReason).toBe('filtered');
    });
  });

  it('a filtered posting is not sent by Rank these, and does not count as below the cut', async () => {
    const { app, a } = await boot();
    await filterOn(app, a);
    const src = await runBoard(app, a, [
      ...Array.from({ length: 26 }, () => post(GOOD)),
      post(BAD),
    ]);
    expect(ranked).toHaveLength(25);
    expect(await listBelowCut(app.db, ctxOf(a), src.id)).toHaveLength(1);
    expect((await byTitle(app, a)).get(BAD)!.rankSkipReason).toBe('filtered');
  });

  it('a drain does not rank a filtered posting: it is not waiting', async () => {
    const { app, a } = await boot();
    await filterOn(app, a);
    await runBoard(app, a, [post(BAD)]);
    expect(await drainWaitingResults(app.db, ctxOf(a))).toMatchObject({ ranked: 0 });
    expect(ranked).toEqual([]);
  });
});

describe('#218 criterion 2: on by default once recall holds', () => {
  const NEEDED = { neededRecall: 0.95, neededPositives: 20 };

  for (const [kept, missed, on] of [
    [19, 0, false], // Every one kept, but too few.
    [20, 0, true],
    [19, 1, true], // Exactly 95%.
    [18, 2, false], // 90%.
    [37, 2, false], // 94.87%: it would round up to 95%, and must not count.
  ] as const) {
    const recall = kept / (kept + missed);
    it(`${kept} kept and ${missed} missed: ${on ? 'on' : 'shadow mode'}`, async () => {
      const { app, a } = await boot();
      await aTarget(app, a);
      await decided(app, a, kept, missed);
      expect(await status(a)).toMatchObject({
        ...NEEDED,
        positives: kept + missed,
        kept,
        recall,
        on,
      });

      await runBoard(app, a, [post(BAD)]);
      const held = (await results(app, a))[0]!;
      if (on) {
        expect(ranked).toEqual([]);
        expect(held.rankSkipReason).toBe('filtered');
      } else {
        // Shadow mode: judged and stored as before, and ranked as before.
        expect(ranked).toEqual([BAD]);
        expect(held).toMatchObject({
          prefilterOutcome: 'filtered',
          rankSkipReason: null,
          aiScore: 60,
        });
      }
    });
  }

  it('with nothing decided it stays in shadow mode, and says so', async () => {
    const { a, app } = await boot();
    await aTarget(app, a);
    expect(await status(a)).toMatchObject({ ...NEEDED, positives: 0, recall: null, on: false });
  });

  it('with no active role target nothing can be judged, so nothing is filtered', async () => {
    const { app, a } = await boot();
    const target = await filterOn(app, a);
    await app.db
      .update(roleTargets)
      .set({ active: false })
      .where(eq(roleTargets.id, target.id))
      .run();
    await runBoard(app, a, [post(BAD)]);
    expect((await results(app, a))[0]).toMatchObject({
      prefilterOutcome: null,
      rankSkipReason: null,
      aiScore: 60,
    });
  });

  it('it is per user: another user’s decisions do not turn it on', async () => {
    const { app, a, b } = await boot();
    await filterOn(app, a);
    await aTarget(app, b);
    expect((await status(a)).on).toBe(true);
    expect((await status(b)).on).toBe(false);
    await runBoard(app, b, [post(BAD)]);
    expect((await results(app, b))[0]).toMatchObject({ rankSkipReason: null, aiScore: 60 });
  });

  it('recall falling back below it returns new postings to shadow mode; earlier ones stay', async () => {
    const { app, a } = await boot();
    await filterOn(app, a);
    await runBoard(app, a, [post(BAD, { title: 'Office Coordinator 1' })]);
    expect(ranked).toEqual([]);

    await decided(app, a, 0, 5);
    expect((await status(a)).on).toBe(false);
    await runBoard(app, a, [post(BAD, { title: 'Office Coordinator 2' })]);
    expect(ranked).toEqual(['Office Coordinator 2']);
    expect((await byTitle(app, a)).get('Office Coordinator 1')!.rankSkipReason).toBe('filtered');
  });
});

describe('#218 criterion 3: job alerts are never filtered', () => {
  it('a lead from an alert email is ranked, with the filter on', async () => {
    const { app, a } = await boot();
    await filterOn(app, a);
    const src = await createSource(app.db, ctxOf(a), { kind: 'alert_email', config: {} });
    await insertLeads(app.db, ctxOf(a), [post(BAD)], src.id);
    await app.jobs.drain();

    expect(ranked).toEqual([BAD]);
    expect((await byTitle(app, a)).get(BAD)).toMatchObject({
      prefilterOutcome: null,
      rankSkipReason: null,
      aiScore: 60,
    });
  });
});

describe('#218 criterion 4: the best pre-filter scores go first', () => {
  /** A waiting posting of a given title match, oldest first by `age`. */
  async function waiting(
    app: FastifyInstance,
    c: TestClient,
    sourceId: string,
    rows: { title: string; score: number | null; age: number; filtered?: boolean }[],
  ) {
    const run = await createRun(app.db, ctxOf(c), { sourceId });
    const now = Date.now();
    for (const { title, score, age, filtered } of rows) {
      const posting = post(title);
      const row = await insertResult(app.db, ctxOf(c), {
        runId: run.id,
        posting,
        dedupeKey: posting.externalId!,
        resolution: 'full',
        prefilter:
          score === null
            ? null
            : filtered === true
              ? { outcome: 'filtered', rule: 'location', score }
              : { outcome: 'pass', rule: null, score },
      });
      await setRankDeferred(app.db, ctxOf(c), row.id);
      await app.db
        .update(discoveryResults)
        .set({ createdAt: now - age })
        .where(eq(discoveryResults.id, row.id))
        .run();
    }
  }

  it('the deferral queue: score first, then oldest, then those with no score', async () => {
    const { app, a } = await boot();
    const src = await aBoard(app, a, []);
    await waiting(app, a, src.id, [
      { title: 'low old', score: 0.5, age: 4000 },
      { title: 'none oldest', score: null, age: 5000 },
      { title: 'high new', score: 1, age: 1000 },
      { title: 'mid', score: 0.75, age: 2000 },
      { title: 'high old', score: 1, age: 3000 },
    ]);
    const ids = await listWaitingResultIds(app.db, ctxOf(a));
    const titleOf = new Map((await results(app, a)).map((r) => [r.id, r.posting.title]));
    expect(ids.map((id) => titleOf.get(id))).toEqual([
      'high old',
      'high new',
      'mid',
      'low old',
      'none oldest',
    ]);
  });

  // tl: the score is the title's alone. A perfect title in the wrong place is not a best match.
  it('the deferral queue: a posting that passes goes ahead of a better title that was filtered', async () => {
    const { app, a } = await boot();
    const src = await aBoard(app, a, []);
    await waiting(app, a, src.id, [
      { title: 'perfect title elsewhere', score: 1, age: 3000, filtered: true },
      { title: 'half a title', score: 0.5, age: 1000 },
      { title: 'no verdict', score: null, age: 4000 },
    ]);
    const titleOf = new Map((await results(app, a)).map((r) => [r.id, r.posting.title]));
    expect((await listWaitingResultIds(app.db, ctxOf(a))).map((id) => titleOf.get(id))).toEqual([
      'half a title',
      // Never judged, such as a job alert, which the filter does not rule out (decision 5).
      'no verdict',
      'perfect title elsewhere',
    ]);
  });

  it('a drain takes them in that order', async () => {
    const { app, a } = await boot();
    const src = await aBoard(app, a, []);
    await waiting(app, a, src.id, [
      { title: 'low old', score: 0.5, age: 4000 },
      { title: 'high new', score: 1, age: 1000 },
    ]);
    await drainWaitingResults(app.db, ctxOf(a));
    expect(ranked).toEqual(['high new', 'low old']);
  });

  it('a posting refused today still goes behind, whatever its score', async () => {
    const { app, a } = await boot();
    const src = await aBoard(app, a, []);
    await waiting(app, a, src.id, [
      { title: 'refused', score: 1, age: 2000 },
      { title: 'in line', score: 0.5, age: 1000 },
    ]);
    const refused = (await byTitle(app, a)).get('refused')!;
    await app.db
      .update(discoveryResults)
      .set({ rankSkipReason: 'provider_error', rankDeferredAt: Date.now() })
      .where(eq(discoveryResults.id, refused.id))
      .run();
    const titleOf = new Map((await results(app, a)).map((r) => [r.id, r.posting.title]));
    expect((await listWaitingResultIds(app.db, ctxOf(a))).map((id) => titleOf.get(id))).toEqual([
      'in line',
      'refused',
    ]);
  });

  it('the first-run cap: the best 25 are ranked, not the newest, and the rest wait below it', async () => {
    const { app, a } = await boot();
    await aTarget(app, a, { name: GOOD, titleFamily: GOOD });
    const newest = Date.UTC(2026, 9, 1);
    const postings = [
      // Newer, and half a match.
      ...Array.from({ length: 5 }, (_, i) =>
        post('Platform Coordinator', { externalId: `half-${i}`, postedAt: newest + i }),
      ),
      // Older, and a full match.
      ...Array.from({ length: 25 }, (_, i) =>
        post(GOOD, { externalId: `full-${i}`, postedAt: newest - 1000 - i }),
      ),
    ];
    const src = await runBoard(app, a, postings);
    expect(ranked).toEqual(Array.from({ length: 25 }, () => GOOD));
    const held = await listBelowCut(app.db, ctxOf(a), src.id);
    expect(held).toHaveLength(5);
  });

  it('below the cut, ties go to the newest, and no date goes last', async () => {
    const { app, a } = await boot();
    await aTarget(app, a);
    const newest = Date.UTC(2026, 9, 1);
    const src = await runBoard(
      app,
      a,
      Array.from({ length: 25 }, () => post(GOOD, { postedAt: newest + 1000 })),
    );
    const run = await createRun(app.db, ctxOf(a), { sourceId: src.id });
    const hold = async (title: string, score: number | null, postedAt?: number) => {
      const posting = post(title, postedAt === undefined ? {} : { postedAt });
      const row = await insertResult(app.db, ctxOf(a), {
        runId: run.id,
        posting,
        dedupeKey: posting.externalId!,
        resolution: 'full',
        prefilter: score === null ? null : { outcome: 'pass', rule: null, score },
        rankSkipReason: 'below_cut',
      });
      return row.id;
    };
    const old = await hold('tie old', 1, newest - 2000);
    const fresh = await hold('tie new', 1, newest - 1000);
    const undated = await hold('tie undated', 1);
    const low = await hold('low new', 0.5, newest);
    const none = await hold('no score', null, newest);
    const posting = post('perfect title elsewhere', { postedAt: newest + 5000 });
    const elsewhere = await insertResult(app.db, ctxOf(a), {
      runId: run.id,
      posting,
      dedupeKey: posting.externalId!,
      resolution: 'full',
      prefilter: { outcome: 'filtered', rule: 'location', score: 1 },
      rankSkipReason: 'below_cut',
    });
    expect((await listBelowCut(app.db, ctxOf(a), src.id)).map((r) => r.id)).toEqual([
      fresh,
      old,
      undated,
      low,
      none,
      elsewhere.id,
    ]);
  });
});

describe('#218 criterion 5: a switch per source', () => {
  const patch = (c: TestClient, id: string, prefilterEnabled: unknown) =>
    c.request({
      method: 'PATCH',
      url: `/api/v1/discovery/sources/${id}`,
      payload: { prefilterEnabled },
    });

  it('it defaults on, and the API carries it', async () => {
    const { app, a } = await boot();
    const src = await aBoard(app, a, []);
    const res = await patch(a, src.id, true);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ prefilterEnabled: boolean }>().prefilterEnabled).toBe(true);
    expect(src.prefilterEnabled).toBe(true);
  });

  it('off for one board: that board ranks everything, and another still filters', async () => {
    const { app, a } = await boot();
    await filterOn(app, a);
    const off = await aBoard(app, a, [post(BAD, { title: 'Office Coordinator 1' })]);
    expect((await patch(a, off.id, false)).statusCode).toBe(200);
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: off.id }, { userId: a.userId });
    await app.jobs.drain();
    await runBoard(app, a, [post(BAD, { title: 'Office Coordinator 2' })]);

    expect(ranked).toEqual(['Office Coordinator 1']);
    const by = await byTitle(app, a);
    // Still judged and stored: only acting on it is off.
    expect(by.get('Office Coordinator 1')).toMatchObject({
      prefilterOutcome: 'filtered',
      rankSkipReason: null,
      aiScore: 60,
    });
    expect(by.get('Office Coordinator 2')!.rankSkipReason).toBe('filtered');
  });

  it('turned back on, the next run filters again', async () => {
    const { app, a } = await boot();
    await filterOn(app, a);
    const src = await aBoard(app, a, [post(BAD)], { prefilterEnabled: false });
    expect(src.prefilterEnabled).toBe(false);
    expect((await patch(a, src.id, true)).statusCode).toBe(200);
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();
    expect(ranked).toEqual([]);
  });

  it('another user cannot change it', async () => {
    const { app, a, b } = await boot();
    const src = await aBoard(app, a, []);
    expect((await patch(b, src.id, false)).statusCode).toBe(404);
  });

  it('refuses anything but a boolean', async () => {
    const { app, a } = await boot();
    const src = await aBoard(app, a, []);
    expect((await patch(a, src.id, 'no')).statusCode).toBe(400);
  });
});

describe('#218 criterion 6: the share it would remove', () => {
  it('counts what it judged and what it filtered, in shadow mode as well as on', async () => {
    const { app, a } = await boot();
    await aTarget(app, a);
    expect(await status(a)).toMatchObject({ judged: 0, filtered: 0 });
    await runBoard(app, a, [post(GOOD), post(BAD), post(BAD), post(BAD)]);
    expect(await status(a)).toMatchObject({ on: false, judged: 4, filtered: 3 });

    await decided(app, a, 20);
    await runBoard(app, a, [post(BAD)]);
    expect(await status(a)).toMatchObject({ on: true, judged: 5, filtered: 4 });
  });

  // tl on https://github.com/bgoleno/opportun/pull/280: the Sources card must show the saving. The
  // first run is left out of these figures, so this needs a later one.
  it('the Sources card counts ranking calls without what it filtered', async () => {
    const { app, a } = await boot();
    await filterOn(app, a);
    const postings: NormalizedPosting[] = [];
    const src = await aBoard(app, a, postings);
    const runIt = async () => {
      await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
      await app.jobs.drain();
    };
    await runIt();
    postings.push(post(GOOD), ...Array.from({ length: 9 }, () => post(BAD)));
    await runIt();
    // The router is mocked, so this is the 30-day average cost per call: $0.50.
    await app.db
      .insert(taskRuns)
      .values({
        id: `one-call-${a.userId}`,
        userId: a.userId,
        taskKey: DISCOVERY_RANK_KIND,
        provider: 'openai',
        model: 'placeholder-model',
        inputTokens: 1,
        outputTokens: 1,
        estCost: 0.5,
        fallbackPricing: false,
        durationMs: 1,
        status: 'ok',
        error: null,
        createdAt: Date.now(),
      })
      .run();

    const res = await a.request({ method: 'GET', url: '/api/v1/discovery/cost-figures' });
    expect(res.statusCode, res.body).toBe(200);
    const row = res
      .json<{
        sources: {
          sourceId: string;
          newPerDay: number;
          rankCallsPerDay: number;
          costPerDayUsd: number;
        }[];
      }>()
      .sources.find((s) => s.sourceId === src.id)!;
    expect(row.newPerDay).toBeCloseTo(10, 5);
    expect(row.rankCallsPerDay).toBeCloseTo(1, 5);
    expect(row.costPerDayUsd).toBeCloseTo(0.5, 5);
    expect(ranked).toEqual([GOOD]);

    const runs = await a.request({
      method: 'GET',
      url: `/api/v1/discovery/sources/${src.id}/runs`,
    });
    const stats = runs
      .json<{ items: { stats: { inserted: number; filtered: number } }[] }>()
      .items.map((r) => r.stats);
    expect(stats).toContainEqual(expect.objectContaining({ inserted: 10, filtered: 9 }));
  });

  it('with the filter in shadow mode, every stored posting is still a ranking call', async () => {
    const { app, a } = await boot();
    await aTarget(app, a);
    const postings: NormalizedPosting[] = [];
    const src = await aBoard(app, a, postings);
    const runIt = async () => {
      await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
      await app.jobs.drain();
    };
    await runIt();
    postings.push(post(GOOD), post(BAD));
    await runIt();
    const res = await a.request({ method: 'GET', url: '/api/v1/discovery/cost-figures' });
    const row = res
      .json<{ sources: { sourceId: string; rankCallsPerDay: number }[] }>()
      .sources.find((s) => s.sourceId === src.id)!;
    expect(row.rankCallsPerDay).toBeCloseTo(2, 5);
  });

  it('what was never judged does not count, nor another user’s', async () => {
    const { app, a, b } = await boot();
    await aTarget(app, a);
    await aTarget(app, b);
    const src = await createSource(app.db, ctxOf(a), { kind: 'alert_email', config: {} });
    await insertLeads(app.db, ctxOf(a), [post(BAD)], src.id);
    await runBoard(app, b, [post(BAD)]);
    expect(await status(a)).toMatchObject({ judged: 0, filtered: 0 });
    expect(await status(b)).toMatchObject({ judged: 1, filtered: 1 });
  });

  it('a posting ranked anyway still counts as one it filtered', async () => {
    const { app, a } = await boot();
    await filterOn(app, a);
    await runBoard(app, a, [post(BAD)]);
    await rankAnyway(a, (await results(app, a))[0]!.id);
    await app.jobs.drain();
    expect(await status(a)).toMatchObject({ judged: 1, filtered: 1 });
  });
});
