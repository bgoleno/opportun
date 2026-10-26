import { AiUnavailableError, FALLBACK_PRICE, runStructured, TASK_KEYS } from '@opportun/ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLanguageModel } from '../../../packages/ai/src/providers';
import { buildAiDeps, budgetKey } from '../src/lib/ai';
import { useApi } from './api';
import { bool, exec, queryAll, queryOne } from './db';
import { testApp } from './helpers';
import { registerTwoUsers } from './isolation';

// The provider is always mocked: no network calls and no real keys in tests.
vi.mock('../../../packages/ai/src/providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/ai/src/providers')>();
  return { ...real, createLanguageModel: vi.fn() };
});

const boot = useApi();
const KEY = 'sk-ant-test-THIS-IS-A-SECRET-0123456789';

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

const Out = z.object({ label: z.string() });
const call = { system: 's', prompt: 'p', schema: Out };

beforeEach(() => {
  vi.mocked(createLanguageModel).mockReset();
  // Adding a key validates it; model-list calls must never reach the network here.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('network disabled')));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function addKey(
  c: { request: (r: never) => Promise<{ statusCode: number }> },
  label: string,
) {
  const res = await (c.request as (r: unknown) => Promise<{ statusCode: number }>)({
    method: 'POST',
    url: '/api/v1/secrets',
    payload: { kind: 'ai_api_key', label, value: KEY },
  });
  expect(res.statusCode).toBe(201);
}

describe('server AiDeps', () => {
  it('resolves the provider key by label, records the run for the caller only', async () => {
    const { app, a, b } = await boot();
    await addKey(a, 'anthropic');
    const model = new MockLanguageModelV4({ doGenerate: ok('{"label":"x"}') });
    vi.mocked(createLanguageModel).mockReturnValue(model);

    const deps = await buildAiDeps(app.db, { userId: a.userId, isAdmin: false });
    expect(await runStructured(deps, 'comms.classify', call)).toEqual({ label: 'x' });
    expect(vi.mocked(createLanguageModel).mock.calls[0]![1]).toBe(KEY);

    const rows = (await queryAll(app, 'SELECT * FROM task_runs')) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: a.userId,
      task_key: 'comms.classify',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      input_tokens: 1000,
      output_tokens: 100,
      status: 'ok',
    });
    expect(rows[0]!.est_cost as number).toBeGreaterThan(0);

    // b has no key: no_key, recorded against b, no provider call.
    vi.mocked(createLanguageModel).mockClear();
    const bDeps = await buildAiDeps(app.db, { userId: b.userId, isAdmin: false });
    await expect(runStructured(bDeps, 'comms.classify', call)).rejects.toMatchObject({
      reason: 'no_key',
    });
    expect(vi.mocked(createLanguageModel)).not.toHaveBeenCalled();
    const bRows = await queryAll(
      app,
      'SELECT status, error FROM task_runs WHERE user_id = ?',
      b.userId,
    );
    expect(bRows).toEqual([{ status: 'error', error: 'no_key' }]);
  });

  it('a key labelled for another provider is not used', async () => {
    const { app, a } = await boot();
    await addKey(a, 'openai');
    const deps = await buildAiDeps(app.db, { userId: a.userId, isAdmin: false });
    await expect(deps.getKey('anthropic')).rejects.toBeInstanceOf(AiUnavailableError);
    expect(await deps.getKey('openai')).toBe(KEY);
  });

  it('the stored per-user policy override and budget are applied', async () => {
    const { app, a } = await boot();
    await addKey(a, 'openai');
    const put = await a.request({
      method: 'PUT',
      url: '/api/v1/ai/policies/comms.classify',
      payload: { provider: 'openai', model: 'gpt-5.5-mini', maxOutputTokens: 500 },
    });
    expect(put.statusCode).toBe(200);
    const model = new MockLanguageModelV4({ doGenerate: ok('{"label":"y"}') });
    vi.mocked(createLanguageModel).mockReturnValue(model);
    const deps = await buildAiDeps(app.db, { userId: a.userId, isAdmin: false });
    await runStructured(deps, 'comms.classify', call);
    expect(vi.mocked(createLanguageModel).mock.calls[0]![0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.5-mini',
    });
    expect(deps.budget.perTaskDailyUsd).toBe(5);

    // Budget: today's spend for the task is summed from task_runs.
    await exec(
      app,
      `INSERT INTO settings (key, user_id, value, updated_at) VALUES (?, ?, ?, ?)`,
      budgetKey(a.userId),
      a.userId,
      JSON.stringify({ perTaskDailyUsd: 0.001 }),
      Date.now(),
    );
    await exec(
      app,
      `INSERT INTO task_runs (id, user_id, task_key, provider, model, est_cost, status, created_at)
         VALUES ('r1', ?, 'comms.classify', 'openai', 'm', 0.002, 'ok', ?)`,
      a.userId,
      Date.now(),
    );
    vi.mocked(createLanguageModel).mockClear();
    const capped = await buildAiDeps(app.db, { userId: a.userId, isAdmin: false });
    expect(capped.budget.perTaskDailyUsd).toBe(0.001);
    await expect(runStructured(capped, 'comms.classify', call)).rejects.toMatchObject({
      reason: 'budget_exceeded',
    });
    expect(vi.mocked(createLanguageModel)).not.toHaveBeenCalled();
    // Other tasks have their own budget.
    vi.mocked(createLanguageModel).mockReturnValue(
      new MockLanguageModelV4({ doGenerate: ok('{"label":"z"}') }),
    );
    await expect(runStructured(capped, 'resume.match', call)).rejects.toMatchObject({
      reason: 'no_key',
    });
  });

  it('the API key never reaches a task_run row, an error message, or a response', async () => {
    const { app, a } = await boot();
    await addKey(a, 'anthropic');
    // A hostile provider error that echoes the key back.
    vi.mocked(createLanguageModel).mockImplementation(
      (_policy, apiKey) =>
        new MockLanguageModelV4({
          doGenerate: async () => {
            throw new Error(`invalid x-api-key: ${apiKey}`);
          },
        }),
    );
    const deps = await buildAiDeps(app.db, { userId: a.userId, isAdmin: false });
    const err = await runStructured(deps, 'resume.match', call).catch((e: unknown) => e);
    expect((err as AiUnavailableError).reason).toBe('provider_error');
    expect((err as Error).message).not.toContain(KEY);
    expect(String((err as Error).stack)).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);

    // Schema failure path too.
    vi.mocked(createLanguageModel).mockReturnValue(
      new MockLanguageModelV4({ doGenerate: [ok('{}'), ok(`{"oops":"${KEY}"}`)] }),
    );
    await expect(runStructured(deps, 'resume.match', call)).rejects.toMatchObject({
      reason: 'invalid_output',
    });

    const rows = await queryAll(app, 'SELECT * FROM task_runs');
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(KEY);
    const audit = await queryAll(app, 'SELECT * FROM audit_log');
    expect(JSON.stringify(audit)).not.toContain(KEY);
    for (const url of [
      '/api/v1/ai/usage',
      '/api/v1/ai/policies',
      '/api/v1/ai/prompts',
      '/api/v1/secrets',
    ]) {
      const res = await a.request({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain(KEY);
    }
  });
});

describe('cost estimation against the ledger', () => {
  it('an openai run with a listed model stores a nonzero list-price cost', async () => {
    const { app, a } = await boot();
    await addKey(a, 'openai');
    await a.request({
      method: 'PUT',
      url: '/api/v1/ai/policies/comms.classify',
      payload: { provider: 'openai', model: 'gpt-5.4-mini', maxOutputTokens: 500 },
    });
    vi.mocked(createLanguageModel).mockReturnValue(
      new MockLanguageModelV4({ doGenerate: ok('{"label":"x"}') }),
    );
    await runStructured(
      await buildAiDeps(app.db, { userId: a.userId, isAdmin: false }),
      'comms.classify',
      call,
    );
    const row = (await queryOne(
      app,
      'SELECT est_cost AS cost, fallback_pricing AS fb FROM task_runs WHERE user_id = ?',
      a.userId,
    )) as { cost: number; fb: unknown };
    // 1000 input at $0.75/MTok + 100 output at $4.50/MTok.
    expect(row.cost).toBeCloseTo(0.0012);
    expect(bool(row.fb)).toBe(false);
  });

  it('an unlisted model is charged the fallback price, flagged, and trips the budget gate', async () => {
    const { app, a } = await boot();
    await addKey(a, 'anthropic');
    await a.request({
      method: 'PUT',
      url: '/api/v1/ai/policies/capture.extract',
      payload: { provider: 'anthropic', model: 'claude-unlisted-model', maxOutputTokens: 500 },
    });
    await exec(
      app,
      'INSERT INTO settings (key, user_id, value, updated_at) VALUES (?, ?, ?, ?)',
      budgetKey(a.userId),
      a.userId,
      JSON.stringify({ perTaskDailyUsd: 0.01 }),
      Date.now(),
    );
    const model = new MockLanguageModelV4({ doGenerate: ok('{"label":"x"}') });
    vi.mocked(createLanguageModel).mockReturnValue(model);
    const deps = async () => await buildAiDeps(app.db, { userId: a.userId, isAdmin: false });

    await runStructured(await deps(), 'capture.extract', call);
    const row = (await queryOne(
      app,
      'SELECT est_cost AS cost, fallback_pricing AS fb FROM task_runs WHERE user_id = ?',
      a.userId,
    )) as { cost: number; fb: unknown };
    const expected =
      (1000 * FALLBACK_PRICE.inputPerMTok + 100 * FALLBACK_PRICE.outputPerMTok) / 1_000_000;
    expect(row.cost).toBeCloseTo(expected);
    expect(row.cost).toBeGreaterThan(0.01);
    expect(bool(row.fb)).toBe(true);

    // The first run spent past the cap: the next call is refused without reaching the provider.
    await expect(runStructured(await deps(), 'capture.extract', call)).rejects.toMatchObject({
      reason: 'budget_exceeded',
    });
    expect(model.doGenerateCalls).toHaveLength(1);

    const usage = (await a.request({ method: 'GET', url: '/api/v1/ai/usage' })).json();
    expect(usage.totals).toEqual([
      expect.objectContaining({ taskKey: 'capture.extract', runs: 2, estimated: true }),
    ]);
    expect(usage.items[0]).toMatchObject({ taskKey: 'capture.extract', estimated: true });
  });
});

describe('policy routes', () => {
  it('lists defaults, saves an override, and resets it', async () => {
    const { a, b } = await boot();
    const list = (await a.request({ method: 'GET', url: '/api/v1/ai/policies' })).json();
    expect(list.budget).toEqual({ perTaskDailyUsd: 5 });
    const tailor = list.items.find((i: { taskKey: string }) => i.taskKey === 'resume.tailor');
    expect(tailor).toMatchObject({
      defaultPolicy: { provider: 'anthropic', model: 'claude-opus-5-5' },
      override: null,
    });
    // Every registered task is listed, so adding one cannot quietly skip the policy UI.
    expect(list.items).toHaveLength(TASK_KEYS.length);

    const put = await a.request({
      method: 'PUT',
      url: '/api/v1/ai/policies/resume.tailor',
      payload: {
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        maxOutputTokens: 8000,
        temperature: 0.2,
      },
    });
    expect(put.json().override).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      maxOutputTokens: 8000,
      temperature: 0.2,
    });
    // Per user.
    const bList = (await b.request({ method: 'GET', url: '/api/v1/ai/policies' })).json();
    expect(bList.items.every((i: { override: unknown }) => i.override === null)).toBe(true);

    const del = await a.request({ method: 'DELETE', url: '/api/v1/ai/policies/resume.tailor' });
    expect(del.statusCode).toBe(204);
    const after = (await a.request({ method: 'GET', url: '/api/v1/ai/policies' })).json();
    expect(
      after.items.find((i: { taskKey: string }) => i.taskKey === 'resume.tailor').override,
    ).toBeNull();
  });

  it('saves per-policy price overrides and rejects negative ones', async () => {
    const { a } = await boot();
    const put = (payload: Record<string, unknown>) =>
      a.request({ method: 'PUT', url: '/api/v1/ai/policies/capture.extract', payload });
    const base = { provider: 'anthropic', model: 'claude-sonnet-5-5', maxOutputTokens: 1000 };
    const ok = await put({ ...base, inputUsdPerMTok: 1.5, outputUsdPerMTok: 0 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().override).toEqual({ ...base, inputUsdPerMTok: 1.5, outputUsdPerMTok: 0 });
    expect((await put({ ...base, inputUsdPerMTok: -1 })).statusCode).toBe(400);
  });

  it('validates openai_compatible baseUrl and drops baseUrl for other providers', async () => {
    const { a } = await boot();
    const put = (payload: Record<string, unknown>) =>
      a.request({ method: 'PUT', url: '/api/v1/ai/policies/capture.extract', payload });
    for (const baseUrl of [
      undefined,
      'http://10.0.0.2:8080/v1',
      'ftp://x',
      'https://u:p@h.example/v1',
    ]) {
      const res = await put({
        provider: 'openai_compatible',
        model: 'llama',
        maxOutputTokens: 100,
        baseUrl,
      });
      expect(res.statusCode, String(baseUrl)).toBe(400);
    }
    const anth = await put({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      maxOutputTokens: 100,
      baseUrl: 'https://evil.example',
    });
    expect(anth.statusCode).toBe(200);
    expect(anth.json().override.baseUrl).toBeUndefined();
    expect(
      (await a.request({ method: 'PUT', url: '/api/v1/ai/policies/nope', payload: {} })).statusCode,
    ).toBe(400);
  });

  it('rejects http on localhost by default (issue #334): the operator has not opted in', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'PUT',
      url: '/api/v1/ai/policies/capture.extract',
      payload: {
        provider: 'openai_compatible',
        model: 'llama',
        maxOutputTokens: 100,
        baseUrl: 'http://localhost:11434/v1',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.issues[0].message).toMatch(/disabled on this deployment/);
  });

  it('accepts http on localhost once the operator sets OPPORTUN_AI_ALLOW_LOOPBACK_HTTP (issue #334)', async () => {
    const { app } = await testApp({ aiAllowLoopbackHttp: true });
    try {
      const { a } = await registerTwoUsers(app);
      const res = await a.request({
        method: 'PUT',
        url: '/api/v1/ai/policies/capture.extract',
        payload: {
          provider: 'openai_compatible',
          model: 'llama',
          maxOutputTokens: 100,
          baseUrl: 'http://localhost:11434/v1',
        },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
