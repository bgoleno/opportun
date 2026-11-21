// OpenAI's batch client for ranking (#510, slice B of https://github.com/bgoleno/opportun/issues/358;
// tl's slice text issuecomment-6871513480). Every response comes from openaiBatch.fixtures.ts,
// written from OpenAI's documentation: no test here reaches any network, and every key is made up.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { batchProviderFor, type BatchRequest } from './batch';
import {
  BATCH_ID,
  batchObject,
  ERROR_FILE_ID,
  expiredLine,
  fileObject,
  INPUT_FILE_ID,
  jsonl,
  OUTPUT_FILE_ID,
  refusedLine,
  responseBody,
  succeededLine,
  type Status,
} from './openaiBatch.fixtures';
import { batchMultiplier, estimateCost } from './pricing';
import { runStructured, structuredRequest } from './router';
import {
  OFFICIAL_BASE_URLS,
  type AiDeps,
  type ModelPolicy,
  type ProviderFetchOptions,
} from './types';

const KEY = 'sk-proj-test-0123456789abcdefghij';
const Score = z.object({ score: z.number().int().min(0).max(100), rationale: z.string() });
const OPTS = {
  system: 'Fixed instructions for every posting. '.repeat(40),
  prompt: '<untrusted>\nCompany: Example Corp\nTitle: Staff Engineer\n</untrusted>\nScore it.',
  schema: Score,
};
const GPT: ModelPolicy = { provider: 'openai', model: 'gpt-5', maxOutputTokens: 2000 };
const POSTING = '01a1d41a-8318-7fae-98aa-5b6d74dd44a4';
const BASE = OFFICIAL_BASE_URLS.openai;

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
      body: typeof raw === 'string' ? JSON.parse(raw) : raw,
    });
    return answer(url, init);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The answers a whole submit gets: the upload, then the batch. */
const submitAnswers = (url: string) =>
  url.endsWith('/files') ? json(fileObject()) : json(batchObject('validating'));

/** A client whose only fetch is `fetch`, as the server hands one over (#334, #344). */
function client(
  fetch: typeof globalThis.fetch,
  over: Partial<ProviderFetchOptions> = {},
  policy: ModelPolicy = GPT,
) {
  const provider = batchProviderFor({
    policy,
    apiKey: KEY,
    providerFetch: { fetch, allowLoopbackHttp: false, ...over },
  });
  if (provider === null) throw new Error('expected an OpenAI batch client');
  return provider;
}

const request = (customId: string, policy: ModelPolicy = GPT): BatchRequest => ({
  customId,
  request: structuredRequest(policy, OPTS),
});

/** The JSONL file a submit uploaded, as its lines. */
async function uploadedLines(sent: Sent[]): Promise<Record<string, unknown>[]> {
  const form = sent[0]!.body as FormData;
  const file = form.get('file') as File;
  return (await file.text())
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('batchProviderFor (criterion 1)', () => {
  const target = (policy: ModelPolicy, over: Partial<ProviderFetchOptions> = {}) => ({
    policy,
    apiKey: KEY,
    providerFetch: { fetch: globalThis.fetch, allowLoopbackHttp: false, ...over },
  });

  it("has a client for an OpenAI policy on OpenAI's own API", () => {
    expect(batchProviderFor(target(GPT))).not.toBeNull();
    // The operator's OPENAI_BASE_URL naming OpenAI's own API, trailing slash or not, is the same.
    expect(batchProviderFor(target(GPT, { baseUrls: { openai: `${BASE}/` } }))).not.toBeNull();
  });

  it('has none for an OpenAI-compatible endpoint, or for any other base URL: those rank live', () => {
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
    for (const openai of [
      'https://llm-gateway.example.com/v1',
      'https://api.openai.com/v2',
      'http://api.openai.com/v1',
    ]) {
      expect(batchProviderFor(target(GPT, { baseUrls: { openai } })), openai).toBeNull();
    }
  });
});

describe('submit (criteria 1 and 2)', () => {
  it('uploads the requests as one JSONL file (purpose batch), then creates the batch on the live endpoint, in 24 hours', async () => {
    const { fetch, sent } = recordingFetch(submitAnswers);
    const out = await client(fetch).submit([request(POSTING), request('posting_2')]);
    expect(out).toEqual({ batchId: BATCH_ID });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      `POST ${BASE}/files`,
      `POST ${BASE}/batches`,
    ]);

    const [upload, create] = sent;
    // The live call's header: the key as a bearer token, nowhere else.
    expect(upload!.headers.authorization).toBe(`Bearer ${KEY}`);
    const form = upload!.body as FormData;
    expect(form.get('purpose')).toBe('batch');
    expect((form.get('file') as File).name).toBe('batch.jsonl');
    const lines = await uploadedLines(sent);
    expect(lines.map((l) => [l.custom_id, l.method, l.url])).toEqual([
      [POSTING, 'POST', '/v1/responses'],
      ['posting_2', 'POST', '/v1/responses'],
    ]);

    expect(create!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(create!.headers['content-type']).toBe('application/json');
    expect(create!.body).toEqual({
      input_file_id: INPUT_FILE_ID,
      endpoint: '/v1/responses',
      completion_window: '24h',
      // #634: the output and error files expire a week after they are made, if cleanup cannot
      // remove them first.
      output_expires_after: { anchor: 'created_at', seconds: 7 * 24 * 60 * 60 },
    });
    // Nothing else carries the key: not a line, not the batch's body.
    expect(JSON.stringify(lines)).not.toContain(KEY);
    expect(JSON.stringify(create!.body)).not.toContain(KEY);
  });

  it("uses the fetch that trusts the operator's base URL, as live calls do", async () => {
    const plain = recordingFetch(() => {
      throw new Error('the plain fetch is not for the official API here');
    });
    const official = recordingFetch(submitAnswers);
    await client(plain.fetch, {
      officialFetch: official.fetch,
      baseUrls: { openai: `${BASE}///` },
    }).submit([request(POSTING)]);
    expect(plain.sent).toHaveLength(0);
    expect(official.sent.map((s) => s.url)).toEqual([`${BASE}/files`, `${BASE}/batches`]);
  });

  it('refuses repeated or empty custom ids, and an empty batch, before anything is sent', async () => {
    const { fetch, sent } = recordingFetch(submitAnswers);
    await expect(client(fetch).submit([request('a'), request('a')])).rejects.toThrow(/custom id/);
    await expect(client(fetch).submit([request('')])).rejects.toThrow(/custom id/);
    await expect(client(fetch).submit([])).rejects.toThrow(/1 to 50,000/);
    expect(sent).toHaveLength(0);
  });

  it('a refused batch create deletes the file it uploaded, and still throws naming the status', async () => {
    const { fetch, sent } = recordingFetch((url, init) => {
      if (url.endsWith('/files') && init.method === 'POST') return json(fileObject());
      if (url.endsWith('/batches')) return json({ error: { message: 'quota' } }, 429);
      if (init.method === 'DELETE') return json({ id: INPUT_FILE_ID, deleted: true });
      throw new Error(`not a documented endpoint: ${init.method} ${url}`);
    });
    await expect(client(fetch).submit([request(POSTING)])).rejects.toThrow(
      'OpenAI batch submit: HTTP 429',
    );
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      `POST ${BASE}/files`,
      `POST ${BASE}/batches`,
      `DELETE ${BASE}/files/${INPUT_FILE_ID}`,
    ]);
  });

  it('a delete that fails after a refused create still throws the create refusal', async () => {
    const { fetch } = recordingFetch((url, init) => {
      if (url.endsWith('/files') && init.method === 'POST') return json(fileObject());
      if (url.endsWith('/batches')) return json({ error: { message: 'quota' } }, 429);
      throw new Error('network down');
    });
    await expect(client(fetch).submit([request(POSTING)])).rejects.toThrow(
      'OpenAI batch submit: HTTP 429',
    );
  });

  it.each(['upload', 'submit'])(
    'a refused %s names the status, never the key or the provider text',
    async (step) => {
      const { fetch } = recordingFetch((url) =>
        (step === 'upload') === url.endsWith('/files')
          ? json(
              {
                error: {
                  message: `Incorrect API key provided: ${KEY}`,
                  type: 'invalid_request_error',
                },
              },
              401,
            )
          : submitAnswers(url),
      );
      const err = await client(fetch)
        .submit([request(POSTING)])
        .then(
          () => null,
          (e: unknown) => e as Error,
        );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toBe(`OpenAI batch ${step}: HTTP 401`);
      expect(String(err!.stack)).not.toContain(KEY);
    },
  );
});

describe('state (criterion 1)', () => {
  it.each([
    ['validating', 'in_progress'],
    ['in_progress', 'in_progress'],
    ['finalizing', 'in_progress'],
    ['completed', 'ended'],
    ['failed', 'ended'],
    ['expired', 'ended'],
    ['cancelling', 'ended'],
    ['cancelled', 'ended'],
  ] as const)('status %s is %s', async (status, expected) => {
    const { fetch, sent } = recordingFetch(() => json(batchObject(status as Status)));
    expect(await client(fetch).state(BATCH_ID)).toBe(expected);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('GET');
    expect(sent[0]!.url).toBe(`${BASE}/batches/${BATCH_ID}`);
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('a batch the provider no longer has (404) is gone', async () => {
    const { fetch } = recordingFetch(() =>
      json({ error: { message: 'No batch found', type: 'invalid_request_error' } }, 404),
    );
    expect(await client(fetch).state(BATCH_ID)).toBe('gone');
  });

  it('a status it does not know is an unexpected answer, not an ending', async () => {
    const { fetch } = recordingFetch(() => json(batchObject('in_progress', { status: 'paused' })));
    await expect(client(fetch).state(BATCH_ID)).rejects.toThrow(/unexpected status/);
  });

  it('a batch id with / ? or # stays one path segment on the operator host', async () => {
    const { fetch, sent } = recordingFetch(() => json(batchObject('in_progress')));
    await client(fetch).state('a/b?c#d');
    expect(sent[0]!.url).toBe(`${BASE}/batches/a%2Fb%3Fc%23d`);
  });
});

describe('results (criterion 1)', () => {
  /** A batch with these files, answered at the documented endpoints only. */
  function ended(
    output: unknown[] | null,
    errors: unknown[] | null,
    batch: Record<string, unknown> = {},
  ) {
    return recordingFetch((url) => {
      if (url === `${BASE}/batches/${BATCH_ID}`) {
        return json(
          batchObject('completed', {
            output_file_id: output === null ? null : OUTPUT_FILE_ID,
            error_file_id: errors === null ? null : ERROR_FILE_ID,
            ...batch,
          }),
        );
      }
      if (url === `${BASE}/files/${OUTPUT_FILE_ID}/content`) return new Response(jsonl(output!));
      if (url === `${BASE}/files/${ERROR_FILE_ID}/content`) return new Response(jsonl(errors!));
      throw new Error(`not a documented endpoint: ${url}`);
    });
  }

  it('reads the output file and the error file into results, by custom id', async () => {
    const { fetch, sent } = ended(
      [succeededLine(POSTING, '{"score":70,"rationale":"fits"}', { input: 300, cached: 200 })],
      [expiredLine('posting_2'), refusedLine('posting_3')],
    );
    expect(await client(fetch).results(BATCH_ID)).toEqual([
      {
        customId: POSTING,
        kind: 'succeeded',
        text: '{"score":70,"rationale":"fits"}',
        // input_tokens already counts the cached ones (the Response object's usage).
        usage: { input: 300, output: 20, cacheRead: 200, cacheWrite: 0 },
      },
      { customId: 'posting_2', kind: 'expired' },
      // The error's type only: never its message, which quotes the request.
      {
        customId: 'posting_3',
        kind: 'errored',
        invalidRequest: true,
        detail: 'invalid_request_error',
      },
    ]);
    expect(sent.map((s) => s.url)).toEqual([
      `${BASE}/batches/${BATCH_ID}`,
      `${BASE}/files/${OUTPUT_FILE_ID}/content`,
      `${BASE}/files/${ERROR_FILE_ID}/content`,
    ]);
    for (const s of sent) expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("a refusal that is not the request's fault is retried later, and a bare error is too", async () => {
    const { fetch } = ended(null, [
      refusedLine('a', 500, 'server_error'),
      refusedLine('b', 429, 'weird type with spaces'),
      {
        id: 'batch_req_9',
        custom_id: 'c',
        response: null,
        error: { code: 'batch_cancelled', message: 'x' },
      },
    ]);
    expect(await client(fetch).results(BATCH_ID)).toEqual([
      { customId: 'a', kind: 'errored', invalidRequest: false, detail: 'server_error' },
      { customId: 'b', kind: 'errored', invalidRequest: false, detail: 'http_429' },
      { customId: 'c', kind: 'errored', invalidRequest: false, detail: 'batch_cancelled' },
    ]);
  });

  it('a batch with no files (it failed validation) has no results: the collect job returns those postings as expired ones', async () => {
    const { fetch, sent } = ended(null, null, { status: 'failed' });
    expect(await client(fetch).results(BATCH_ID)).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it('a refusal answer or no text reads as the empty answer, which the caller counts invalid', async () => {
    const line = succeededLine(POSTING, 'unused');
    const body = (line.response as { body: { output: unknown[] } }).body;
    body.output = [
      { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No.' }] },
    ];
    const { fetch } = ended([line], null);
    const [item] = await client(fetch).results(BATCH_ID);
    expect(item).toMatchObject({ kind: 'succeeded', text: '' });
  });

  it('joins the output_text parts of every message, as the live call reads them', async () => {
    const line = succeededLine(POSTING, 'unused');
    const body = (line.response as { body: { output: unknown[] } }).body;
    body.output = [
      { type: 'reasoning', summary: [] },
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: '{"score":' },
          { type: 'output_text', text: '5,"rationale":"x"}' },
        ],
      },
    ];
    const { fetch } = ended([line], null);
    expect(await client(fetch).results(BATCH_ID)).toEqual([
      {
        customId: POSTING,
        kind: 'succeeded',
        text: '{"score":5,"rationale":"x"}',
        usage: { input: 300, output: 20, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it('a line that names no request, or is not JSON, is an unexpected answer, not a lost posting', async () => {
    for (const lines of [[{ response: null, error: { code: 'batch_expired' } }], ['not json']]) {
      const { fetch } = recordingFetch((url) =>
        url.endsWith(`/batches/${BATCH_ID}`)
          ? json(batchObject('completed', { error_file_id: null }))
          : new Response(
              lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'),
            ),
      );
      await expect(client(fetch).results(BATCH_ID)).rejects.toThrow(/unexpected line/);
    }
  });

  it('reads files by the ids the batch names, on the operator host, never a URL from a response', async () => {
    const { fetch, sent } = ended([succeededLine(POSTING, '{}')], null, {
      output_file_id: 'https://elsewhere.example.com/steal',
    });
    await client(fetch)
      .results(BATCH_ID)
      .catch(() => undefined);
    for (const s of sent) expect(new URL(s.url).host).toBe(new URL(BASE).host);
  });

  it('a result file OpenAI no longer has (404, past its expiry) is read as no results: those requests wait again', async () => {
    const { fetch } = recordingFetch((url) => {
      if (url === `${BASE}/batches/${BATCH_ID}`) return json(batchObject('completed'));
      if (url === `${BASE}/files/${OUTPUT_FILE_ID}/content`) {
        return json({ error: { message: 'No such File object' } }, 404);
      }
      if (url === `${BASE}/files/${ERROR_FILE_ID}/content`) {
        return new Response(jsonl([expiredLine('posting_2')]));
      }
      throw new Error(`not a documented endpoint: ${url}`);
    });
    // No throw, so the collect job ends the batch, and every posting with no result waits again.
    expect(await client(fetch).results(BATCH_ID)).toEqual([
      { customId: 'posting_2', kind: 'expired' },
    ]);
  });

  it('a refused file read names the status, never the key', async () => {
    const { fetch } = recordingFetch((url) =>
      url.endsWith(`/batches/${BATCH_ID}`)
        ? json(batchObject('completed'))
        : json({ error: { message: `bad key ${KEY}` } }, 401),
    );
    await expect(client(fetch).results(BATCH_ID)).rejects.toThrow('OpenAI batch results: HTTP 401');
  });
});

describe('the batch request is the live call (criterion 3)', () => {
  it("each line's endpoint and body equal the live path's for the same posting", async () => {
    // The live path: runStructured, through the real OpenAI client of the AI SDK, its HTTP
    // request captured by a fake fetch that answers as the Responses API would.
    const live = recordingFetch(() => json(responseBody('{"score":70,"rationale":"fits"}')));
    const deps: AiDeps = {
      getKey: async () => KEY,
      policyFor: async () => GPT,
      record: async () => {},
      budget: { perTaskDailyUsd: 5 },
      spentTodayUsd: async () => 0,
      providerFetch: { fetch: live.fetch, allowLoopbackHttp: false },
    };
    await runStructured(deps, 'discovery.rank', OPTS);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0]!.url).toBe(`${BASE}/responses`);
    const liveBody = live.sent[0]!.body as Record<string, unknown>;

    const batch = recordingFetch(submitAnswers);
    await client(batch.fetch).submit([request(POSTING)]);
    const [line] = await uploadedLines(batch.sent);
    expect(line!.url).toBe(new URL(live.sent[0]!.url).pathname);
    // Fields a batch line's body does not take, with the reason. None today: the live call is not
    // streamed (no `stream`), and a line's body takes the endpoint's own parameters (the guide).
    expect(line!.body).toEqual(liveBody);
    // What the equality covers, named so a later change to the live call is seen here.
    // The system prompt is the first `input` message (the SDK's), and `text` is the structured
    // output format with the schema.
    expect(Object.keys(line!.body as object).sort()).toEqual(
      ['input', 'max_output_tokens', 'model', 'text'].sort(),
    );
    expect((line!.body as { text: { format: { type: string } } }).text.format.type).toBe(
      'json_schema',
    );
  });

  it('building the lines sends nothing more and never hands the real key to the SDK', async () => {
    const { fetch, sent } = recordingFetch(submitAnswers);
    await client(fetch).submit([request(POSTING)]);
    // The upload and the batch: the body was built without a request leaving.
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(await uploadedLines(sent))).not.toContain(KEY);
  });
});

describe('cleanup: the batch files removed once the results are applied (#634)', () => {
  const FILES = [INPUT_FILE_ID, OUTPUT_FILE_ID, ERROR_FILE_ID];
  /** A completed batch; each file DELETE answered by `answer`. */
  function deletes(answer: (fileId: string) => Response) {
    return recordingFetch((url, init) => {
      if (url === `${BASE}/batches/${BATCH_ID}`) return json(batchObject('completed'));
      const m = /\/files\/([^/]+)$/.exec(url);
      if (m !== null && init.method === 'DELETE') return answer(decodeURIComponent(m[1]!));
      throw new Error(`not a documented endpoint: ${init.method} ${url}`);
    });
  }

  it('deletes the input, output and error files, with the key, on the operator host', async () => {
    const { fetch, sent } = deletes((id) => json({ id, object: 'file', deleted: true }));
    await client(fetch).cleanup(BATCH_ID);
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET ${BASE}/batches/${BATCH_ID}`,
      ...FILES.map((id) => `DELETE ${BASE}/files/${id}`),
    ]);
    for (const s of sent) expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('a file already gone counts as removed', async () => {
    const { fetch } = deletes(() => json({ error: { message: 'No such File object' } }, 404));
    await expect(client(fetch).cleanup(BATCH_ID)).resolves.toBeUndefined();
  });

  it('a refused delete still tries the others, then throws naming the status, never the key', async () => {
    const { fetch, sent } = deletes((id) =>
      id === INPUT_FILE_ID
        ? json({ error: { message: `bad key ${KEY}` } }, 500)
        : json({ id, deleted: true }),
    );
    const err = await client(fetch)
      .cleanup(BATCH_ID)
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err?.message).toBe('OpenAI batch delete: HTTP 500');
    expect(String(err?.stack)).not.toContain(KEY);
    expect(sent.filter((s) => s.method === 'DELETE')).toHaveLength(3);
  });

  it('a batch the provider no longer has has nothing to remove', async () => {
    const { fetch, sent } = recordingFetch(() => json({ error: { message: 'No batch' } }, 404));
    await client(fetch).cleanup(BATCH_ID);
    expect(sent).toHaveLength(1);
  });

  it('a batch with no output or error file deletes only its input', async () => {
    const { fetch, sent } = recordingFetch((url, init) =>
      url.endsWith(`/batches/${BATCH_ID}`)
        ? json(batchObject('failed', { output_file_id: null, error_file_id: null }))
        : init.method === 'DELETE'
          ? json({ deleted: true })
          : json({}, 500),
    );
    await client(fetch).cleanup(BATCH_ID);
    expect(sent.filter((s) => s.method === 'DELETE').map((s) => s.url)).toEqual([
      `${BASE}/files/${INPUT_FILE_ID}`,
    ]);
  });
});

describe('the batch price (criterion 5)', () => {
  it("is half the live price, OpenAI's published Batch API discount", () => {
    expect(batchMultiplier('openai')).toBe(0.5);
    const live = estimateCost('openai', 'gpt-5', 1000, 1000, GPT).usd;
    const batch = estimateCost('openai', 'gpt-5', 1000, 1000, GPT, undefined, { batch: true }).usd;
    expect(live).toBeGreaterThan(0);
    expect(batch).toBeCloseTo(live / 2, 10);
    // An OpenAI-compatible endpoint has no batches here.
    expect(batchMultiplier('openai_compatible')).toBeUndefined();
  });
});
