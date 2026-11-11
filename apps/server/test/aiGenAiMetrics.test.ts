// The Gen AI metrics (design.md 14.2, 14.4; https://github.com/bgoleno/opportun/issues/344, FR-T4
// part 2). They come from the record the server writes to task_runs, so the two cannot
// disagree: the same tokens, the same duration and the same estimated cost. Each point is the
// user's (14.7). A zero is not recorded, and a call refused before the provider records only its
// duration, with its reason as error.type.
import { AiUnavailableError, runStructured, type ModelPolicy } from '@opportun/ai';
import { MockLanguageModelV4 } from 'ai/test';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLanguageModel } from '../../../packages/ai/src/providers';
import { obsMetricPoints, taskRuns } from '../src/db/schema';
import { buildAiDeps } from '../src/lib/ai';
import { flushNow, setCollecting } from '../src/obs';
import { MINUTE_MS } from '../src/obs/metrics';
import { useApi } from './api';
import { countRows, queryOne } from './db';

vi.mock('../../../packages/ai/src/providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/ai/src/providers')>();
  return { ...real, createLanguageModel: vi.fn() };
});

const boot = useApi();
type App = Awaited<ReturnType<typeof boot>>['app'];
const KEY = 'sk-ant-test-THIS-IS-A-SECRET-0123456789';

function ok(input: number, output: number) {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text' as const, text: '{"label":"x"}' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: output, text: output, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

const call = { system: 's', prompt: 'p', schema: z.object({ label: z.string() }) };

beforeEach(() => {
  vi.mocked(createLanguageModel).mockReset();
});

afterEach(async () => {
  await setCollecting(false);
});

async function points(app: App, userId: string) {
  const rows = await app.db
    .select()
    .from(obsMetricPoints)
    .where(and(eq(obsMetricPoints.resolution, MINUTE_MS), eq(obsMetricPoints.userId, userId)))
    .all();
  return new Map(rows.map((r) => [r.metric, r]));
}

async function depsFor(app: App, userId: string, overrides?: { policy?: ModelPolicy }) {
  const deps = await buildAiDeps(app.db, { userId, isAdmin: false });
  deps.getKey = async () => KEY;
  if (overrides?.policy !== undefined) {
    const policy = overrides.policy;
    deps.policyFor = async () => policy;
  }
  return deps;
}

describe('the Gen AI metrics (#344)', () => {
  it('a call records duration, input and output tokens and cost, each the same as its task_runs row', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    vi.mocked(createLanguageModel).mockReturnValue(ok(1000, 100));
    await runStructured(await depsFor(app, a.userId), 'comms.classify', call);
    await flushNow();

    const run = (await queryOne(app, 'SELECT * FROM task_runs WHERE user_id = ?', a.userId)) as {
      input_tokens: number;
      output_tokens: number;
      est_cost: number;
      duration_ms: number;
      model: string;
    };
    const got = await points(app, a.userId);
    const base = {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'opportun.ai.provider': 'anthropic',
      'gen_ai.request.model': run.model,
      'opportun.ai.task': 'comms.classify',
      'opportun.ai.feature': 'mail',
    };
    expect(got.get('gen_ai.client.inference.duration')).toMatchObject({
      attributes: base,
      count: 1,
    });
    expect(got.get('gen_ai.client.inference.duration')!.sum).toBeCloseTo(run.duration_ms / 1000, 9);
    expect(got.get('gen_ai.client.inference.usage.input_tokens')).toMatchObject({
      attributes: { ...base, 'gen_ai.token.modality': 'text' },
      sum: run.input_tokens,
    });
    expect(got.get('gen_ai.client.inference.usage.output_tokens')).toMatchObject({
      attributes: { ...base, 'gen_ai.token.modality': 'text' },
      sum: run.output_tokens,
    });
    expect(got.get('opportun.gen_ai.usage.cost')).toMatchObject({
      attributes: { ...base, 'opportun.ai.cost.estimated': false },
    });
    expect(got.get('opportun.gen_ai.usage.cost')!.sum).toBeCloseTo(run.est_cost, 12);
    expect(run.est_cost).toBeGreaterThan(0);
  });

  it('a call refused before the provider records its duration with error.type, and no tokens or cost', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    const deps = await depsFor(app, a.userId);
    deps.getKey = async () => {
      throw new AiUnavailableError('no_key');
    };
    await expect(runStructured(deps, 'comms.classify', call)).rejects.toMatchObject({
      reason: 'no_key',
    });
    await flushNow();
    const got = await points(app, a.userId);
    expect([...got.keys()]).toEqual(['gen_ai.client.inference.duration']);
    expect(got.get('gen_ai.client.inference.duration')!.attributes).toMatchObject({
      'error.type': 'no_key',
    });
  });

  it('a model priced by the fallback says so; a gateway is openai on the wire; a zero is not recorded', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    vi.mocked(createLanguageModel).mockReturnValue(ok(500, 0));
    const policy: ModelPolicy = {
      provider: 'openai_compatible',
      model: 'llama-local',
      maxOutputTokens: 100,
      baseUrl: 'https://llm.example.com/v1',
    };
    await runStructured(await depsFor(app, a.userId, { policy }), 'comms.classify', call);
    await flushNow();
    const got = await points(app, a.userId);
    expect(got.get('opportun.gen_ai.usage.cost')!.attributes).toMatchObject({
      'gen_ai.provider.name': 'openai',
      'opportun.ai.provider': 'openai_compatible',
      'gen_ai.request.model': 'llama-local',
      'opportun.ai.cost.estimated': true,
    });
    expect(got.has('gen_ai.client.inference.usage.input_tokens')).toBe(true);
    expect(got.has('gen_ai.client.inference.usage.output_tokens')).toBe(false);
  });

  it('are the caller’s own: another user’s call is not counted as theirs', async () => {
    const { app, a, b } = await boot();
    await setCollecting(true);
    vi.mocked(createLanguageModel).mockReturnValue(ok(10, 5));
    await runStructured(await depsFor(app, b.userId), 'comms.classify', call);
    await flushNow();
    expect((await points(app, a.userId)).size).toBe(0);
    expect((await points(app, b.userId)).size).toBe(4);
  });

  it('with collection off, nothing is recorded, and task_runs is written as before', async () => {
    const { app, a } = await boot();
    vi.mocked(createLanguageModel).mockReturnValue(ok(10, 5));
    await runStructured(await depsFor(app, a.userId), 'comms.classify', call);
    await flushNow();
    expect((await points(app, a.userId)).size).toBe(0);
    expect(await countRows(app, taskRuns)).toBe(1);
  });

  it('the server passes the caller as the user of its AI calls (AiDeps.userId)', async () => {
    const { app, a } = await boot();
    expect((await buildAiDeps(app.db, { userId: a.userId, isAdmin: false })).userId).toBe(a.userId);
  });
});
