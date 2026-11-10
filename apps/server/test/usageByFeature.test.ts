// Settings > AI > Usage by feature (https://github.com/bgoleno/opportun/issues/341): GET /ai/usage
// groups the caller's task_runs by the feature each task belongs to (TASK_FEATURE), lists every
// feature and every task with zeros where nothing ran, and sums the cost recorded at the time of
// each call, so a price changed later does not change what an old call cost.
import { newId } from '@opportun/core';
import { FEATURES, runStructured, tasksOfFeature } from '@opportun/ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { estimateCost } from '../../../packages/ai/src/pricing';
import { createLanguageModel } from '../../../packages/ai/src/providers';
import { buildAiDeps } from '../src/lib/ai';
import { taskRuns } from '../src/db/schema';
import { useApi } from './api';

// The provider is always mocked: no network calls and no real keys in tests.
vi.mock('../../../packages/ai/src/providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/ai/src/providers')>();
  return { ...real, createLanguageModel: vi.fn() };
});
// The price estimate the router records with each call. It is the real one until a test changes
// the price table under it (below).
vi.mock('../../../packages/ai/src/pricing', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/ai/src/pricing')>();
  return { ...real, estimateCost: vi.fn(real.estimateCost) };
});

const boot = useApi();
const DAY = 86_400_000;

interface Metrics {
  runs: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  estimated: boolean;
}
interface ModelUsage extends Metrics {
  provider: string;
  model: string;
}
interface TaskUsage extends Metrics {
  taskKey: string;
  models: ModelUsage[];
}
interface FeatureUsage extends Metrics {
  feature: string;
  label: string;
  tasks: TaskUsage[];
}

const ZERO = {
  runs: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  estCostUsd: 0,
  estimated: false,
};

type App = Awaited<ReturnType<typeof boot>>['app'];

async function insertRun(
  app: App,
  r: {
    userId: string;
    taskKey: string;
    at: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    model?: string;
    status?: 'ok' | 'error';
    fallback?: boolean;
  },
) {
  // Through drizzle, so the boolean binds on both SQLite and Postgres.
  await app.db
    .insert(taskRuns)
    .values({
      id: newId(),
      userId: r.userId,
      taskKey: r.taskKey,
      provider: 'anthropic',
      model: r.model ?? 'claude-haiku-5-5',
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      estCost: r.cost,
      fallbackPricing: r.fallback === true,
      durationMs: 10,
      status: r.status ?? 'ok',
      error: r.status === 'error' ? 'provider_error' : null,
      createdAt: r.at,
    })
    .run();
}

async function features(
  c: { request: (r: never) => Promise<{ statusCode: number; json: () => unknown }> },
  days?: number,
): Promise<FeatureUsage[]> {
  const url = days === undefined ? '/api/v1/ai/usage' : `/api/v1/ai/usage?days=${days}`;
  const res = await (
    c.request as (r: unknown) => Promise<{ statusCode: number; json: () => unknown }>
  )({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  return (res.json() as { features: FeatureUsage[] }).features;
}

const byFeature = (list: FeatureUsage[], key: string): FeatureUsage => {
  const f = list.find((x) => x.feature === key);
  if (f === undefined) throw new Error(`no feature ${key}`);
  return f;
};
const byTask = (f: FeatureUsage, key: string): TaskUsage => {
  const t = f.tasks.find((x) => x.taskKey === key);
  if (t === undefined) throw new Error(`no task ${key}`);
  return t;
};

// Anchor fixtures at 12:00 UTC today so day buckets never straddle midnight.
const noon = () => new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00Z').getTime();

describe('GET /ai/usage: by feature (#341)', () => {
  it('with no runs, lists every feature and every task, all zero', async () => {
    const { a } = await boot();
    const list = await features(a);
    expect(list.map((f) => f.feature)).toEqual(FEATURES.map((f) => f.key));
    expect(list.map((f) => f.label)).toEqual(FEATURES.map((f) => f.label));
    for (const f of list) {
      expect(f, f.feature).toMatchObject(ZERO);
      expect(
        f.tasks.map((t) => t.taskKey),
        f.feature,
      ).toEqual(tasksOfFeature(f.feature as never));
      for (const t of f.tasks) {
        expect(t, t.taskKey).toMatchObject(ZERO);
        expect(t.models, t.taskKey).toEqual([]);
      }
    }
  });

  it("groups the caller's runs by feature, task and model, with zeros for the rest", async () => {
    const { app, a, b } = await boot();
    const now = noon();
    const run = (taskKey: string, extra: Partial<Parameters<typeof insertRun>[1]> = {}) =>
      insertRun(app, {
        userId: a.userId,
        taskKey,
        at: now - 1000,
        inputTokens: 100,
        outputTokens: 10,
        cost: 0.01,
        ...extra,
      });
    await run('comms.classify');
    await run('comms.classify', {
      status: 'error',
      inputTokens: 200,
      outputTokens: 20,
      cost: 0.02,
    });
    await run('comms.classify', { at: now - DAY, model: 'claude-sonnet-5-5', cost: 0.05 });
    await run('comms.triage', { inputTokens: 40, outputTokens: 1, cost: 0.001, fallback: true });
    await run('resume.match', { inputTokens: 1000, outputTokens: 300, cost: 0.5 });
    await run('resume.match', { at: now - 40 * DAY, inputTokens: 9999, cost: 99 }); // outside 30 days
    await insertRun(app, {
      userId: b.userId,
      taskKey: 'comms.classify',
      at: now - 1000,
      inputTokens: 7777,
      outputTokens: 7777,
      cost: 7,
    });

    const list = await features(a, 30);
    // Every feature is listed, in order, whether or not it ran.
    expect(list.map((f) => f.feature)).toEqual(FEATURES.map((f) => f.key));

    const mail = byFeature(list, 'mail');
    expect(mail).toMatchObject({
      label: 'Mail',
      runs: 4,
      errors: 1,
      inputTokens: 440,
      outputTokens: 41,
      estimated: true,
    });
    expect(mail.estCostUsd).toBeCloseTo(0.081);
    expect(mail.tasks.map((t) => t.taskKey)).toEqual(['comms.triage', 'comms.classify']);

    const classify = byTask(mail, 'comms.classify');
    expect(classify).toMatchObject({
      runs: 3,
      errors: 1,
      inputTokens: 400,
      outputTokens: 40,
      estimated: false,
    });
    expect(classify.estCostUsd).toBeCloseTo(0.08);
    // One row per model the task used, by model name.
    expect(classify.models.map((m) => [m.provider, m.model, m.runs])).toEqual([
      ['anthropic', 'claude-haiku-5-5', 2],
      ['anthropic', 'claude-sonnet-5-5', 1],
    ]);
    expect(classify.models[0]!.estCostUsd).toBeCloseTo(0.03);
    expect(byTask(mail, 'comms.triage')).toMatchObject({ runs: 1, estimated: true });

    const matching = byFeature(list, 'matching');
    expect(matching).toMatchObject({ runs: 1, inputTokens: 1000, outputTokens: 300 });
    expect(matching.estCostUsd).toBeCloseTo(0.5);

    // A feature and a task that never ran: zero rows, not missing ones.
    const discovery = byFeature(list, 'discovery');
    expect(discovery).toMatchObject(ZERO);
    expect(byTask(discovery, 'discovery.rank')).toMatchObject({ ...ZERO, models: [] });
    expect(byTask(mail, 'comms.triage').models).toHaveLength(1);

    // The features add up to the per-task totals, and b's run is not a's.
    const res = await a.request({ method: 'GET', url: '/api/v1/ai/usage?days=30' });
    const body = res.json() as { totals: Metrics[] };
    const sum = (xs: Metrics[]) => xs.reduce((n, x) => n + x.runs, 0);
    expect(sum(list)).toBe(sum(body.totals));
    expect(res.body).not.toContain('7777');
  });

  it('counts only the chosen window: 7, 30 or 90 days', async () => {
    const { app, a } = await boot();
    const now = noon();
    for (const ago of [0, 10, 60, 120]) {
      await insertRun(app, {
        userId: a.userId,
        taskKey: 'resume.tailor',
        at: now - ago * DAY,
        inputTokens: 1,
        outputTokens: 1,
        cost: 1,
      });
    }
    const runs = async (days: number) =>
      byFeature(await features(a, days), 'resume_tailoring').runs;
    expect(await runs(7)).toBe(1);
    expect(await runs(30)).toBe(2);
    expect(await runs(90)).toBe(3);
  });

  it('a run of a task no longer registered is counted under Other, not dropped', async () => {
    const { app, a } = await boot();
    await insertRun(app, {
      userId: a.userId,
      taskKey: 'retired.task',
      at: noon(),
      inputTokens: 5,
      outputTokens: 5,
      cost: 0.25,
    });
    const list = await features(a);
    const other = list.at(-1)!;
    expect(other).toMatchObject({ feature: 'other', label: 'Other', runs: 1, inputTokens: 5 });
    expect(other.tasks.map((t) => t.taskKey)).toEqual(['retired.task']);
    expect(list).toHaveLength(FEATURES.length + 1);
  });
});

// ---------------------------------------------------------------------------
// The cost is the one recorded at the time of the call (criterion 2).

const KEY = 'sk-test-THIS-IS-A-SECRET-0123456789';

function ok(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 100, text: 100, reasoning: 0 },
    },
    warnings: [],
  };
}
const call = { system: 's', prompt: 'p', schema: z.object({ label: z.string() }) };

describe('GET /ai/usage: the price at the time of the call (#341)', () => {
  beforeEach(async () => {
    vi.mocked(createLanguageModel).mockReset();
    const real = await vi.importActual<typeof import('../../../packages/ai/src/pricing')>(
      '../../../packages/ai/src/pricing',
    );
    vi.mocked(estimateCost).mockImplementation(real.estimateCost);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('network disabled')));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function setUp() {
    const { app, a } = await boot();
    const added = await a.request({
      method: 'POST',
      url: '/api/v1/secrets',
      payload: { kind: 'ai_api_key', label: 'openai', value: KEY },
    });
    expect(added.statusCode).toBe(201);
    const put = await a.request({
      method: 'PUT',
      url: '/api/v1/ai/policies/comms.classify',
      payload: { provider: 'openai', model: 'gpt-5.4-mini', maxOutputTokens: 500 },
    });
    expect(put.statusCode).toBe(200);
    vi.mocked(createLanguageModel).mockReturnValue(
      new MockLanguageModelV4({ doGenerate: ok('{"label":"x"}') }),
    );
    const classify = async () =>
      await runStructured(
        await buildAiDeps(app.db, { userId: a.userId, isAdmin: false }),
        'comms.classify',
        call,
      );
    const mailCost = async () => byFeature(await features(a), 'mail').estCostUsd;
    return { a, classify, mailCost };
  }

  it('a price table changed after a run does not change what the run cost', async () => {
    const { classify, mailCost } = await setUp();
    await classify();
    // 1000 input at $0.75/MTok + 100 output at $4.50/MTok, the listed gpt-5.4-mini price.
    expect(await mailCost()).toBeCloseTo(0.0012, 8);

    // The table now lists the model at 100 times the price.
    const real = await vi.importActual<typeof import('../../../packages/ai/src/pricing')>(
      '../../../packages/ai/src/pricing',
    );
    vi.mocked(estimateCost).mockImplementation((provider, model, input, output) =>
      real.estimateCost(provider, model, input, output, {
        inputUsdPerMTok: 75,
        outputUsdPerMTok: 450,
      }),
    );
    expect(await mailCost()).toBeCloseTo(0.0012, 8);

    // A new call is charged the new price, and the old one keeps its own.
    await classify();
    expect(await mailCost()).toBeCloseTo(0.0012 + 0.12, 8);
  });

  it("a policy's own price changed after a run does not change what the run cost", async () => {
    const { a, classify, mailCost } = await setUp();
    const price = async (input: number, output: number) => {
      const res = await a.request({
        method: 'PUT',
        url: '/api/v1/ai/policies/comms.classify',
        payload: {
          provider: 'openai',
          model: 'gpt-5.4-mini',
          maxOutputTokens: 500,
          inputUsdPerMTok: input,
          outputUsdPerMTok: output,
        },
      });
      expect(res.statusCode).toBe(200);
    };
    await price(1, 10);
    await classify();
    // 1000 input at $1/MTok + 100 output at $10/MTok.
    expect(await mailCost()).toBeCloseTo(0.002, 8);
    await price(100, 1000);
    expect(await mailCost()).toBeCloseTo(0.002, 8);
    await classify();
    expect(await mailCost()).toBeCloseTo(0.002 + 0.2, 8);
  });
});
