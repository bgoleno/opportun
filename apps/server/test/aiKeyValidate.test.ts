import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLanguageModel } from '../../../packages/ai/src/providers';
import { validateAiKey } from '../src/lib/aiKeyValidate';
import { setAiOverride, setProviderResolveOverride } from '../src/lib/ai';
import { captureLogs } from './helpers';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { queryAll, queryOne } from './db';

/** A fixed public address (matching safeFetch.test.ts's own PUBLIC_IP convention): every
 *  RFC 2606 fixture host in this file (llm.example.com) is chosen specifically so it never
 *  resolves for real (docs/pre-publication-checklist.md's own note on that convention), so
 *  aiProviderFetch's real DNS check needs this override rather than depending on the network. */
const resolvePublic = async (): Promise<string[]> => ['93.184.216.34'];

// Providers are mocked at the SDK boundary (anthropic) and the HTTP boundary (model lists).
vi.mock('../../../packages/ai/src/providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/ai/src/providers')>();
  return { ...real, createLanguageModel: vi.fn() };
});

const logs = captureLogs();
const boot = useApi(() => ({ logStream: logs }));
const KEY = 'sk-test-VALIDATE-SECRET-0123456789abcdef';
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.mocked(createLanguageModel).mockReset();
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('network disabled in tests'));
  vi.stubGlobal('fetch', fetchMock);
  logs.lines.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function ok() {
  return {
    content: [{ type: 'text' as const, text: 'p' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}

function apiError(statusCode: number, message: string): APICallError {
  return new APICallError({
    message,
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    statusCode,
    isRetryable: false,
  });
}

async function addKey(c: TestClient, label: string, extra: Record<string, unknown> = {}) {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/secrets',
    payload: { kind: 'ai_api_key', label, value: KEY, ...extra },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res;
}

async function putPolicy(c: TestClient, task: string, policy: Record<string, unknown>) {
  const res = await c.request({
    method: 'PUT',
    url: `/api/v1/ai/policies/${task}`,
    payload: { maxOutputTokens: 500, ...policy },
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe('openai keys', () => {
  it('lists models once and reports policy models missing from the list', async () => {
    const { app, a } = await boot();
    await putPolicy(a, 'comms.classify', { provider: 'openai', model: 'gpt-5.5-mini' });
    await putPolicy(a, 'resume.match', { provider: 'openai', model: 'gpt-6-unreleased' });
    await putPolicy(a, 'capture.extract', { provider: 'openai', model: 'gpt-5.5-mini' });
    fetchMock.mockResolvedValue(json(200, { data: [{ id: 'gpt-5.5-mini' }, { id: 'x' }] }));

    const created = await addKey(a, 'openai');
    const v = created.json().validation;
    expect(v).toMatchObject({ ok: true, provider: 'openai', expiresAt: null, error: null });
    // Policy order (TASK_KEYS), each distinct model once.
    expect(v.models).toEqual([
      { model: 'gpt-6-unreleased', ok: false, error: 'model not available to this key' },
      { model: 'gpt-5.5-mini', ok: true, error: null },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/models');
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    // Not a task: nothing in the run ledger.
    expect(await queryOne(app, 'SELECT count(*) AS n FROM task_runs')).toEqual({ n: 0 });
  });

  it('a rejected key is still stored, reported invalid, and its error never echoes the key', async () => {
    const { app, a } = await boot();
    await putPolicy(a, 'comms.classify', { provider: 'openai', model: 'gpt-5.5-mini' });
    fetchMock.mockResolvedValue(
      json(401, { error: { message: `Incorrect API key provided: ${KEY}` } }),
    );
    const created = await addKey(a, 'openai');
    expect(created.body).not.toContain(KEY);
    const v = created.json().validation;
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/^HTTP 401/);
    expect(v.error.length).toBeLessThanOrEqual(303);
    const list = await a.request({ method: 'GET', url: '/api/v1/ai/keys' });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].validation.ok).toBe(false);
    expect(list.body).not.toContain(KEY);
    const settingsRows = await queryAll(app, `SELECT value FROM settings`);
    expect(JSON.stringify(settingsRows)).not.toContain(KEY);
    expect(logs.text()).not.toContain(KEY);
  });

  it('a provider outage on create is ok=false with a sanitized reason, not a 500', async () => {
    const { a } = await boot();
    fetchMock.mockRejectedValue(new Error(`connect ECONNREFUSED (key ${KEY})`));
    const created = await addKey(a, 'openai');
    const v = created.json().validation;
    expect(v.ok).toBe(false);
    expect(v.error).toContain('ECONNREFUSED');
    expect(created.body).not.toContain(KEY);
  });
});

describe('openai_compatible keys', () => {
  it('an endpoint without a standard model list is reported as unverifiable', async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, resolvePublic);
    await putPolicy(a, 'comms.classify', {
      provider: 'openai_compatible',
      model: 'llama-4',
      baseUrl: 'https://llm.example.com/v1',
    });
    fetchMock.mockResolvedValue(new Response('<html>no</html>', { status: 200 }));
    const v = (await addKey(a, 'openai_compatible')).json().validation;
    expect(fetchMock.mock.calls[0]![0]).toBe('https://llm.example.com/v1/models');
    expect(v.ok).toBe(true);
    expect(v.models).toEqual([
      { model: 'llama-4', ok: false, error: 'unverifiable: endpoint has no model list' },
    ]);
  });

  it('with no policy pointing at an endpoint it is unverifiable and makes no call', async () => {
    const { a } = await boot();
    const v = (await addKey(a, 'openai_compatible')).json().validation;
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/^unverifiable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('openai_compatible keys under an AiOverride (issue #13)', () => {
  const override = (allowLoopbackHttp: boolean) => ({
    policyFor: () => ({
      provider: 'openai_compatible' as const,
      model: 'mock-model',
      baseUrl: 'http://127.0.0.1:1/mock',
      maxOutputTokens: 1,
    }),
    getKey: () => 'mock-key',
    allowLoopbackHttp,
  });

  it("honors the override's own loopback allowance, and validates its policy, not the stored ones", async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, resolvePublic);
    await putPolicy(a, 'comms.classify', {
      provider: 'openai_compatible',
      model: 'llama-4',
      baseUrl: 'https://llm.example.com/v1',
    });
    setAiOverride(app.db, override(true));
    fetchMock.mockResolvedValue(json(200, { data: [{ id: 'mock-model' }] }));
    const v = (await addKey(a, 'openai_compatible')).json().validation;
    // Only the override's endpoint is contacted: a stored policy cannot steer validation.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['http://127.0.0.1:1/mock/models']);
    expect(v.ok).toBe(true);
  });

  it("does not let the override's mere presence switch loopback http on", async () => {
    const { app, a } = await boot();
    setAiOverride(app.db, override(false));
    const v = (await addKey(a, 'openai_compatible')).json().validation;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(v.ok).toBe(false);
  });
});

describe('anthropic keys', () => {
  it('pings each distinct referenced model once with a 1-token call', async () => {
    const { app, a } = await boot();
    const calls: string[] = [];
    vi.mocked(createLanguageModel).mockImplementation(
      (policy) =>
        new MockLanguageModelV4({
          doGenerate: async (opts) => {
            calls.push(policy.model);
            expect(opts.maxOutputTokens).toBe(1);
            if (policy.model === 'claude-opus-5-5') throw apiError(404, 'model: not_found');
            return ok();
          },
        }),
    );
    const v = (await addKey(a, 'anthropic')).json().validation;
    expect([...calls].sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(v.ok).toBe(true);
    const byModel = Object.fromEntries(
      (v.models as { model: string; ok: boolean }[]).map((m) => [m.model, m.ok]),
    );
    expect(byModel).toEqual({
      'claude-opus-5-5': false,
      'claude-sonnet-5-5': true,
      'claude-haiku-5-5': true,
    });
    expect(await queryOne(app, 'SELECT count(*) AS n FROM task_runs')).toEqual({ n: 0 });
  });

  it('an auth failure on the first call short-circuits the rest', async () => {
    const { a } = await boot();
    let n = 0;
    vi.mocked(createLanguageModel).mockImplementation(
      (_policy, apiKey) =>
        new MockLanguageModelV4({
          doGenerate: async () => {
            n += 1;
            throw apiError(401, `invalid x-api-key ${apiKey} ${'x'.repeat(800)}`);
          },
        }),
    );
    const created = await addKey(a, 'anthropic');
    const v = created.json().validation;
    expect(n).toBe(1);
    expect(v.ok).toBe(false);
    expect(v.models).toHaveLength(3);
    expect(v.models.slice(1).every((m: { error: string }) => m.error.includes('not checked'))).toBe(
      true,
    );
    expect(v.error.length).toBeLessThanOrEqual(303);
    expect(created.body).not.toContain(KEY);
  });

  it('labels the organization-scoped key error as workspace scoping', async () => {
    const { a } = await boot();
    vi.mocked(createLanguageModel).mockImplementation(
      () =>
        new MockLanguageModelV4({
          doGenerate: async () => {
            throw apiError(
              400,
              'This API key is not scoped to a workspace. The request must include an anthropic-workspace-id header or use a workspace-scoped key.',
            );
          },
        }),
    );
    const v = (await addKey(a, 'anthropic')).json().validation;
    expect(v.models).toHaveLength(3);
    for (const m of v.models as { ok: boolean; error: string }[]) {
      expect(m.ok).toBe(false);
      expect(m.error.startsWith('workspace scoping: ')).toBe(true);
    }
  });
});

describe('validate route, storage and isolation', () => {
  it('revalidates on demand, returns it with the key list, and delete cleans it up', async () => {
    const { app, a } = await boot();
    const id = (await addKey(a, 'openai')).json().id;
    fetchMock.mockResolvedValue(json(200, { data: [] }));
    const res = await a.request({ method: 'POST', url: `/api/v1/ai/keys/${id}/validate` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, provider: 'openai', expiresAt: null });
    const list = (await a.request({ method: 'GET', url: '/api/v1/ai/keys' })).json();
    expect(list.items[0].validation).toEqual(res.json());
    const key = `key_validation:${id}:${a.userId}`;
    const count = async () =>
      (
        (await queryOne(app, 'SELECT count(*) AS n FROM settings WHERE key = ?', key)) as {
          n: number;
        }
      ).n;
    expect(await count()).toBe(1);
    expect((await a.request({ method: 'DELETE', url: `/api/v1/secrets/${id}` })).statusCode).toBe(
      204,
    );
    expect(await count()).toBe(0);
  });

  it('validate of a deleted key id is 404 and stores nothing', async () => {
    const { app, a } = await boot();
    const id = (await addKey(a, 'openai')).json().id;
    expect((await a.request({ method: 'DELETE', url: `/api/v1/secrets/${id}` })).statusCode).toBe(
      204,
    );
    fetchMock.mockClear();
    const res = await a.request({ method: 'POST', url: `/api/v1/ai/keys/${id}/validate` });
    expect(res.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await queryOne(
        app,
        'SELECT count(*) AS n FROM settings WHERE key LIKE ?',
        `key_validation:${id}:%`,
      ),
    ).toEqual({ n: 0 });
    expect((await a.request({ method: 'GET', url: '/api/v1/ai/keys' })).json().items).toEqual([]);
  });

  it('re-validating the same key overwrites the stored result, never appends', async () => {
    const { app, a } = await boot();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 16, 12));
      fetchMock.mockResolvedValue(json(401, { error: 'bad key' }));
      const id = (await addKey(a, 'openai')).json().id;
      const first = (
        await a.request({ method: 'POST', url: `/api/v1/ai/keys/${id}/validate` })
      ).json();
      expect(first.ok).toBe(false);

      vi.setSystemTime(Date.UTC(2026, 9, 16, 13));
      fetchMock.mockResolvedValue(json(200, { data: [] }));
      const second = (
        await a.request({ method: 'POST', url: `/api/v1/ai/keys/${id}/validate` })
      ).json();
      expect(second.ok).toBe(true);
      expect(second.error).toBeNull();
      expect(second.checkedAt).toBeGreaterThan(first.checkedAt);

      const rows = await queryAll(
        app,
        'SELECT key FROM settings WHERE key LIKE ?',
        `key_validation:${id}:%`,
      );
      expect(rows).toHaveLength(1);
      const listed = (await a.request({ method: 'GET', url: '/api/v1/ai/keys' })).json().items;
      expect(listed).toHaveLength(1);
      expect(listed[0].validation).toEqual(second);
    } finally {
      vi.useRealTimers();
    }
  });

  it('user B cannot validate user A key (404) and sees none of A keys', async () => {
    const { app, a, b } = await boot();
    const id = (await addKey(a, 'openai')).json().id;
    fetchMock.mockClear();
    const res = await b.request({ method: 'POST', url: `/api/v1/ai/keys/${id}/validate` });
    expect(res.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await b.request({ method: 'GET', url: '/api/v1/ai/keys' })).json().items).toEqual([]);
    await expect(
      validateAiKey(app.db, { userId: b.userId, isAdmin: false }, id),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a non-key secret id is 404 for validation', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/secrets',
      payload: { kind: 'oauth_token', label: 'Gmail', value: KEY },
    });
    const v = await a.request({ method: 'POST', url: `/api/v1/ai/keys/${res.json().id}/validate` });
    expect(v.statusCode).toBe(404);
  });
});

describe('key name and expiry metadata', () => {
  const EXP = Date.UTC(2031, 0, 15);

  it('create with name and expiry round-trips to both lists', async () => {
    const { a } = await boot();
    const created = await addKey(a, 'openai', { displayName: 'opportun-prod', expiresAt: EXP });
    expect(created.json()).toMatchObject({ displayName: 'opportun-prod', expiresAt: EXP });
    const keys = (await a.request({ method: 'GET', url: '/api/v1/ai/keys' })).json();
    expect(keys.items[0]).toMatchObject({
      label: 'openai',
      displayName: 'opportun-prod',
      expiresAt: EXP,
    });
    const secrets = (await a.request({ method: 'GET', url: '/api/v1/secrets' })).json();
    expect(secrets.items[0]).toMatchObject({ displayName: 'opportun-prod', expiresAt: EXP });
  });

  it('PATCH edits only name and expiry, never value, kind or label', async () => {
    const { app, a } = await boot();
    const id = (await addKey(a, 'openai')).json().id;
    const before = (await queryOne(app, 'SELECT * FROM secrets WHERE id = ?', id)) as Record<
      string,
      unknown
    >;
    for (const bad of [{ value: 'other' }, { kind: 'oauth_token' }, { label: 'anthropic' }]) {
      const res = await a.request({ method: 'PATCH', url: `/api/v1/secrets/${id}`, payload: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const ok = await a.request({
      method: 'PATCH',
      url: `/api/v1/secrets/${id}`,
      payload: { displayName: 'renamed', expiresAt: EXP },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ label: 'openai', displayName: 'renamed', expiresAt: EXP });
    const after = (await queryOne(app, 'SELECT * FROM secrets WHERE id = ?', id)) as Record<
      string,
      unknown
    >;
    const pick = (r: Record<string, unknown>) => [r.ciphertext, r.iv, r.tag, r.kind, r.label];
    expect(pick(after)).toEqual(pick(before));
    const cleared = await a.request({
      method: 'PATCH',
      url: `/api/v1/secrets/${id}`,
      payload: { displayName: '', expiresAt: null },
    });
    expect(cleared.json()).toMatchObject({ displayName: null, expiresAt: null });
  });

  it('PATCH is user-scoped', async () => {
    const { a, b } = await boot();
    const id = (await addKey(a, 'openai')).json().id;
    const res = await b.request({
      method: 'PATCH',
      url: `/api/v1/secrets/${id}`,
      payload: { displayName: 'stolen' },
    });
    expect(res.statusCode).toBe(404);
    const keys = (await a.request({ method: 'GET', url: '/api/v1/ai/keys' })).json();
    expect(keys.items[0].displayName).toBeNull();
  });

  it('a provider_error with an expired stored key carries the expiry hint', async () => {
    const { a } = await boot();
    const expired = Date.UTC(2024, 4, 1);
    vi.mocked(createLanguageModel).mockImplementation(
      () =>
        new MockLanguageModelV4({
          doGenerate: async () => {
            throw apiError(401, 'invalid x-api-key');
          },
        }),
    );
    await addKey(a, 'anthropic', { expiresAt: expired });
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/capture',
      payload: { text: 'Senior Engineer at Acme. Build things.' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({
      reason: 'provider_error',
      keyHint: 'the stored key expired on 2024-05-01',
    });
    expect(res.body).not.toContain(KEY);
  });
});
