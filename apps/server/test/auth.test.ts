import { createHash } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DUMMY_HASH } from '../src/lib/passwords';
import { createSession, getSessionUser } from '../src/lib/sessions';
import { testApp, type TestAppOptions } from './helpers';
import { bool, exec, queryAll, queryOne } from './db';

vi.mock('@node-rs/argon2', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@node-rs/argon2')>();
  return { ...mod, verify: vi.fn(mod.verify) };
});
const argon2 = await import('@node-rs/argon2');

const COOKIE = 'opportun_session';
const CSRF = 'opportun_csrf';
const PASSWORD = 'correct horse battery';
const DAY = 24 * 60 * 60 * 1000;

interface Cookie {
  name: string;
  value: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  path?: string;
  maxAge?: number;
  expires?: Date;
}

function sessionCookie(res: LightMyRequestResponse): Cookie | undefined {
  return (res.cookies as Cookie[]).find((c) => c.name === COOKIE);
}

/** CSRF token issued alongside each session token, keyed by session token. */
const csrfBySession = new Map<string, string>();

function remember(res: LightMyRequestResponse): string | undefined {
  const token = sessionCookie(res)?.value;
  const csrf = (res.cookies as Cookie[]).find((c) => c.name === CSRF)?.value;
  if (token && csrf) csrfBySession.set(token, csrf);
  return token;
}

/** Cookies and header for an unsafe request as the holder of `token`. */
function authed(token: string): {
  cookies: Record<string, string>;
  headers: Record<string, string>;
} {
  const csrf = csrfBySession.get(token) ?? '';
  return { cookies: { [COOKIE]: token, [CSRF]: csrf }, headers: { 'x-csrf-token': csrf } };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.mocked(argon2.verify).mockClear();
  csrfBySession.clear();
});

async function boot(baseUrl?: string, opts: TestAppOptions = {}): Promise<FastifyInstance> {
  ({ app } = await testApp(baseUrl ? { baseUrl } : {}, opts));
  return app;
}

function register(
  a: FastifyInstance,
  body: Record<string, unknown> = {},
  token?: string,
): Promise<LightMyRequestResponse> {
  return a.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email: 'ada@example.com', password: PASSWORD, displayName: 'Ada', ...body },
    cookies: token ? { [COOKIE]: token } : {},
  });
}

function login(
  a: FastifyInstance,
  email: string,
  password: string,
  ip = '10.0.0.1',
): Promise<LightMyRequestResponse> {
  return a.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
    remoteAddress: ip,
  });
}

function me(a: FastifyInstance, token: string | undefined): Promise<LightMyRequestResponse> {
  return a.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    cookies: token ? { [COOKIE]: token } : {},
  });
}

async function registerAdmin(a: FastifyInstance): Promise<string> {
  const res = await register(a);
  expect(res.statusCode).toBe(201);
  const token = remember(res);
  expect(token).toBeTruthy();
  return token as string;
}

async function count(a: FastifyInstance, sql: string, ...params: unknown[]): Promise<number> {
  return ((await queryOne(a, sql, ...params)) as { n: number }).n;
}

describe('POST /auth/register', () => {
  it('creates the first user as admin, sets a locked-down session cookie, closes registration', async () => {
    const a = await boot();
    const res = await register(a);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      user: { id: expect.any(String), email: 'ada@example.com', displayName: 'Ada', isAdmin: true },
    });

    const cookie = sessionCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.path).toBe('/');
    expect(cookie?.secure).toBeFalsy();
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url

    const user = (await queryOne(a, 'SELECT * FROM users')) as Record<string, unknown>;
    expect(bool(user.is_admin)).toBe(true);
    expect(user.email).toBe('ada@example.com');
    expect(user.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

    // Only the token hash is stored.
    const sessions = (await queryAll(a, 'SELECT id, user_id FROM sessions')) as {
      id: string;
      user_id: string;
    }[];
    expect(sessions).toEqual([{ id: sha256(cookie?.value ?? ''), user_id: user.id }]);

    const setting = (await queryOne(
      a,
      `SELECT user_id, value FROM settings WHERE key = 'registration_open'`,
    )) as { user_id: string | null; value: string };
    expect(setting).toEqual({ user_id: null, value: 'false' });
  });

  it('returns 403 registration_closed after the first user', async () => {
    const a = await boot();
    await registerAdmin(a);
    const res = await register(a, { email: 'bob@example.com' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: 'registration_closed' } });
    expect(sessionCookie(res)).toBeUndefined();
    expect(await count(a, 'SELECT count(*) AS n FROM users')).toBe(1);
  });

  it('lets an admin reopen registration; later users are not admins', async () => {
    const a = await boot();
    const admin = await registerAdmin(a);
    const open = await a.inject({
      method: 'PATCH',
      url: '/api/v1/admin/registration',
      payload: { open: true },
      ...authed(admin),
    });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({ open: true });

    const res = await register(a, { email: 'bob@example.com', displayName: 'Bob' });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.isAdmin).toBe(false);
    const bob = remember(res) as string;

    const denied = await a.inject({
      method: 'PATCH',
      url: '/api/v1/admin/registration',
      payload: { open: false },
      ...authed(bob),
    });
    expect(denied.statusCode).toBe(403);
    const anon = await a.inject({
      method: 'PATCH',
      url: '/api/v1/admin/registration',
      payload: { open: false },
      cookies: { [CSRF]: 'anon-csrf' },
      headers: { 'x-csrf-token': 'anon-csrf' },
    });
    expect(anon.statusCode).toBe(401);

    const close = await a.inject({
      method: 'PATCH',
      url: '/api/v1/admin/registration',
      payload: { open: false },
      ...authed(admin),
    });
    expect(close.json()).toEqual({ open: false });
    expect((await register(a, { email: 'cy@example.com' })).statusCode).toBe(403);
  });

  it('rejects a duplicate email with 409 when registration is open', async () => {
    const a = await boot();
    const admin = await registerAdmin(a);
    await a.inject({
      method: 'PATCH',
      url: '/api/v1/admin/registration',
      payload: { open: true },
      ...authed(admin),
    });
    const res = await register(a, { email: 'ADA@example.com' });
    expect(res.statusCode).toBe(409);
    expect(await count(a, 'SELECT count(*) AS n FROM users')).toBe(1);
  });

  it('validates the body: password min 12, email format, display name', async () => {
    const a = await boot();
    expect((await register(a, { password: 'short-11chr' })).statusCode).toBe(400);
    expect((await register(a, { email: 'not-an-email' })).statusCode).toBe(400);
    expect((await register(a, { displayName: '' })).statusCode).toBe(400);
    expect(await count(a, 'SELECT count(*) AS n FROM users')).toBe(0);
  });
});

describe('GET /auth/registration', () => {
  it('reports open before any account exists, unauthenticated', async () => {
    const a = await boot();
    const res = await a.inject({ method: 'GET', url: '/api/v1/auth/registration' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ open: true });
  });

  it('reports closed once the first account exists and nobody reopened it', async () => {
    const a = await boot();
    await registerAdmin(a);
    const res = await a.inject({ method: 'GET', url: '/api/v1/auth/registration' });
    expect(res.json()).toEqual({ open: false });
  });

  it('reports open once an admin reopens it, unauthenticated', async () => {
    const a = await boot();
    const admin = await registerAdmin(a);
    await a.inject({
      method: 'PATCH',
      url: '/api/v1/admin/registration',
      payload: { open: true },
      ...authed(admin),
    });
    const res = await a.inject({ method: 'GET', url: '/api/v1/auth/registration' });
    expect(res.json()).toEqual({ open: true });
  });
});

describe('POST /auth/login', () => {
  it('logs in with the right password, case-insensitive email', async () => {
    const a = await boot();
    await registerAdmin(a);
    const res = await login(a, 'Ada@Example.com', PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('ada@example.com');
    const cookie = sessionCookie(res);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.path).toBe('/');
    expect(await count(a, 'SELECT count(*) AS n FROM sessions')).toBe(2);
    expect((await me(a, cookie?.value)).statusCode).toBe(200);
  });

  it('returns the same 401 for a wrong password and an unknown email, both running argon2 verify', async () => {
    const a = await boot();
    await registerAdmin(a);
    const verify = vi.mocked(argon2.verify);
    verify.mockClear();

    const wrong = await login(a, 'ada@example.com', 'wrong password!!');
    expect(wrong.statusCode).toBe(401);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[0]).toMatch(/^\$argon2id\$/);
    expect(verify.mock.calls[0]?.[0]).not.toBe(DUMMY_HASH);

    const unknown = await login(a, 'nobody@example.com', 'wrong password!!');
    expect(unknown.statusCode).toBe(401);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[1]?.[0]).toBe(DUMMY_HASH);

    expect(unknown.json()).toEqual(wrong.json());
    expect(wrong.json()).toEqual({ error: { code: 'invalid_credentials' } });
    expect(sessionCookie(wrong)).toBeUndefined();
    expect(await count(a, 'SELECT count(*) AS n FROM sessions')).toBe(1);
  });

  it('rate limits the 11th attempt per IP and email with 429 and retry-after', async () => {
    const a = await boot();
    await registerAdmin(a);
    for (let i = 0; i < 10; i++) {
      expect((await login(a, 'ada@example.com', 'wrong password!!')).statusCode).toBe(401);
    }
    const limited = await login(a, 'ada@example.com', PASSWORD);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: { code: 'rate_limited' } });
    const retryAfter = Number(limited.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    expect(sessionCookie(limited)).toBeUndefined();

    // The per-(IP,email) bucket is per-IP, so a login from another IP is unaffected until the
    // per-account backstop (EMAIL_LIMIT in routes/auth.ts) fills; one such login is far below
    // its ceiling. The distributed case that DOES trip that backstop is its own test below.
    expect((await login(a, 'ada@example.com', PASSWORD, '10.0.0.2')).statusCode).toBe(200);
    expect((await login(a, 'other@example.com', PASSWORD)).statusCode).toBe(401);
  });
});

describe('login rate limit and proxies', () => {
  it('ignores X-Forwarded-For from a public client, so it cannot rotate past the limit', async () => {
    const a = await boot();
    await registerAdmin(a);
    const attempt = (i: number) =>
      a.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'ada@example.com', password: 'wrong password!!' },
        remoteAddress: '203.0.113.5',
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
      });
    for (let i = 0; i < 10; i++) expect((await attempt(i)).statusCode).toBe(401);
    expect((await attempt(99)).statusCode).toBe(429);
  });

  it('ignores X-Forwarded-For from a LAN client, so a private-range peer cannot rotate past the limit', async () => {
    const a = await boot();
    await registerAdmin(a);
    // A housemate's device on the home LAN: an RFC1918 address, inside the range the old
    // trustProxy default (uniquelocal) trusted. It forges a fresh X-Forwarded-For each time.
    // An instance that trusts no proxy by default keeps req.ip at the socket peer, so every
    // attempt lands in one bucket and the forged header never moves the counter. The 11th
    // being 429 (not 401 from a fresh bucket) is what proves the header was ignored.
    const attempt = (i: number) =>
      a.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'ada@example.com', password: 'wrong password!!' },
        remoteAddress: '192.168.1.50',
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
      });
    for (let i = 0; i < 10; i++) expect((await attempt(i)).statusCode).toBe(401);
    expect((await attempt(99)).statusCode).toBe(429);
  });

  it('with one trusted proxy, a forged extra X-Forwarded-For hop cannot rotate req.ip', async () => {
    // The boundary a trusted-proxy check gets wrong when it trusts too many hops. The proxy
    // (127.0.0.1, trusted) appends the real client as the rightmost entry; the attacker prepends
    // a fresh forged hop each time. Only the rightmost untrusted hop is taken, so req.ip stays
    // the one real client and the forged hop never opens a new bucket: the 11th is 429.
    ({ app } = await testApp({ trustedProxies: ['127.0.0.1'] }));
    const a = app!;
    await registerAdmin(a);
    const attempt = (i: number) =>
      a.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'ada@example.com', password: 'wrong password!!' },
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': `6.6.6.${i}, 203.0.113.9` },
      });
    for (let i = 0; i < 10; i++) expect((await attempt(i)).statusCode).toBe(401);
    expect((await attempt(99)).statusCode).toBe(429);
  });
});

describe('per-account login limit (issue #333)', () => {
  it('caps failed logins against one account across many source IPs (the distributed-attack backstop)', async () => {
    const a = await boot();
    await registerAdmin(a);
    // 30 wrong attempts against ada@, each from a different source IP, so neither the per-IP nor
    // the per-(IP,email) bucket ever fills: only a bucket keyed on the account itself can catch
    // a distributed attack. This is the property half 2 adds, and it is what inverts the old
    // "a different IP is always free" assumption, at the 30-per-15-minute ceiling rather than at
    // the per-(IP,email) 11th.
    for (let i = 0; i < 30; i++) {
      expect(
        (await login(a, 'ada@example.com', 'wrong password!!', `203.0.113.${i}`)).statusCode,
      ).toBe(401);
    }
    // The 31st, from yet another fresh IP, with the CORRECT password: 429 proves the refusal is
    // the per-account backstop draining, not bad credentials. This is also the accepted lockout
    // cost (bounded, self-healing in 15 minutes).
    expect((await login(a, 'ada@example.com', PASSWORD, '203.0.113.200')).statusCode).toBe(429);
  });

  it('throttles an unknown account the same as a real one, so throttling does not reveal which exist', async () => {
    const a = await boot();
    await registerAdmin(a);
    // The account attacked here was never registered. It must throttle identically to a real
    // one (the bucket is keyed on the attempted email before any lookup), or the presence of
    // throttling would be a user-enumeration oracle.
    for (let i = 0; i < 30; i++) {
      expect((await login(a, 'ghost@example.com', 'whatever!!', `203.0.113.${i}`)).statusCode).toBe(
        401,
      );
    }
    expect((await login(a, 'ghost@example.com', 'whatever!!', '203.0.113.200')).statusCode).toBe(
      429,
    );
  });

  it('does not drain the per-account bucket on successful logins, so a flaky client cannot lock itself out', async () => {
    const a = await boot();
    await registerAdmin(a);
    // EMAIL_LIMIT.limit (30) successful logins, each from a different source IP so the
    // per-(IP,email) bucket (cap 10) never trips either -- isolating the account-level bucket a
    // success must not spend from.
    for (let i = 0; i < 30; i++) {
      expect((await login(a, 'ada@example.com', PASSWORD, `203.0.113.${i}`)).statusCode).toBe(200);
    }
    // A 31st successful login, from yet another fresh IP: still 200. Before the fix this is 429,
    // because 30 prior successes drained the same bucket a distributed attacker's failures would
    // have had to work for.
    expect((await login(a, 'ada@example.com', PASSWORD, '203.0.113.200')).statusCode).toBe(200);
  });
});

// ADR-14: one install answers at localhost, at <machine>.local and at a LAN IP at the same
// time, so OPPORTUN_BASE_URL cannot decide Secure for all of them. The request decides.
describe('Secure cookie flag', () => {
  /** A phone or a housemate's desktop on the home network, over plain HTTP. */
  const LAN = '192.168.1.50';
  const HTTPS_BASE = 'https://opportun.example.com';

  /**
   * light-my-request has no TLS, so mark the injected socket encrypted: that is what
   * req.protocol reads for a direct HTTPS connection with no proxy in front of it.
   */
  const overTls: TestAppOptions = {
    setup: (a) => {
      a.addHook('onRequest', async (req) => {
        (req.raw.socket as { encrypted?: boolean }).encrypted = true;
      });
    },
  };

  function cookieNamed(res: LightMyRequestResponse, name: string): Cookie | undefined {
    return (res.cookies as Cookie[]).find((c) => c.name === name);
  }

  function registerFrom(
    a: FastifyInstance,
    opts: { remoteAddress?: string; headers?: Record<string, string> } = {},
  ): Promise<LightMyRequestResponse> {
    return a.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'ada@example.com', password: PASSWORD, displayName: 'Ada' },
      ...opts,
    });
  }

  it('leaves the cookies unmarked over plain HTTP even when the base URL is https', async () => {
    const a = await boot(HTTPS_BASE);
    const res = await registerFrom(a, { remoteAddress: LAN });
    expect(res.statusCode).toBe(201);
    expect(cookieNamed(res, COOKIE)?.secure).toBeFalsy();
    expect(cookieNamed(res, CSRF)?.secure).toBeFalsy();
    expect(cookieNamed(res, COOKIE)?.httpOnly).toBe(true);
  });

  it('marks the cookies Secure over HTTPS even when the base URL is http', async () => {
    const a = await boot(undefined, overTls);
    const res = await registerFrom(a);
    expect(res.statusCode).toBe(201);
    expect(cookieNamed(res, COOKIE)?.secure).toBe(true);
    expect(cookieNamed(res, CSRF)?.secure).toBe(true);
  });

  it('follows x-forwarded-proto from a proxy listed in OPPORTUN_TRUSTED_PROXIES (Caddy in deploy/)', async () => {
    // The true case still holds, but only when the proxy is explicitly trusted (issue #333):
    // trust is now configured, not inferred from the peer being in a private range.
    ({ app } = await testApp({ trustedProxies: ['127.0.0.1'] }));
    const res = await registerFrom(app!, {
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.statusCode).toBe(201);
    expect(cookieNamed(res, COOKIE)?.secure).toBe(true);
    expect(cookieNamed(res, CSRF)?.secure).toBe(true);
  });

  it('ignores x-forwarded-proto from an untrusted peer by default, so a client cannot forge https', async () => {
    // Proof the trust was withdrawn, not relocated (issue #333): with no OPPORTUN_TRUSTED_PROXIES
    // set, a peer at 127.0.0.1 claiming x-forwarded-proto: https does NOT get Secure cookies.
    // Before the fix this peer was inside the trusted range and the claim was honored.
    const a = await boot();
    const res = await registerFrom(a, {
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.statusCode).toBe(201);
    expect(cookieNamed(res, COOKIE)?.secure).toBeFalsy();
    expect(cookieNamed(res, CSRF)?.secure).toBeFalsy();
  });

  it('ignores x-forwarded-proto from a hop outside the trusted set', async () => {
    const a = await boot(HTTPS_BASE);
    const res = await registerFrom(a, {
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.statusCode).toBe(201);
    expect(cookieNamed(res, COOKIE)?.secure).toBeFalsy();
  });

  it('clears the cookies with the same flag the request earns', async () => {
    const a = await boot(HTTPS_BASE);
    const token = await registerAdmin(a);
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      remoteAddress: LAN,
      ...authed(token),
    });
    expect(res.statusCode).toBe(204);
    expect(cookieNamed(res, COOKIE)?.secure).toBeFalsy();
    expect(cookieNamed(res, CSRF)?.secure).toBeFalsy();
  });
});

describe('session lifecycle', () => {
  it('GET /auth/me returns the user, never the password hash; 401 without a session', async () => {
    const a = await boot();
    const token = await registerAdmin(a);
    const res = await me(a, token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: { id: expect.any(String), email: 'ada@example.com', displayName: 'Ada', isAdmin: true },
    });
    expect(res.body).not.toContain('argon2');

    expect((await me(a, undefined)).statusCode).toBe(401);
    expect((await me(a, 'not-a-real-token')).statusCode).toBe(401);
    expect((await me(a, undefined)).json()).toEqual({ error: { code: 'unauthorized' } });
  });

  it('logout deletes the session row and clears the cookie', async () => {
    const a = await boot();
    const token = await registerAdmin(a);
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      ...authed(token),
    });
    expect(res.statusCode).toBe(204);
    const cleared = sessionCookie(res);
    expect(cleared?.value).toBe('');
    expect(cleared?.path).toBe('/');
    expect(cleared?.expires?.getTime() ?? 0).toBeLessThan(Date.now());
    expect(await count(a, 'SELECT count(*) AS n FROM sessions WHERE id = ?', sha256(token))).toBe(
      0,
    );
    expect((await me(a, token)).statusCode).toBe(401);
  });

  it('password change invalidates other sessions and rotates the current one', async () => {
    const a = await boot();
    const first = await registerAdmin(a);
    const second = remember(await login(a, 'ada@example.com', PASSWORD)) as string;
    expect((await me(a, second)).statusCode).toBe(200);

    const bad = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { current: 'not my password', next: 'a brand new passphrase' },
      ...authed(first),
    });
    expect(bad.statusCode).toBe(403);
    expect((await me(a, second)).statusCode).toBe(200);

    const tooShort = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { current: PASSWORD, next: 'short' },
      ...authed(first),
    });
    expect(tooShort.statusCode).toBe(400);

    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { current: PASSWORD, next: 'a brand new passphrase' },
      ...authed(first),
    });
    expect(res.statusCode).toBe(204);
    const rotated = sessionCookie(res);
    expect(rotated?.httpOnly).toBe(true);
    expect(rotated?.value).not.toBe(first);

    expect((await me(a, second)).statusCode).toBe(401);
    expect((await me(a, first)).statusCode).toBe(401);
    expect((await me(a, rotated?.value)).statusCode).toBe(200);
    expect(await count(a, 'SELECT count(*) AS n FROM sessions')).toBe(1);

    expect((await login(a, 'ada@example.com', PASSWORD, '10.0.0.9')).statusCode).toBe(401);
    expect(
      (await login(a, 'ada@example.com', 'a brand new passphrase', '10.0.0.9')).statusCode,
    ).toBe(200);
  });

  it('password change requires a session', async () => {
    const a = await boot();
    await registerAdmin(a);
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { current: PASSWORD, next: 'a brand new passphrase' },
      cookies: { [CSRF]: 'anon-csrf' },
      headers: { 'x-csrf-token': 'anon-csrf' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('sessions', () => {
  async function setup(): Promise<{ a: FastifyInstance; userId: string }> {
    const a = await boot();
    await registerAdmin(a);
    const { id } = (await queryOne(a, 'SELECT id FROM users')) as { id: string };
    return { a, userId: id };
  }

  it('creates a 30 day absolute session and slides the idle window on use', async () => {
    const { a, userId } = await setup();
    const before = Date.now();
    const { token, expiresAt } = await createSession(a.db, userId, {
      ip: '1.2.3.4',
      userAgent: 'ua',
    });
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY);
    const row = (await queryOne(a, 'SELECT * FROM sessions WHERE id = ?', sha256(token))) as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      user_id: userId,
      ip: '1.2.3.4',
      user_agent: 'ua',
      expires_at: expiresAt,
    });

    const stale = Date.now() - 6 * DAY;
    await exec(a, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', stale, sha256(token));
    expect(await getSessionUser(a.db, token)).toEqual({ userId, isAdmin: true });
    const seen = (await queryOne(
      a,
      'SELECT last_seen_at AS t FROM sessions WHERE id = ?',
      sha256(token),
    )) as { t: number };
    expect(seen.t).toBeGreaterThan(stale);
  });

  it('expires after 7 idle days and deletes the row', async () => {
    const { a, userId } = await setup();
    const { token } = await createSession(a.db, userId, {});
    await exec(
      a,
      'UPDATE sessions SET last_seen_at = ? WHERE id = ?',
      Date.now() - 7 * DAY - 1000,
      sha256(token),
    );
    expect(await getSessionUser(a.db, token)).toBeNull();
    expect(await count(a, 'SELECT count(*) AS n FROM sessions WHERE id = ?', sha256(token))).toBe(
      0,
    );
  });

  it('expires at the absolute limit even when active', async () => {
    const { a, userId } = await setup();
    const { token } = await createSession(a.db, userId, {});
    await exec(a, 'UPDATE sessions SET expires_at = ? WHERE id = ?', Date.now() - 1, sha256(token));
    expect(await getSessionUser(a.db, token)).toBeNull();
    expect(await count(a, 'SELECT count(*) AS n FROM sessions WHERE id = ?', sha256(token))).toBe(
      0,
    );
  });
});
