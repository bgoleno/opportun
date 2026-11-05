// A posting dismissed before its rank job runs, then restored with Undo
// (https://github.com/bgoleno/opportun/issues/274, qa on
// https://github.com/bgoleno/opportun/pull/266 and tl on
// https://github.com/bgoleno/opportun/pull/280). The job ended not_pending, and after Undo the
// posting had no reason, no wait and no job, so nothing ever ranked it. The rank jobs here stay
// queued until the test runs them, so the dismiss always lands first. The provider is mocked and
// every posting is made up.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import type { NormalizedPosting } from '@opportun/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSource, resetSources } from '../src/adapters/discoverySource';
import { discoveryResults, jobs, taskRuns } from '../src/db/schema';
import { LEAD_RESOLVE_KIND } from '../src/jobs/discoveryKinds';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import { RANK_WAITING_KIND, resumeAfterUndo } from '../src/jobs/discoveryRankWaiting';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import { enqueue, runNextJob } from '../src/jobs/runner';
import type { UserCtx } from '../src/repos/base';
import {
  createRun,
  createSource,
  insertResult,
  listResults,
  setDisposition,
  setRankDeferred,
  setRankWaitingIfUnranked,
} from '../src/repos/discovery';
import { writeDiscoveryBudget } from '../src/repos/discoveryBudget';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

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

let n = 0;
const post = (title: string, over: Partial<NormalizedPosting> = {}): NormalizedPosting => {
  n += 1;
  return {
    company: `Company ${n}`,
    title,
    descriptionMd: 'Own the platform.',
    postingUrl: `https://boards.example.com/${n}`,
    externalId: `gh-${n}`,
    ...over,
  };
};

/** Stores the postings through a real first run. Their jobs are queued, and have not run. */
async function storedWithJobsQueued(
  app: FastifyInstance,
  c: TestClient,
  postings: NormalizedPosting[],
) {
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      for (const posting of postings) yield { posting, nextCursor: null };
    },
  });
  const src = await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: `org-${n}` },
    roleTargetId: null,
  });
  await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: c.userId });
  await runNextJob(app.db, { services: app.jobs.services });
  return src;
}

const results = async (app: FastifyInstance, c: TestClient) =>
  (await listResults(app.db, ctxOf(c), { limit: 200, offset: 0 })).items;
const byTitle = async (app: FastifyInstance, c: TestClient) =>
  new Map((await results(app, c)).map((r) => [r.posting.title, r]));
const idOf = async (app: FastifyInstance, c: TestClient, title: string) =>
  (await byTitle(app, c)).get(title)!.id;

const dismiss = async (c: TestClient, id: string) => {
  const res = await c.request({
    method: 'POST',
    url: `/api/v1/discovery/results/${id}/dismiss`,
    payload: {},
  });
  expect(res.statusCode, res.body).toBe(200);
};
const undo = async (c: TestClient, ids: string[]) => {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/discovery/results/bulk-undo-dismiss',
    payload: { ids },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ results: { id: string; outcome: string }[] }>().results;
};
const pendingJobs = async (app: FastifyInstance, c: TestClient, kind: string) =>
  await app.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, kind), eq(jobs.userId, c.userId), eq(jobs.status, 'pending')))
    .all();

/** Any status: a drain queued wrongly may have run and finished by the time a test looks. */
const everyDrain = async (app: FastifyInstance, c: TestClient) =>
  await app.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, RANK_WAITING_KIND), eq(jobs.userId, c.userId)))
    .all();

/** The budget is spent for today, so nothing can be ranked until it has room. */
async function budgetSpent(app: FastifyInstance, c: TestClient) {
  await writeDiscoveryBudget(app.db, ctxOf(c), 0.01);
  await app.db
    .insert(taskRuns)
    .values({
      id: `spent-${c.userId}`,
      userId: c.userId,
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
}

describe('#274: Undo after the rank job has already run', () => {
  it('dismissed before its job ran, then restored: it is ranked', async () => {
    const { app, a } = await boot();
    await storedWithJobsQueued(app, a, [post('Kept'), post('Undone')]);
    const id = await idOf(app, a, 'Undone');
    await dismiss(a, id);

    // Its job finds it dismissed, and ends without ranking it.
    await app.jobs.drain();
    expect(ranked).toEqual(['Kept']);
    expect((await byTitle(app, a)).get('Undone')!.aiScore).toBeNull();

    expect(await undo(a, [id])).toEqual([{ id, outcome: 'restored' }]);
    await app.jobs.drain();

    expect(ranked).toEqual(['Kept', 'Undone']);
    expect((await byTitle(app, a)).get('Undone')).toMatchObject({
      aiScore: 60,
      rankSkipReason: null,
      rankDeferredAt: null,
      disposition: 'pending',
    });
  });

  it('after Rank these: sent, dismissed before its job ran, then restored', async () => {
    const { app, a } = await boot();
    const titles = Array.from({ length: 26 }, (_, i) => `Posting ${i + 1}`);
    const src = await storedWithJobsQueued(
      app,
      a,
      titles.map((t) => post(t)),
    );
    await app.jobs.drain();
    const held = [...(await byTitle(app, a)).values()].find(
      (r) => r.rankSkipReason === 'below_cut',
    )!;
    ranked = [];

    const sent = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/sources/${src.id}/rank-below-cut`,
      payload: { count: 1 },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    await dismiss(a, held.id);
    await app.jobs.drain();
    expect(ranked).toEqual([]);

    await undo(a, [held.id]);
    await app.jobs.drain();
    expect(ranked).toEqual([held.posting.title]);
  });

  it('after Rank anyway: sent, dismissed before its job ran, then restored', async () => {
    const { app, a } = await boot();
    const src = await createSource(app.db, ctxOf(a), {
      kind: 'ats_lever',
      config: { org: 'held' },
      roleTargetId: null,
    });
    const run = await createRun(app.db, ctxOf(a), { sourceId: src.id });
    const posting = post('Held by the filter');
    const held = await insertResult(app.db, ctxOf(a), {
      runId: run.id,
      posting,
      dedupeKey: posting.externalId!,
      resolution: 'full',
      prefilter: { outcome: 'filtered', rule: 'title', score: 0 },
      rankSkipReason: 'filtered',
    });
    const sent = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${held.id}/rank-anyway`,
    });
    expect(sent.json<{ queued: number }>().queued).toBe(1);
    await dismiss(a, held.id);
    await app.jobs.drain();
    expect(ranked).toEqual([]);

    await undo(a, [held.id]);
    await app.jobs.drain();
    expect(ranked).toEqual(['Held by the filter']);
    expect((await results(app, a))[0]).toMatchObject({ aiScore: 60, rankSkipReason: null });
  });

  it('one that never had a job, as the denylist leaves it: restored, it is ranked', async () => {
    const { app, a } = await boot();
    const src = await createSource(app.db, ctxOf(a), {
      kind: 'ats_lever',
      config: { org: 'denied' },
      roleTargetId: null,
    });
    const run = await createRun(app.db, ctxOf(a), { sourceId: src.id });
    const posting = post('Suppressed');
    const row = await insertResult(app.db, ctxOf(a), {
      runId: run.id,
      posting,
      dedupeKey: posting.externalId!,
      resolution: 'full',
    });
    await setDisposition(app.db, ctxOf(a), row.id, 'dismissed');

    await undo(a, [row.id]);
    await app.jobs.drain();
    expect(ranked).toEqual(['Suppressed']);
  });

  it('several restored together: one drain, and each is ranked once', async () => {
    const { app, a } = await boot();
    await storedWithJobsQueued(app, a, [post('One'), post('Two'), post('Three')]);
    const ids = (await results(app, a)).map((r) => r.id);
    for (const id of ids) await dismiss(a, id);
    await app.jobs.drain();
    expect(ranked).toEqual([]);

    await undo(a, ids);
    expect(await pendingJobs(app, a, RANK_WAITING_KIND)).toHaveLength(1);
    await app.jobs.drain();
    expect([...ranked].sort()).toEqual(['One', 'Three', 'Two']);
  });

  it('a partial lead goes back to lead resolution, not straight to ranking', async () => {
    const { app, a } = await boot();
    await storedWithJobsQueued(app, a, [post('Partial', { descriptionMd: null })]);
    const id = await idOf(app, a, 'Partial');
    await dismiss(a, id);
    await app.db.delete(jobs).where(eq(jobs.kind, LEAD_RESOLVE_KIND)).run();

    await undo(a, [id]);
    expect(await pendingJobs(app, a, LEAD_RESOLVE_KIND)).toHaveLength(1);
    expect(await pendingJobs(app, a, RANK_WAITING_KIND)).toEqual([]);
    expect((await results(app, a))[0]!.rankDeferredAt).toBeNull();
  });
});

describe('#274: or it shows why not', () => {
  it('over budget it says it is waiting, queues no drain, and is ranked once there is room', async () => {
    const { app, a } = await boot();
    await storedWithJobsQueued(app, a, [post('Undone')]);
    const id = await idOf(app, a, 'Undone');
    await dismiss(a, id);
    await app.jobs.drain();
    await budgetSpent(app, a);

    await undo(a, [id]);
    expect(await pendingJobs(app, a, RANK_WAITING_KIND)).toEqual([]);
    expect((await results(app, a))[0]).toMatchObject({
      aiScore: null,
      rankDeferredAt: expect.any(Number),
    });

    const put = await a.request({
      method: 'PUT',
      url: '/api/v1/ai/discovery-budget',
      payload: { dailyUsd: 100 },
    });
    expect(put.statusCode, put.body).toBe(200);
    await app.jobs.drain();
    expect(ranked).toEqual(['Undone']);
  });

  it('with no AI key its card says so', async () => {
    const { app, a } = await boot();
    await storedWithJobsQueued(app, a, [post('Undone')]);
    const id = await idOf(app, a, 'Undone');
    await dismiss(a, id);
    await app.jobs.drain();

    vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
    await undo(a, [id]);
    await app.jobs.drain();
    expect((await results(app, a))[0]).toMatchObject({
      aiScore: null,
      rankSkipReason: 'no_key',
      rankDeferredAt: expect.any(Number),
    });
  });

  it('with the provider out its card says so, and it keeps waiting', async () => {
    const { app, a } = await boot();
    await storedWithJobsQueued(app, a, [post('Undone')]);
    const id = await idOf(app, a, 'Undone');
    await dismiss(a, id);
    await app.jobs.drain();

    vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('provider_error'));
    await undo(a, [id]);
    await app.jobs.drain();
    expect((await results(app, a))[0]).toMatchObject({
      aiScore: null,
      rankSkipReason: 'provider_error',
      rankDeferredAt: expect.any(Number),
    });
  });
});

describe('#274: Undo with the rank job still to come', () => {
  it('its job ranks it, once, with no wait and no drain', async () => {
    const { app, a } = await boot();
    await storedWithJobsQueued(app, a, [post('Undone')]);
    const id = await idOf(app, a, 'Undone');
    await dismiss(a, id);

    await undo(a, [id]);
    expect((await results(app, a))[0]!.rankDeferredAt).toBeNull();
    expect(await pendingJobs(app, a, RANK_WAITING_KIND)).toEqual([]);
    expect(await pendingJobs(app, a, DISCOVERY_RANK_KIND)).toHaveLength(1);

    await app.jobs.drain();
    expect(ranked).toEqual(['Undone']);
  });

  // It may have read the posting as dismissed already, and a job queued now would dedupe onto it
  // and end with nothing ranked. The wait does not depend on what that job does.
  it('a job already running does not count: it joins the wait', async () => {
    const { app, a } = await boot();
    await storedWithJobsQueued(app, a, [post('Undone')]);
    const id = await idOf(app, a, 'Undone');
    await dismiss(a, id);
    await app.db
      .update(jobs)
      .set({ status: 'running' })
      .where(eq(jobs.dedupeKey, `${DISCOVERY_RANK_KIND}:${id}`))
      .run();

    await undo(a, [id]);
    expect((await results(app, a))[0]!.rankDeferredAt).toEqual(expect.any(Number));
    expect(await pendingJobs(app, a, RANK_WAITING_KIND)).toHaveLength(1);
    await app.jobs.drain();
    expect(ranked).toEqual(['Undone']);
  });
});

describe('#274: what already says why, or needs nothing, stays as it is', () => {
  /** A dismissed posting, as `over` leaves it, with no job. */
  async function dismissedRow(
    app: FastifyInstance,
    c: TestClient,
    title: string,
    over: Parameters<typeof insertResult>[2] extends infer T ? Partial<T> : never = {},
  ) {
    const src = await createSource(app.db, ctxOf(c), {
      kind: 'ats_lever',
      config: { org: `row-${n}` },
      roleTargetId: null,
    });
    const run = await createRun(app.db, ctxOf(c), { sourceId: src.id });
    const posting = post(title);
    const row = await insertResult(app.db, ctxOf(c), {
      runId: run.id,
      posting,
      dedupeKey: posting.externalId!,
      resolution: 'full',
      ...over,
    });
    await setDisposition(app.db, ctxOf(c), row.id, 'dismissed');
    return row.id;
  }

  for (const reason of ['below_cut', 'filtered', 'no_key', 'provider_error'] as const) {
    it(`a posting with the reason ${reason} keeps it, with no wait and no call`, async () => {
      const { app, a } = await boot();
      const id = await dismissedRow(app, a, 'Has a reason', { rankSkipReason: reason });
      await undo(a, [id]);
      await app.jobs.drain();
      expect(ranked).toEqual([]);
      expect((await results(app, a))[0]).toMatchObject({
        rankSkipReason: reason,
        rankDeferredAt: null,
        aiScore: null,
      });
    });
  }

  it('a ranked posting is not ranked again', async () => {
    const { app, a } = await boot();
    const id = await dismissedRow(app, a, 'Ranked');
    await app.db
      .update(discoveryResults)
      .set({ aiScore: 70 })
      .where(eq(discoveryResults.id, id))
      .run();
    await undo(a, [id]);
    await app.jobs.drain();
    expect(ranked).toEqual([]);
    expect((await results(app, a))[0]).toMatchObject({ aiScore: 70, rankDeferredAt: null });
    expect(await everyDrain(app, a)).toEqual([]);
  });

  it('one that was already waiting keeps its place, and does not move its time', async () => {
    const { app, a } = await boot();
    const id = await dismissedRow(app, a, 'Waiting');
    await setRankDeferred(app.db, ctxOf(a), id, 12345);
    await undo(a, [id]);
    expect((await results(app, a))[0]!.rankDeferredAt).toBe(12345);
    // It waits for a sweep as it did before, with nothing new queued.
    expect(await everyDrain(app, a)).toEqual([]);
  });

  it('another user’s posting: not found, and nothing changes', async () => {
    const { app, a, b } = await boot();
    const id = await dismissedRow(app, a, 'Mine');
    expect(await undo(b, [id])).toEqual([{ id, outcome: 'not_found' }]);
    expect(await pendingJobs(app, b, RANK_WAITING_KIND)).toEqual([]);
    expect(await pendingJobs(app, a, RANK_WAITING_KIND)).toEqual([]);
    expect((await results(app, a))[0]).toMatchObject({
      disposition: 'dismissed',
      rankDeferredAt: null,
    });
  });

  it('one not dismissed any more is left alone', async () => {
    const { app, a } = await boot();
    await storedWithJobsQueued(app, a, [post('Still pending')]);
    const id = await idOf(app, a, 'Still pending');
    expect(await undo(a, [id])).toEqual([{ id, outcome: 'already_decided' }]);
    expect((await results(app, a))[0]!.rankDeferredAt).toBeNull();
    expect(await pendingJobs(app, a, RANK_WAITING_KIND)).toEqual([]);
  });

  it('a pending posting with no job, named by mistake, does not join the wait', async () => {
    const { app, a } = await boot();
    const src = await createSource(app.db, ctxOf(a), {
      kind: 'ats_lever',
      config: { org: 'never-dismissed' },
      roleTargetId: null,
    });
    const run = await createRun(app.db, ctxOf(a), { sourceId: src.id });
    const posting = post('Never dismissed');
    const row = await insertResult(app.db, ctxOf(a), {
      runId: run.id,
      posting,
      dedupeKey: posting.externalId!,
      resolution: 'full',
    });
    expect(await undo(a, [row.id])).toEqual([{ id: row.id, outcome: 'already_decided' }]);
    expect((await results(app, a))[0]!.rankDeferredAt).toBeNull();
    expect(await everyDrain(app, a)).toEqual([]);
  });

  // Dismissed again in the moment after the restore committed: a route test cannot place this.
  it('dismissed again before it resumes: it stays out of the wait', async () => {
    const { app, a } = await boot();
    const id = await dismissedRow(app, a, 'Again');
    await resumeAfterUndo(app.db, ctxOf(a), [id]);
    expect((await results(app, a))[0]!.rankDeferredAt).toBeNull();
    expect(await everyDrain(app, a)).toEqual([]);
  });

  // Its source deleted in that moment: the restore has committed, and must still read as done.
  it('a posting gone before it resumes is passed over, and the others still resume', async () => {
    const { app, a } = await boot();
    const id = await dismissedRow(app, a, 'Stays');
    await setDisposition(app.db, ctxOf(a), id, 'pending');
    await expect(resumeAfterUndo(app.db, ctxOf(a), ['no-such-id', id])).resolves.toBeUndefined();
    expect((await results(app, a))[0]!.rankDeferredAt).toEqual(expect.any(Number));
  });

  describe('joining the wait, on its own', () => {
    it('a ranking that landed since is left alone', async () => {
      const { app, a } = await boot();
      const id = await dismissedRow(app, a, 'Ranked since');
      await app.db
        .update(discoveryResults)
        .set({ aiScore: 70 })
        .where(eq(discoveryResults.id, id))
        .run();
      await setRankWaitingIfUnranked(app.db, ctxOf(a), id);
      expect((await results(app, a))[0]!.rankDeferredAt).toBeNull();
    });

    it('another user’s posting is left alone', async () => {
      const { app, a, b } = await boot();
      const id = await dismissedRow(app, a, 'Mine');
      await setRankWaitingIfUnranked(app.db, ctxOf(b), id);
      expect((await results(app, a))[0]!.rankDeferredAt).toBeNull();
    });

    it('a wait already there keeps its time', async () => {
      const { app, a } = await boot();
      const id = await dismissedRow(app, a, 'Waiting');
      await setRankDeferred(app.db, ctxOf(a), id, 12345);
      await setRankWaitingIfUnranked(app.db, ctxOf(a), id);
      expect((await results(app, a))[0]!.rankDeferredAt).toBe(12345);
    });
  });

  it('only the ones restored join the wait, in a batch with others', async () => {
    const { app, a } = await boot();
    const undone = await dismissedRow(app, a, 'Undone');
    const reasoned = await dismissedRow(app, a, 'Reasoned', { rankSkipReason: 'provider_error' });
    await undo(a, [undone, reasoned, 'no-such-id']);
    const rows = await app.db
      .select({ id: discoveryResults.id, at: discoveryResults.rankDeferredAt })
      .from(discoveryResults)
      .where(inArray(discoveryResults.id, [undone, reasoned]))
      .all();
    expect(new Map(rows.map((r) => [r.id, r.at !== null]))).toEqual(
      new Map([
        [undone, true],
        [reasoned, false],
      ]),
    );
  });
});
