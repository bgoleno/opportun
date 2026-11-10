// The per-user capture budget (https://github.com/bgoleno/opportun/issues/272). One user's
// burst of captures must not be able to fill the connection pool for everyone else, so
// POST /capture (the web app's paste or link dialog) and POST /connector/capture (the browser
// extension, any of the user's tokens) spend one shared budget per user. The extension's
// per-token budget stays as it was. Each refusal names the limit it hit, so each client can
// say which one and when to try again.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertLeads } from '../src/jobs/discoveryRun';
import { CAPTURE_USER_LIMIT } from '../src/lib/captureLimit';
import { ensureChannelSource } from '../src/repos/discovery';
import { useApi } from './api';
import { PROFILE } from './fixtures/capture/pages';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const PASSWORD = 'correct horse battery';
const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

const EXTRACTED = {
  companyName: 'Initech',
  title: 'Staff Platform Engineer',
  location: 'Austin, TX',
  remote: 'hybrid' as const,
  compNote: null,
  descriptionMd: 'Own the payments platform.',
  postingUrl: 'https://careers.initech.example/jobs/42',
};
const PASTED =
  'Staff Platform Engineer at Initech (Austin, TX, hybrid). Own the payments platform.';

// The clock stands still, so every bucket refills only when a test moves it.
const START = Date.UTC(2026, 10, 10, 12);
beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ['Date'] });
  vi.mocked(runStructured).mockReset();
  // The web capture's extraction answers; the extension's refinement has no key, so its
  // deterministic reading stands, as in connectorCapture.test.ts.
  vi.mocked(runStructured).mockImplementation(async (_deps, task) => {
    if (task === 'capture.extract') return EXTRACTED as never;
    throw new AiUnavailableError('no_key');
  });
});
afterEach(() => {
  vi.useRealTimers();
});

async function token(c: TestClient): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/device-tokens',
    payload: { name: 'Browser extension', scopes: ['capture:push'], password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { token: string }).token;
}

function push(app: FastifyInstance, bearer: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/connector/capture',
    headers: { authorization: `Bearer ${bearer}` },
    payload: PROFILE,
  });
}

function paste(c: TestClient, extra: Record<string, unknown> = {}) {
  return c.request({ method: 'POST', url: '/api/v1/capture', payload: { text: PASTED, ...extra } });
}

/** `n` extension captures on one token, each accepted. */
async function pushes(app: FastifyInstance, bearer: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await push(app, bearer);
    expect([200, 201], res.body).toContain(res.statusCode);
  }
}

/** A partial lead from an alert email, which a capture with its resultId completes. */
async function alertLead(app: FastifyInstance, c: TestClient): Promise<string> {
  const ctx = ctxOf(c);
  const source = await ensureChannelSource(app.db, ctx, 'alert_email');
  const { inserted } = await insertLeads(
    app.db,
    ctx,
    [{ company: 'Initech', title: 'Staff Platform Engineer', location: 'Austin, TX' }],
    source.id,
  );
  expect(inserted[0]?.resolution).toBe('needs_capture');
  return inserted[0]!.id;
}

const PER_USER_REFUSAL = {
  error: { code: 'rate_limited', reason: 'per_user', max: 60, windowMinutes: 15 },
};

describe('the per-user capture budget', () => {
  it('is 60 captures per 15 minutes', () => {
    // The number the clients show comes from the refusal itself; this pins the constant the
    // PR reasons about, so a change to it is a visible decision.
    expect(CAPTURE_USER_LIMIT).toEqual({ limit: 60, windowMs: 15 * 60 * 1000 });
  });

  it('refuses the 61st capture across the web app and every token, and leaves another user alone', async () => {
    const { app, a, b } = await boot();
    // 59 from the extension on two tokens (each under its own 30), then 1 from the web app
    // that completes an alert's lead: that one request is one unit, like any other capture.
    await pushes(app, await token(a), 30);
    await pushes(app, await token(a), 29);
    const completed = await paste(a, { resultId: await alertLead(app, a) });
    expect(completed.statusCode, completed.body).toBe(200);

    const web = await paste(a);
    expect(web.statusCode, web.body).toBe(429);
    expect(web.json()).toEqual(PER_USER_REFUSAL);
    // One unit comes back every 15 s (60 per 900 s).
    expect(web.headers['retry-after']).toBe('15');

    // A fresh token does not get the user a fresh budget.
    const fresh = await push(app, await token(a));
    expect(fresh.statusCode, fresh.body).toBe(429);
    expect(fresh.json()).toEqual(PER_USER_REFUSAL);

    // The other user's captures, on both routes, are untouched.
    const theirs = await paste(b);
    expect(theirs.statusCode, theirs.body).toBe(201);
    const theirPush = await push(app, await token(b));
    expect([200, 201], theirPush.body).toContain(theirPush.statusCode);

    // Once a unit is back, the first user can capture again.
    vi.setSystemTime(START + 15_000);
    expect((await paste(a)).statusCode).not.toBe(429);
  });

  it("a request the user's budget refuses does not use up the token's own budget", async () => {
    const { app, a } = await boot();
    const first = await token(a);
    await pushes(app, first, 25);
    await pushes(app, await token(a), 30);
    for (let i = 0; i < 5; i++) expect((await paste(a)).statusCode).not.toBe(429);
    // The user has spent 60; the first token 25 of its 30.
    for (let i = 0; i < 5; i++) {
      const res = await push(app, first);
      expect(res.statusCode).toBe(429);
      expect(res.json().error.reason).toBe('per_user');
    }
    // A minute on, the user has 4 units back and the token 2 more: 7 in all, if the five
    // refusals above were given back. Otherwise it would have 2, and the third capture below
    // would be refused by the token's own limit.
    vi.setSystemTime(START + 60_000);
    await pushes(app, first, 4);
    const fifth = await push(app, first);
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error.reason).toBe('per_user');
  });
});
