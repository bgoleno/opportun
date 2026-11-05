// Why a posting was not ranked (https://github.com/bgoleno/opportun/issues/210, tl's slice 2 on
// #190): a skipped ranking keeps the router's reason on the result until it is ranked, and
// Settings counts budget refusals. A budget refusal itself now waits (#214, discoveryBudget.test.ts).
import { AiUnavailableError, runStructured, type AiUnavailableReason } from '@opportun/ai';
import {
  newId,
  RANK_SKIP_REASONS,
  type NormalizedPosting,
  type RankSkipReason,
} from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { discoveryResults, jobs, prompts, taskRuns } from '../src/db/schema';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import { enqueue } from '../src/jobs/runner';
import { createSource, listResults } from '../src/repos/discovery';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const PAGE = { limit: 50, offset: 0 };
const DAY = 86_400_000;

beforeEach(() => vi.mocked(runStructured).mockReset());
afterEach(() => resetSources());

const POSTING: NormalizedPosting = {
  company: 'Initech',
  title: 'Staff Platform Engineer',
  descriptionMd: 'Own the platform.',
  postingUrl: 'https://boards.example.com/initech/1',
  location: 'Austin, TX',
  externalId: 'gh-1',
};

async function discover(app: FastifyInstance, c: TestClient): Promise<void> {
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      yield { posting: POSTING, nextCursor: null };
    },
  } satisfies DiscoverySource);
  const src = await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: 'initech' },
    roleTargetId: null,
  });
  await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: c.userId });
  await app.jobs.drain();
}

const onlyResult = async (app: FastifyInstance, c: TestClient) =>
  (await listResults(app.db, ctxOf(c), PAGE)).items[0]!;

const rankJobs = (app: FastifyInstance) =>
  app.db.select().from(jobs).where(eq(jobs.kind, DISCOVERY_RANK_KIND)).all();

describe('a skipped ranking keeps why (#210)', () => {
  // key_rejected is the router's provider_error with its keyRejected flag (#261).
  it('the codes are exactly the router’s own reasons, and key_rejected', () => {
    expectTypeOf<Exclude<RankSkipReason, 'key_rejected'>>().toEqualTypeOf<AiUnavailableReason>();
    expect(RANK_SKIP_REASONS).toContain('key_rejected');
  });

  // budget_exceeded no longer ends as a skip: the posting waits (#214, discoveryBudget.test.ts).
  const routerReasons = RANK_SKIP_REASONS.filter(
    (r): r is Exclude<RankSkipReason, 'budget_exceeded' | 'key_rejected'> =>
      r !== 'budget_exceeded' && r !== 'key_rejected',
  );
  for (const reason of routerReasons) {
    it(`records ${reason}, and the result stays unranked and pending`, async () => {
      const { app, a } = await boot();
      vi.mocked(runStructured).mockRejectedValueOnce(new AiUnavailableError(reason));
      await discover(app, a);
      const res = await onlyResult(app, a);
      expect(res).toMatchObject({
        rankSkipReason: reason,
        aiScore: null,
        aiRationale: null,
        disposition: 'pending',
      });
      // The API carries it to the queue card.
      const listed = await a.request({
        method: 'GET',
        url: '/api/v1/discovery/results?disposition=pending',
      });
      expect(listed.json().items[0].rankSkipReason).toBe(reason);
      // Not a budget refusal, so nothing is retried or deferred: one ranking job, done, skipped.
      const ranks = await rankJobs(app);
      expect(ranks).toHaveLength(1);
      expect(ranks[0]).toMatchObject({ status: 'done', result: { status: 'skipped', reason } });
    });
  }

  it('ranking it later clears the reason', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockRejectedValueOnce(new AiUnavailableError('provider_error'));
    await discover(app, a);
    const skipped = await onlyResult(app, a);
    expect(skipped.rankSkipReason).toBe('provider_error');

    vi.mocked(runStructured).mockResolvedValueOnce({
      score: 64,
      rationale: 'A fair match.',
      disqualifiers: [],
    });
    await enqueue(app.db, DISCOVERY_RANK_KIND, { resultId: skipped.id }, { userId: a.userId });
    await app.jobs.drain();
    expect(await onlyResult(app, a)).toMatchObject({
      rankSkipReason: null,
      aiScore: 64,
      aiRationale: 'A fair match.',
    });
  });

  it('a result never sent to the AI (no prompt to rank with) records nothing', async () => {
    const { app, a } = await boot();
    // With the discovery prompt gone, ranking stops before any AI call.
    await app.db.delete(prompts).where(eq(prompts.taskKey, DISCOVERY_RANK_KIND)).run();
    await discover(app, a);
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
    expect((await onlyResult(app, a)).rankSkipReason).toBeNull();
  });

  it('recording a skip writes only the reason: updatedAt and the score are as they were', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockRejectedValueOnce(new AiUnavailableError('provider_error'));
    await discover(app, a);
    const row = (await app.db.select().from(discoveryResults).all())[0]!;
    expect(row.rankSkipReason).toBe('provider_error');
    expect(row.updatedAt).toBe(row.createdAt);
  });
});

describe('GET /ai/usage/rank-skips: postings the budget refused (#210)', () => {
  async function run(
    app: FastifyInstance,
    userId: string,
    at: number,
    over: Partial<typeof taskRuns.$inferInsert> = {},
  ) {
    await app.db
      .insert(taskRuns)
      .values({
        id: newId(),
        userId,
        taskKey: DISCOVERY_RANK_KIND,
        provider: 'openai',
        model: 'm',
        inputTokens: 0,
        outputTokens: 0,
        estCost: 0,
        fallbackPricing: false,
        durationMs: 0,
        status: 'error',
        error: 'budget_exceeded',
        createdAt: at,
        ...over,
      })
      .run();
  }

  it('counts discovery.rank budget refusals today and over the last 7 days, the caller’s only', async () => {
    const { app, a, b } = await boot();
    const now = Date.now();
    const today = Math.floor(now / DAY) * DAY;
    await run(app, a.userId, now);
    await run(app, a.userId, today); // the first moment of the budget's UTC day
    await run(app, a.userId, today - 1); // yesterday
    await run(app, a.userId, today - 6 * DAY); // the 7th day back, included
    await run(app, a.userId, today - 6 * DAY - 1); // older: not counted
    // Not budget refusals of discovery.rank:
    await run(app, a.userId, now, { error: 'provider_error' });
    await run(app, a.userId, now, { status: 'ok', error: null });
    await run(app, a.userId, now, { taskKey: 'comms.classify' });
    // Another user's.
    await run(app, b.userId, now);

    const res = await a.request({ method: 'GET', url: '/api/v1/ai/usage/rank-skips' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ today: 2, last7Days: 4 });
  });

  it('none yet: zeros', async () => {
    const { a } = await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/ai/usage/rank-skips' });
    expect(res.json()).toEqual({ today: 0, last7Days: 0 });
  });

  it('needs a session', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'GET', url: '/api/v1/ai/usage/rank-skips' });
    expect(res.statusCode).toBe(401);
  });
});
