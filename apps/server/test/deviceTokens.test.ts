// Device tokens (FR-M5, FR-C5; plan Task 8 and Review Focus 1): shown once, stored hashed,
// scoped, revocable on the very next request, and strictly separate from session auth.
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, deviceTokens } from '../src/db/schema';
import { deviceRoute, requireDevice } from '../src/lib/deviceTokens';
import { requireUser } from '../src/repos/base';
import { useApi } from './api';
import { captureLogs, testApp } from './helpers';
import { assertIsolated, registerTwoUsers, type TestClient } from './isolation';

const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const PASSWORD = 'correct horse battery';

/** Test-only routes standing in for the connector endpoints (Tasks 9 and 13). */
function deviceTestRoutes(app: FastifyInstance): void {
  app.register(
    async (api) => {
      api.get('/test/device/mail', deviceRoute('mail:push'), async (req) => ({
        userId: requireDevice(req).userId,
      }));
      api.post('/test/device/mail', deviceRoute('mail:push'), async (req) => ({
        userId: requireDevice(req).userId,
      }));
      api.get('/test/device/capture', deviceRoute('capture:push'), async (req) => ({
        userId: requireDevice(req).userId,
      }));
      // A device route whose handler (wrongly) asks for a session: it must never get one.
      api.get('/test/device/session-probe', deviceRoute('mail:push'), async (req) => ({
        userId: requireUser(req).userId,
      }));
    },
    { prefix: '/api/v1' },
  );
}

const boot = useApi(() => ({ setup: deviceTestRoutes }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

async function create(
  c: TestClient,
  scopes: string[] = ['mail:push'],
  name = 'MacBook connector',
): Promise<{ id: string; token: string }> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/device-tokens',
    payload: { name, scopes, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string };
}

function bearer(app: FastifyInstance, method: 'GET' | 'POST', url: string, token: string) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(method === 'POST' ? { payload: {} } : {}),
  });
}

describe('device token lifecycle', () => {
  it('create returns the token once; list and storage never hold it', async () => {
    const { app, a } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/device-tokens',
      payload: { name: 'MacBook connector', scopes: ['mail:push'], password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown> & { token: string; id: string };
    expect(body.token).toMatch(/^odt_[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({ name: 'MacBook connector', scopes: ['mail:push'] });

    const list = await a.request({ method: 'GET', url: '/api/v1/device-tokens' });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(body.token);
    expect(list.body).not.toMatch(/hash/i);
    expect(list.json().items).toEqual([
      {
        id: body.id,
        name: 'MacBook connector',
        scopes: ['mail:push'],
        lastUsedAt: null,
        revokedAt: null,
        createdAt: T0,
      },
    ]);

    const row = (await app.db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.id, body.id))
      .get())!;
    expect(row.tokenHash).toBe(createHash('sha256').update(body.token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(body.token);
    expect(JSON.stringify(await app.db.select().from(auditLog).all())).not.toContain(body.token);
  });

  it('validates name and scopes', async () => {
    const { a } = await boot();
    const post = (payload: Record<string, unknown>) =>
      a.request({
        method: 'POST',
        url: '/api/v1/device-tokens',
        payload: { ...payload, password: PASSWORD },
      });
    expect((await post({ name: 'x', scopes: [] })).statusCode).toBe(400);
    expect((await post({ name: 'x', scopes: ['admin'] })).statusCode).toBe(400);
    expect((await post({ name: '', scopes: ['mail:push'] })).statusCode).toBe(400);
    const dup = await post({ name: 'x', scopes: ['mail:push', 'mail:push'] });
    expect(dup.statusCode).toBe(201);
    expect(dup.json().scopes).toEqual(['mail:push']);
  });

  it('creating a token needs the current password (a hijacked cookie cannot mint one)', async () => {
    const { app, a } = await boot();
    const post = (extra: Record<string, unknown>) =>
      a.request({
        method: 'POST',
        url: '/api/v1/device-tokens',
        payload: { name: 'stolen', scopes: ['mail:push'], ...extra },
      });
    expect((await post({})).statusCode).toBe(400);
    const wrong = await post({ password: 'not the password at all' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('invalid_password');
    expect(wrong.body).not.toContain('odt_');
    expect(await app.db.select().from(deviceTokens).all()).toHaveLength(0);
    const events = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'auth.reauth_failed'))
      .all();
    expect(events[0]!.detail).toEqual({ action: 'device_token.create' });
  });

  it('a token authenticates its own user on an opted-in route, bearer only, no CSRF', async () => {
    const { app, a } = await boot();
    const { token } = await create(a);
    const get = await bearer(app, 'GET', '/api/v1/test/device/mail', token);
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ userId: a.userId });
    const post = await bearer(app, 'POST', '/api/v1/test/device/mail', token);
    expect(post.statusCode).toBe(200);
  });

  it('records last use, at most once a minute', async () => {
    const { app, a } = await boot();
    const { id, token } = await create(a);
    const lastUsed = async () =>
      (await app.db.select().from(deviceTokens).where(eq(deviceTokens.id, id)).get())!.lastUsedAt;
    await bearer(app, 'GET', '/api/v1/test/device/mail', token);
    expect(await lastUsed()).toBe(T0);
    vi.setSystemTime(T0 + 30_000);
    await bearer(app, 'GET', '/api/v1/test/device/mail', token);
    expect(await lastUsed()).toBe(T0);
    vi.setSystemTime(T0 + 61_000);
    await bearer(app, 'GET', '/api/v1/test/device/mail', token);
    expect(await lastUsed()).toBe(T0 + 61_000);
  });
});

describe('revocation (Review Focus 1)', () => {
  it('a revoked token fails on its very next request, not at some expiry', async () => {
    const { app, a } = await boot();
    const { id, token } = await create(a);
    expect((await bearer(app, 'GET', '/api/v1/test/device/mail', token)).statusCode).toBe(200);
    const del = await a.request({ method: 'DELETE', url: `/api/v1/device-tokens/${id}` });
    expect(del.statusCode).toBe(204);
    const after = await bearer(app, 'GET', '/api/v1/test/device/mail', token);
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('invalid_token');
    expect(after.headers['www-authenticate']).toBe('Bearer');

    const listed = (await a.request({ method: 'GET', url: '/api/v1/device-tokens' })).json()
      .items[0];
    expect(listed.revokedAt).toBe(T0);
    // Revoking again is harmless and keeps the first revocation time.
    vi.setSystemTime(T0 + 5_000);
    expect(
      (await a.request({ method: 'DELETE', url: `/api/v1/device-tokens/${id}` })).statusCode,
    ).toBe(204);
    expect(
      (await a.request({ method: 'GET', url: '/api/v1/device-tokens' })).json().items[0].revokedAt,
    ).toBe(T0);
    const events = (
      await app.db
        .select({ event: auditLog.event })
        .from(auditLog)
        .where(eq(auditLog.userId, a.userId))
        .all()
    ).map((r) => r.event);
    expect(events).toEqual(
      expect.arrayContaining(['device_token.created', 'device_token.revoked']),
    );
  });
});

describe('scope', () => {
  it('a token without the route scope is 403', async () => {
    const { app, a } = await boot();
    const { token } = await create(a, ['capture:push']);
    const res = await bearer(app, 'GET', '/api/v1/test/device/mail', token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
    expect((await bearer(app, 'GET', '/api/v1/test/device/capture', token)).statusCode).toBe(200);
  });

  it('a mail:push token can read nothing: every GET under the API refuses it', async () => {
    const { app, a } = await boot();
    const { token } = await create(a, ['mail:push', 'capture:push']);
    const urls = apiGetRoutes(app).filter((u) => !u.startsWith('/api/v1/test/'));
    // The parser must actually see the API, or this test proves nothing.
    expect(urls.length).toBeGreaterThan(40);
    expect(urls).toContain('/api/v1/device-tokens');
    expect(urls).toContain('/api/v1/opportunities/x0000000-0000-7000-8000-000000000000');
    for (const url of urls) {
      const withBearer = await bearer(app, 'GET', url, token);
      if (!PUBLIC_GETS.has(url)) {
        expect(withBearer.statusCode, `${url} answered a device token`).toBeGreaterThanOrEqual(400);
      }
      // ...and the bearer changes nothing: the same answer as no credentials at all.
      const anonymous = await app.inject({ method: 'GET', url });
      expect(withBearer.statusCode, url).toBe(anonymous.statusCode);
      expect(withBearer.body, url).toBe(anonymous.body);
    }
  });
});

describe('strict separation of device and session auth', () => {
  it('a bearer device token is refused by normal session routes', async () => {
    const { app, a } = await boot();
    const { token } = await create(a);
    expect((await bearer(app, 'GET', '/api/v1/auth/me', token)).statusCode).toBe(401);
    expect((await bearer(app, 'GET', '/api/v1/device-tokens', token)).statusCode).toBe(401);
    // Unsafe session routes stop it even earlier (no CSRF pair), and nothing is created.
    const mint = await app.inject({
      method: 'POST',
      url: '/api/v1/device-tokens',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'escalate', scopes: ['mail:push'] },
    });
    expect(mint.statusCode).toBeGreaterThanOrEqual(401);
    expect(mint.statusCode).toBeLessThan(404);
    expect(await app.db.select().from(deviceTokens).all()).toHaveLength(1);
  });

  it('a session cookie is refused by device routes', async () => {
    const { app, a } = await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/test/device/mail' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_token');
    const post = await a.request({ method: 'POST', url: '/api/v1/test/device/mail', payload: {} });
    expect(post.statusCode).toBe(401);
    // Even with a valid bearer too, a device route never resolves the session.
    const { token } = await create(a);
    const probe = await app.inject({
      method: 'GET',
      url: '/api/v1/test/device/session-probe',
      cookies: { opportun_session: a.session },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(probe.statusCode).toBe(401);
    expect(probe.json().error.code).toBe('unauthorized');
  });

  it('a session token presented as a bearer is not a device token', async () => {
    const { app, a } = await boot();
    const res = await bearer(app, 'GET', '/api/v1/test/device/mail', a.session);
    expect(res.statusCode).toBe(401);
    for (const header of ['Bearer', 'Basic abc', `bearer odt_${'A'.repeat(43)}`, 'odt_x']) {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/test/device/mail',
        headers: { authorization: header },
      });
      expect(r.statusCode, header).toBe(401);
    }
  });
});

describe('isolation', () => {
  assertIsolated({
    name: 'device tokens (revoke by id)',
    setup: deviceTestRoutes,
    create: async (c) => (await create(c)).id,
    read: (c, id) => c.request({ method: 'DELETE', url: `/api/v1/device-tokens/${id}` }),
  });

  it("lists only the caller's tokens and authenticates each token as its owner only", async () => {
    const { app, a, b } = await boot();
    const ta = await create(a, ['mail:push'], 'A laptop');
    const tb = await create(b, ['mail:push'], 'B laptop');
    const names = async (c: TestClient) =>
      (await c.request({ method: 'GET', url: '/api/v1/device-tokens' }))
        .json()
        .items.map((i: { name: string }) => i.name);
    expect(await names(a)).toEqual(['A laptop']);
    expect(await names(b)).toEqual(['B laptop']);
    expect((await bearer(app, 'GET', '/api/v1/test/device/mail', ta.token)).json()).toEqual({
      userId: a.userId,
    });
    expect((await bearer(app, 'GET', '/api/v1/test/device/mail', tb.token)).json()).toEqual({
      userId: b.userId,
    });
    // B revoking A's token is a 404 and A's token keeps working (and vice versa).
    expect(
      (await b.request({ method: 'DELETE', url: `/api/v1/device-tokens/${ta.id}` })).statusCode,
    ).toBe(404);
    expect(
      (await a.request({ method: 'DELETE', url: `/api/v1/device-tokens/${tb.id}` })).statusCode,
    ).toBe(404);
    expect((await bearer(app, 'GET', '/api/v1/test/device/mail', ta.token)).statusCode).toBe(200);
    expect((await bearer(app, 'GET', '/api/v1/test/device/mail', tb.token)).statusCode).toBe(200);
  });
});

describe('secrecy', () => {
  it('the token never reaches a log line', async () => {
    const logs = captureLogs();
    const { app } = await testApp(
      { logLevel: 'trace' },
      { logStream: logs, setup: deviceTestRoutes },
    );
    try {
      const { a } = await registerTwoUsers(app);
      const { token } = await create(a);
      await bearer(app, 'GET', '/api/v1/test/device/mail', token);
      await bearer(app, 'GET', '/api/v1/auth/me', token);
      expect(logs.text()).toContain('/api/v1/test/device/mail');
      expect(logs.text()).not.toContain(token);
    } finally {
      await app.close();
    }
  });
});

describe('route guard', () => {
  it('refuses to register a device-auth route without the device preHandler', async () => {
    await expect(
      testApp(
        {},
        {
          setup: (app) => {
            app.get('/api/v1/test/bad', { config: { deviceAuth: true } }, async () => ({}));
          },
        },
      ),
    ).rejects.toThrow(/deviceAuth/);
  });

  describe('rename (design D6)', () => {
    it('renames a token', async () => {
      const { a } = await boot();
      const { id } = await create(a);
      const res = await a.request({
        method: 'PATCH',
        url: `/api/v1/device-tokens/${id}`,
        payload: { name: 'Mac mini' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id, name: 'Mac mini' });
      const list = await a.request({ method: 'GET', url: '/api/v1/device-tokens' });
      expect((list.json() as { items: { name: string }[] }).items[0]?.name).toBe('Mac mini');
    });

    it('trims the name', async () => {
      const { a } = await boot();
      const { id } = await create(a);
      const res = await a.request({
        method: 'PATCH',
        url: `/api/v1/device-tokens/${id}`,
        payload: { name: '  Laptop  ' },
      });
      expect(res.json()).toMatchObject({ name: 'Laptop' });
    });

    it('refuses an empty or over-long name', async () => {
      const { a } = await boot();
      const { id } = await create(a);
      for (const name of ['', '   ', 'x'.repeat(101)]) {
        const res = await a.request({
          method: 'PATCH',
          url: `/api/v1/device-tokens/${id}`,
          payload: { name },
        });
        expect(res.statusCode, JSON.stringify(name)).toBe(400);
      }
    });

    it('records the rename in the audit log, like create and revoke do', async () => {
      const { app, a } = await boot();
      const { id } = await create(a);
      await a.request({
        method: 'PATCH',
        url: `/api/v1/device-tokens/${id}`,
        payload: { name: 'Mac mini' },
      });
      const rows = await app.db.select().from(auditLog).all();
      const renamed = rows.find((r) => r.event === 'device_token.renamed');
      // Renaming is how a token you want to keep is made to look like something harmless.
      expect(renamed).toBeDefined();
      expect(JSON.stringify(renamed)).toContain('Mac mini');
      expect(JSON.stringify(renamed)).toContain('MacBook connector');
    });

    it('404s a token belonging to another user', async () => {
      const { a, b } = await boot();
      const { id } = await create(a);
      const res = await b.request({
        method: 'PATCH',
        url: `/api/v1/device-tokens/${id}`,
        payload: { name: 'theirs' },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

const PLACEHOLDER_ID = 'x0000000-0000-7000-8000-000000000000';

/**
 * GETs that answer without any credentials (the browser lands on the OAuth callback and is
 * redirected with an error flash; the login page lists the sign-in providers). The bearer
 * must still change nothing on them.
 */
const PUBLIC_GETS = new Set([
  '/api/v1/integrations/google/callback',
  '/api/v1/auth/oauth/providers',
  // Deliberately public (issue: the login page's registration link): POST /auth/register is
  // itself unauthenticated and already reveals this via its 403 registration_closed, so a
  // read-only GET of the same fact discloses nothing new.
  '/api/v1/auth/registration',
]);

/** Every GET route under /api, from Fastify's route tree, with params filled in. */
function apiGetRoutes(app: FastifyInstance): string[] {
  const tree = app.printRoutes({ commonPrefix: false, method: 'GET' });
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of tree.split('\n')) {
    // Each tree level is a 4-character indent before the "├── " or "└── " branch marker.
    const branch = Math.max(line.indexOf('├── '), line.indexOf('└── '));
    if (branch === -1 || branch % 4 !== 0) continue;
    const [segment, methods] = line.slice(branch + 4).split(' (');
    stack.length = branch / 4;
    stack.push(segment!);
    if (methods === undefined || !methods.replace(')', '').split(', ').includes('GET')) continue;
    const path = stack.join('');
    if (!path.startsWith('/api/')) continue;
    out.push(path.replace(/:[A-Za-z]+/g, PLACEHOLDER_ID));
  }
  return out;
}
