import { InvalidTransitionError } from '@opportun/core';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { audit } from '../src/lib/audit';
import { captureLogs, testApp, type TestAppOptions } from './helpers';
import { queryAll, queryOne } from './db';

const SESSION = 'opportun_session';
const CSRF = 'opportun_csrf';
const PASSWORD = 'correct horse battery';
// img-src adds data: for the TOTP enrollment QR (iteration 3 plan, Task 3); nothing else loosens.
const CSP = "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

interface Cookie {
  name: string;
  value: string;
  httpOnly?: boolean;
  sameSite?: string;
  path?: string;
  secure?: boolean;
}

function cookie(res: LightMyRequestResponse, name: string): Cookie | undefined {
  return (res.cookies as Cookie[]).find((c) => c.name === name);
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(
  overrides: Parameters<typeof testApp>[0] = {},
  opts: TestAppOptions = {},
): Promise<FastifyInstance> {
  ({ app } = await testApp(overrides, opts));
  return app;
}

async function registerAdmin(a: FastifyInstance): Promise<{ session: string; csrf: string }> {
  const res = await a.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email: 'ada@example.com', password: PASSWORD, displayName: 'Ada' },
  });
  expect(res.statusCode).toBe(201);
  return {
    session: cookie(res, SESSION)?.value as string,
    csrf: cookie(res, CSRF)?.value as string,
  };
}

interface AuditRow {
  user_id: string | null;
  event: string;
  detail: string | null;
  ip: string | null;
}

async function auditRows(a: FastifyInstance, event?: string): Promise<AuditRow[]> {
  const sql = 'SELECT user_id, event, detail, ip FROM audit_log';
  return (
    event === undefined
      ? await queryAll(a, `${sql} ORDER BY created_at, id`)
      : await queryAll(a, `${sql} WHERE event = ? ORDER BY created_at, id`, event)
  ) as AuditRow[];
}

describe('security headers', () => {
  it('sets CSP, nosniff, referrer and permissions policy on /healthz', async () => {
    const a = await boot();
    const res = await a.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('sets them on api errors too', async () => {
    const a = await boot();
    const res = await a.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-security-policy']).toBe(CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sends HSTS only when the public base URL is https', async () => {
    const tls = await boot({ baseUrl: 'https://jobs.example.com' });
    for (const url of ['/healthz', '/api/v1/nope']) {
      const res = await tls.inject({ method: 'GET', url });
      expect(res.headers['strict-transport-security'], url).toBe('max-age=31536000');
    }
    await tls.close();
    const plain = await boot({ baseUrl: 'http://localhost:8080' });
    const res = await plain.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers).not.toHaveProperty('strict-transport-security');
  });
});

describe('csrf', () => {
  it('issues a readable csrf cookie with every new session', async () => {
    const a = await boot();
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'ada@example.com', password: PASSWORD, displayName: 'Ada' },
    });
    const c = cookie(res, CSRF);
    expect(c?.value).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(c?.httpOnly).toBeFalsy();
    expect(c?.sameSite).toBe('Lax');
    expect(c?.path).toBe('/');

    const login = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ada@example.com', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect(cookie(login, CSRF)?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie(login, CSRF)?.value).not.toBe(c?.value);
  });

  it('rejects a POST without the header, with a mismatched header, accepts a matching one', async () => {
    const a = await boot();
    const { session, csrf } = await registerAdmin(a);
    const logout = (headers: Record<string, string>) =>
      a.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        cookies: { [SESSION]: session, [CSRF]: csrf },
        headers,
      });

    const missing = await logout({});
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toEqual({ error: { code: 'csrf' } });

    const mismatched = await logout({ 'x-csrf-token': `${csrf.slice(0, -1)}x` });
    expect(mismatched.statusCode).toBe(403);
    expect(mismatched.json()).toEqual({ error: { code: 'csrf' } });

    // The session survived both rejected attempts.
    const me = await a.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { [SESSION]: session },
    });
    expect(me.statusCode).toBe(200);

    const ok = await logout({ 'x-csrf-token': csrf });
    expect(ok.statusCode).toBe(204);
  });

  it('rejects a header with no csrf cookie, and guards PATCH and unknown api routes', async () => {
    const a = await boot();
    const { session, csrf } = await registerAdmin(a);
    const noCookie = await a.inject({
      method: 'PATCH',
      url: '/api/v1/admin/registration',
      payload: { open: true, password: PASSWORD },
      cookies: { [SESSION]: session },
      headers: { 'x-csrf-token': csrf },
    });
    expect(noCookie.statusCode).toBe(403);

    const patch = await a.inject({
      method: 'PATCH',
      url: '/api/v1/admin/registration',
      payload: { open: true, password: PASSWORD },
      cookies: { [SESSION]: session, [CSRF]: csrf },
    });
    expect(patch.statusCode).toBe(403);

    const unknown = await a.inject({ method: 'DELETE', url: '/api/v1/whatever/1' });
    expect(unknown.statusCode).toBe(403);
  });

  it('exempts login and register, and leaves GET alone', async () => {
    const a = await boot();
    await registerAdmin(a);
    const login = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ada@example.com', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const me = await a.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { [SESSION]: cookie(login, SESSION)?.value as string },
    });
    expect(me.statusCode).toBe(200);
  });

  it('clears the csrf cookie on logout', async () => {
    const a = await boot();
    const { session, csrf } = await registerAdmin(a);
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [SESSION]: session, [CSRF]: csrf },
      headers: { 'x-csrf-token': csrf },
    });
    expect(res.statusCode).toBe(204);
    expect(cookie(res, CSRF)?.value).toBe('');
  });
});

describe('central error handler', () => {
  const routes: TestAppOptions = {
    setup: (a) => {
      a.get('/api/v1/__test/zod', async () => {
        z.object({ n: z.number() }).parse({ n: 'not a number' });
        return {};
      });
      a.get('/api/v1/__test/transition', async () => {
        throw new InvalidTransitionError('applied', 'discovered');
      });
      a.get('/api/v1/__test/boom', async () => {
        throw new Error('database password is hunter2-internal');
      });
    },
  };

  it('maps a thrown zod error to 400 validation with issues', async () => {
    const a = await boot({}, routes);
    const res = await a.inject({ method: 'GET', url: '/api/v1/__test/zod' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('validation');
    expect(body.error.issues).toEqual([
      expect.objectContaining({ path: ['n'], code: 'invalid_type' }),
    ]);
  });

  it('maps request schema failures to the same 400 shape', async () => {
    const a = await boot();
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'ada@example.com', password: 'short', displayName: 'Ada' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
    expect(res.json().error.issues.length).toBeGreaterThan(0);
  });

  it('maps InvalidTransitionError to 422', async () => {
    const a = await boot({}, routes);
    const res = await a.inject({ method: 'GET', url: '/api/v1/__test/transition' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_transition');
  });

  it('hides unknown errors behind a generic 500 and logs the full error', async () => {
    const logs = captureLogs();
    const a = await boot({ logLevel: 'error' }, { ...routes, logStream: logs });
    const res = await a.inject({ method: 'GET', url: '/api/v1/__test/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal', message: 'Internal server error' } });
    expect(res.body).not.toContain('hunter2');
    expect(logs.text()).toContain('hunter2-internal');
  });
});

describe('logging', () => {
  it('redacts credentials from log lines', async () => {
    const logs = captureLogs();
    const a = await boot({ logLevel: 'info' }, { logStream: logs });
    a.log.info(
      {
        req: { headers: { authorization: 'Bearer AUTHZ', cookie: 'opportun_session=COOKIE' } },
        body: { password: 'PASSWD', token: 'TOKEN', apiKey: 'APIKEY', ciphertext: 'CIPHER' },
      },
      'probe',
    );
    const text = logs.text();
    expect(text).toContain('probe');
    for (const leak of ['AUTHZ', 'COOKIE', 'PASSWD', 'TOKEN', 'APIKEY', 'CIPHER']) {
      expect(text).not.toContain(leak);
    }
  });

  it('never logs the oauth code or state from the google callback url', async () => {
    const logs = captureLogs();
    const a = await boot({ logLevel: 'info' }, { logStream: logs });
    await a.inject({
      method: 'GET',
      url: '/api/v1/integrations/google/callback?code=OAUTHCODE123&state=OAUTHSTATE456&scope=x',
    });
    const text = logs.text();
    const urls = logs.lines
      .map((l) => JSON.parse(l) as { req?: { url?: string } })
      .flatMap((l) => (l.req?.url === undefined ? [] : [l.req.url]));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith('/api/v1/integrations/google/callback')).toBe(true);
    }
    expect(text).not.toContain('OAUTHCODE123');
    expect(text).not.toContain('OAUTHSTATE456');
  });

  it('keeps the query string on other request urls', async () => {
    const logs = captureLogs();
    const a = await boot({ logLevel: 'info' }, { logStream: logs });
    await a.inject({ method: 'GET', url: '/healthz?probe=visible' });
    expect(logs.text()).toContain('/healthz?probe=visible');
  });
});

describe('audit log', () => {
  it('writes rows with redacted detail', async () => {
    const a = await boot();
    await audit(a.db, 'test.event', {
      ip: '10.1.1.1',
      detail: { label: 'x', password: 'PASSWD', nested: { apiKey: 'APIKEY' } },
    });
    const [row] = await auditRows(a, 'test.event');
    expect(row).toMatchObject({ user_id: null, ip: '10.1.1.1' });
    expect(row?.detail).not.toContain('PASSWD');
    expect(row?.detail).not.toContain('APIKEY');
    expect(JSON.parse(row?.detail ?? '{}')).toMatchObject({ label: 'x' });
  });

  it('records auth.login_failed with the ip and never the password', async () => {
    const a = await boot();
    await registerAdmin(a);
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ada@example.com', password: 'wrong password!!' },
      remoteAddress: '10.9.9.9',
    });
    expect(res.statusCode).toBe(401);
    const rows = await auditRows(a, 'auth.login_failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ip).toBe('10.9.9.9');
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({ email: 'ada@example.com' });
    expect(JSON.stringify(rows)).not.toContain('wrong password');
  });

  it('records auth.login_throttled once per window when the limiter answers 429', async () => {
    const a = await boot();
    await registerAdmin(a);
    const attempt = () =>
      a.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'ada@example.com', password: 'wrong password!!' },
        remoteAddress: '10.9.9.9',
      });
    // The first ten attempts reach the handler, which audits them; the eleventh is refused by
    // the limiter before the handler runs, so only the limiter can leave a trace of it.
    for (let i = 0; i < 10; i++) expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(429);
    const rows = await auditRows(a, 'auth.login_throttled');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ip).toBe('10.9.9.9');
    expect(JSON.stringify(rows)).toContain('ada@example.com');
    expect(JSON.stringify(rows)).not.toContain('wrong password');
    // One row per key per window: a throttled flood cannot flood the log either.
    for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(429);
    expect(await auditRows(a, 'auth.login_throttled')).toHaveLength(1);
  });

  it('records register, login, password change and logout', async () => {
    const a = await boot();
    const { session, csrf } = await registerAdmin(a);
    const userId = ((await queryOne(a, 'SELECT id FROM users')) as { id: string }).id;
    await a.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ada@example.com', password: PASSWORD },
    });
    const pw = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { current: PASSWORD, next: 'a brand new passphrase' },
      cookies: { [SESSION]: session, [CSRF]: csrf },
      headers: { 'x-csrf-token': csrf },
    });
    expect(pw.statusCode).toBe(204);
    const rotated = cookie(pw, SESSION)?.value as string;
    const rotatedCsrf = cookie(pw, CSRF)?.value as string;
    const out = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [SESSION]: rotated, [CSRF]: rotatedCsrf },
      headers: { 'x-csrf-token': rotatedCsrf },
    });
    expect(out.statusCode).toBe(204);

    const rows = await auditRows(a);
    expect(rows.map((r) => r.event)).toEqual([
      'auth.register',
      'auth.login',
      'auth.password_changed',
      'auth.logout',
    ]);
    for (const r of rows) expect(r.user_id).toBe(userId);
    const all = JSON.stringify(rows);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('a brand new passphrase');
    expect(all).not.toContain(session);
  });
});
