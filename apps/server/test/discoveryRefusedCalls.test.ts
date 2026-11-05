// What a refused or failed discovery.rank call does to the figures the user reads
// (https://github.com/bgoleno/opportun/issues/258, items 1 and 2). tl's ruling on
// https://github.com/bgoleno/opportun/pull/212: "Calls" counts every discovery.rank task run, so a
// refusal that never reached a provider is a call and an error, at no cost. The router is real
// here, unlike in discoveryBudget.test.ts, because the rows it writes are what is under test. The
// network is a stub and every posting is made up.
import { newId, type NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { jobs, taskRuns } from '../src/db/schema';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import { RANK_WAITING_SWEEP_KIND, sweepWaitingResults } from '../src/jobs/discoveryRankWaiting';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import { enqueue, runNextJob } from '../src/jobs/runner';
import type { UserCtx } from '../src/repos/base';
import { createSource } from '../src/repos/discovery';
import { writeDiscoveryBudget } from '../src/repos/discoveryBudget';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const fetchStub = vi.fn<typeof fetch>();

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

/** Stores `count` postings and runs what that queues: each posting's ranking. */
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

/** A ranking that reached a provider and cost `usd`, as the router writes one. */
async function spend(app: FastifyInstance, c: TestClient, usd: number): Promise<void> {
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

/** The last-7-days row the Settings card shows, read the way the card reads it. */
async function figures(c: TestClient) {
  const res = await c.request({ method: 'GET', url: '/api/v1/discovery/cost-figures' });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{
    rank: {
      calls: number;
      errors: number;
      inputTokens: unknown;
      outputTokens: unknown;
      avgCostUsd: number | null;
      totalCostUsd: number;
    }[];
  }>().rank[0]!;
}

const rankErrors = async (app: FastifyInstance, c: TestClient) =>
  await app.db
    .select({ error: taskRuns.error })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.userId, c.userId),
        eq(taskRuns.taskKey, DISCOVERY_RANK_KIND),
        eq(taskRuns.status, 'error'),
      ),
    )
    .all();

async function addAnthropicKey(c: TestClient): Promise<void> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/secrets',
    payload: { kind: 'ai_api_key', label: 'anthropic', value: 'made-up-key-for-a-test' },
  });
  expect(res.statusCode, res.body).toBe(201);
}

describe('item 1: a refused run counts as a call and an error, with no cost', () => {
  it('no key: no request is sent, and the card still reads 1 call, 1 error, nothing spent', async () => {
    const { app, a } = await boot();
    await discover(app, a, 1);

    expect(fetchStub).not.toHaveBeenCalled();
    expect(await rankErrors(app, a)).toEqual([{ error: 'no_key' }]);
    expect(await figures(a)).toMatchObject({
      calls: 1,
      errors: 1,
      inputTokens: null,
      outputTokens: null,
      avgCostUsd: null,
      totalCostUsd: 0,
    });
  });

  it('the per-task daily limit: one more call and error, and the total does not move', async () => {
    const { app, a } = await boot();
    await writeDiscoveryBudget(app.db, ctxOf(a), 100);
    await spend(app, a, 5);
    await discover(app, a, 1);

    expect(fetchStub).not.toHaveBeenCalled();
    expect(await rankErrors(app, a)).toEqual([{ error: 'budget_exceeded' }]);
    expect(await figures(a)).toMatchObject({ calls: 2, errors: 1, totalCostUsd: 5 });
  });
});

describe('item 2: the hourly retry, with postings waiting', () => {
  /**
   * `count` postings waiting, because their first day's budget was spent, then the next day, when
   * the budget has room again. Only Date is faked, so jobs and the database run as usual.
   */
  async function waitingUntilTomorrow(app: FastifyInstance, c: TestClient, count: number) {
    const today = Math.floor(Date.now() / DAY) * DAY;
    vi.useFakeTimers({ now: today + HOUR, toFake: ['Date'] });
    await writeDiscoveryBudget(app.db, ctxOf(c), 0.02);
    await spend(app, c, 0.02);
    await discover(app, c, count);
    expect(await rankErrors(app, c)).toEqual([]);
    return today + DAY + HOUR;
  }

  /** One hourly sweep at `at` and the drain it queues. */
  async function sweepAt(app: FastifyInstance, at: number): Promise<void> {
    vi.setSystemTime(at);
    expect(await sweepWaitingResults(app.db)).toEqual({ queued: 1 });
    // A sweep job of its own may be due by now: running it too would be a second sweep.
    await app.db
      .delete(jobs)
      .where(and(eq(jobs.kind, RANK_WAITING_SWEEP_KIND), eq(jobs.status, 'pending')))
      .run();
    await app.jobs.drain();
  }

  it('no key: at most one error row a sweep however many wait, and the cost stays the same', async () => {
    const { app, a } = await boot();
    const at = await waitingUntilTomorrow(app, a, 5);
    const before = await figures(a);

    await sweepAt(app, at);
    const first = await figures(a);
    expect(first.errors - before.errors).toBe(1);
    expect(first.totalCostUsd).toBe(before.totalCostUsd);

    await sweepAt(app, at + HOUR);
    const second = await figures(a);
    expect(second.errors - first.errors).toBeLessThanOrEqual(1);
    expect(second.calls - first.calls).toBeLessThanOrEqual(1);
    expect(second.totalCostUsd).toBe(before.totalCostUsd);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('a provider outage, one posting waiting: one failed call a sweep, at no cost', async () => {
    const { app, a } = await boot();
    await addAnthropicKey(a);
    const at = await waitingUntilTomorrow(app, a, 1);
    const before = await figures(a);

    await sweepAt(app, at);
    const first = await figures(a);
    expect(first.errors - before.errors).toBe(1);

    await sweepAt(app, at + HOUR);
    const second = await figures(a);
    expect(second.errors - first.errors).toBe(1);
    expect(second.totalCostUsd).toBe(before.totalCostUsd);
  });

  // Not one a sweep: with more waiting, a drain gives up only after three errors in a row, because
  // one error can be about that posting alone (OUTAGE_AFTER_ERRORS in discoveryRankWaiting.ts).
  it('a provider outage, many waiting: at most three failed calls a sweep, at no cost', async () => {
    const { app, a } = await boot();
    await addAnthropicKey(a);
    const at = await waitingUntilTomorrow(app, a, 5);
    const before = await figures(a);

    await sweepAt(app, at);
    const first = await figures(a);
    expect(first.errors - before.errors).toBe(3);

    await sweepAt(app, at + HOUR);
    const second = await figures(a);
    expect(second.errors - first.errors).toBeLessThanOrEqual(3);
    expect(second.totalCostUsd).toBe(before.totalCostUsd);
  });
});
