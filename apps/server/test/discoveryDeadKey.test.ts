// A key the provider keeps rejecting stops the hourly sweep's calls, end to end
// (https://github.com/bgoleno/opportun/issues/261, sec's Optional 2 on
// https://github.com/bgoleno/opportun/pull/230). The router is real here, because what it makes of
// a 401 is what is under test; discoveryBudget.test.ts has the drain and the ways back. The network
// is a stub and every posting is made up.
import type { NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSource, resetSources } from '../src/adapters/discoverySource';
import { discoveryResults, jobs, taskRuns } from '../src/db/schema';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import { RANK_WAITING_SWEEP_KIND, sweepWaitingResults } from '../src/jobs/discoveryRankWaiting';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import { enqueue, runNextJob } from '../src/jobs/runner';
import type { UserCtx } from '../src/repos/base';
import { createSource, setRankDeferred } from '../src/repos/discovery';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const fetchStub = vi.fn<typeof fetch>();
const answering = (status: number) =>
  fetchStub.mockImplementation(
    async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: 'refused' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );

beforeEach(() => {
  fetchStub.mockReset();
  fetchStub.mockRejectedValue(new Error('network disabled in tests'));
  vi.stubGlobal('fetch', fetchStub);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetSources();
});

const posting = (i: number): NormalizedPosting => ({
  company: 'Initech',
  title: `Engineer ${i}`,
  descriptionMd: 'Own the platform.',
  postingUrl: `https://boards.example.com/initech/${i}`,
  externalId: `gh-${i}`,
});

/** `count` postings of this user's waiting, with an Anthropic key, on a day with budget. */
async function waiting(app: FastifyInstance, c: TestClient, count: number): Promise<number> {
  const today = Math.floor(Date.now() / DAY) * DAY;
  vi.useFakeTimers({ now: today + HOUR, toFake: ['Date'] });
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      for (let i = 1; i <= count; i++) yield { posting: posting(i), nextCursor: null };
    },
  });
  const src = await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: 'initech' },
    roleTargetId: null,
  });
  await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: c.userId });
  await runNextJob(app.db, { services: app.jobs.services });
  await app.db.delete(jobs).where(eq(jobs.kind, DISCOVERY_RANK_KIND)).run();
  const rows = await app.db
    .select({ id: discoveryResults.id })
    .from(discoveryResults)
    .where(eq(discoveryResults.userId, c.userId))
    .all();
  expect(rows).toHaveLength(count);
  for (const row of rows) await setRankDeferred(app.db, ctxOf(c), row.id);
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/secrets',
    payload: { kind: 'ai_api_key', label: 'anthropic', value: 'made-up-key-for-a-test' },
  });
  expect(res.statusCode, res.body).toBe(201);
  // Adding the key queues a drain; each test runs its own sweeps.
  await app.db.delete(jobs).where(eq(jobs.status, 'pending')).run();
  fetchStub.mockClear();
  return today + DAY + HOUR;
}

/** One hourly sweep at `at` and the drain it queues. */
async function sweepAt(app: FastifyInstance, at: number): Promise<{ queued: number }> {
  vi.setSystemTime(at);
  const out = await sweepWaitingResults(app.db);
  await app.db
    .delete(jobs)
    .where(and(eq(jobs.kind, RANK_WAITING_SWEEP_KIND), eq(jobs.status, 'pending')))
    .run();
  await app.jobs.drain();
  return out;
}

const errorRows = async (app: FastifyInstance, c: TestClient) =>
  (
    await app.db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(
        and(
          eq(taskRuns.userId, c.userId),
          eq(taskRuns.taskKey, DISCOVERY_RANK_KIND),
          eq(taskRuns.status, 'error'),
        ),
      )
      .all()
  ).length;

const cards = async (app: FastifyInstance, c: TestClient) =>
  await app.db
    .select({
      reason: discoveryResults.rankSkipReason,
      score: discoveryResults.aiScore,
      deferred: discoveryResults.rankDeferredAt,
      disposition: discoveryResults.disposition,
    })
    .from(discoveryResults)
    .where(eq(discoveryResults.userId, c.userId))
    .all();

describe('#261: the hourly sweep with a dead key', () => {
  it('a 401: one call, then none across a whole day of sweeps, and every card says why', async () => {
    const { app, a } = await boot();
    const at = await waiting(app, a, 5);
    answering(401);

    expect(await sweepAt(app, at)).toEqual({ queued: 1 });
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(await errorRows(app, a)).toBe(1);

    for (let h = 1; h <= 24; h++) {
      expect(await sweepAt(app, at + h * HOUR)).toEqual({ queued: 0 });
    }
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(await errorRows(app, a)).toBe(1);

    const rows = await cards(app, a);
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r).toMatchObject({
        reason: 'key_rejected',
        score: null,
        deferred: expect.any(Number),
        disposition: 'pending',
      });
    }
  });

  it('a 403 is not a dead key: the sweep keeps trying, up to three calls each', async () => {
    const { app, a } = await boot();
    const at = await waiting(app, a, 5);
    answering(403);

    expect(await sweepAt(app, at)).toEqual({ queued: 1 });
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(await sweepAt(app, at + HOUR)).toEqual({ queued: 1 });
    expect(fetchStub.mock.calls.length).toBeGreaterThan(3);
    expect((await cards(app, a)).map((r) => r.reason)).not.toContain('key_rejected');
  });

  it('an outage the network reports is not one either', async () => {
    const { app, a } = await boot();
    const at = await waiting(app, a, 2);
    // The stub still rejects, as beforeEach set it.
    expect(await sweepAt(app, at)).toEqual({ queued: 1 });
    expect(await sweepAt(app, at + HOUR)).toEqual({ queued: 1 });
    expect((await cards(app, a)).map((r) => r.reason)).not.toContain('key_rejected');
  });
});
