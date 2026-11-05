// While drains run, a worker stays free for other job kinds
// (https://github.com/bgoleno/opportun/issues/260, sec's probe on
// https://github.com/bgoleno/opportun/pull/230). A drain holds its worker for its whole loop and
// there is one per user. The provider is mocked and every posting is made up.
import { runStructured } from '@opportun/ai';
import { newId, type NormalizedPosting } from '@opportun/core';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerSource, resetSources } from '../src/adapters/discoverySource';
import { discoveryResults, jobs, taskRuns, users } from '../src/db/schema';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import { enqueueRankWaiting, RANK_WAITING_KIND } from '../src/jobs/discoveryRankWaiting';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import { registerJob } from '../src/jobs/registry';
import { enqueue, runNextJob, startRunner } from '../src/jobs/runner';
import { TITLE_VARIANTS_KIND } from '../src/jobs/titleVariants';
import type { UserCtx } from '../src/repos/base';
import { createSource, setRankDeferred, setWaitingNoKey } from '../src/repos/discovery';
import { DEFAULT_DISCOVERY_DAILY_USD } from '../src/repos/discoveryBudget';
import { createRoleTarget } from '../src/repos/profile';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const POSTINGS_EACH = 2;
const OTHER_KIND = 'test.not_a_drain';
const LONG_AGO = Date.UTC(2020, 0, 1);

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      for (let i = 1; i <= POSTINGS_EACH; i++) {
        const posting: NormalizedPosting = {
          company: 'Initech',
          title: `Engineer ${i}`,
          descriptionMd: 'Own the platform.',
          postingUrl: `https://boards.example.com/initech/${i}`,
          externalId: `gh-${i}`,
        };
        yield { posting, nextCursor: null };
      }
    },
  });
});
afterEach(() => resetSources());

async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Another user, written directly: the shared harness registers two. */
async function anotherUser(app: FastifyInstance, n: number): Promise<UserCtx> {
  const id = newId();
  const now = Date.now();
  await app.db
    .insert(users)
    .values({
      id,
      email: `drain-${n}@example.com`,
      passwordHash: 'not-a-real-hash',
      displayName: `Drain ${n}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { userId: id, isAdmin: false };
}

/** Postings of this user's that wait for the budget. */
async function backlog(app: FastifyInstance, ctx: UserCtx): Promise<void> {
  const src = await createSource(app.db, ctx, {
    kind: 'ats_lever',
    config: { org: `initech-${ctx.userId}` },
    roleTargetId: null,
  });
  await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: ctx.userId });
  await runNextJob(app.db, { services: app.jobs.services });
  await app.db.delete(jobs).where(eq(jobs.kind, DISCOVERY_RANK_KIND)).run();
  const rows = await app.db
    .select({ id: discoveryResults.id })
    .from(discoveryResults)
    .where(eq(discoveryResults.userId, ctx.userId))
    .all();
  expect(rows).toHaveLength(POSTINGS_EACH);
  for (const row of rows) await setRankDeferred(app.db, ctx, row.id, LONG_AGO);
}

/** Every provider call parks until `open`, counting how many are in flight. */
function heldProvider() {
  const state = { inFlight: 0, peak: 0, calls: 0 };
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  vi.mocked(runStructured).mockImplementation((async () => {
    state.calls += 1;
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    await gate;
    state.inFlight -= 1;
    return { score: 60, rationale: 'A fair match.', disqualifiers: [] };
  }) as never);
  return { state, open };
}

// sec's Optional 3 on #230: the route has lines from two PRs, merged by hand there.
describe('#260 criterion 3: adding an AI key runs the drain step and the title sweep', () => {
  const KEY = 'made-up-key-for-a-test';
  const ctxOf = (c: { userId: string }): UserCtx => ({ userId: c.userId, isAdmin: false });
  const addKey = (c: TestClient, kind: 'ai_api_key' | 'device_token' = 'ai_api_key') =>
    c.request({
      method: 'POST',
      url: '/api/v1/secrets',
      payload: { kind, label: 'openai', value: KEY },
    });
  const queuedFor = async (app: FastifyInstance, kind: string) =>
    (await app.db.select().from(jobs).where(eq(jobs.kind, kind)).all()).map((j) => j.userId);
  const reasons = async (app: FastifyInstance, c: TestClient) =>
    (
      await app.db
        .select({ reason: discoveryResults.rankSkipReason })
        .from(discoveryResults)
        .where(eq(discoveryResults.userId, c.userId))
        .all()
    ).map((r) => r.reason);
  /** Postings waiting behind a missing key, and a role target with no title variants yet. */
  async function waitingBehindNoKey(app: FastifyInstance, c: TestClient): Promise<void> {
    await backlog(app, ctxOf(c));
    await setWaitingNoKey(app.db, ctxOf(c));
    await createRoleTarget(app.db, ctxOf(c), {
      name: 'Platform',
      titleFamily: 'Platform Engineering',
    });
  }
  /** Spends the user's whole default budget for today. */
  const budgetSpent = (app: FastifyInstance, c: TestClient) =>
    app.db
      .insert(taskRuns)
      .values({
        id: newId(),
        userId: c.userId,
        taskKey: DISCOVERY_RANK_KIND,
        provider: 'openai',
        model: 'placeholder-model',
        inputTokens: 100,
        outputTokens: 10,
        estCost: DEFAULT_DISCOVERY_DAILY_USD,
        fallbackPricing: false,
        durationMs: 1,
        status: 'ok',
        error: null,
        createdAt: Date.now(),
      })
      .run();

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in this test')));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('with room in the budget: both are queued, for this user only, and the key is validated', async () => {
    const { app, a, b } = await boot();
    await waitingBehindNoKey(app, a);
    await waitingBehindNoKey(app, b);

    const res = await addKey(a);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ validation: { ok: boolean } }>().validation.ok).toBe(false);

    expect(await queuedFor(app, RANK_WAITING_KIND)).toEqual([a.userId]);
    expect(await queuedFor(app, TITLE_VARIANTS_KIND)).toEqual([a.userId]);
    expect(await reasons(app, a)).toEqual([null, null]);
    expect(await reasons(app, b)).toEqual(['no_key', 'no_key']);
    const everyJob = JSON.stringify(await app.db.select().from(jobs).all());
    expect(everyJob).not.toContain(KEY);
  });

  it('with no room in the budget: no drain, but the cards are corrected and the sweep still runs', async () => {
    const { app, a } = await boot();
    await waitingBehindNoKey(app, a);
    await budgetSpent(app, a);

    const res = await addKey(a);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ validation: { ok: boolean } }>().validation.ok).toBe(false);

    expect(await queuedFor(app, RANK_WAITING_KIND)).toEqual([]);
    expect(await queuedFor(app, TITLE_VARIANTS_KIND)).toEqual([a.userId]);
    expect(await reasons(app, a)).toEqual([null, null]);
  });

  it('another kind of secret does neither', async () => {
    const { app, a } = await boot();
    await waitingBehindNoKey(app, a);

    const res = await addKey(a, 'device_token');
    expect(res.statusCode, res.body).toBe(201);

    expect(await queuedFor(app, RANK_WAITING_KIND)).toEqual([]);
    expect(await queuedFor(app, TITLE_VARIANTS_KIND)).toEqual([]);
    expect(await reasons(app, a)).toEqual(['no_key', 'no_key']);
  });
});

describe('#260: drains leave a worker free, at the default worker count', () => {
  it('four users’ drains are held at the provider: a job queued now still runs, and the backlogs finish', async () => {
    const { app, a, b } = await boot();
    const everyone: UserCtx[] = [
      { userId: a.userId, isAdmin: false },
      { userId: b.userId, isAdmin: false },
      await anotherUser(app, 3),
      await anotherUser(app, 4),
    ];
    for (const ctx of everyone) await backlog(app, ctx);
    // After every backlog: backlog's runNextJob would otherwise pick up a queued drain.
    for (const ctx of everyone) await enqueueRankWaiting(app.db, ctx);

    let ranOther = false;
    registerJob({
      kind: OTHER_KIND,
      payloadSchema: z.object({}).passthrough(),
      maxAttempts: 1,
      run: async () => {
        ranOther = true;
      },
    });

    const { state, open } = heldProvider();
    // No workers and no kindLimits: what a real server runs with.
    const runner = startRunner(app.db, { services: app.jobs.services, intervalMs: 5 });
    try {
      await until(() => state.inFlight >= 2);
      // Long enough for a worker with nothing to claim to have finished looking. A job queued
      // before that would be picked up by the first look, which proves nothing about a long drain.
      await new Promise((r) => setTimeout(r, 100));
      await enqueue(app.db, OTHER_KIND, {});
      await until(() => ranOther);
      expect(state.peak).toBe(2);
    } finally {
      open();
      await until(async () => {
        const left = await app.db
          .select({ id: discoveryResults.id })
          .from(discoveryResults)
          .where(isNotNull(discoveryResults.rankDeferredAt))
          .all();
        return left.length === 0;
      });
      await runner.stop();
    }

    // Criterion 2: every posting of every user, ranked once, and no drain left behind.
    expect(state.calls).toBe(everyone.length * POSTINGS_EACH);
    const rows = await app.db
      .select({ aiScore: discoveryResults.aiScore })
      .from(discoveryResults)
      .where(
        inArray(
          discoveryResults.userId,
          everyone.map((c) => c.userId),
        ),
      )
      .all();
    expect(rows.map((r) => r.aiScore)).toEqual(
      Array.from({ length: everyone.length * POSTINGS_EACH }, () => 60),
    );
    const unfinished = await app.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, RANK_WAITING_KIND), inArray(jobs.status, ['pending', 'running'])))
      .all();
    expect(unfinished).toEqual([]);
  });
});
