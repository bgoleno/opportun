// mockApi gives each route the status it is told (https://github.com/bgoleno/opportun/issues/941): a
// plain {status, body} was answered as a 200 with that as its body, so a refusal written so was never
// one, and the test passed on whatever the page does with a 200 it can't read.
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/lib/api';
import { takeMockProblems } from './mockProblems';
import { mockApi } from './render';

const REFUSAL = { error: { code: 'not_suppressing', message: 'Already done.' } };
const ended = (method = 'GET') =>
  api('/thing', { method }).then(
    (body) => ({ body }),
    (err: unknown) =>
      err instanceof ApiError ? { status: err.status, code: err.code } : { threw: String(err) },
  );

describe.each([
  ['plain', (answer: unknown) => answer],
  ['from a handler', (answer: unknown) => () => answer],
  ['from a handler that waits', (answer: unknown) => () => Promise.resolve(answer)],
])('an answer, %s', (_how, route) => {
  it('with a status is that status', async () => {
    mockApi({ 'GET /thing': route({ status: 409, body: REFUSAL }) });
    expect(await ended()).toEqual({ status: 409, code: 'not_suppressing' });
  });

  it('with no body, and with 204', async () => {
    mockApi({ 'GET /thing': route({ status: 502 }), 'POST /thing': route({ status: 204 }) });
    expect(await ended()).toEqual({ status: 502, code: 'http_502' });
    expect(await ended('POST')).toEqual({ body: undefined });
  });

  it('with no status is a 200, whatever status its body has', async () => {
    mockApi({
      'GET /thing': route({ id: 'c1', status: 'denied' }),
      'POST /thing': route({ connected: false, status: null }),
      'PUT /thing': route([1, 2]),
    });
    expect(await ended()).toEqual({ body: { id: 'c1', status: 'denied' } });
    expect(await ended('POST')).toEqual({ body: { connected: false, status: null } });
    expect(await ended('PUT')).toEqual({ body: [1, 2] });
  });

  it("is refused as an error's body without its status", async () => {
    mockApi({ 'GET /thing': route(REFUSAL) });
    await ended();
    expect(new Set(takeMockProblems())).toEqual(
      new Set(['GET /thing answers the error not_suppressing with 200']),
    );
  });

  it("is refused as an error's body with a status that isn't one's", async () => {
    mockApi({ 'GET /thing': route({ status: 201, body: REFUSAL }) });
    await ended();
    expect(new Set(takeMockProblems())).toEqual(
      new Set(['GET /thing answers the error not_suppressing with 201']),
    );
  });

  it('is refused with a numeric status among fields of its own', async () => {
    mockApi({ 'GET /thing': route({ status: 409, error: { code: 'x' } }) });
    await ended();
    expect(new Set(takeMockProblems())).toEqual(
      new Set(['GET /thing has a numeric status beside error: put them in body']),
    );
  });

  it("control: an error field that isn't an error's envelope is a body", async () => {
    mockApi({ 'GET /thing': route({ ok: false, error: 'HTTP 401', models: [] }) });
    expect(await ended()).toEqual({ body: { ok: false, error: 'HTTP 401', models: [] } });
    expect(takeMockProblems()).toEqual([]);
  });
});

it('a plain one that is never called is refused too', () => {
  mockApi({ 'DELETE /thing': REFUSAL });
  expect(takeMockProblems()).toEqual(['DELETE /thing answers the error not_suppressing with 200']);
});

it.fails('a test that leaves one fails', () => {
  mockApi({ 'DELETE /thing': REFUSAL });
});
