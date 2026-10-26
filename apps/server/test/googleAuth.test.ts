import { describe, expect, it, vi } from 'vitest';
import { DOCS_SCOPES, readTokens } from '../src/lib/google';
import { useApi } from './api';
import { connectGoogle, fakeGoogle, type FakeGoogle } from './fakeGoogle';
import type { TestClient } from './isolation';
import { type HasDb, listTables, queryAll, queryOne, withFailingWrite } from './db';

let google: FakeGoogle;
const boot = useApi(() => {
  google = fakeGoogle();
  return { build: { google } };
});

const CLIENT_SECRET = 'GOCSPX-client-secret-value';

async function saveClient(c: TestClient) {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/integrations/google/client',
    payload: { clientId: 'client-id.apps.googleusercontent.com', clientSecret: CLIENT_SECRET },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ stored: true, validation: { ok: true, status: 'valid' } });
}

async function connectUrl(c: TestClient): Promise<URL> {
  const res = await c.request({
    method: 'GET',
    url: '/api/v1/integrations/google/connect?scopes=docs',
  });
  expect(res.statusCode).toBe(200);
  return new URL(res.json().authUrl as string);
}

/** Every row of every table, on either engine (listTables). */
async function dumpDatabase(app: HasDb): Promise<string> {
  const dumps: string[] = [];
  for (const t of await listTables(app))
    dumps.push(JSON.stringify(await queryAll(app, `SELECT * FROM "${t}"`)));
  return dumps.join('\n');
}

describe('google connection', () => {
  it('builds a consent URL with exactly the docs scopes, offline access and forced consent', async () => {
    const { a } = await boot();
    await saveClient(a);
    const url = await connectUrl(a);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual([
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/drive',
    ]);
    expect(url.searchParams.get('scope')).not.toMatch(/drive\.file/);
    expect(url.searchParams.get('scope')).not.toMatch(/gmail/);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/v1/integrations/google/callback',
    );
    expect(url.searchParams.get('client_id')).toBe('client-id.apps.googleusercontent.com');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('refuses to connect before client credentials exist, and rejects an unknown scope set', async () => {
    const { a } = await boot();
    const none = await a.request({
      method: 'GET',
      url: '/api/v1/integrations/google/connect?scopes=docs',
    });
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe('google_not_configured');
    await saveClient(a);
    const unknown = await a.request({
      method: 'GET',
      url: '/api/v1/integrations/google/connect?scopes=gmail.modify',
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('answers 403 to a callback with a bad, foreign or missing state, without exchanging the code', async () => {
    const { app, a, b } = await boot();
    await saveClient(a);
    await saveClient(b);
    const state = (await connectUrl(a)).searchParams.get('state')!;
    const tampered = `${state.slice(0, -2)}xx`;
    const cases = [
      a.request({
        method: 'GET',
        url: `/api/v1/integrations/google/callback?code=c&state=${encodeURIComponent(tampered)}`,
      }),
      a.request({
        method: 'GET',
        url: '/api/v1/integrations/google/callback?code=c&state=garbage',
      }),
      a.request({ method: 'GET', url: '/api/v1/integrations/google/callback?code=c' }),
      // b replays a's state: bound to a's session and user.
      b.request({
        method: 'GET',
        url: `/api/v1/integrations/google/callback?code=c&state=${encodeURIComponent(state)}`,
      }),
    ];
    for (const res of await Promise.all(cases)) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('bad_state');
    }
    // A second session of the same user cannot use it either.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'isolation-a@example.com', password: 'correct horse battery' },
    });
    expect(login.statusCode).toBe(200);
    const cookies = Object.fromEntries(
      (login.cookies as { name: string; value: string }[]).map((c) => [c.name, c.value]),
    );
    const other = await app.inject({
      method: 'GET',
      url: `/api/v1/integrations/google/callback?code=c&state=${encodeURIComponent(state)}`,
      cookies,
    });
    expect(other.statusCode).toBe(403);
    expect(google.exchanged).toEqual([]);
  });

  it('answers a session lookup failure differently from no session at all (issue #108)', async () => {
    const { app, a } = await boot();
    const spy = vi.spyOn(app.db, 'select').mockImplementationOnce(() => {
      throw new Error('connection lost');
    });
    try {
      const res = await a.request({
        method: 'GET',
        url: '/api/v1/integrations/google/callback?code=c',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('google=unavailable');
    } finally {
      spy.mockRestore();
    }
    expect(google.exchanged).toEqual([]);
  });

  it("an ordinary route still fails loudly on a lookup failure: it isn't treated as logged out", async () => {
    const { app, a } = await boot();
    const spy = vi.spyOn(app.db, 'select').mockImplementationOnce(() => {
      throw new Error('connection lost');
    });
    try {
      const res = await a.request({ method: 'GET', url: '/api/v1/auth/me' });
      expect(res.statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });

  it('stores tokens encrypted: no plaintext token or client secret anywhere in the database', async () => {
    const { app, a } = await boot();
    await connectGoogle(a);
    expect(google.exchanged).toEqual(['auth-code']);
    const dump = await dumpDatabase(app);
    expect(dump).not.toContain(google.nextTokens.access_token);
    expect(dump).not.toContain(google.nextTokens.refresh_token);
    expect(dump).not.toContain(CLIENT_SECRET);
    const rows = await queryAll(
      app,
      'SELECT kind, label FROM secrets WHERE user_id = ? ORDER BY label',
      a.userId,
    );
    expect(rows).toEqual([
      { kind: 'oauth_token', label: 'google_oauth_client_id' },
      { kind: 'oauth_token', label: 'google_oauth_client_secret' },
      { kind: 'oauth_token', label: 'google_tokens' },
    ]);
  });

  it('spends the state on its first use: a replayed callback is refused', async () => {
    const { app, a } = await boot();
    await saveClient(a);
    const state = (await connectUrl(a)).searchParams.get('state')!;
    const url = `/api/v1/integrations/google/callback?code=auth-code&state=${encodeURIComponent(state)}`;
    // The legitimate first use completes: the code is exchanged and the tokens are stored.
    const first = await a.request({ method: 'GET', url });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe('/settings/integrations');
    expect(google.exchanged).toEqual(['auth-code']);
    expect(await readTokens(app.db, { userId: a.userId, isAdmin: true })).toMatchObject({
      refreshToken: google.nextTokens.refresh_token,
    });
    // The same state again, from the same session and inside the ten minute window.
    const replay = await a.request({ method: 'GET', url });
    expect(replay.statusCode).toBe(403);
    expect(replay.json().error.code).toBe('bad_state');
    // The replayed code never reached Google, and the attempt is on the record.
    expect(google.exchanged).toEqual(['auth-code']);
    expect(
      await queryAll(app, "SELECT id FROM audit_log WHERE event = 'google.bad_state'"),
    ).toHaveLength(1);
  });

  it('redirects the callback to the integrations settings page', async () => {
    const { a } = await boot();
    await saveClient(a);
    const state = (await connectUrl(a)).searchParams.get('state')!;
    const res = await a.request({
      method: 'GET',
      url: `/api/v1/integrations/google/callback?code=x&state=${encodeURIComponent(state)}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/settings/integrations');
  });

  it('a callback with no session redirects into the app instead of a JSON 401', async () => {
    // The browser lands here from Google; without a session cookie for this host
    // (connect started on another origin) the user must get a page, not a dead end.
    const { app } = await boot();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/integrations/google/callback?code=x&state=y',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/settings/integrations?google=session');
  });

  it('reports status with the granted scopes, per user', async () => {
    const { a, b } = await boot();
    const before = await a.request({ method: 'GET', url: '/api/v1/integrations/google' });
    const setup = {
      redirectUri: 'http://localhost:3000/api/v1/integrations/google/callback',
      jsOrigin: 'http://localhost:3000',
      aiAvailable: false,
    };
    expect(before.json()).toEqual({
      connected: false,
      scopes: [],
      clientConfigured: false,
      clientId: null,
      ...setup,
      validation: null,
    });
    await connectGoogle(a);
    const after = await a.request({ method: 'GET', url: '/api/v1/integrations/google' });
    expect(after.json()).toEqual({
      connected: true,
      scopes: [...DOCS_SCOPES].sort(),
      email: 'connected@example.com',
      clientConfigured: true,
      clientId: 'client-id.apps.googleusercontent.com',
      ...setup,
      validation: { ok: true, status: 'valid', checkedAt: expect.any(Number) },
    });
    const asB = await b.request({ method: 'GET', url: '/api/v1/integrations/google' });
    expect(asB.json()).toMatchObject({ connected: false, scopes: [] });
  });

  it('disconnect revokes the refresh token and deletes the secrets', async () => {
    const { app, a } = await boot();
    await connectGoogle(a);
    const res = await a.request({ method: 'DELETE', url: '/api/v1/integrations/google' });
    expect(res.statusCode).toBe(204);
    expect(google.revoked).toEqual([google.nextTokens.refresh_token]);
    expect(await queryOne(app, 'SELECT count(*) AS n FROM secrets')).toEqual({ n: 0 });
    const status = await a.request({ method: 'GET', url: '/api/v1/integrations/google' });
    expect(status.json()).toMatchObject({ connected: false });
  });

  it('getClient refuses ungranted scopes and persists a rotated refresh token', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: true };
    await expect(app.googleConn.getClient(app.db, ctx, DOCS_SCOPES)).rejects.toMatchObject({
      code: 'google_not_configured',
    });
    await connectGoogle(a);
    await expect(
      app.googleConn.getClient(app.db, ctx, ['https://www.googleapis.com/auth/gmail.readonly']),
    ).rejects.toMatchObject({ code: 'google_scope_missing' });

    const client = await app.googleConn.getClient(app.db, ctx, DOCS_SCOPES);
    expect(client.credentials.refresh_token).toBe(google.nextTokens.refresh_token);
    client.emit('tokens', { access_token: 'ya29.rotated', refresh_token: '1//rotated' });
    await expect.poll(async () => (await readTokens(app.db, ctx))?.refreshToken).toBe('1//rotated');
    const stored = await readTokens(app.db, ctx);
    expect(stored).toMatchObject({ accessToken: 'ya29.rotated', email: 'connected@example.com' });
    expect(stored?.scopes).toEqual([...DOCS_SCOPES].sort());
    // A refresh without a new refresh token keeps the stored one.
    client.emit('tokens', { access_token: 'ya29.again' });
    await expect.poll(async () => (await readTokens(app.db, ctx))?.accessToken).toBe('ya29.again');
    expect((await readTokens(app.db, ctx))?.refreshToken).toBe('1//rotated');
    expect(await dumpDatabase(app)).not.toContain('1//rotated');
  });

  it('logs, rather than silently discards, a refreshed token that fails to persist (#147)', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: true };
    await connectGoogle(a);
    const client = await app.googleConn.getClient(app.db, ctx, DOCS_SCOPES);
    const errorSpy = vi.spyOn(app.log, 'error').mockImplementation(() => undefined as never);
    await withFailingWrite(app, 'secrets', { on: 'INSERT', message: 'boom' });

    // The library's own event, same as a real refresh: nothing here is called directly.
    client.emit('tokens', { access_token: 'ya29.lost-write' });
    await expect.poll(() => errorSpy.mock.calls.length).toBeGreaterThan(0);

    const [meta, msg] = errorSpy.mock.calls[0]!;
    expect(msg).toBe('failed to persist a refreshed Google token');
    expect(meta).toMatchObject({ userId: a.userId });
    expect(String((meta as { err: unknown }).err)).toContain('boom');
    // The write really did not land: it is a lost write that got logged, not a cosmetic one.
    expect((await readTokens(app.db, ctx))?.accessToken).not.toBe('ya29.lost-write');
  });
});
