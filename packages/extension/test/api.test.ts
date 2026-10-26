import { describe, expect, it, vi } from 'vitest';
import { CONNECTION_TEST_PAYLOAD, postCapture, testConnection, type FetchLike } from '../src/api';
import type { Settings } from '../src/settings';

const TOKEN = `odt_${'B'.repeat(43)}`;
const SETTINGS: Settings = { serverUrl: 'https://opportun.example.com', token: TOKEN };
const PAYLOAD = {
  url: 'https://www.linkedin.com/in/dana-testworth-0a1b2c/',
  title: 'Dana Testworth | LinkedIn',
  text: 'Dana Testworth\nVP of Platform Engineering at Initech',
};

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn<FetchLike>(async () => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  }));
}

describe('postCapture request', () => {
  it('POSTs the payload as JSON with the bearer token, no cookies, no redirects', async () => {
    const fetch = respond(201, { kind: 'profile', contactId: 'c1', created: true, refined: false });
    await postCapture(fetch, SETTINGS, PAYLOAD);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://opportun.example.com/api/v1/connector/capture');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    });
    expect(JSON.parse(init.body)).toEqual(PAYLOAD);
  });
});

describe('postCapture outcomes', () => {
  it('a created or updated profile', async () => {
    expect(
      await postCapture(
        respond(201, { kind: 'profile', contactId: 'c1', created: true, refined: true }),
        SETTINGS,
        PAYLOAD,
      ),
    ).toEqual({ kind: 'profile', contactId: 'c1', created: true, refined: true });
    expect(
      await postCapture(
        respond(200, { kind: 'profile', contactId: 'c1', created: false, refined: false }),
        SETTINGS,
        PAYLOAD,
      ),
    ).toEqual({ kind: 'profile', contactId: 'c1', created: false, refined: false });
  });

  it('a new lead and a duplicate', async () => {
    expect(
      await postCapture(
        respond(201, { kind: 'job', resultId: 'r1', duplicate: false, refined: false }),
        SETTINGS,
        PAYLOAD,
      ),
    ).toEqual({ kind: 'job', resultId: 'r1', duplicate: false, refined: false });
    expect(
      await postCapture(
        respond(200, { kind: 'job', resultId: null, duplicate: true, refined: false }),
        SETTINGS,
        PAYLOAD,
      ),
    ).toEqual({ kind: 'job', resultId: null, duplicate: true, refined: false });
  });

  it('carries the opportunity a current server reports, and tolerates an older one', async () => {
    // Final review, Important 2 and Minor 14. The response contract is frozen: the four
    // original fields keep their meaning, and the two added ones are optional in both
    // directions.
    expect(
      await postCapture(
        respond(201, {
          kind: 'job',
          resultId: 'r1',
          duplicate: false,
          refined: false,
          opportunityId: 'o1',
          stage: 'interested',
        }),
        SETTINGS,
        PAYLOAD,
      ),
    ).toEqual({
      kind: 'job',
      resultId: 'r1',
      duplicate: false,
      refined: false,
      opportunityId: 'o1',
      stage: 'interested',
    });
    expect(
      await postCapture(
        respond(201, { kind: 'job', resultId: 'r1', duplicate: false, refined: false, extra: 1 }),
        SETTINGS,
        PAYLOAD,
      ),
    ).toMatchObject({ kind: 'job', resultId: 'r1' });
  });

  it('a refusal carries the server’s reason', async () => {
    const fetch = respond(422, {
      error: { code: 'unrecognized_page', reason: 'unsupported_path' },
    });
    expect(await postCapture(fetch, SETTINGS, PAYLOAD)).toEqual({
      kind: 'refused',
      reason: 'unsupported_path',
    });
  });

  it('401, 403, 413 and 429', async () => {
    expect(
      await postCapture(respond(401, { error: { code: 'unauthorized' } }), SETTINGS, PAYLOAD),
    ).toEqual({ kind: 'unauthorized' });
    expect(
      await postCapture(respond(403, { error: { code: 'forbidden' } }), SETTINGS, PAYLOAD),
    ).toEqual({ kind: 'forbidden' });
    expect(await postCapture(respond(413, undefined), SETTINGS, PAYLOAD)).toEqual({
      kind: 'too_large',
    });
    expect(
      await postCapture(
        respond(429, { error: { code: 'rate_limited' } }, { 'retry-after': '120' }),
        SETTINGS,
        PAYLOAD,
      ),
    ).toEqual({ kind: 'rate_limited', retryAfterSec: 120 });
    expect(await postCapture(respond(429, undefined), SETTINGS, PAYLOAD)).toEqual({
      kind: 'rate_limited',
      retryAfterSec: null,
    });
  });

  it('other 4xx keep their error code; 5xx and odd bodies are server errors', async () => {
    expect(
      await postCapture(respond(422, { error: { code: 'invalid_posting' } }), SETTINGS, PAYLOAD),
    ).toEqual({ kind: 'invalid', status: 422, code: 'invalid_posting' });
    expect(
      await postCapture(respond(400, { error: { code: 'validation' } }), SETTINGS, PAYLOAD),
    ).toEqual({ kind: 'invalid', status: 400, code: 'validation' });
    expect(await postCapture(respond(404, '<html>'), SETTINGS, PAYLOAD)).toEqual({
      kind: 'invalid',
      status: 404,
      code: 'unknown',
    });
    expect(await postCapture(respond(500, undefined), SETTINGS, PAYLOAD)).toEqual({
      kind: 'server_error',
      status: 500,
    });
    expect(await postCapture(respond(200, { kind: 'banana' }), SETTINGS, PAYLOAD)).toEqual({
      kind: 'server_error',
      status: 200,
    });
  });

  it('a network failure (offline, TLS, redirect refused) is reported as unreachable', async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await postCapture(fetch, SETTINGS, PAYLOAD)).toEqual({ kind: 'network' });
  });
});

describe('testConnection', () => {
  it('sends a deliberately unrecognizable page', async () => {
    const fetch = respond(422, {
      error: { code: 'unrecognized_page', reason: 'unsupported_path' },
    });
    await testConnection(fetch, SETTINGS);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(CONNECTION_TEST_PAYLOAD);
    expect(new URL(CONNECTION_TEST_PAYLOAD.url).protocol).toBe('https:');
  });

  it('treats the expected 422 refusal as connected with a valid token', async () => {
    const fetch = respond(422, {
      error: { code: 'unrecognized_page', reason: 'unsupported_path' },
    });
    expect(await testConnection(fetch, SETTINGS)).toEqual({ kind: 'connected' });
  });

  it('reports token and reachability problems as such', async () => {
    expect(
      await testConnection(respond(401, { error: { code: 'unauthorized' } }), SETTINGS),
    ).toEqual({ kind: 'unauthorized' });
    expect(await testConnection(respond(403, { error: { code: 'forbidden' } }), SETTINGS)).toEqual({
      kind: 'forbidden',
    });
    expect(await testConnection(respond(429, undefined), SETTINGS)).toEqual({
      kind: 'rate_limited',
      retryAfterSec: null,
    });
  });

  it('anything accepted is unexpected (it should never create data)', async () => {
    expect(
      await testConnection(
        respond(201, { kind: 'profile', contactId: 'c1', created: true, refined: false }),
        SETTINGS,
      ),
    ).toEqual({ kind: 'server_error', status: 201 });
  });
});
