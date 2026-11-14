// Anthropic's batch client for ranking (#509, slice A of https://github.com/bgoleno/opportun/issues/358;
// tl's slice text issuecomment-6871513480). Every response comes from anthropicBatch.fixtures.ts,
// written from Anthropic's API reference: no test here reaches any network, and every key is made
// up.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BATCH_ID,
  canceledLine,
  erroredLine,
  expiredLine,
  jsonl,
  liveMessage,
  liveToolMessage,
  messageBatch,
  succeededLine,
  succeededToolLine,
} from './anthropicBatch.fixtures';
import { batchProviderFor, type BatchRequest } from './batch';
import { resolvePolicy } from './policies';

import { runStructured, structuredRequest } from './router';
import {
  OFFICIAL_BASE_URLS,
  type AiDeps,
  type ModelPolicy,
  type ProviderFetchOptions,
} from './types';

const KEY = 'sk-ant-test-0123456789abcdefghij';
const Score = z.object({ score: z.number().int().min(0).max(100), rationale: z.string() });
const PREFIX = 'Fixed instructions for every posting. '.repeat(120);
const REST = '<untrusted>\nCompany: Example Corp\nTitle: Staff Engineer\n</untrusted>';
const OPTS = {
  system: PREFIX + REST,
  cacheBreak: PREFIX.length,
  prompt: 'Score the posting and return the result.',
  schema: Score,
};
const SONNET: ModelPolicy = resolvePolicy('discovery.rank', undefined);
const POSTING = '01a1d41a-8318-7fae-98aa-5b6d74dd44a4';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers from `answer` and records every request; it reaches no network. */
function recordingFetch(answer: (url: string, init: RequestInit) => Response) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const raw = init.body;
    sent.push({
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
    });
    return answer(url, init);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A client whose only fetch is `fetch`, as the server hands one over (#334, #344). */
function client(
  fetch: typeof globalThis.fetch,
  over: Partial<ProviderFetchOptions> = {},
  policy: ModelPolicy = SONNET,
) {
  const provider = batchProviderFor({
    policy,
    apiKey: KEY,
    providerFetch: { fetch, allowLoopbackHttp: false, ...over },
  });
  if (provider === null) throw new Error('expected an Anthropic batch client');
  return provider;
}

const request = (customId: string): BatchRequest => ({
  customId,
  request: structuredRequest(SONNET, OPTS),
});

describe('batchProviderFor (criterion 1)', () => {
  it('has a client for an Anthropic policy, and none for any other provider', () => {
    const target = (policy: ModelPolicy) => ({
      policy,
      apiKey: KEY,
      providerFetch: { fetch: globalThis.fetch, allowLoopbackHttp: false },
    });
    expect(batchProviderFor(target(SONNET))).not.toBeNull();
    expect(
      batchProviderFor(target({ provider: 'openai', model: 'gpt-5', maxOutputTokens: 2000 })),
    ).toBeNull();
    expect(
      batchProviderFor(
        target({
          provider: 'openai_compatible',
          model: 'local',
          maxOutputTokens: 2000,
          baseUrl: 'https://llm.example.com/v1',
        }),
      ),
    ).toBeNull();
  });
});

describe('submit (criteria 1 and 2)', () => {
  it('posts the requests to /v1/messages/batches with their custom ids, as the live call is sent', async () => {
    const { fetch, sent } = recordingFetch(() => json(messageBatch('in_progress')));
    const out = await client(fetch).submit([request(POSTING), request('posting_2')]);
    expect(out).toEqual({ batchId: BATCH_ID });
    expect(sent).toHaveLength(1);
    const [post] = sent;
    expect(post!.method).toBe('POST');
    expect(post!.url).toBe(`${OFFICIAL_BASE_URLS.anthropic}/messages/batches`);
    // The live call's headers (the AI SDK's): the key in x-api-key, never Authorization.
    expect(post!.headers['x-api-key']).toBe(KEY);
    expect(post!.headers['anthropic-version']).toBe('2023-06-01');
    expect(post!.headers['content-type']).toBe('application/json');
    expect(post!.headers).not.toHaveProperty('authorization');
    const body = post!.body as { requests: { custom_id: string; params: unknown }[] };
    expect(body.requests.map((r) => r.custom_id)).toEqual([POSTING, 'posting_2']);
  });

  it("goes to the operator's ANTHROPIC_BASE_URL, with the fetch that trusts it, as live calls do", async () => {
    const plain = recordingFetch(() => {
      throw new Error('the plain fetch is not for the operator base URL');
    });
    const official = recordingFetch(() => json(messageBatch('in_progress')));
    await client(plain.fetch, {
      officialFetch: official.fetch,
      baseUrls: { anthropic: 'https://llm-gateway.example.com/v1' },
    }).submit([request(POSTING)]);
    expect(plain.sent).toHaveLength(0);
    expect(official.sent.map((s) => s.url)).toEqual([
      'https://llm-gateway.example.com/v1/messages/batches',
    ]);
  });

  it("an operator base URL's trailing slashes give one clean path", async () => {
    const { fetch, sent } = recordingFetch(() => json(messageBatch('in_progress')));
    await client(fetch, {
      baseUrls: { anthropic: 'https://llm-gateway.example.com/v1///' },
    }).submit([request(POSTING)]);
    expect(sent.map((s) => s.url)).toEqual(['https://llm-gateway.example.com/v1/messages/batches']);
  });

  it('refuses a custom id Anthropic would not take, before anything is sent', async () => {
    const { fetch, sent } = recordingFetch(() => json(messageBatch('in_progress')));
    for (const id of ['', 'has space', 'a'.repeat(65), 'slash/id']) {
      await expect(client(fetch).submit([request(id)])).rejects.toThrow(/custom id/);
    }
    expect(sent).toHaveLength(0);
  });

  it('a refused submit names the status, never the key or the provider text', async () => {
    const { fetch } = recordingFetch(() =>
      json(
        {
          type: 'error',
          error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` },
        },
        401,
      ),
    );
    const err = await client(fetch)
      .submit([request(POSTING)])
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/401/);
    expect(err!.message).not.toContain(KEY);
    expect(String(err!.stack)).not.toContain(KEY);
  });
});

describe('state (criterion 1)', () => {
  it.each([
    ['in_progress', 'in_progress'],
    ['canceling', 'in_progress'],
    ['ended', 'ended'],
  ] as const)('processing_status %s is %s', async (status, expected) => {
    const { fetch, sent } = recordingFetch(() => json(messageBatch(status)));
    expect(await client(fetch).state(BATCH_ID)).toBe(expected);
    expect(sent[0]!.method).toBe('GET');
    expect(sent[0]!.url).toBe(`${OFFICIAL_BASE_URLS.anthropic}/messages/batches/${BATCH_ID}`);
    expect(sent[0]!.headers['x-api-key']).toBe(KEY);
  });

  it('a batch the provider no longer has (404) is gone', async () => {
    const { fetch } = recordingFetch(() =>
      json({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }, 404),
    );
    expect(await client(fetch).state(BATCH_ID)).toBe('gone');
  });

  it('any other failure throws, for the collect job to try again later', async () => {
    const { fetch } = recordingFetch(() =>
      json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529),
    );
    await expect(client(fetch).state(BATCH_ID)).rejects.toThrow(/529/);
  });

  it('an unknown processing_status throws rather than guess', async () => {
    const { fetch } = recordingFetch(() =>
      json(messageBatch('in_progress', { processing_status: 'paused' })),
    );
    await expect(client(fetch).state(BATCH_ID)).rejects.toThrow(/processing_status/);
  });
});

describe('results (criterion 1)', () => {
  const file = jsonl([
    succeededLine(POSTING, '{"score":70,"rationale":"fits"}', {
      input_tokens: 120,
      output_tokens: 48,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2400,
    }),
    erroredLine('posting_2', 'invalid_request_error', 'max_tokens: too large'),
    erroredLine('posting_3', 'overloaded_error', 'Overloaded'),
    expiredLine('posting_4'),
    canceledLine('posting_5'),
  ]);

  it('reads every result type from the documented results endpoint', async () => {
    const { fetch, sent } = recordingFetch(
      () => new Response(file, { status: 200, headers: { 'content-type': 'application/x-jsonl' } }),
    );
    const items = await client(fetch).results(BATCH_ID);
    expect(sent.map((s) => s.url)).toEqual([
      `${OFFICIAL_BASE_URLS.anthropic}/messages/batches/${BATCH_ID}/results`,
    ]);
    expect(sent[0]!.headers['x-api-key']).toBe(KEY);
    expect(items).toEqual([
      {
        customId: POSTING,
        kind: 'succeeded',
        text: '{"score":70,"rationale":"fits"}',
        // Total input is input_tokens plus both cache counts (the reference); BatchUsage.input
        // includes the cache tokens, as the live path's does.
        usage: { input: 2520, output: 48, cacheRead: 2400, cacheWrite: 0 },
      },
      {
        customId: 'posting_2',
        kind: 'errored',
        invalidRequest: true,
        detail: 'invalid_request_error',
      },
      { customId: 'posting_3', kind: 'errored', invalidRequest: false, detail: 'overloaded_error' },
      { customId: 'posting_4', kind: 'expired' },
      { customId: 'posting_5', kind: 'canceled' },
    ]);
  });

  it("never fetches a results_url a response names: the key goes only to the operator's base URL", async () => {
    // The batch, as the state reads it, names a results_url on another host (tl at 28b9731: the
    // test must offer one for it to mean anything).
    const { fetch, sent } = recordingFetch((url) =>
      url.endsWith('/results')
        ? new Response(jsonl([expiredLine(POSTING)]))
        : json(
            messageBatch('ended', {
              results_url: `https://elsewhere.example.net/v1/messages/batches/${BATCH_ID}/results`,
            }),
          ),
    );
    const c = client(fetch, { baseUrls: { anthropic: 'https://llm-gateway.example.com/v1' } });
    expect(await c.state(BATCH_ID)).toBe('ended');
    await c.results(BATCH_ID);
    expect(sent.map((s) => s.url)).toEqual([
      `https://llm-gateway.example.com/v1/messages/batches/${BATCH_ID}`,
      `https://llm-gateway.example.com/v1/messages/batches/${BATCH_ID}/results`,
    ]);
    expect(sent.some((s) => s.url.includes('elsewhere.example.net'))).toBe(false);
  });

  it('a batch id with / ? or # stays one path segment, on the operator host (sec at 28b9731)', async () => {
    const { fetch, sent } = recordingFetch(() => new Response(jsonl([expiredLine(POSTING)])));
    await client(fetch).results('msgbatch_a/../b?x=1#y');
    expect(sent.map((s) => s.url)).toEqual([
      `${OFFICIAL_BASE_URLS.anthropic}/messages/batches/msgbatch_a%2F..%2Fb%3Fx%3D1%23y/results`,
    ]);
  });

  it("a succeeded answer given as the SDK's json tool call is the answer's text (tl at 28b9731)", async () => {
    const { fetch } = recordingFetch(
      () => new Response(jsonl([succeededToolLine(POSTING, { score: 70, rationale: 'fits' })])),
    );
    expect(await client(fetch).results(BATCH_ID)).toEqual([
      {
        customId: POSTING,
        kind: 'succeeded',
        text: '{"score":70,"rationale":"fits"}',
        usage: { input: 140, output: 52, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it('a line with a custom id but a result this client does not know is that request errored, not the batch', async () => {
    const odd = { custom_id: 'posting_2', result: { type: 'paused_for_review' } };
    const { fetch } = recordingFetch(() => new Response(jsonl([odd, expiredLine(POSTING)])));
    expect(await client(fetch).results(BATCH_ID)).toEqual([
      {
        customId: 'posting_2',
        kind: 'errored',
        invalidRequest: false,
        detail: 'unrecognised_result',
      },
      { customId: POSTING, kind: 'expired' },
    ]);
  });

  it('null cache counts are zero, and text blocks are joined', async () => {
    const line = succeededLine(POSTING, 'ignored', {
      input_tokens: 300,
      output_tokens: 20,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });
    ((line.result as { message: { content: unknown[] } }).message.content as unknown[]) = [
      { type: 'text', text: '{"score":' },
      { type: 'text', text: '5,"rationale":"x"}' },
    ];
    const { fetch } = recordingFetch(() => new Response(jsonl([line])));
    expect(await client(fetch).results(BATCH_ID)).toEqual([
      {
        customId: POSTING,
        kind: 'succeeded',
        text: '{"score":5,"rationale":"x"}',
        usage: { input: 300, output: 20, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it('a line that names no request is an unexpected answer, not a lost posting', async () => {
    const { fetch } = recordingFetch(
      () => new Response('{"result":{"type":"expired"}}\nnot json\n'),
    );
    await expect(client(fetch).results(BATCH_ID)).rejects.toThrow(/results/);
  });
});

describe('the batch request is the live call (criterion 3)', () => {
  it("each request's params equal the body the live path sends for the same posting", async () => {
    // The live path: runStructured, through the real Anthropic client of the AI SDK, its HTTP
    // request captured by a fake fetch that answers as the Messages API would.
    const live = recordingFetch(() => json(liveMessage('{"score":70,"rationale":"fits"}')));
    const deps: AiDeps = {
      getKey: async () => KEY,
      policyFor: async () => SONNET,
      record: async () => {},
      budget: { perTaskDailyUsd: 5 },
      spentTodayUsd: async () => 0,
      providerFetch: { fetch: live.fetch, allowLoopbackHttp: false },
    };
    await runStructured(deps, 'discovery.rank', OPTS);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0]!.url).toBe(`${OFFICIAL_BASE_URLS.anthropic}/messages`);
    const liveBody = live.sent[0]!.body as Record<string, unknown>;

    // The batch path, for the same posting's StructuredRequest.
    const batch = recordingFetch(() => json(messageBatch('in_progress')));
    await client(batch.fetch).submit([request(POSTING)]);
    const params = (batch.sent[0]!.body as { requests: { params: Record<string, unknown> }[] })
      .requests[0]!.params;

    // Fields a batch request does not take, with the reason. None today: the live call is not
    // streamed (no `stream`), and every field it sends is a Messages API creation parameter,
    // which is what a batch request's params are (the reference).
    const NOT_IN_A_BATCH: string[] = [];
    const expected = Object.fromEntries(
      Object.entries(liveBody).filter(([k]) => !NOT_IN_A_BATCH.includes(k)),
    );
    expect(params).toEqual(expected);
    // What the equality covers, named so a later change to the live call is seen here.
    expect(Object.keys(params).sort()).toEqual(
      ['max_tokens', 'messages', 'model', 'output_config', 'system'].sort(),
    );
    expect((params.system as { cache_control?: unknown }[])[0]!.cache_control).toEqual({
      type: 'ephemeral',
    });
  });

  it("in the SDK's json tool mode too (a model it does not know for native structured output)", async () => {
    const OLD: ModelPolicy = {
      provider: 'anthropic',
      // One the SDK (@ai-sdk/anthropic 4.0.81, getModelCapabilities) asks through its json tool, as
      // it does any id it does not know, a gateway alias among them.
      model: 'claude-3-haiku-20240307',
      maxOutputTokens: 4000,
    };
    const live = recordingFetch(() => json(liveToolMessage({ score: 70, rationale: 'fits' })));
    const deps: AiDeps = {
      getKey: async () => KEY,
      policyFor: async () => OLD,
      record: async () => {},
      budget: { perTaskDailyUsd: 5 },
      spentTodayUsd: async () => 0,
      providerFetch: { fetch: live.fetch, allowLoopbackHttp: false },
    };
    await runStructured(deps, 'discovery.rank', OPTS);
    expect(live.sent).toHaveLength(1);
    const liveBody = live.sent[0]!.body as Record<string, unknown>;
    // The live call asks through the SDK's json tool here, not output_config.
    const tools = liveBody.tools as { name?: string }[] | undefined;
    expect(tools?.map((t) => t.name)).toEqual(['json']);
    expect(liveBody).toHaveProperty('tool_choice');
    expect(liveBody).not.toHaveProperty('output_config');

    const batch = recordingFetch(() => json(messageBatch('in_progress')));
    await client(batch.fetch, {}, OLD).submit([
      { customId: POSTING, request: structuredRequest(OLD, OPTS) },
    ]);
    const params = (batch.sent[0]!.body as { requests: { params: Record<string, unknown> }[] })
      .requests[0]!.params;
    expect(params).toEqual(liveBody);
  });

  it('building the params sends nothing and never hands the real key to the SDK', async () => {
    const { fetch, sent } = recordingFetch(() => json(messageBatch('in_progress')));
    await client(fetch).submit([request(POSTING)]);
    // One request: the batch itself. The live body was built without a request leaving.
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.body)).not.toContain(KEY);
  });
});
