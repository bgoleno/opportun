// First-run tour and setup checklist state (FR-U11, FR-U12).
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { keyValidationKey } from '../src/lib/aiKeyValidate';
import { writeSetting } from '../src/lib/ai';
import { GMAIL_SCOPES, writeTokens } from '../src/lib/google';
import { useApi } from './api';
import { queryOne } from './db';
import type { TestClient } from './isolation';

const boot = useApi();
const URL = '/api/v1/onboarding';

const get = async (c: TestClient) => {
  const res = await c.request({ method: 'GET', url: URL });
  expect(res.statusCode).toBe(200);
  return res.json();
};

const putTour = (c: TestClient, payload: Record<string, unknown>) =>
  c.request({ method: 'PUT', url: `${URL}/tour`, payload });

async function addOpportunity(c: TestClient): Promise<void> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName: 'Acme', title: 'PM', sourceKind: 'import' },
  });
  expect(res.statusCode).toBe(201);
}

/** Adds an AI key through the real route. Offline, its inline validation fails (Invalid). */
async function addAiKey(c: TestClient): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/secrets',
    payload: { kind: 'ai_api_key', label: 'anthropic', value: 'sk-test-0123456789abcdef' },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().validation.ok).toBe(false);
  return res.json().id;
}

/** Stores what a successful validation stores: the key authenticated (Valid). */
async function markKeyValid(app: FastifyInstance, c: TestClient, secretId: string, models = []) {
  await writeSetting(
    app.db,
    { userId: c.userId, isAdmin: false },
    keyValidationKey(secretId, c.userId),
    {
      ok: true,
      provider: 'anthropic',
      models,
      expiresAt: null,
      checkedAt: Date.now(),
      error: null,
    },
  );
}

async function connectGmail(app: FastifyInstance, c: TestClient): Promise<void> {
  await writeTokens(
    app.db,
    { userId: c.userId, isAdmin: false },
    {
      accessToken: 'at',
      refreshToken: 'rt',
      expiryDate: null,
      scopes: [...GMAIL_SCOPES],
    },
  );
}

/** Signs `email` in again: a new session, as a second sign-in (or a second browser) would be. */
async function signInAgain(app: FastifyInstance, email: string): Promise<TestClient> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: 'correct horse battery' },
  });
  expect(res.statusCode).toBe(200);
  const cookie = (name: string) =>
    (res.cookies as { name: string; value: string }[]).find((x) => x.name === name)!.value;
  const session = cookie('opportun_session');
  const csrf = cookie('opportun_csrf');
  return {
    userId: res.json().user.id,
    session,
    csrf,
    request: ({ method, url, payload }) =>
      app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
        cookies: { opportun_session: session, opportun_csrf: csrf },
        headers: { 'x-csrf-token': csrf },
      }),
  };
}

/** Session created_at has millisecond resolution: make sure the next one is strictly later. */
const nextMs = () => new Promise((r) => setTimeout(r, 5));

describe('GET /onboarding', () => {
  it('returns the defaults for a brand-new account, with autoStart and demo false', async () => {
    const { a } = await boot();
    expect(await get(a)).toEqual({
      tour: { version: 1, status: 'not_started', stepId: null, startedAt: null, finishedAt: null },
      checklist: {
        aiKey: false,
        mail: false,
        firstOpportunity: false,
        dismissed: false,
        activatedAt: null,
      },
      autoStart: true,
      demo: false,
    });
  });

  it('does not auto-start for an account that already has an opportunity', async () => {
    const { a } = await boot();
    await addOpportunity(a);
    const body = await get(a);
    expect(body.autoStart).toBe(false);
    expect(body.checklist.firstOpportunity).toBe(true);
  });

  it('does not auto-start for an account that has any AI key, even an invalid one', async () => {
    const { a } = await boot();
    await addAiKey(a);
    const body = await get(a);
    expect(body.autoStart).toBe(false);
    // An Invalid key does not tick the checklist item.
    expect(body.checklist.aiKey).toBe(false);
  });

  it('does not auto-start once a tour row exists', async () => {
    const { a } = await boot();
    expect((await putTour(a, { status: 'skipped', stepId: 'welcome' })).statusCode).toBe(200);
    expect((await get(a)).autoStart).toBe(false);
  });

  it('ticks the AI key item only for a key whose last validation authenticated', async () => {
    const { app, a } = await boot();
    const id = await addAiKey(a);
    expect((await get(a)).checklist.aiKey).toBe(false);
    await markKeyValid(app, a, id);
    expect((await get(a)).checklist.aiKey).toBe(true);
  });

  it('counts an authenticated key with model errors (an amber state) as done', async () => {
    const { app, a } = await boot();
    const id = await addAiKey(a);
    await markKeyValid(app, a, id, [
      { model: 'claude-x', ok: false, error: 'model not available to this key' },
    ] as never);
    expect((await get(a)).checklist.aiKey).toBe(true);
  });

  it('ticks mail when Gmail is granted', async () => {
    const { app, a } = await boot();
    await connectGmail(app, a);
    expect((await get(a)).checklist.mail).toBe(true);
    const status = await a.request({ method: 'GET', url: '/api/v1/integrations/gmail' });
    expect(status.json().connected).toBe(true);
  });

  it('records activatedAt the first time all three are done, and keeps it after a key is deleted', async () => {
    const { app, a } = await boot();
    const id = await addAiKey(a);
    await markKeyValid(app, a, id);
    await connectGmail(app, a);
    expect((await get(a)).checklist.activatedAt).toBeNull();
    await addOpportunity(a);
    const first = (await get(a)).checklist.activatedAt;
    expect(typeof first).toBe('number');
    // Refetched on every window focus: a later GET, and concurrent ones, never re-stamp it.
    await nextMs();
    const again = await Promise.all([get(a), get(a), get(a)]);
    expect(again.map((r) => r.checklist.activatedAt)).toEqual([first, first, first]);

    const del = await a.request({ method: 'DELETE', url: `/api/v1/secrets/${id}` });
    expect(del.statusCode).toBe(204);
    const after = await get(a);
    expect(after.checklist.aiKey).toBe(false);
    expect(after.checklist.activatedAt).toBe(first);
  });

  it('requires a session', async () => {
    const { app } = await boot();
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(401);
  });
});

describe('PUT /onboarding/tour', () => {
  it('stamps startedAt on start and finishedAt on completion, server-side', async () => {
    const { a } = await boot();
    const before = Date.now();
    const started = await putTour(a, { status: 'in_progress', stepId: 'checklist' });
    expect(started.statusCode).toBe(200);
    expect(started.json().status).toBe('in_progress');
    expect(started.json().startedAt).toBeGreaterThanOrEqual(before);
    expect(started.json().finishedAt).toBeNull();

    const paused = await putTour(a, { status: 'paused', stepId: 'mail' });
    expect(paused.json()).toMatchObject({ status: 'paused', stepId: 'mail' });
    // Resuming a paused run is the same run: startedAt does not move.
    expect(paused.json().startedAt).toBe(started.json().startedAt);
    await nextMs();
    const resumed = await putTour(a, { status: 'in_progress', stepId: 'inbox' });
    expect(resumed.json().startedAt).toBe(started.json().startedAt);

    const done = await putTour(a, { status: 'completed', stepId: 'finish' });
    expect(done.json().finishedAt).toBeGreaterThanOrEqual(started.json().startedAt);
    expect((await get(a)).tour).toEqual(done.json());
  });

  it('records skipped with the step reached, visible from a second sign-in', async () => {
    const { app, a } = await boot();
    await putTour(a, { status: 'in_progress', stepId: 'checklist' });
    await putTour(a, { status: 'skipped', stepId: 'inbox' });
    const other = await signInAgain(app, 'isolation-a@example.com');
    expect((await get(other)).tour).toMatchObject({ status: 'skipped', stepId: 'inbox' });
  });

  it('starts a new run (fresh startedAt, cleared finishedAt) after a finished one', async () => {
    const { a } = await boot();
    const first = (await putTour(a, { status: 'in_progress', stepId: 'checklist' })).json();
    await putTour(a, { status: 'skipped', stepId: 'mail' });
    await nextMs();
    const again = (await putTour(a, { status: 'in_progress', stepId: 'checklist' })).json();
    expect(again.startedAt).toBeGreaterThan(first.startedAt);
    expect(again.finishedAt).toBeNull();
  });

  it('rejects an unknown status, an unknown step and extra fields, leaving state unchanged', async () => {
    const { app, a } = await boot();
    await putTour(a, { status: 'paused', stepId: 'mail' });
    const row = () =>
      queryOne(app, 'SELECT value FROM settings WHERE key = ?', `onboarding_tour:${a.userId}`);
    const before = await row();
    for (const payload of [
      { status: 'done', stepId: 'mail' },
      { status: 'paused', stepId: 'nope' },
      { status: 'paused', stepId: 'mail', startedAt: 1 },
      { status: 'not_started', stepId: null },
    ]) {
      const res = await putTour(a, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await row()).toEqual(before);
  });

  it('requires a CSRF token', async () => {
    const { app, a } = await boot();
    const res = await app.inject({
      method: 'PUT',
      url: `${URL}/tour`,
      payload: { status: 'skipped', stepId: 'welcome' },
      cookies: { opportun_session: a.session },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /onboarding/checklist', () => {
  it('records dismissed and rejects anything else', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'PATCH',
      url: `${URL}/checklist`,
      payload: { dismissed: true },
    });
    expect(res.statusCode).toBe(200);
    expect((await get(a)).checklist.dismissed).toBe(true);
    for (const payload of [{ dismissed: false }, { dismissed: true, activatedAt: 1 }]) {
      const bad = await a.request({ method: 'PATCH', url: `${URL}/checklist`, payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('onboarding isolation between users', () => {
  it("never reads or writes another user's state, in either direction", async () => {
    const { app, a, b } = await boot();
    for (const [writer, reader] of [
      [a, b],
      [b, a],
    ] as const) {
      const readerBefore = (await reader.request({ method: 'GET', url: URL })).body;
      await addOpportunity(writer);
      await connectGmail(app, writer);
      await putTour(writer, { status: 'paused', stepId: 'mail' });
      await writer.request({
        method: 'PATCH',
        url: `${URL}/checklist`,
        payload: { dismissed: true },
      });
      expect((await get(writer)).tour.status).toBe('paused');
      // Byte-identical: nothing the writer did leaked into the reader's response.
      expect((await reader.request({ method: 'GET', url: URL })).body).toBe(readerBefore);
    }
    for (const c of [a, b]) {
      const row = await queryOne<{ userId: string }>(
        app,
        'SELECT user_id AS "userId" FROM settings WHERE key = ?',
        `onboarding_tour:${c.userId}`,
      );
      expect(row?.userId).toBe(c.userId);
    }
  });
});

describe('demo instance', () => {
  it('a real instance reports demo false and keeps the brand-new-account rule', async () => {
    const { a } = await boot({ demo: false });
    await addOpportunity(a);
    expect(await get(a)).toMatchObject({ demo: false, autoStart: false });
  });

  it('auto-starts on every sign-in, even for an account with data, until the tour is touched', async () => {
    const { app, a } = await boot({ demo: true });
    await addOpportunity(a);
    expect(await get(a)).toMatchObject({ demo: true, autoStart: true });

    // Touched in this session (shown, then finished): not again in this session.
    await putTour(a, { status: 'in_progress', stepId: 'checklist' });
    expect((await get(a)).autoStart).toBe(false);
    await putTour(a, { status: 'completed', stepId: 'finish' });
    expect((await get(a)).autoStart).toBe(false);

    // A fresh sign-in gets it again, although the stored status is still completed.
    await nextMs();
    const next = await signInAgain(app, 'isolation-a@example.com');
    const body = await get(next);
    expect(body.tour.status).toBe('completed');
    expect(body.autoStart).toBe(true);
    // The first session is unaffected by the second one's existence.
    expect((await get(a)).autoStart).toBe(false);
  });

  it('a skip from the welcome screen also holds for the rest of the session only', async () => {
    const { app, a } = await boot({ demo: true });
    await putTour(a, { status: 'skipped', stepId: 'welcome' });
    expect((await get(a)).autoStart).toBe(false);
    await nextMs();
    const next = await signInAgain(app, 'isolation-a@example.com');
    expect((await get(next)).autoStart).toBe(true);
  });
});
