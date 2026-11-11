// Ranking in batches (#441, slice 1 of https://github.com/bgoleno/opportun/issues/358; tl's design
// issuecomment-6794239917, "Tests that matter most", and ruling on #441), against a fake batch
// provider: no provider has a real batch client in this slice. The live call is mocked, every key
// and posting is made up.
import {
  AiUnavailableError,
  estimateBatchRequestUsd,
  resolvePolicy,
  runStructured,
  structuredRequest,
  type BatchProvider,
  type BatchRequest,
  type BatchResultItem,
  type BatchState,
} from '@opportun/ai';
import { newId, type NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { discoveryResults, jobs, rankBatches, secrets, taskRuns, users } from '../src/db/schema';
import { MULTI_POSTED_PREFIX } from '../src/jobs/discoveryKinds';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import { drainWaitingResults, sweepWaitingResults } from '../src/jobs/discoveryRankWaiting';
import { DISCOVERY_RUN_KIND, rankAnyway, rankBelowCut } from '../src/jobs/discoveryRun';
import {
  collectRankBatch,
  RANK_BATCH_COLLECT_KIND,
  RANK_BATCH_SEND_KIND,
  setRankBatching,
  submitRankBatch,
  sweepRankBatches,
} from '../src/jobs/rankBatch';
import { rankBudgetHasRoom } from '../src/jobs/rankBudget';
import { enqueue } from '../src/jobs/runner';
import { budgetKey, writeSetting } from '../src/lib/ai';
import { setRaceHook } from '../src/lib/racePoints';
import type { UserCtx } from '../src/repos/base';
import { createSource, getResult, listResults } from '../src/repos/discovery';
import {
  discoveryBudgetHasRoom,
  discoverySpentTodayUsd,
  writeDiscoveryBudget,
} from '../src/repos/discoveryBudget';
import {
  endBatchWait,
  hasResult,
  listBatchWaitingIds,
  markBatchSubmitted,
  rankOutputHistory,
  releaseBatchWaiting,
  setBatchWaiting,
  takeBatchLink,
  unlinkBatch,
  writeRankBatching,
} from '../src/repos/rankBatches';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

/** A batch provider that keeps what it was sent, and answers as a test tells it to. */
class FakeBatches implements BatchProvider {
  sent: { batchId: string; requests: BatchRequest[] }[] = [];
  private readonly states = new Map<string, BatchState>();
  private readonly answers = new Map<string, BatchResultItem[]>();
  /** Thrown by every state call while set: a key revoked at the provider, say. */
  stateError: Error | null = null;
  /** Thrown by the next submit while set, with nothing taken: a refused batch. */
  submitError: Error | null = null;
  async submit(requests: readonly BatchRequest[]): Promise<{ batchId: string }> {
    if (this.submitError !== null) throw this.submitError;
    const batchId = `msgbatch_fake_${this.sent.length + 1}`;
    this.sent.push({ batchId, requests: [...requests] });
    this.states.set(batchId, 'in_progress');
    return { batchId };
  }
  async state(batchId: string): Promise<BatchState> {
    if (this.stateError !== null) throw this.stateError;
    return this.states.get(batchId) ?? 'gone';
  }
  async results(batchId: string): Promise<BatchResultItem[]> {
    return this.answers.get(batchId) ?? [];
  }
  /** Ends the nth batch sent (1-based), each request answered by `answer`. */
  end(n: number, answer: (r: BatchRequest) => BatchResultItem | null): void {
    const batch = this.sent[n - 1]!;
    this.answers.set(
      batch.batchId,
      batch.requests.map(answer).filter((r): r is BatchResultItem => r !== null),
    );
    this.states.set(batch.batchId, 'ended');
  }
  forget(n: number): void {
    this.states.set(this.sent[n - 1]!.batchId, 'gone');
  }
  /** Sets the nth batch's results by hand, ids and all (a provider naming another's posting). */
  answer(n: number, items: BatchResultItem[]): void {
    const batch = this.sent[n - 1]!;
    this.answers.set(batch.batchId, items);
    this.states.set(batch.batchId, 'ended');
  }
  /** Every result id sent, across batches, once for each time it was sent. */
  sentIds(): string[] {
    return this.sent.flatMap((b) => b.requests.map((r) => r.customId));
  }
}

let fake: FakeBatches | null = null;
const boot = useApi(() => ({ build: { rankBatchProvider: () => fake } }));
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
const PAGE = { limit: 600, offset: 0 };
const POLICY = resolvePolicy('discovery.rank', undefined);
const USAGE = { input: 1_500, output: 90, cacheRead: 0, cacheWrite: 0 };

// As in discoveryBudget.test.ts: one known instant, so no weekly schedule runs in the days moved.
const PINNED_NOW = Date.UTC(2026, 10, 12, 7);

beforeEach(() => {
  vi.useFakeTimers({ now: PINNED_NOW, toFake: ['Date'], shouldAdvanceTime: true });
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockResolvedValue({ score: 40, rationale: 'Live.', disqualifiers: [] });
  fake = new FakeBatches();
});
afterEach(() => {
  setRaceHook(undefined);
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

let sources = 0;
/** Stores `count` postings and runs every job due, their rank jobs among them. */
async function discover(
  app: FastifyInstance,
  c: TestClient,
  count = 1,
  first = 1,
): Promise<string> {
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      for (let i = first; i < first + count; i++) yield { posting: posting(i), nextCursor: null };
    },
  } satisfies DiscoverySource);
  sources += 1;
  const src = await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: `initech-${sources}` },
    roleTargetId: null,
  });
  await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: c.userId });
  await app.jobs.drain();
  return src.id;
}

async function addKey(c: TestClient): Promise<void> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/secrets',
    payload: { kind: 'ai_api_key', label: 'anthropic', value: 'made-up-key-for-a-test' },
  });
  expect(res.statusCode, res.body).toBe(201);
}

/** Batching on, with a key for the provider in use. */
async function batching(app: FastifyInstance, c: TestClient): Promise<void> {
  await addKey(c);
  await setRankBatching(app.db, ctxOf(c), true);
}

const results = async (app: FastifyInstance, c: TestClient) =>
  (await listResults(app.db, ctxOf(c), PAGE)).items;

const rankRows = (app: FastifyInstance, c: TestClient) =>
  app.db
    .select()
    .from(taskRuns)
    .where(and(eq(taskRuns.userId, c.userId), eq(taskRuns.taskKey, DISCOVERY_RANK_KIND)))
    .all();

const batchRows = (app: FastifyInstance, c: TestClient) =>
  app.db.select().from(rankBatches).where(eq(rankBatches.userId, c.userId)).all();

const submit = (app: FastifyInstance, c: TestClient) =>
  submitRankBatch(app.db, ctxOf(c), app.jobs.services);

/** Collects the user's one sent batch. */
async function collect(app: FastifyInstance, c: TestClient) {
  const sent = (await batchRows(app, c)).filter((b) => b.state === 'submitted');
  expect(sent).toHaveLength(1);
  return await collectRankBatch(app.db, sent[0]!.id, app.jobs.services);
}

const succeeded =
  (score: number) =>
  (r: BatchRequest): BatchResultItem => ({
    customId: r.customId,
    kind: 'succeeded',
    text: JSON.stringify({ score, rationale: 'Batched.', disqualifiers: [] }),
    usage: USAGE,
  });

const crashAt = (point: string) =>
  setRaceHook((p) => {
    if (p === point) throw new Error(`crash at ${point}`);
  });

describe('batching off (criterion 2): the live path is unchanged', () => {
  it('a new posting is ranked live, once, and nothing is batched or queued for a batch', async () => {
    const { app, a } = await boot();
    await addKey(a);
    await discover(app, a, 2);
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(2);
    for (const r of await results(app, a)) {
      expect(r).toMatchObject({
        aiScore: 40,
        rankSkipReason: null,
        rankDeferredAt: null,
        rankBatchId: null,
        rankBatchSentAt: null,
      });
    }
    expect(fake!.sent).toEqual([]);
    expect(await batchRows(app, a)).toEqual([]);
    const submits = await app.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, RANK_BATCH_SEND_KIND))
      .all();
    expect(submits).toEqual([]);
  });

  it('the live call is what it was: the same task, prompt split, schema and prompt version', async () => {
    const { app, a, b } = await boot();
    await batching(app, b);
    await discover(app, a, 1);
    await discover(app, b, 1);
    // Only a's posting went live; b's waits for a batch.
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(1);
    const [, task, opts] = vi.mocked(runStructured).mock.calls[0]!;
    expect(task).toBe(DISCOVERY_RANK_KIND);
    expect(Object.keys(opts).sort()).toEqual(
      ['cacheBreak', 'prompt', 'promptId', 'schema', 'system'].sort(),
    );
    expect(opts.system.slice(opts.cacheBreak).startsWith('<untrusted>\n')).toBe(true);
  });
});

describe('batching on', () => {
  it('a new posting waits for the next batch; a submit is queued five minutes on', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
    const [r] = await results(app, a);
    expect(r).toMatchObject({
      aiScore: null,
      rankSkipReason: 'batch_waiting',
      rankBatchId: null,
      rankBatchSentAt: null,
    });
    expect(r!.rankDeferredAt).not.toBeNull();
    // The live drain does not take it.
    expect(await sweepWaitingResults(app.db)).toEqual({ queued: 0 });
    const [job] = await app.db.select().from(jobs).where(eq(jobs.kind, RANK_BATCH_SEND_KIND)).all();
    expect(job!.runAt).toBeGreaterThanOrEqual(PINNED_NOW + 5 * 60_000 - 1_000);
    expect(fake!.sent).toEqual([]);
    // Five minutes on, the queued submit sends it.
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000);
    await app.jobs.drain();
    expect(fake!.sentIds()).toEqual([r!.id]);
  });

  it('a batch request equals the live call for the same posting, the cache split included', async () => {
    const { app, a, b } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await discover(app, b, 1);
    const [, , live] = vi.mocked(runStructured).mock.calls[0]!;
    expect(await submit(app, a)).toMatchObject({ status: 'submitted', requests: 1 });
    const [sent] = fake!.sent[0]!.requests;
    const { promptId, ...opts } = live;
    expect(promptId).toBeTruthy();
    expect(sent!.request).toEqual(structuredRequest(POLICY, opts));
    // The cache split is the one #390 settled: the prefix is marked, the posting is not.
    const blocks = sent!.request.system as { content: string; providerOptions?: unknown }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
    expect(blocks[1]!.content.startsWith('<untrusted>\n')).toBe(true);
  });

  it('sent, its card says so; collected, it is scored once and costed once at the batch price', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await submit(app, a);
    const [r] = await results(app, a);
    const [batch] = await batchRows(app, a);
    expect(batch).toMatchObject({ state: 'submitted', requestCount: 1, provider: 'anthropic' });
    expect(r).toMatchObject({ rankBatchId: batch!.id, rankBatchSentAt: batch!.submittedAt });
    // The card's field reaches the API.
    const res = await a.request({ method: 'GET', url: '/api/v1/discovery/results?limit=10' });
    expect(res.json<{ items: { rankBatchSentAt: number | null }[] }>().items[0]).toMatchObject({
      rankBatchSentAt: batch!.submittedAt,
    });

    expect(await collect(app, a)).toMatchObject({ status: 'in_progress' });
    fake!.end(1, succeeded(77));
    expect(await collect(app, a)).toMatchObject({ status: 'collected', ranked: 1 });
    expect(await getResult(app.db, ctxOf(a), r!.id)).toMatchObject({
      aiScore: 77,
      aiRationale: 'Batched.',
      rankSkipReason: null,
      rankDeferredAt: null,
      rankBatchId: null,
      rankBatchSentAt: null,
    });
    const rows = await rankRows(app, a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'ok', inputTokens: 1_500, outputTokens: 90 });
    const { batchRunRecord } = await import('@opportun/ai');
    expect(rows[0]!.estCost).toBeCloseTo(
      batchRunRecord(DISCOVERY_RANK_KIND, POLICY, USAGE).estCostUsd,
      12,
    );
    expect((await batchRows(app, a))[0]).toMatchObject({ state: 'collected' });
    // Collecting again changes nothing.
    expect(await collectRankBatch(app.db, batch!.id, app.jobs.services)).toEqual({
      status: 'not_in_flight',
    });
    expect(await rankRows(app, a)).toHaveLength(1);
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
  });

  it('one batch in flight for each user; postings arriving meanwhile go in the next', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 2);
    await submit(app, a);
    await discover(app, a, 1, 3);
    expect(await submit(app, a)).toEqual({ status: 'in_flight' });
    fake!.end(1, succeeded(60));
    await collect(app, a);
    // Collecting queued the next submit for the one left waiting.
    expect(await submit(app, a)).toMatchObject({ status: 'submitted', requests: 1 });
    expect(fake!.sent.map((b) => b.requests.length)).toEqual([2, 1]);
  });

  it('Rank these joins the batch; at most 500 postings in one', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await writeDiscoveryBudget(app.db, ctxOf(a), 10_000);
    // The per-task daily limit bounds a batch too ($5 by default, about 240 requests here).
    await writeSetting(app.db, ctxOf(a), budgetKey(a.userId), { perTaskDailyUsd: 10_000 });
    // A first run sends 25 and holds the rest below the cut; Rank these sends them the same way.
    const src = await discover(app, a, 501);
    expect(await rankBelowCut(app.db, ctxOf(a), src, 1_000)).toBe(476);
    await app.jobs.drain();
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
    expect(await submit(app, a)).toMatchObject({ status: 'submitted', requests: 500 });
    expect(new Set(fake!.sentIds()).size).toBe(500);
  }, 60_000);
});

describe('through a crash at each step: sent once, scored once, costed once', () => {
  it('before the provider answers: the batch is failed after 15 minutes, and sent once', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    crashAt('rankBatch.before_submit');
    await expect(submit(app, a)).rejects.toThrow('crash');
    setRaceHook(undefined);
    expect(fake!.sent).toEqual([]);
    expect((await batchRows(app, a))[0]).toMatchObject({ state: 'submitting' });
    // Within the 15 minutes the batch is in flight: nothing more is sent.
    expect(await submit(app, a)).toEqual({ status: 'in_flight' });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect(await sweepRankBatches(app.db, undefined)).toMatchObject({ failed: 1 });
    const [r] = await results(app, a);
    expect(r).toMatchObject({ rankSkipReason: 'batch_waiting', rankBatchId: null });
    expect(await submit(app, a)).toMatchObject({ status: 'submitted' });
    fake!.end(1, succeeded(70));
    await collect(app, a);
    expect(fake!.sentIds()).toEqual([r!.id]);
    expect((await getResult(app.db, ctxOf(a), r!.id)).aiScore).toBe(70);
    expect(await rankRows(app, a)).toHaveLength(1);
  });

  it('after the provider answered, its id unsaved: one more send at most, and logged', async () => {
    const warn = vi.fn();
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    crashAt('rankBatch.provider_answered');
    await expect(submit(app, a)).rejects.toThrow('crash');
    setRaceHook(undefined);
    expect(fake!.sent).toHaveLength(1);
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const log = { warn } as unknown as Parameters<typeof sweepRankBatches>[1];
    await sweepRankBatches(app.db, log);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatch(/never confirmed as sent/);
    expect(await submit(app, a)).toMatchObject({ status: 'submitted' });
    expect(fake!.sent).toHaveLength(2);
    // The first is never collected (nothing knows its id); the second scores it, once.
    fake!.end(2, succeeded(65));
    await collect(app, a);
    const [r] = await results(app, a);
    expect(r!.aiScore).toBe(65);
    expect(await rankRows(app, a)).toHaveLength(1);
    expect(await submit(app, a)).toEqual({ status: 'nothing_waiting' });
    expect(fake!.sent).toHaveLength(2);
  });

  it('after the results are read, before any is applied: collected again, applied once', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 2);
    await submit(app, a);
    fake!.end(1, succeeded(55));
    crashAt('rankBatch.results_read');
    await expect(collect(app, a)).rejects.toThrow('crash');
    setRaceHook(undefined);
    expect((await results(app, a)).map((r) => r.aiScore)).toEqual([null, null]);
    expect(await rankRows(app, a)).toHaveLength(0);
    expect(await collect(app, a)).toMatchObject({ status: 'collected', ranked: 2 });
    expect((await results(app, a)).map((r) => r.aiScore)).toEqual([55, 55]);
    expect(await rankRows(app, a)).toHaveLength(2);
  });

  it('midway through applying: the rest are applied on the next collect, each once', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 3);
    await submit(app, a);
    fake!.end(1, succeeded(50));
    let applied = 0;
    setRaceHook((p) => {
      if (p === 'rankBatch.result_applied' && ++applied === 2) throw new Error('crash midway');
    });
    await expect(collect(app, a)).rejects.toThrow('crash midway');
    setRaceHook(undefined);
    expect((await results(app, a)).filter((r) => r.aiScore === 50)).toHaveLength(2);
    expect(await rankRows(app, a)).toHaveLength(2);
    // The hold is down to the one posting still linked.
    const [batch] = await batchRows(app, a);
    const ledger = (await rankRows(app, a)).reduce((n, r) => n + r.estCost, 0);
    expect(await discoverySpentTodayUsd(app.db, ctxOf(a))).toBeCloseTo(
      ledger + batch!.estCostUsd / 3,
      12,
    );
    expect(await collect(app, a)).toMatchObject({ status: 'collected', ranked: 1 });
    expect((await results(app, a)).map((r) => r.aiScore)).toEqual([50, 50, 50]);
    expect(await rankRows(app, a)).toHaveLength(3);
    expect(fake!.sent).toHaveLength(1);
  });
});

describe('a result that does not score the posting', () => {
  it('expired, canceled and an error put it back, and a later batch ranks it', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 4);
    await submit(app, a);
    const kinds = ['expired', 'canceled', 'errored', 'invalid'] as const;
    const kindOf = new Map(fake!.sent[0]!.requests.map((r, i) => [r.customId, kinds.at(i)!]));
    fake!.end(1, (r): BatchResultItem => {
      const kind = kindOf.get(r.customId)!;
      if (kind === 'errored' || kind === 'invalid') {
        return {
          customId: r.customId,
          kind: 'errored',
          invalidRequest: kind === 'invalid',
          detail: 'made up',
        };
      }
      return { customId: r.customId, kind };
    });
    expect(await collect(app, a)).toMatchObject({ status: 'collected', returned: 3, failed: 1 });
    expect(await rankRows(app, a)).toHaveLength(0);
    const byKind = new Map((await results(app, a)).map((r) => [kindOf.get(r.id)!, r] as const));
    for (const kind of ['expired', 'canceled', 'errored'] as const) {
      expect(byKind.get(kind)).toMatchObject({
        aiScore: null,
        rankSkipReason: 'batch_waiting',
        rankBatchId: null,
      });
      expect(byKind.get(kind)!.rankDeferredAt).not.toBeNull();
    }
    // A request the provider refused fails as a live ranking does, and waits no more.
    expect(byKind.get('invalid')).toMatchObject({
      rankSkipReason: 'provider_error',
      rankDeferredAt: null,
    });
    expect(await submit(app, a)).toMatchObject({ status: 'submitted', requests: 3 });
    fake!.end(2, succeeded(61));
    await collect(app, a);
    for (const kind of ['expired', 'canceled', 'errored'] as const) {
      expect((await getResult(app.db, ctxOf(a), byKind.get(kind)!.id)).aiScore).toBe(61);
    }
  });

  it('a batch the provider no longer has: its postings wait again, as if expired', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 2);
    await submit(app, a);
    fake!.forget(1);
    expect(await collect(app, a)).toEqual({ status: 'gone', returned: 2 });
    expect((await batchRows(app, a))[0]).toMatchObject({ state: 'failed' });
    for (const r of await results(app, a)) {
      expect(r).toMatchObject({ rankSkipReason: 'batch_waiting', rankBatchId: null });
    }
    expect(await submit(app, a)).toMatchObject({ status: 'submitted', requests: 2 });
  });

  it('an answer the schema refuses: invalid output, paid for, as a live call', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await submit(app, a);
    fake!.end(1, (r) => ({
      customId: r.customId,
      kind: 'succeeded',
      text: '{"score":170}',
      usage: USAGE,
    }));
    expect(await collect(app, a)).toMatchObject({ invalid_output: 1 });
    expect((await results(app, a))[0]).toMatchObject({
      aiScore: null,
      rankSkipReason: 'invalid_output',
      rankDeferredAt: null,
    });
    expect(await rankRows(app, a)).toMatchObject([{ status: 'error', error: 'invalid_output' }]);
  });

  it('a posting whose text changed during the batch gets no score from it', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await submit(app, a);
    const [r] = await results(app, a);
    await app.db
      .update(discoveryResults)
      .set({ posting: { ...r!.posting, descriptionMd: 'Own the platform, and the pager.' } })
      .where(eq(discoveryResults.id, r!.id))
      .run();
    fake!.end(1, succeeded(90));
    expect(await collect(app, a)).toMatchObject({ changed: 1, ranked: 0 });
    // Paid for, so costed; the posting waits for a later batch, with its new text.
    expect(await rankRows(app, a)).toHaveLength(1);
    expect(await getResult(app.db, ctxOf(a), r!.id)).toMatchObject({
      aiScore: null,
      rankSkipReason: 'batch_waiting',
      rankBatchId: null,
    });
    await submit(app, a);
    expect(fake!.sent[1]!.requests[0]!.request.system).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('and the pager') }),
      ]),
    );
  });

  it('a posting dismissed during the batch is left as it is: paid for and dropped', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await submit(app, a);
    const [r] = await results(app, a);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${r!.id}/dismiss`,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    fake!.end(1, succeeded(90));
    expect(await collect(app, a)).toMatchObject({ dropped: 1 });
    expect(await getResult(app.db, ctxOf(a), r!.id)).toMatchObject({
      aiScore: null,
      disposition: 'dismissed',
    });
    expect(await rankRows(app, a)).toHaveLength(1);
  });
});

describe('the budget with a batch in flight', () => {
  it('the estimate is held: live calls and tagging wait; collected, the real cost counts', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 2);
    expect(await submit(app, a)).toMatchObject({ requests: 2 });
    const [batch] = await batchRows(app, a);
    expect(batch!.estCostUsd).toBeGreaterThan(0);
    expect(await discoverySpentTodayUsd(app.db, ctxOf(a))).toBeCloseTo(batch!.estCostUsd, 12);
    // A budget the hold fills: no live ranking, no tagging, no second batch.
    await writeDiscoveryBudget(app.db, ctxOf(a), batch!.estCostUsd);
    expect(await rankBudgetHasRoom(app.db, ctxOf(a))).toBe(false);
    expect(await discoveryBudgetHasRoom(app.db, ctxOf(a))).toBe(false);
    fake!.end(1, succeeded(58));
    await collect(app, a);
    const ledger = (await rankRows(app, a)).reduce((n, r) => n + r.estCost, 0);
    expect(ledger).toBeGreaterThan(0);
    expect(await discoverySpentTodayUsd(app.db, ctxOf(a))).toBeCloseTo(ledger, 12);
    expect(await rankBudgetHasRoom(app.db, ctxOf(a))).toBe(true);
  });

  it('a batch takes only as many postings as the budget has room for; the rest keep waiting', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 3);
    // What one request is estimated at, from the first batch's own figure.
    expect(await submit(app, a)).toMatchObject({ requests: 3 });
    const one = (await batchRows(app, a))[0]!.estCostUsd / 3;
    await app.db.delete(rankBatches).run();
    await app.db
      .update(discoveryResults)
      .set({ rankBatchId: null, rankBatchBasis: null, rankBatchPromptId: null })
      .run();
    await writeDiscoveryBudget(app.db, ctxOf(a), one * 2.5);
    expect(await submit(app, a)).toMatchObject({ status: 'submitted', requests: 2 });
    const waiting = (await results(app, a)).filter(
      (r) => r.rankSkipReason === 'batch_waiting' && r.rankBatchId === null,
    );
    expect(waiting).toHaveLength(1);
  });

  it("the estimate: the request's size, and the output limit until 20 calls, then their average", async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    const history = async () => await rankOutputHistory(app.db, ctxOf(a));
    expect(await history()).toEqual({ outputTokens: null, calls: 0 });
    const row = (outputTokens: number, extra: Partial<typeof taskRuns.$inferInsert> = {}) =>
      app.db
        .insert(taskRuns)
        .values({
          id: newId(),
          userId: a.userId,
          taskKey: DISCOVERY_RANK_KIND,
          provider: 'anthropic',
          model: POLICY.model,
          inputTokens: 1_000,
          outputTokens,
          estCost: 0.01,
          durationMs: 1,
          status: 'ok',
          createdAt: Date.now(),
          ...extra,
        })
        .run();
    for (let i = 0; i < 19; i++) await row(i < 10 ? 100 : 121);
    // (10 x 100 + 9 x 121) / 19 = 109.9, rounded up: 19 calls, too few to be used yet.
    expect(await history()).toEqual({ outputTokens: 110, calls: 19 });
    await row(4_000, { status: 'error', error: 'invalid_output' });
    await row(4_000, { createdAt: Date.now() - 31 * 86_400_000 });
    await row(121);
    // (10 x 100 + 10 x 121) / 20 = 110.5, rounded up; the failed call and the one older than 30
    // days do not count.
    expect(await history()).toEqual({ outputTokens: 111, calls: 20 });
    await submit(app, a);
    const [batch] = await batchRows(app, a);
    const sent = fake!.sent[0]!.requests[0]!.request;
    expect(batch!.estCostUsd).toBeCloseTo(
      estimateBatchRequestUsd(POLICY, sent, { outputTokens: 111, calls: 20 }),
      12,
    );
    expect(batch!.estCostUsd).toBeLessThan(
      estimateBatchRequestUsd(POLICY, sent, { outputTokens: null, calls: 0 }),
    );
    // A batch result (half the price, the same tokens) does not move the estimate.
    fake!.end(1, (r) => ({
      customId: r.customId,
      kind: 'succeeded',
      text: JSON.stringify({ score: 50, rationale: 'Batched.', disqualifiers: [] }),
      usage: { ...USAGE, output: 111 },
    }));
    await collect(app, a);
    expect(await history()).toEqual({ outputTokens: 111, calls: 21 });
  });
});

describe('where a posting is ranked live with batching on', () => {
  it('no batch provider: a new posting and one already waiting are both ranked live', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    const [waiting] = await results(app, a);
    expect(waiting!.rankSkipReason).toBe('batch_waiting');
    // The provider in use has no batches now (as every one in this slice).
    fake = null;
    await discover(app, a, 1, 2);
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(1);
    expect(await submit(app, a)).toEqual({ status: 'no_batches', released: 1 });
    await app.jobs.drain();
    expect((await results(app, a)).map((r) => r.aiScore)).toEqual([40, 40]);
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(2);
  });

  it('Rank anyway ranks live, never in a batch', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    const [r] = await results(app, a);
    await app.db
      .update(discoveryResults)
      .set({ rankSkipReason: 'filtered', rankDeferredAt: null })
      .where(eq(discoveryResults.id, r!.id))
      .run();
    expect(await rankAnyway(app.db, ctxOf(a), r!.id)).toBe(1);
    await app.jobs.drain();
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(1);
    expect((await getResult(app.db, ctxOf(a), r!.id)).aiScore).toBe(40);
  });

  it('turning batching off hands the waiting postings to the live drain; one in flight is still collected', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await submit(app, a);
    await discover(app, a, 1, 2);
    await setRankBatching(app.db, ctxOf(a), false);
    await app.jobs.drain();
    const live = (await results(app, a)).filter((r) => r.aiScore === 40);
    expect(live).toHaveLength(1);
    fake!.end(1, succeeded(80));
    expect(await collect(app, a)).toMatchObject({ ranked: 1 });
    expect((await results(app, a)).map((r) => r.aiScore).sort()).toEqual([40, 80]);
  });

  it('a waiting posting with no key goes live and says AI is not set up', async () => {
    const { app, a } = await boot();
    await setRankBatching(app.db, ctxOf(a), true);
    // No key: no batch client, so the rank job ranks live, and the live call finds no key.
    vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
    await discover(app, a, 1);
    expect((await results(app, a))[0]).toMatchObject({ rankSkipReason: 'no_key' });
    expect(fake!.sent).toEqual([]);
  });

  it('the live drain never takes a posting waiting for a batch', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    const [r] = await results(app, a);
    expect(await setBatchWaiting(app.db, ctxOf(a), r!.id)).toBe(true);
    expect(await drainWaitingResults(app.db, ctxOf(a))).toEqual({
      ranked: 0,
      failed: 0,
      stopped: null,
    });
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
  });
});

// tl's review of https://github.com/bgoleno/opportun/pull/444 (issuecomment-6807650055) and sec's.
describe('a batch that cannot be collected (tl, blocking 1)', () => {
  const DAY = 86_400_000;

  it('29 days on, it ends though the provider keeps failing: its postings wait again, and a new batch is sent', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 2);
    await submit(app, a);
    fake!.stateError = new Error('401 from the provider');
    await expect(collect(app, a)).rejects.toThrow('401');
    vi.setSystemTime(Date.now() + 30 * DAY);
    const [batch] = await batchRows(app, a);
    expect(await collectRankBatch(app.db, batch!.id, app.jobs.services)).toEqual({
      status: 'gone',
      returned: 2,
    });
    for (const r of await results(app, a)) {
      expect(r).toMatchObject({ rankSkipReason: 'batch_waiting', rankBatchId: null });
    }
    fake!.stateError = null;
    expect(await submit(app, a)).toMatchObject({ status: 'submitted', requests: 2 });
  });

  it('the estimate is held for 24 hours from sending, not for as long as the batch is out', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await submit(app, a);
    const [batch] = await batchRows(app, a);
    vi.setSystemTime(Date.now() + 23 * 3_600_000);
    expect(await discoverySpentTodayUsd(app.db, ctxOf(a))).toBeCloseTo(batch!.estCostUsd, 12);
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    expect(await discoverySpentTodayUsd(app.db, ctxOf(a))).toBe(0);
  });

  it('a result that cannot be applied does not stop the others: it is logged, counted, and waits again', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 3);
    await submit(app, a);
    fake!.end(1, succeeded(52));
    let n = 0;
    setRaceHook((p) => {
      if (p === 'rankBatch.applying' && ++n === 2) throw new Error('one result fails');
    });
    const error = vi.fn();
    const log = { error, warn: vi.fn() } as unknown as NonNullable<typeof app.jobs.services.log>;
    const out = await collectRankBatch(app.db, (await batchRows(app, a))[0]!.id, {
      ...app.jobs.services,
      log,
    });
    setRaceHook(undefined);
    expect(out).toMatchObject({ status: 'collected', ranked: 2, errors: 1, returned: 1 });
    expect(error).toHaveBeenCalledTimes(1);
    const left = (await results(app, a)).filter((r) => r.aiScore === null);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ rankSkipReason: 'batch_waiting', rankBatchId: null });
    expect(await rankRows(app, a)).toHaveLength(2);
  });
});

describe("the rest of tl's blocking points", () => {
  it('no batch provider while a batch is in flight: the waiting postings still go live (blocking 2)', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await submit(app, a);
    await discover(app, a, 1, 2);
    fake = null;
    expect(await submit(app, a)).toEqual({ status: 'no_batches', released: 1 });
    await app.jobs.drain();
    expect((await results(app, a)).filter((r) => r.aiScore === 40)).toHaveLength(1);
  });

  it('where a live call would start, a batch takes at least its first posting (blocking 3)', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await writeDiscoveryBudget(app.db, ctxOf(a), 0.015);
    await discover(app, a, 2);
    expect(await rankBudgetHasRoom(app.db, ctxOf(a))).toBe(true);
    expect(await submit(app, a)).toMatchObject({ status: 'submitted', requests: 1 });
  });

  it('with the budget spent, no batch is sent', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await writeDiscoveryBudget(app.db, ctxOf(a), 0.015);
    await discover(app, a, 1);
    await app.db
      .insert(taskRuns)
      .values({
        id: newId(),
        userId: a.userId,
        taskKey: DISCOVERY_RANK_KIND,
        provider: 'anthropic',
        model: POLICY.model,
        inputTokens: 1,
        outputTokens: 1,
        estCost: 0.015,
        durationMs: 1,
        status: 'ok',
        createdAt: Date.now(),
      })
      .run();
    expect(await submit(app, a)).toEqual({ status: 'no_room', waiting: 1 });
  });

  it('the per-task daily limit bounds a batch as it stops a live call (blocking 4)', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await writeDiscoveryBudget(app.db, ctxOf(a), 100);
    await discover(app, a, 3);
    expect(await submit(app, a)).toMatchObject({ requests: 3 });
    const one = (await batchRows(app, a))[0]!.estCostUsd / 3;
    await app.db.delete(rankBatches).run();
    await writeSetting(app.db, ctxOf(a), budgetKey(a.userId), { perTaskDailyUsd: one * 2.5 });
    expect(await submit(app, a)).toMatchObject({ status: 'submitted', requests: 2 });
    // At the limit, nothing more, though the discovery budget has room.
    await writeSetting(app.db, ctxOf(a), budgetKey(a.userId), { perTaskDailyUsd: 0 });
    await app.db.delete(rankBatches).run();
    expect(await submit(app, a)).toMatchObject({ status: 'no_room' });
  });

  it('a posting deleted while its batch runs: the result is counted and logged, its cost not recorded (blocking 5)', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 2);
    await submit(app, a);
    const [gone] = await results(app, a);
    await app.db.delete(discoveryResults).where(eq(discoveryResults.id, gone!.id)).run();
    fake!.end(1, succeeded(70));
    const warn = vi.fn();
    const log = { warn, error: vi.fn() } as unknown as NonNullable<typeof app.jobs.services.log>;
    const out = await collectRankBatch(app.db, (await batchRows(app, a))[0]!.id, {
      ...app.jobs.services,
      log,
    });
    expect(out).toMatchObject({ status: 'collected', ranked: 1, unmatched: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatch(/not recorded/);
    expect(await rankRows(app, a)).toHaveLength(1);
  });
});

describe('the rules tl found untested (blocking 6)', () => {
  it('two sends at once make one batch: the in-flight check is made again under the lock', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 2);
    const [, second] = await results(app, a);
    let raced = false;
    setRaceHook(async (p) => {
      if (p !== 'rankBatch.before_create' || raced) return;
      raced = true;
      // The other send takes only the first posting: the second is out of the wait meanwhile.
      await app.db
        .update(discoveryResults)
        .set({ disposition: 'dismissed' })
        .where(eq(discoveryResults.id, second!.id))
        .run();
      expect(await submit(app, a)).toMatchObject({ status: 'submitted', requests: 1 });
      await app.db
        .update(discoveryResults)
        .set({ disposition: 'pending' })
        .where(eq(discoveryResults.id, second!.id))
        .run();
    });
    expect(await submit(app, a)).toEqual({ status: 'in_flight' });
    setRaceHook(undefined);
    expect(fake!.sent).toHaveLength(1);
    expect(await batchRows(app, a)).toHaveLength(1);
  });

  it('a posting the provider gave no result for waits again', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 2);
    await submit(app, a);
    const [first] = fake!.sent[0]!.requests;
    fake!.end(1, (r) => (r.customId === first!.customId ? succeeded(64)(r) : null));
    expect(await collect(app, a)).toMatchObject({ ranked: 1, returned: 1 });
    const waiting = (await results(app, a)).filter((r) => r.aiScore === null);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ rankSkipReason: 'batch_waiting', rankBatchId: null });
  });

  it('a send the provider refuses fails the batch and puts its postings back', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 2);
    fake!.submitError = new Error('400 from the provider');
    expect(await submit(app, a)).toEqual({ status: 'provider_error', returned: 2 });
    expect((await batchRows(app, a))[0]).toMatchObject({ state: 'failed' });
    for (const r of await results(app, a)) {
      expect(r).toMatchObject({ rankSkipReason: 'batch_waiting', rankBatchId: null });
    }
    fake!.submitError = null;
    expect(await submit(app, a)).toMatchObject({ status: 'submitted', requests: 2 });
  });

  it('a send queued before batching was turned off hands the wait to live ranking', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await writeRankBatching(app.db, ctxOf(a), false);
    expect(await submit(app, a)).toEqual({ status: 'off', released: 1 });
    await app.jobs.drain();
    expect((await results(app, a))[0]!.aiScore).toBe(40);
  });

  it('the sweep queues a collect when one is due, and not again before the next look', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await submit(app, a);
    const collects = () =>
      app.db.select().from(jobs).where(eq(jobs.kind, RANK_BATCH_COLLECT_KIND)).all();
    expect(await sweepRankBatches(app.db, undefined)).toEqual({ failed: 0, collect: 1 });
    await collect(app, a);
    await app.db.delete(jobs).where(eq(jobs.kind, RANK_BATCH_COLLECT_KIND)).run();
    expect(await sweepRankBatches(app.db, undefined)).toEqual({ failed: 0, collect: 0 });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(await sweepRankBatches(app.db, undefined)).toEqual({ failed: 0, collect: 1 });
    expect(await collects()).toHaveLength(1);
  });

  it('with no key now, collecting is tried again later and the batch stays sent', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await submit(app, a);
    await app.db.delete(secrets).where(eq(secrets.userId, a.userId)).run();
    expect(await collect(app, a)).toEqual({ status: 'no_client' });
    expect((await batchRows(app, a))[0]).toMatchObject({ state: 'submitted' });
    expect((await results(app, a))[0]!.rankBatchId).not.toBeNull();
  });

  it("the estimate's history reads discovery.rank's calls only", async () => {
    const { app, a } = await boot();
    for (let i = 0; i < 25; i++) {
      await app.db
        .insert(taskRuns)
        .values({
          id: newId(),
          userId: a.userId,
          taskKey: 'company.suggest',
          provider: 'anthropic',
          model: POLICY.model,
          inputTokens: 1,
          outputTokens: 900,
          estCost: 0.01,
          durationMs: 1,
          status: 'ok',
          createdAt: Date.now(),
        })
        .run();
    }
    expect(await rankOutputHistory(app.db, ctxOf(a))).toEqual({ outputTokens: null, calls: 0 });
  });

  it('Rank anyway stays live through lead resolution', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    const [r] = await results(app, a);
    await app.db
      .update(discoveryResults)
      .set({ rankSkipReason: 'filtered', rankDeferredAt: null, resolution: 'needs_capture' })
      .where(eq(discoveryResults.id, r!.id))
      .run();
    expect(await rankAnyway(app.db, ctxOf(a), r!.id)).toBe(1);
    await app.jobs.drain();
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(1);
    expect((await getResult(app.db, ctxOf(a), r!.id)).aiScore).toBe(40);
  });

  it('a batch result keeps the multi-posted cap', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    const [r] = await results(app, a);
    await app.db
      .update(discoveryResults)
      .set({ aiRationale: `${MULTI_POSTED_PREFIX} earlier` })
      .where(eq(discoveryResults.id, r!.id))
      .run();
    await submit(app, a);
    fake!.end(1, succeeded(95));
    await collect(app, a);
    const { MULTI_POSTED_SCORE_CAP } = await import('../src/jobs/discoveryKinds');
    expect((await getResult(app.db, ctxOf(a), r!.id)).aiScore).toBe(MULTI_POSTED_SCORE_CAP);
  });

  it('after a collect, a send is queued for the postings still waiting', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await submit(app, a);
    await discover(app, a, 1, 2);
    await app.db.delete(jobs).where(eq(jobs.kind, RANK_BATCH_SEND_KIND)).run();
    fake!.end(1, succeeded(60));
    await collect(app, a);
    const sends = await app.db.select().from(jobs).where(eq(jobs.kind, RANK_BATCH_SEND_KIND)).all();
    expect(sends).toHaveLength(1);
  });

  it('the hourly waiting sweep queues a send for a user with postings waiting for a batch', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await app.db.delete(jobs).where(eq(jobs.kind, RANK_BATCH_SEND_KIND)).run();
    await sweepWaitingResults(app.db);
    const sends = await app.db.select().from(jobs).where(eq(jobs.kind, RANK_BATCH_SEND_KIND)).all();
    expect(sends.map((j) => j.userId)).toEqual([a.userId]);
  });
});

describe("tl's smaller points", () => {
  it('a batch whose id was saved while it was being failed as stuck is not failed', async () => {
    const { app, a } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    crashAt('rankBatch.provider_answered');
    await expect(submit(app, a)).rejects.toThrow('crash');
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const [batch] = await batchRows(app, a);
    setRaceHook(async (p) => {
      if (p === 'rankBatch.stale_listed') {
        await markBatchSubmitted(app.db, batch!.id, fake!.sent[0]!.batchId);
      }
    });
    await sweepRankBatches(app.db, undefined);
    setRaceHook(undefined);
    expect((await batchRows(app, a))[0]).toMatchObject({ state: 'submitted' });
    expect((await results(app, a))[0]!.rankBatchId).toBe(batch!.id);
  });

  it("a collect job for another user's batch does nothing", async () => {
    const { app, a, b } = await boot();
    await batching(app, a);
    await discover(app, a, 1);
    await submit(app, a);
    fake!.end(1, succeeded(60));
    const [batch] = await batchRows(app, a);
    expect(
      await collectRankBatch(app.db, batch!.id, app.jobs.services, { userId: b.userId }),
    ).toEqual({ status: 'not_in_flight' });
    expect((await results(app, a))[0]!.aiScore).toBeNull();
  });
});

describe('two users batching (sec)', () => {
  it("each has their own batch; one's in flight neither delays nor counts against the other's; collecting one leaves the other's rows alone", async () => {
    const { app, a, b } = await boot();
    await batching(app, a);
    await batching(app, b);
    await discover(app, a, 1);
    await discover(app, b, 1, 2);
    expect(await submit(app, a)).toMatchObject({ status: 'submitted', requests: 1 });
    expect(await submit(app, b)).toMatchObject({ status: 'submitted', requests: 1 });
    const [batchA] = await batchRows(app, a);
    const [batchB] = await batchRows(app, b);
    expect(fake!.sentIds()).toHaveLength(2);
    expect(await discoverySpentTodayUsd(app.db, ctxOf(a))).toBeCloseTo(batchA!.estCostUsd, 12);
    expect(await discoverySpentTodayUsd(app.db, ctxOf(b))).toBeCloseTo(batchB!.estCostUsd, 12);
    const [ra] = await results(app, a);
    const [rb] = await results(app, b);
    // a's batch's answer names b's posting too.
    fake!.answer(1, [
      {
        customId: ra!.id,
        kind: 'succeeded',
        text: JSON.stringify({ score: 61, rationale: 'A.', disqualifiers: [] }),
        usage: USAGE,
      },
      {
        customId: rb!.id,
        kind: 'succeeded',
        text: JSON.stringify({ score: 99, rationale: 'B.', disqualifiers: [] }),
        usage: USAGE,
      },
    ]);
    await collectRankBatch(app.db, batchA!.id, app.jobs.services);
    expect((await getResult(app.db, ctxOf(a), ra!.id)).aiScore).toBe(61);
    expect(await getResult(app.db, ctxOf(b), rb!.id)).toMatchObject({
      aiScore: null,
      rankBatchId: batchB!.id,
    });
    expect(await rankRows(app, b)).toHaveLength(0);
    expect((await batchRows(app, b))[0]).toMatchObject({ state: 'submitted' });
    expect(await discoverySpentTodayUsd(app.db, ctxOf(b))).toBeCloseTo(batchB!.estCostUsd, 12);
  });

  it("each read and write of a posting's batch state is scoped to its user", async () => {
    const { app, a, b } = await boot();
    await batching(app, a);
    await batching(app, b);
    await discover(app, a, 1);
    await discover(app, b, 1, 2);
    const asA = ctxOf(a);
    const [rb] = await results(app, b);
    // Waiting and in no batch yet: a's list has its own posting only.
    expect(await listBatchWaitingIds(app.db, asA)).toEqual(
      (await results(app, a)).map((r) => r.id),
    );
    await submit(app, b);
    const [batchB] = await batchRows(app, b);
    const before = await getResult(app.db, ctxOf(b), rb!.id);
    expect(await hasResult(app.db, asA, rb!.id)).toBe(false);
    expect(await setBatchWaiting(app.db, asA, rb!.id)).toBe(false);
    expect(await takeBatchLink(app.db, asA, batchB!.id, rb!.id)).toBeUndefined();
    expect(await unlinkBatch(app.db, asA, batchB!.id, { batching: false })).toBe(0);
    await endBatchWait(app.db, asA, rb!.id, 'provider_error');
    await releaseBatchWaiting(app.db, asA);
    expect(await getResult(app.db, ctxOf(b), rb!.id)).toEqual(before);
  });

  it("a user's batches go with the user; a posting's link goes with its batch", async () => {
    const { app, a, b } = await boot();
    await batching(app, a);
    await batching(app, b);
    await discover(app, a, 1);
    await discover(app, b, 1, 2);
    await submit(app, a);
    await submit(app, b);
    await app.db.delete(users).where(eq(users.id, b.userId)).run();
    expect(await batchRows(app, b)).toEqual([]);
    const [batchA] = await batchRows(app, a);
    await app.db.delete(rankBatches).where(eq(rankBatches.id, batchA!.id)).run();
    expect((await results(app, a))[0]!.rankBatchId).toBeNull();
  });
});
