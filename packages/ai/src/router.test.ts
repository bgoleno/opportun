import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { resolvePolicy, DEFAULT_POLICIES } from './policies';
import { estimateCostUsd, FALLBACK_PRICE } from './pricing';
import { createLanguageModel } from './providers';
import { runStructured, streamChat } from './router';
import {
  AiUnavailableError,
  type AiDeps,
  type ModelPolicy,
  type TaskKey,
  type TaskRunRecord,
} from './types';

// Every test runs against a mocked provider: no network, no real keys.
vi.mock('./providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('./providers')>();
  return { ...real, createLanguageModel: vi.fn() };
});

const KEY = 'sk-test-SECRET-key-0123456789';
// createLanguageModel is mocked entirely in this file (see vi.mock('./providers') above), so
// this never actually fetches; it only needs a stable reference the toHaveBeenCalledWith
// assertions below can check prepare() actually threaded through.
const PROVIDER_FETCH = {
  fetch: (() => Promise.reject(new Error('unused: createLanguageModel is mocked'))) as typeof fetch,
  allowLoopbackHttp: false,
};

function result(text: string, input = 100, output = 50): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: output, text: output, reasoning: 0 },
    },
    warnings: [],
  };
}

interface Harness {
  deps: AiDeps;
  runs: TaskRunRecord[];
  model: MockLanguageModelV4;
  getKey: ReturnType<typeof vi.fn>;
}

function harness(
  opts: {
    model?: MockLanguageModelV4;
    overrides?: Partial<Record<TaskKey, ModelPolicy>>;
    spent?: number;
    perTaskDailyUsd?: number;
    hasKey?: boolean;
  } = {},
): Harness {
  const runs: TaskRunRecord[] = [];
  const model = opts.model ?? new MockLanguageModelV4({ doGenerate: result('{"score":1}') });
  vi.mocked(createLanguageModel).mockReturnValue(model);
  const getKey = vi.fn(async (provider: string) => {
    expect(typeof provider).toBe('string');
    if (opts.hasKey === false) throw new AiUnavailableError('no_key');
    return KEY;
  });
  const deps: AiDeps = {
    getKey,
    policyFor: async (task) =>
      resolvePolicy(task, new Map(Object.entries(opts.overrides ?? {})).get(task)),
    record: async (run) => {
      runs.push(run);
    },
    budget: { perTaskDailyUsd: opts.perTaskDailyUsd ?? 5 },
    spentTodayUsd: async () => opts.spent ?? 0,
    providerFetch: PROVIDER_FETCH,
  };
  return { deps, runs, model, getKey };
}

const Score = z.object({ score: z.number() });
const call = { system: 'sys', prompt: 'hello', schema: Score };

beforeEach(() => {
  vi.mocked(createLanguageModel).mockReset();
});

describe('policy resolution', () => {
  it('uses the default policy when the user has no override', async () => {
    const h = harness();
    await runStructured(h.deps, 'resume.match', call);
    expect(vi.mocked(createLanguageModel)).toHaveBeenCalledWith(
      DEFAULT_POLICIES['resume.match'],
      KEY,
      PROVIDER_FETCH,
    );
    expect(h.runs[0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it('a user override beats the default', async () => {
    const override: ModelPolicy = { provider: 'openai', model: 'gpt-5.5', maxOutputTokens: 2000 };
    const h = harness({ overrides: { 'resume.match': override } });
    await runStructured(h.deps, 'resume.match', call);
    expect(vi.mocked(createLanguageModel)).toHaveBeenCalledWith(override, KEY, PROVIDER_FETCH);
    expect(h.getKey).toHaveBeenCalledWith('openai');
    expect(h.runs[0]).toMatchObject({ provider: 'openai', model: 'gpt-5.5' });
    // The override does not leak into other tasks.
    expect(resolvePolicy('discovery.rank', undefined)).toEqual(DEFAULT_POLICIES['discovery.rank']);
  });

  it('an openai run with a listed model records a nonzero list-price cost', async () => {
    const policy: ModelPolicy = { provider: 'openai', model: 'gpt-5.4-mini', maxOutputTokens: 500 };
    const h = harness({ overrides: { 'comms.classify': policy } });
    await runStructured(h.deps, 'comms.classify', call);
    expect(h.runs[0]).toMatchObject({ provider: 'openai', fallbackPricing: false });
    expect(h.runs[0]!.estCostUsd).toBeCloseTo(estimateCostUsd('openai', 'gpt-5.4-mini', 100, 50));
    expect(h.runs[0]!.estCostUsd).toBeGreaterThan(0);
  });

  it('an unlisted model id records the fallback cost and is flagged', async () => {
    const policy: ModelPolicy = {
      provider: 'openai_compatible',
      model: 'llama-local',
      maxOutputTokens: 500,
      baseUrl: 'http://localhost:11434/v1',
    };
    const h = harness({ overrides: { 'comms.classify': policy } });
    await runStructured(h.deps, 'comms.classify', call);
    const expected =
      (100 * FALLBACK_PRICE.inputPerMTok + 50 * FALLBACK_PRICE.outputPerMTok) / 1_000_000;
    expect(h.runs[0]).toMatchObject({ fallbackPricing: true });
    expect(h.runs[0]!.estCostUsd).toBeCloseTo(expected);
  });

  it('a policy with price overrides records that cost and is not marked estimated', async () => {
    const policy: ModelPolicy = {
      provider: 'openai_compatible',
      model: 'llama-local',
      maxOutputTokens: 500,
      baseUrl: 'http://localhost:11434/v1',
      inputUsdPerMTok: 0.5,
      outputUsdPerMTok: 2,
    };
    const h = harness({ overrides: { 'comms.classify': policy } });
    await runStructured(h.deps, 'comms.classify', call);
    expect(h.runs[0]).toMatchObject({ fallbackPricing: false });
    expect(h.runs[0]!.estCostUsd).toBeCloseTo((100 * 0.5 + 50 * 2) / 1_000_000, 12);
  });

  it('passes the policy output cap to the provider', async () => {
    const h = harness();
    await runStructured(h.deps, 'comms.classify', call);
    expect(h.model.doGenerateCalls[0]?.maxOutputTokens).toBe(
      DEFAULT_POLICIES['comms.classify'].maxOutputTokens,
    );
  });
});

describe('runStructured', () => {
  it('returns the parsed object and records an ok run with tokens and cost', async () => {
    const h = harness();
    const out = await runStructured(h.deps, 'resume.tailor', { ...call, promptId: 'p1' });
    expect(out).toEqual({ score: 1 });
    expect(h.runs).toHaveLength(1);
    const run = h.runs[0]!;
    expect(run).toMatchObject({
      taskKey: 'resume.tailor',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      promptId: 'p1',
      inputTokens: 100,
      outputTokens: 50,
      status: 'ok',
    });
    expect(run.estCostUsd).toBeCloseTo(estimateCostUsd('anthropic', 'claude-opus-5-5', 100, 50));
    expect(run.estCostUsd).toBeGreaterThan(0);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('retries once on schema-invalid output and succeeds on the second attempt', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [result('{"score":"high"}'), result('{"score":2}')],
    });
    const h = harness({ model });
    expect(await runStructured(h.deps, 'resume.match', call)).toEqual({ score: 2 });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(h.runs).toHaveLength(1);
    // Both attempts are billed.
    expect(h.runs[0]).toMatchObject({ status: 'ok', inputTokens: 200, outputTokens: 100 });
  });

  it('schema-invalid output twice throws invalid_output after exactly one retry and records it', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [result('{"score":"high"}'), result('not json'), result('{"score":3}')],
    });
    const h = harness({ model });
    const err = await runStructured(h.deps, 'resume.match', call).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect((err as AiUnavailableError).reason).toBe('invalid_output');
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({
      status: 'error',
      error: 'invalid_output',
      inputTokens: 200,
      outputTokens: 100,
    });
  });

  it('budget exceeded short-circuits without calling the provider, and records the refusal', async () => {
    const h = harness({ spent: 5, perTaskDailyUsd: 5 });
    const err = await runStructured(h.deps, 'resume.tailor', call).catch((e: unknown) => e);
    expect((err as AiUnavailableError).reason).toBe('budget_exceeded');
    expect(vi.mocked(createLanguageModel)).not.toHaveBeenCalled();
    expect(h.model.doGenerateCalls).toHaveLength(0);
    expect(h.getKey).not.toHaveBeenCalled();
    expect(h.runs).toEqual([
      expect.objectContaining({
        taskKey: 'resume.tailor',
        status: 'error',
        error: 'budget_exceeded',
        inputTokens: 0,
        outputTokens: 0,
        estCostUsd: 0,
      }),
    ]);
  });

  it('a missing key throws no_key and records the failure', async () => {
    const h = harness({ hasKey: false });
    const err = await runStructured(h.deps, 'comms.classify', call).catch((e: unknown) => e);
    expect((err as AiUnavailableError).reason).toBe('no_key');
    expect(h.model.doGenerateCalls).toHaveLength(0);
    expect(h.runs).toEqual([expect.objectContaining({ status: 'error', error: 'no_key' })]);
  });

  it('provider errors become provider_error, are recorded, and never carry the key', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error(`401 invalid x-api-key ${KEY}`);
      },
    });
    const h = harness({ model });
    const err = await runStructured(h.deps, 'resume.match', call).catch((e: unknown) => e);
    expect((err as AiUnavailableError).reason).toBe('provider_error');
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.status).toBe('error');
    expect(h.runs[0]!.error).toMatch(/^provider_error/);
    expect(JSON.stringify(h.runs)).not.toContain(KEY);
  });

  it('every call records exactly one run, successes and failures alike', async () => {
    const ok = harness();
    await runStructured(ok.deps, 'resume.match', call);
    const bad = harness({
      model: new MockLanguageModelV4({ doGenerate: [result('{}'), result('{}')] }),
    });
    await expect(runStructured(bad.deps, 'resume.match', call)).rejects.toThrow();
    expect(ok.runs).toHaveLength(1);
    expect(bad.runs).toHaveLength(1);
  });
});

describe('streamChat', () => {
  function streamModel(text: string): MockLanguageModelV4 {
    const chunks: LanguageModelV4StreamPart[] = [
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: text },
      { type: 'text-end', id: 't' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 30, noCache: 30, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 7, text: 7, reasoning: 0 },
        },
      },
    ];
    return new MockLanguageModelV4({ doStream: { stream: simulateReadableStream({ chunks }) } });
  }

  it('streams text and records the run once the stream finishes', async () => {
    const h = harness({ model: streamModel('Hello there') });
    const res = await streamChat(h.deps, 'resume.tailor', {
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(await res.text).toBe('Hello there');
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    expect(h.runs[0]).toMatchObject({
      taskKey: 'resume.tailor',
      status: 'ok',
      inputTokens: 30,
      outputTokens: 7,
    });
  });

  /**
   * Pins the ordering the server integration test relies on (and the reason it flaked on
   * Postgres only, never on SQLite): a caller that fully drains textStream, then reads the
   * ledger, must see the run already recorded, with no waitFor and no luck involved. deps.record
   * carries a deliberate delay so the assertion only passes if streamChat's onFinish callback is
   * genuinely awaited by the SDK before it closes the stream, not fired-and-forgotten.
   */
  it('has recorded the run by the time a full drain of textStream completes, even when the ledger write is slow', async () => {
    const runs: TaskRunRecord[] = [];
    const h = harness({ model: streamModel('Hello there') });
    h.deps.record = async (run) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      runs.push(run);
    };
    const res = await streamChat(h.deps, 'resume.tailor', {
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    for await (const delta of res.textStream) text += delta;
    expect(text).toBe('Hello there');
    // No waitFor: if onFinish were fire-and-forget, this would observe an empty ledger here.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ taskKey: 'resume.tailor', status: 'ok' });
  });

  it('a ledger write failure during streamChat is reported, not thrown, and the stream still delivers its text', async () => {
    const h = harness({ model: streamModel('Hello there') });
    h.deps.record = async () => {
      throw new Error('db unavailable');
    };
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await streamChat(h.deps, 'resume.tailor', {
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      });
      let text = '';
      for await (const delta of res.textStream) text += delta;
      expect(text).toBe('Hello there');
      expect(reported).toHaveBeenCalledWith(
        expect.stringContaining('resume.tailor'),
        expect.any(Error),
      );
    } finally {
      reported.mockRestore();
    }
  });

  it('enforces the budget before opening a stream', async () => {
    const h = harness({ model: streamModel('x'), spent: 9, perTaskDailyUsd: 5 });
    await expect(
      streamChat(h.deps, 'resume.tailor', {
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ reason: 'budget_exceeded' });
    expect(h.model.doStreamCalls).toHaveLength(0);
    expect(h.runs).toEqual([expect.objectContaining({ error: 'budget_exceeded' })]);
  });
});
