// How many requests saving an Anthropic key sends to the provider
// (https://github.com/bgoleno/opportun/issues/828): one 1-token POST /v1/messages per distinct
// model the user's task policies name, and nothing else. A model's answer is what proves this key
// can use that model (workspace scoping, a refusal for that model, credit), and Settings shows each
// model's (lib/aiKeyValidate.ts validateAnthropic). The real Anthropic client runs here; the
// provider is faked at the fetch every provider request leaves through, which counts them.
import { DEFAULT_POLICIES, TASK_KEYS } from '@opportun/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const KEY = 'sk-ant-test-SAVE-REQUESTS-0123456789abcdef';

/** Every request the provider received: its method, its URL and the model its body named. */
type Seen = { method: string; url: string; model: string | undefined };

function fakeAnthropic(answer: (model: string | undefined) => Response) {
  const seen: Seen[] = [];
  const fake = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: string }) : {};
    seen.push({ method, url, model: body.model });
    return answer(body.model);
  });
  vi.stubGlobal('fetch', fake);
  return seen;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const message = (model: string | undefined): Response =>
  json(200, {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'p' }],
    stop_reason: 'max_tokens',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

beforeEach(() => {
  // Nothing reaches the network: a request this file does not fake fails the test loudly.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network disabled in tests');
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function saveKey(c: TestClient) {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/secrets',
    payload: { kind: 'ai_api_key', label: 'anthropic', value: KEY },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().validation as { ok: boolean; models: { model: string; ok: boolean }[] };
}

const distinctDefaultModels = [
  ...new Set(TASK_KEYS.map((t) => DEFAULT_POLICIES[t]).map((p) => p.model)),
].sort();

describe('saving an Anthropic key (#828)', () => {
  it('sends one POST /v1/messages per distinct model its policies name, and nothing else', async () => {
    const { a } = await boot();
    const seen = fakeAnthropic(message);
    const v = await saveKey(a);
    expect(v.ok).toBe(true);
    // The defaults name three models (Opus, Sonnet, Haiku), each once.
    expect(distinctDefaultModels).toHaveLength(3);
    expect(seen.map((r) => r.model).sort()).toEqual(distinctDefaultModels);
    expect(
      seen.every((r) => r.method === 'POST' && r.url === 'https://api.anthropic.com/v1/messages'),
    ).toBe(true);
  });

  it('sends one when every policy names the same model', async () => {
    const { a } = await boot();
    const model = DEFAULT_POLICIES['comms.triage'].model;
    for (const task of TASK_KEYS) {
      const res = await a.request({
        method: 'PUT',
        url: `/api/v1/ai/policies/${task}`,
        payload: { provider: 'anthropic', model, maxOutputTokens: 500 },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    const seen = fakeAnthropic(message);
    await saveKey(a);
    expect(seen).toEqual([{ method: 'POST', url: 'https://api.anthropic.com/v1/messages', model }]);
  });

  it('sends one when the provider rejects the key', async () => {
    const { a } = await boot();
    const seen = fakeAnthropic(() =>
      json(401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }),
    );
    const v = await saveKey(a);
    expect(v.ok).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: 'https://api.anthropic.com/v1/messages' });
  });
});
