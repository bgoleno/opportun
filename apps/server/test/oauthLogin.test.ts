import { createHash } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeAndIdentify, providerFetchOptions } from '../src/lib/oauthProviders';
import { consumePasswordSetGrant, grantPasswordSet } from '../src/lib/oauthState';
import { createSafeFetch } from '../src/lib/safeFetch';
import { totpCode } from '../src/lib/totp';
import { useApi } from './api';
import { testApp } from './helpers';
import { fakeOAuth, type FakeIdentity, type FakeOAuth } from './fakeOAuth';
import { registerTwoUsers, type TestClient } from './isolation';
import { exec, queryAll, queryOne } from './db';
import { heldApart, holdAt } from './race';

let provider: FakeOAuth;
const boot = useApi(() => {
  provider = fakeOAuth();
  return { build: { oauth: { fetch: provider.fetch } } };
});

const CLIENT_SECRET = 'client-secret-value';

afterEach(() => {
  vi.useRealTimers();
});

const INTEGRATION_CLIENT_ID = 'integration-client.apps.googleusercontent.com';
const INTEGRATION_SECRET = 'GOCSPX-integration-client-secret';

/**
 * Saves a Google client under the Drive/Gmail integration (routes/googleAuth.ts), where the
 * guided setup wizard puts it. A well-formed id is stored even when the probe cannot reach
 * Google, so this needs no googleFetch of its own.
 */
async function configureIntegrationClient(c: TestClient) {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/integrations/google/client',
    payload: { clientId: INTEGRATION_CLIENT_ID, clientSecret: INTEGRATION_SECRET },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().stored).toBe(true);
}

async function configure(admin: TestClient, name: 'google' | 'github' | 'linkedin') {
  const res = await admin.request({
    method: 'PUT',
    url: `/api/v1/admin/oauth-providers/${name}`,
    payload: { clientId: `${name}-client-id`, clientSecret: CLIENT_SECRET },
  });
  expect(res.statusCode).toBe(200);
  return res;
}

describe('oauth provider configuration (admin)', () => {
  it('stores credentials and reports configured flags, never the secret', async () => {
    const { app, a } = await boot();
    const before = await a.request({ method: 'GET', url: '/api/v1/admin/oauth-providers' });
    expect(before.statusCode).toBe(200);
    expect(before.json().items).toEqual([
      {
        provider: 'google',
        configured: false,
        available: true,
        redirectUri: 'http://localhost:3000/api/v1/auth/oauth/google/callback',
        integrationClientId: null,
        sharesIntegrationClient: false,
      },
      {
        provider: 'github',
        configured: false,
        available: true,
        redirectUri: 'http://localhost:3000/api/v1/auth/oauth/github/callback',
        integrationClientId: null,
        sharesIntegrationClient: false,
      },
      {
        provider: 'linkedin',
        configured: false,
        available: true,
        redirectUri: 'http://localhost:3000/api/v1/auth/oauth/linkedin/callback',
        integrationClientId: null,
        sharesIntegrationClient: false,
      },
    ]);

    const put = await configure(a, 'github');
    expect(put.body).not.toContain(CLIENT_SECRET);
    expect(put.json()).toMatchObject({ provider: 'github', configured: true });

    const one = await a.request({ method: 'GET', url: '/api/v1/admin/oauth-providers/github' });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ provider: 'github', configured: true });
    expect(one.body).not.toContain(CLIENT_SECRET);
    expect(one.body).not.toContain('github-client-id');

    // The secret is sealed at rest: no table holds it in plaintext.
    const dump = (await queryAll(
      app,
      "SELECT value FROM settings WHERE key LIKE 'oauth_provider:%'",
    )) as { value: string }[];
    expect(dump).toHaveLength(1);
    expect(dump[0]!.value).not.toContain(CLIENT_SECRET);
    const audit = (await queryAll(
      app,
      "SELECT detail FROM audit_log WHERE event = 'admin.oauth_provider_configured'",
    )) as { detail: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).not.toContain(CLIENT_SECRET);
  });

  it('removes a provider configuration', async () => {
    const { a } = await boot();
    await configure(a, 'google');
    const del = await a.request({ method: 'DELETE', url: '/api/v1/admin/oauth-providers/google' });
    expect(del.statusCode).toBe(204);
    const one = await a.request({ method: 'GET', url: '/api/v1/admin/oauth-providers/google' });
    expect(one.json()).toMatchObject({ configured: false });
  });

  it('is admin-only: a regular user gets 403 on read, write and delete', async () => {
    const { b } = await boot();
    for (const req of [
      { method: 'GET' as const, url: '/api/v1/admin/oauth-providers' },
      { method: 'GET' as const, url: '/api/v1/admin/oauth-providers/google' },
      {
        method: 'PUT' as const,
        url: '/api/v1/admin/oauth-providers/google',
        payload: { clientId: 'x', clientSecret: 'y' },
      },
      { method: 'DELETE' as const, url: '/api/v1/admin/oauth-providers/google' },
      { method: 'POST' as const, url: '/api/v1/admin/oauth-providers/google/import' },
    ]) {
      const res = await b.request(req);
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(403);
    }
  });

  it('requires CSRF on writes', async () => {
    const { app, a } = await boot();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/oauth-providers/google',
      cookies: { opportun_session: a.session, opportun_csrf: a.csrf },
      payload: { clientId: 'x', clientSecret: 'y' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf');
  });

  it('rejects an unknown provider', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'PUT',
      url: '/api/v1/admin/oauth-providers/facebook',
      payload: { clientId: 'x', clientSecret: 'y' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists only configured providers publicly, without a session', async () => {
    const { app, a } = await boot();
    const none = await app.inject({ method: 'GET', url: '/api/v1/auth/oauth/providers' });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ providers: [] });
    await configure(a, 'github');
    const some = await app.inject({ method: 'GET', url: '/api/v1/auth/oauth/providers' });
    expect(some.json()).toEqual({ providers: ['github'] });
  });

  it('offers the Google client already saved for the integration, never its secret', async () => {
    const { a } = await boot();
    const none = await a.request({ method: 'GET', url: '/api/v1/admin/oauth-providers/google' });
    expect(none.json().integrationClientId).toBeNull();

    await configureIntegrationClient(a);

    const offered = await a.request({ method: 'GET', url: '/api/v1/admin/oauth-providers/google' });
    expect(offered.json().integrationClientId).toBe(INTEGRATION_CLIENT_ID);
    expect(offered.body).not.toContain(INTEGRATION_SECRET);
  });

  it('only Google has an integration client to offer', async () => {
    const { a } = await boot();
    await configureIntegrationClient(a);
    const all = await a.request({ method: 'GET', url: '/api/v1/admin/oauth-providers' });
    const byName = Object.fromEntries(
      (all.json().items as { provider: string; integrationClientId: string | null }[]).map((i) => [
        i.provider,
        i.integrationClientId,
      ]),
    );
    expect(byName).toEqual({
      google: INTEGRATION_CLIENT_ID,
      github: null,
      linkedin: null,
    });
  });

  it('imports the integration client, so sign-in runs on it without it being typed again', async () => {
    const { app, a } = await boot();
    await configureIntegrationClient(a);

    const res = await a.request({
      method: 'POST',
      url: '/api/v1/admin/oauth-providers/google/import',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ provider: 'google', configured: true });
    // The secret moves inside the server: it is in no response the browser ever sees.
    expect(res.body).not.toContain(INTEGRATION_SECRET);

    const s = await start(app, 'google', 'login');
    expect(s.url.searchParams.get('client_id')).toBe(INTEGRATION_CLIENT_ID);
    const code = provider.issue({ id: '808', email: null, emailVerified: false });
    await callback(app, 'google', { code, state: s.state }, { [OAUTH_COOKIE]: s.binding });
    const token = provider.calls.find((c) => c.url === 'https://oauth2.googleapis.com/token')!;
    expect(token.form!.get('client_secret')).toBe(INTEGRATION_SECRET);
  });

  it('says when sign-in and the integration have ended up on one client', async () => {
    const { a } = await boot();
    await configureIntegrationClient(a);
    const apart = await a.request({ method: 'GET', url: '/api/v1/admin/oauth-providers/google' });
    expect(apart.json().sharesIntegrationClient).toBe(false);

    await a.request({ method: 'POST', url: '/api/v1/admin/oauth-providers/google/import' });
    const shared = await a.request({ method: 'GET', url: '/api/v1/admin/oauth-providers/google' });
    expect(shared.json().sharesIntegrationClient).toBe(true);

    // Pasting a separate client over it uncouples them again.
    await configure(a, 'google');
    const again = await a.request({ method: 'GET', url: '/api/v1/admin/oauth-providers/google' });
    expect(again.json().sharesIntegrationClient).toBe(false);
  });

  it('refuses the import when no integration client is saved', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/admin/oauth-providers/google/import',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('integration_client_missing');
  });

  it('refuses the import for a provider with no integration behind it', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/admin/oauth-providers/github/import',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('import_unsupported');
  });

  it("imports from the admin's own integration client, not another user's", async () => {
    const { a, b } = await boot();
    // b is a regular user with a Google client of their own; a (the admin) has none.
    await configureIntegrationClient(b);
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/admin/oauth-providers/google/import',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('integration_client_missing');
  });
});

// ---------------------------------------------------------------------------
// Task 6: login, link and unlink flows

const PASSWORD = 'correct horse battery';
const A_EMAIL = 'isolation-a@example.com';
const OAUTH_COOKIE = 'opportun_oauth';

type Provider = 'google' | 'github' | 'linkedin';

function cookieOf(res: LightMyRequestResponse, name: string) {
  return (
    res.cookies as { name: string; value: string; httpOnly?: boolean; secure?: boolean }[]
  ).find((c) => c.name === name);
}

interface Started {
  url: URL;
  state: string;
  binding: string;
}

/**
 * Login: GET start as the browser would. Link: the signed-in SPA's POST with the current
 * password (re-auth), which answers the provider URL and sets the binding cookie.
 */
async function start(
  app: FastifyInstance,
  name: Provider,
  mode: 'login' | 'link',
  as?: TestClient,
): Promise<Started> {
  if (mode === 'link') {
    const linked = await as!.request({
      method: 'POST',
      url: `/api/v1/auth/oauth/${name}/link`,
      payload: { password: PASSWORD },
    });
    expect(linked.statusCode, linked.body).toBe(200);
    const binding = cookieOf(linked, OAUTH_COOKIE);
    expect(binding?.httpOnly).toBe(true);
    const url = new URL(linked.json().authUrl as string);
    return { url, state: url.searchParams.get('state')!, binding: binding!.value };
  }
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/oauth/${name}/start?mode=${mode}`,
    ...(as === undefined ? {} : { cookies: { opportun_session: as.session } }),
  });
  expect(res.statusCode, res.body).toBe(302);
  const binding = cookieOf(res, OAUTH_COOKIE);
  expect(binding?.httpOnly).toBe(true);
  const url = new URL(res.headers.location as string);
  return { url, state: url.searchParams.get('state')!, binding: binding!.value };
}

/** The provider redirecting the browser back to the callback. */
function callback(
  app: FastifyInstance,
  name: Provider,
  query: Record<string, string>,
  cookies: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/auth/oauth/${name}/callback?${new URLSearchParams(query).toString()}`,
    cookies,
    headers,
  });
}

/** What the TLS-terminating proxy in deploy/ adds, from a hop app.ts trusts. */
const OVER_HTTPS = { 'x-forwarded-proto': 'https' };

/** A full login round trip as an anonymous browser. */
async function oauthLogin(app: FastifyInstance, name: Provider, identity: FakeIdentity) {
  const s = await start(app, name, 'login');
  const code = provider.issue(identity);
  return callback(app, name, { code, state: s.state }, { [OAUTH_COOKIE]: s.binding });
}

/** A full link round trip from `as`'s signed-in browser. */
async function oauthLink(
  app: FastifyInstance,
  name: Provider,
  as: TestClient,
  identity: FakeIdentity,
) {
  const s = await start(app, name, 'link', as);
  const code = provider.issue(identity);
  return callback(
    app,
    name,
    { code, state: s.state },
    { [OAUTH_COOKIE]: s.binding, opportun_session: as.session, opportun_csrf: as.csrf },
  );
}

async function events(
  app: FastifyInstance,
  event: string,
): Promise<{ userId: string | null; detail: string }[]> {
  return (await queryAll(
    app,
    'SELECT user_id AS "userId", detail FROM audit_log WHERE event = ?',
    event,
  )) as { userId: string | null; detail: string }[];
}

async function oauthRows(app: FastifyInstance) {
  return (await queryAll(
    app,
    'SELECT user_id AS "userId", provider, provider_account_id AS "accountId" FROM oauth_accounts',
  )) as { userId: string; provider: string; accountId: string }[];
}

async function userCount(app: FastifyInstance): Promise<number> {
  return ((await queryOne(app, 'SELECT count(*) AS n FROM users')) as { n: number }).n;
}

async function me(app: FastifyInstance, session: string) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    cookies: { opportun_session: session },
  });
}

function setRegistration(a: TestClient, open: boolean) {
  return a.request({
    method: 'PATCH',
    url: '/api/v1/admin/registration',
    payload: { open, password: PASSWORD },
  });
}

const GH_ATTACKER: FakeIdentity = { id: '9001', email: A_EMAIL, emailVerified: false };

describe('oauth start', () => {
  it('redirects to google with a signed state, PKCE S256 and the exact redirect URI', async () => {
    const { a, app } = await boot();
    await configure(a, 'google');
    const s = await start(app, 'google', 'login');
    expect(s.url.origin + s.url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(s.url.searchParams.get('client_id')).toBe('google-client-id');
    expect(s.url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/v1/auth/oauth/google/callback',
    );
    expect(s.url.searchParams.get('scope')).toBe('openid email profile');
    expect(s.url.searchParams.get('response_type')).toBe('code');
    expect(s.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(s.url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.state.length).toBeGreaterThan(40);
    // The binding cookie is not the state, and the state does not carry it.
    expect(s.state).not.toContain(s.binding);
  });

  it('github gets PKCE S256 too, and the exchange carries the matching verifier', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    await oauthLink(app, 'github', a, { id: '606', email: null, emailVerified: false });
    provider.calls.length = 0;
    const s = await start(app, 'github', 'login');
    expect(s.url.origin + s.url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(s.url.searchParams.get('code_challenge_method')).toBe('S256');
    const challenge = s.url.searchParams.get('code_challenge')!;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const code = provider.issue({ id: '606', email: null, emailVerified: false });
    const res = await callback(
      app,
      'github',
      { code, state: s.state },
      { [OAUTH_COOKIE]: s.binding },
    );
    expect(res.headers.location).toBe('/');
    const token = provider.calls.find(
      (c) => c.url === 'https://github.com/login/oauth/access_token',
    )!;
    const verifier = token.form!.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
  });

  // ADR-14: the base URL here is http://localhost:3000, and the same install also answers
  // over https through the proxy in deploy/. The binding cookie follows the request.
  it('names and marks the binding cookie from the request scheme, not the base URL', async () => {
    // Trust the proxy at 127.0.0.1 so its x-forwarded-proto is honored (issue #333). The plain
    // request below arrives from an untrusted LAN peer (192.168.1.50) and is still seen as http.
    const { a, app } = await boot({ trustedProxies: ['127.0.0.1'] });
    await configure(a, 'google');
    const url = '/api/v1/auth/oauth/google/start?mode=login';

    const plain = await app.inject({ method: 'GET', url, remoteAddress: '192.168.1.50' });
    expect(plain.statusCode).toBe(302);
    expect(cookieOf(plain, OAUTH_COOKIE)?.secure).toBeFalsy();
    expect(cookieOf(plain, '__Host-opportun_oauth')).toBeUndefined();

    const tls = await app.inject({
      method: 'GET',
      url,
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(tls.statusCode).toBe(302);
    expect(cookieOf(tls, '__Host-opportun_oauth')?.secure).toBe(true);
    expect(cookieOf(tls, '__Host-opportun_oauth')?.httpOnly).toBe(true);
    expect(cookieOf(tls, OAUTH_COOKIE)).toBeUndefined();
  });

  it('refuses an unconfigured provider, and linking by GET or without a session', async () => {
    const { a, app } = await boot();
    const none = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/google/start?mode=login',
    });
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe('provider_not_configured');
    await configure(a, 'github');
    // Linking is never a plain navigation: it is a password-confirmed POST.
    const byGet = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/github/start?mode=link',
      cookies: { opportun_session: a.session },
    });
    expect(byGet.statusCode).toBe(400);
    const noSession = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/github/link',
      cookies: { opportun_csrf: a.csrf },
      headers: { 'x-csrf-token': a.csrf },
      payload: { password: PASSWORD },
    });
    expect(noSession.statusCode).toBe(401);
  });

  it('linking takes the current password (Wave-1 re-auth) before anything is issued', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/github/link',
      cookies: { opportun_session: a.session, opportun_csrf: a.csrf },
      payload: { password: PASSWORD },
    });
    expect(noCsrf.statusCode).toBe(403);
    const wrong = await a.request({
      method: 'POST',
      url: '/api/v1/auth/oauth/github/link',
      payload: { password: 'not the password' },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('invalid_password');
    expect(cookieOf(wrong, OAUTH_COOKIE)).toBeUndefined();
    expect(wrong.body).not.toContain('authUrl');
    const failed = await events(app, 'auth.reauth_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.detail).toContain('oauth.link');
  });
});

describe('oauth login', () => {
  it('signs in a linked account, and the exchange is pinned and PKCE-verified', async () => {
    const { a, app } = await boot();
    await configure(a, 'google');
    const identity = { id: 'google-sub-a', email: A_EMAIL, emailVerified: true };
    expect((await oauthLink(app, 'google', a, identity)).headers.location).toBe(
      '/settings/security?oauth=linked',
    );
    provider.calls.length = 0;
    const s = await start(app, 'google', 'login');
    const code = provider.issue(identity);
    const res = await callback(
      app,
      'google',
      { code, state: s.state },
      { [OAUTH_COOKIE]: s.binding },
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const session = cookieOf(res, 'opportun_session')!.value;
    expect((await me(app, session)).json().user.id).toBe(a.userId);
    expect(cookieOf(res, 'opportun_csrf')?.value).toBeTruthy();
    // The binding cookie is spent.
    expect(cookieOf(res, OAUTH_COOKIE)?.value).toBe('');

    const token = provider.calls.find((c) => c.url === 'https://oauth2.googleapis.com/token')!;
    expect(token.opts.allowHosts).toEqual(['oauth2.googleapis.com']);
    expect(token.form!.get('redirect_uri')).toBe(
      'http://localhost:3000/api/v1/auth/oauth/google/callback',
    );
    const verifier = token.form!.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      s.url.searchParams.get('code_challenge'),
    );
    const login = (await events(app, 'auth.login')).filter((e) => e.detail?.includes('oauth'));
    expect(login).toHaveLength(1);
    expect(login[0]!.userId).toBe(a.userId);
  });

  it('REVIEW FOCUS 2: a provider email on an existing account, VERIFIED or not, never links or signs in', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    await configure(a, 'google');
    // Even with registration open, the unverified address must neither link nor squat.
    expect((await setRegistration(a, true)).statusCode).toBe(200);
    const users = await userCount(app);
    const gh = await oauthLogin(app, 'github', GH_ATTACKER);
    expect(gh.statusCode).toBe(302);
    expect(gh.headers.location).toBe('/login?oauth=unknown');
    expect(cookieOf(gh, 'opportun_session')).toBeUndefined();
    const google = await oauthLogin(app, 'google', {
      id: 'attacker-sub',
      email: A_EMAIL.toUpperCase(),
      emailVerified: false,
    });
    expect(google.headers.location).toBe('/login?oauth=unknown');
    expect(cookieOf(google, 'opportun_session')).toBeUndefined();
    expect(await oauthRows(app)).toEqual([]);
    expect(await userCount(app)).toBe(users);
    expect(await events(app, 'auth.oauth_linked_by_email')).toHaveLength(0);
    expect((await events(app, 'auth.oauth_unknown')).length).toBe(2);
    // ...and a later attempt with the same provider account still gets nothing.
    const again = await oauthLogin(app, 'github', GH_ATTACKER);
    expect(cookieOf(again, 'opportun_session')).toBeUndefined();

    // VERIFIED does not change that: there is no email-based password reset here, so control
    // of the mailbox must never become access to the account. The flash tells the owner how
    // to link it themselves.
    for (const name of ['github', 'google'] as const) {
      const verified = await oauthLogin(app, name, {
        id: name === 'github' ? '4242' : 'verified-google',
        email: A_EMAIL,
        emailVerified: true,
      });
      expect(verified.headers.location).toBe('/login?oauth=existing_account');
      expect(cookieOf(verified, 'opportun_session')).toBeUndefined();
      expect(cookieOf(verified, 'opportun_csrf')).toBeUndefined();
    }
    expect(await oauthRows(app)).toEqual([]);
    expect(await userCount(app)).toBe(users);
    expect(await events(app, 'auth.oauth_linked_by_email')).toHaveLength(0);
    const existing = await events(app, 'auth.oauth_existing_account');
    expect(existing).toHaveLength(2);
    expect(existing.every((e) => e.userId === a.userId)).toBe(true);
    expect(
      (await events(app, 'auth.login')).filter((e) => e.detail?.includes('oauth')),
    ).toHaveLength(0);
  });

  it('a verified email of an account with that provider already linked still only flashes', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    await oauthLink(app, 'github', a, { id: '1', email: 'other@example.net', emailVerified: true });
    const res = await oauthLogin(app, 'github', { id: '2', email: A_EMAIL, emailVerified: true });
    expect(res.headers.location).toBe('/login?oauth=existing_account');
    expect(cookieOf(res, 'opportun_session')).toBeUndefined();
    expect(await oauthRows(app)).toHaveLength(1);
  });

  it('creates a new account with an unusable password when registration is open', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    await setRegistration(a, true);
    const res = await oauthLogin(app, 'github', {
      id: '77',
      email: 'New.Person@Example.com',
      emailVerified: true,
      name: 'New Person',
    });
    expect(res.headers.location).toBe('/');
    const session = cookieOf(res, 'opportun_session')!.value;
    const user = (await me(app, session)).json().user;
    expect(user).toMatchObject({
      email: 'new.person@example.com',
      displayName: 'New Person',
      isAdmin: false,
    });
    const row = (await queryOne(
      app,
      'SELECT password_hash AS h FROM users WHERE id = ?',
      user.id,
    )) as { h: string };
    expect(row.h.startsWith('!')).toBe(true);
    // No password signs in to it, not even an empty-looking one.
    const pw = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'new.person@example.com', password: row.h },
    });
    expect(pw.statusCode).toBe(401);
    const reg = (await events(app, 'auth.register')).filter((e) => e.userId === user.id);
    expect(reg).toHaveLength(1);
    expect(reg[0]!.detail).toContain('oauth');
  });

  it('registration closed: an unknown account gets the unknown flash and nothing is created', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    const users = await userCount(app);
    const res = await oauthLogin(app, 'github', {
      id: '78',
      email: 'stranger@example.com',
      emailVerified: true,
    });
    expect(res.headers.location).toBe('/login?oauth=unknown');
    expect(cookieOf(res, 'opportun_session')).toBeUndefined();
    expect(await userCount(app)).toBe(users);
  });

  it('a 2FA-enabled user still gets the pending-2fa step (OAuth replaces only the password)', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    const enrolled = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/enroll',
      payload: { password: PASSWORD },
    });
    const { secret } = enrolled.json() as { secret: string };
    // The clock steps 30 s per sign-in: a TOTP step is never accepted twice.
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    const activated = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/activate',
      payload: { password: PASSWORD, code: totpCode(secret, now) },
    });
    expect(activated.statusCode).toBe(200);
    await oauthLink(app, 'github', a, { id: '55', email: A_EMAIL, emailVerified: true });
    // Twice, so the second sign-in also proves the first spent nothing it should not have.
    for (let i = 0; i < 2; i++) {
      vi.setSystemTime(now + (i + 1) * 30_000);
      const res = await oauthLogin(app, 'github', {
        id: '55',
        email: A_EMAIL,
        emailVerified: true,
      });
      expect(res.statusCode).toBe(302);
      expect(cookieOf(res, 'opportun_session')).toBeUndefined();
      const location = res.headers.location as string;
      expect(location).toMatch(/^\/login#pending2fa=[A-Za-z0-9_-]{43}$/);
      const pendingToken = location.split('=')[1]!;
      // The pending token is not a session.
      expect((await me(app, pendingToken)).statusCode).toBe(401);
      const verified = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/2fa/verify',
        payload: { pendingToken, code: totpCode(secret, Date.now()) },
      });
      expect(verified.statusCode, verified.body).toBe(200);
      expect(verified.json().user.id).toBe(a.userId);
    }
    vi.useRealTimers();
    expect((await events(app, 'auth.2fa_challenge')).length).toBe(2);
  });

  it('provider denial and exchange failures land on the login page with a flash', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    const s = await start(app, 'github', 'login');
    const denied = await callback(
      app,
      'github',
      { error: 'access_denied', state: s.state },
      { [OAUTH_COOKIE]: s.binding },
    );
    expect(denied.headers.location).toBe('/login?oauth=denied');
    provider.tokenStatus = 500;
    const failed = await oauthLogin(app, 'github', {
      id: '1',
      email: A_EMAIL,
      emailVerified: true,
    });
    expect(failed.headers.location).toBe('/login?oauth=error');
    expect(cookieOf(failed, 'opportun_session')).toBeUndefined();
  });
});

describe('oauth state', () => {
  it('a forged state is 403, audited, and never reaches the token endpoint', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    const s = await start(app, 'github', 'login');
    const [body, mac] = s.state.split('.');
    const tampered = `${body}x.${mac}`;
    const res = await callback(
      app,
      'github',
      { code: provider.issue(GH_ATTACKER), state: tampered },
      { [OAUTH_COOKIE]: s.binding },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('bad_state');
    expect(await events(app, 'auth.oauth_bad_state')).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);
  });

  it('login CSRF: a valid state without its browser binding cookie is refused', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    // The attacker starts a flow in their own browser and sends the callback URL to a victim.
    const s = await start(app, 'github', 'login');
    const code = provider.issue({ id: '666', email: 'attacker@example.com', emailVerified: true });
    const res = await callback(app, 'github', { code, state: s.state }, {});
    expect(res.statusCode).toBe(403);
    const other = await callback(
      app,
      'github',
      { code, state: s.state },
      { [OAUTH_COOKIE]: 'someone-elses-binding-value-aaaaaaaaaaaaaaa' },
    );
    expect(other.statusCode).toBe(403);
    expect(provider.calls).toHaveLength(0);
  });

  it('a replayed state is refused the second time', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    await oauthLink(app, 'github', a, { id: '5', email: A_EMAIL, emailVerified: true });
    const s = await start(app, 'github', 'login');
    const cookies = { [OAUTH_COOKIE]: s.binding };
    const first = await callback(
      app,
      'github',
      { code: provider.issue({ id: '5', email: A_EMAIL, emailVerified: true }), state: s.state },
      cookies,
    );
    expect(first.headers.location).toBe('/');
    const replay = await callback(
      app,
      'github',
      { code: provider.issue({ id: '5', email: A_EMAIL, emailVerified: true }), state: s.state },
      cookies,
    );
    expect(replay.statusCode).toBe(403);
    expect(await events(app, 'auth.oauth_bad_state')).toHaveLength(1);
  });

  it('a state is bound to its provider, and expires after ten minutes', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    await configure(a, 'google');
    const s = await start(app, 'github', 'login');
    const cross = await callback(
      app,
      'google',
      { code: provider.issue(GH_ATTACKER), state: s.state },
      { [OAUTH_COOKIE]: s.binding },
    );
    expect(cross.statusCode).toBe(403);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const late = await start(app, 'github', 'login');
      vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
      const res = await callback(
        app,
        'github',
        { code: provider.issue(GH_ATTACKER), state: late.state },
        { [OAUTH_COOKIE]: late.binding },
      );
      expect(res.statusCode).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a link state is bound to the session that started it', async () => {
    const { a, b, app } = await boot();
    await configure(a, 'github');
    const s = await start(app, 'github', 'link', a);
    const code = provider.issue({ id: '12', email: 'x@example.com', emailVerified: true });
    // b's browser presenting a's state (with a's binding cookie, even) links nothing.
    const res = await callback(
      app,
      'github',
      { code, state: s.state },
      { [OAUTH_COOKIE]: s.binding, opportun_session: b.session },
    );
    expect(res.statusCode).toBe(403);
    expect(await oauthRows(app)).toEqual([]);
  });

  it('never logs the code or state of a callback', async () => {
    const { loggedUrl } = await import('../src/app');
    expect(loggedUrl('/api/v1/auth/oauth/github/callback?code=abc&state=def')).toBe(
      '/api/v1/auth/oauth/github/callback?[redacted]',
    );
    expect(loggedUrl('/api/v1/auth/oauth/google/callback?code=abc')).toBe(
      '/api/v1/auth/oauth/google/callback?[redacted]',
    );
  });
});

describe('oauth link and unlink', () => {
  it('links to the signed-in user and lists linked accounts per user only', async () => {
    const { a, b, app } = await boot();
    await configure(a, 'github');
    const res = await oauthLink(app, 'github', b, {
      id: '314',
      email: 'unrelated@example.org',
      emailVerified: false,
    });
    // Linking from a live session does not depend on the provider email at all.
    expect(res.headers.location).toBe('/settings/security?oauth=linked');
    expect(await oauthRows(app)).toEqual([
      { userId: b.userId, provider: 'github', accountId: '314' },
    ]);
    expect((await events(app, 'auth.oauth_linked'))[0]!.userId).toBe(b.userId);
    const mine = await b.request({ method: 'GET', url: '/api/v1/auth/oauth/accounts' });
    expect(mine.json()).toMatchObject({ hasPassword: true, accounts: [{ provider: 'github' }] });
    const theirs = await a.request({ method: 'GET', url: '/api/v1/auth/oauth/accounts' });
    expect(theirs.json()).toMatchObject({ accounts: [] });
  });

  it("conflict: another user's provider account cannot be linked", async () => {
    const { a, b, app } = await boot();
    await configure(a, 'github');
    const identity = { id: '271', email: A_EMAIL, emailVerified: true };
    await oauthLink(app, 'github', a, identity);
    const res = await oauthLink(app, 'github', b, identity);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/settings/security?oauth=conflict');
    expect(await oauthRows(app)).toEqual([
      { userId: a.userId, provider: 'github', accountId: '271' },
    ]);
    expect(await events(app, 'auth.oauth_link_conflict')).toHaveLength(1);
  });

  it('two link flows for one user: the second callback gets the conflict flash', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    // Both flows start (two tabs, or a double click) before either comes back.
    const first = await start(app, 'github', 'link', a);
    const second = await start(app, 'github', 'link', a);
    const back = (s: Started, id: string) =>
      callback(
        app,
        'github',
        { code: provider.issue({ id, email: null, emailVerified: false }), state: s.state },
        { [OAUTH_COOKIE]: s.binding, opportun_session: a.session },
      );
    expect((await back(first, '1')).headers.location).toBe('/settings/security?oauth=linked');
    expect((await back(second, '2')).headers.location).toBe('/settings/security?oauth=conflict');
    expect(await oauthRows(app)).toEqual([
      { userId: a.userId, provider: 'github', accountId: '1' },
    ]);
    const conflicts = await events(app, 'auth.oauth_link_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.detail).toContain('provider_already_linked');
  });

  it('RACE (Task 5 hotspot 9): two link callbacks for one user at once: one links, one conflicts', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    const first = await start(app, 'github', 'link', a);
    const second = await start(app, 'github', 'link', a);
    const back = (s: Started, id: string) =>
      callback(
        app,
        'github',
        { code: provider.issue({ id, email: null, emailVerified: false }), state: s.state },
        { [OAUTH_COOKIE]: s.binding, opportun_session: a.session },
      );
    // Both callbacks have exchanged their code and stand at the link transaction.
    const barrier = holdAt('oauth.link', 2);
    const responses = await Promise.all([back(first, '1'), back(second, '2')]);
    expect(barrier.arrived()).toBe(2);
    expect(responses.map((r) => r.headers.location).sort()).toEqual([
      '/settings/security?oauth=conflict',
      '/settings/security?oauth=linked',
    ]);
    const rows = await oauthRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: a.userId, provider: 'github' });
    const conflicts = await events(app, 'auth.oauth_link_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.detail).toContain('provider_already_linked');
  });

  it('two link callbacks with both transactions open: the user scope holds the second at its lock', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    const first = await start(app, 'github', 'link', a);
    const second = await start(app, 'github', 'link', a);
    const back = (s: Started, id: string) =>
      callback(
        app,
        'github',
        { code: provider.issue({ id, email: null, emailVerified: false }), state: s.state },
        { [OAUTH_COOKIE]: s.binding, opportun_session: a.session },
      );
    const [one, two] = await heldApart(
      'oauth.link.locked',
      () => back(first, '1'),
      () => back(second, '2'),
    );
    expect([one.headers.location, two.headers.location]).toEqual([
      '/settings/security?oauth=linked',
      '/settings/security?oauth=conflict',
    ]);
    expect(await oauthRows(app)).toEqual([
      { userId: a.userId, provider: 'github', accountId: '1' },
    ]);
  });

  it('RACE (Task 5 hotspot 9): two sign-ins of one new identity at once create one account', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    await setRegistration(a, true);
    const identity = { id: '4242', email: 'twice@example.org', emailVerified: true };
    const flows = [await start(app, 'github', 'login'), await start(app, 'github', 'login')];
    const users = await userCount(app);
    const barrier = holdAt('oauth.login', 2);
    const responses = await Promise.all(
      flows.map((s) =>
        callback(
          app,
          'github',
          { code: provider.issue(identity), state: s.state },
          { [OAUTH_COOKIE]: s.binding },
        ),
      ),
    );
    expect(barrier.arrived()).toBe(2);
    // One creates the account; the other signs in to it, or (a lost insert race on an engine
    // without the write gate) is sent back to start over. Never a second account.
    const locations = responses.map((r) => r.headers.location);
    expect(locations).toContain('/');
    for (const l of locations) expect(['/', '/login?oauth=error']).toContain(l);
    expect(await userCount(app)).toBe(users + 1);
    expect((await oauthRows(app)).filter((r) => r.accountId === '4242')).toHaveLength(1);
  });

  it('unlinks with the current password and CSRF', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    await oauthLink(app, 'github', a, { id: '1', email: null, emailVerified: false });
    const noCsrf = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/oauth/github',
      cookies: { opportun_session: a.session, opportun_csrf: a.csrf },
      payload: { password: PASSWORD },
    });
    expect(noCsrf.statusCode).toBe(403);
    const wrong = await a.request({
      method: 'DELETE',
      url: '/api/v1/auth/oauth/github',
      payload: { password: 'not the password' },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('invalid_password');
    const ok = await a.request({
      method: 'DELETE',
      url: '/api/v1/auth/oauth/github',
      payload: { password: PASSWORD },
    });
    expect(ok.statusCode).toBe(204);
    expect(await oauthRows(app)).toEqual([]);
    expect(await events(app, 'auth.oauth_unlinked')).toHaveLength(1);
    const gone = await a.request({
      method: 'DELETE',
      url: '/api/v1/auth/oauth/github',
      payload: { password: PASSWORD },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('an account with no usable password can neither unlink its last method nor link', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    await configure(a, 'google');
    await setRegistration(a, true);
    const res = await oauthLogin(app, 'github', {
      id: '88',
      email: 'only@example.com',
      emailVerified: true,
    });
    const session = cookieOf(res, 'opportun_session')!.value;
    const csrf = cookieOf(res, 'opportun_csrf')!.value;
    const as = (method: 'DELETE' | 'POST', url: string, payload: Record<string, unknown>) =>
      app.inject({
        method,
        url,
        cookies: { opportun_session: session, opportun_csrf: csrf },
        headers: { 'x-csrf-token': csrf },
        payload,
      });
    const last = await as('DELETE', '/api/v1/auth/oauth/github', {});
    expect(last.statusCode).toBe(409);
    expect(last.json().error.code).toBe('last_method');
    const accounts = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/accounts',
      cookies: { opportun_session: session },
    });
    expect(accounts.json()).toMatchObject({ hasPassword: false });
    // Linking needs the current password; this account must set one first (Settings).
    const link = await as('POST', '/api/v1/auth/oauth/google/link', {
      password: 'anything at all',
    });
    expect(link.statusCode).toBe(409);
    expect(link.json().error.code).toBe('password_required');
    expect(await oauthRows(app)).toHaveLength(1);
  });
});

describe('LinkedIn sign-in (C-1 official-API carve-out)', () => {
  const TOKEN = 'https://www.linkedin.com/oauth/v2/accessToken';
  const USERINFO = 'https://api.linkedin.com/v2/userinfo';

  /** The REAL safeFetch rules over a scripted transport that plays LinkedIn's two endpoints. */
  function realRulesFetch() {
    const requested: string[] = [];
    const fetch = createSafeFetch({
      now: () => 0,
      sleep: async () => undefined,
      resolve: async () => ['93.184.216.34'],
      request: async (target) => {
        requested.push(target.url.href);
        const answer =
          target.url.href === TOKEN
            ? { access_token: 'li-token' }
            : { sub: 'li-sub', email: 'Li@Example.com', email_verified: true, name: 'Li User' };
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: (async function* () {
            yield Buffer.from(JSON.stringify(answer));
          })(),
        };
      },
    });
    return { fetch, requested };
  }

  it('starts at the official authorization page with state only', async () => {
    const { a, app } = await boot();
    await configure(a, 'linkedin');
    const s = await start(app, 'linkedin', 'login');
    expect(s.url.origin + s.url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(s.url.searchParams.get('scope')).toBe('openid profile email');
    expect(s.url.searchParams.has('code_challenge')).toBe(false);
    expect(s.url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/v1/auth/oauth/linkedin/callback',
    );
  });

  it('links and signs in through the two official endpoints only', async () => {
    const { a, app } = await boot();
    await configure(a, 'linkedin');
    const identity = { id: 'li-a', email: null, emailVerified: false };
    expect((await oauthLink(app, 'linkedin', a, identity)).headers.location).toBe(
      '/settings/security?oauth=linked',
    );
    const res = await oauthLogin(app, 'linkedin', identity);
    expect(res.headers.location).toBe('/');
    expect((await me(app, cookieOf(res, 'opportun_session')!.value)).json().user.id).toBe(a.userId);
    const urls = [...new Set(provider.calls.map((c) => c.url))].sort();
    expect(urls).toEqual([USERINFO, TOKEN].sort());
    for (const c of provider.calls) expect(c.opts.officialApiUrl).toBe(c.url);
  });

  it('the registry path passes the real safeFetch rules for exactly those two URLs', async () => {
    const { fetch, requested } = realRulesFetch();
    await expect(
      exchangeAndIdentify(fetch, 'linkedin', {
        creds: { clientId: 'id', clientSecret: 'secret' },
        code: 'code',
        redirectUri: 'http://localhost:3000/cb',
      }),
    ).resolves.toEqual({
      providerAccountId: 'li-sub',
      email: 'li@example.com',
      emailVerified: true,
      displayName: 'Li User',
    });
    expect(requested).toEqual([TOKEN, USERINFO]);
  });

  it('any OTHER LinkedIn URL through the same code path is still refused', async () => {
    const { fetch, requested } = realRulesFetch();
    for (const other of [
      'https://www.linkedin.com/in/someone',
      'https://www.linkedin.com/feed/',
      'https://api.linkedin.com/v2/me',
      'https://linkedin.com/oauth/v2/accessToken',
      `${USERINFO}?projection=(id)`,
      'https://lnkd.in/abc',
    ]) {
      const opts = providerFetchOptions(other);
      expect(opts.officialApiUrl, other).toBeUndefined();
      await expect(
        fetch(other, { ...opts, headers: { authorization: 'Bearer t' } }),
        other,
      ).rejects.toMatchObject({ reason: 'host_not_allowed' });
    }
    expect(requested).toEqual([]);
  });
});

describe('first password for an account created by OAuth sign-in (rulings R3, M-1)', () => {
  const NEXT = 'a brand new password';
  const FRESH = { id: '31337', email: 'fresh@example.com', emailVerified: true };

  /** An OAuth-created (passwordless) account's browser: a fresh sign-in, a new session. */
  async function signIn(app: FastifyInstance) {
    const res = await oauthLogin(app, 'github', FRESH);
    const session = cookieOf(res, 'opportun_session')!.value;
    const csrf = cookieOf(res, 'opportun_csrf')!.value;
    const userId = (await me(app, session)).json().user.id as string;
    const request = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
      app.inject({
        method,
        url,
        cookies: { opportun_session: session, opportun_csrf: csrf },
        headers: { 'x-csrf-token': csrf },
        ...(payload === undefined ? {} : { payload }),
      });
    /** Confirms with the provider (mode=setpw) from this session, as `identity`. */
    const reauth = async (identity: FakeIdentity = FRESH, name: Provider = 'github') => {
      const started = await request('POST', `/api/v1/auth/oauth/${name}/setpw`, {});
      expect(started.statusCode, started.body).toBe(200);
      const binding = cookieOf(started, OAUTH_COOKIE)!.value;
      const state = new URL(started.json().authUrl as string).searchParams.get('state')!;
      const res = await callback(
        app,
        name,
        { code: provider.issue(identity), state },
        { [OAUTH_COOKIE]: binding, opportun_session: session },
      );
      return res.headers.location as string;
    };
    return { userId, session, request, reauth };
  }

  async function passwordless(app: FastifyInstance, a: TestClient) {
    await configure(a, 'github');
    await configure(a, 'google');
    await setRegistration(a, true);
    return signIn(app);
  }

  it('without a fresh provider confirmation, a session alone cannot set the password', async () => {
    const { a, app } = await boot();
    const c = await passwordless(app, a);
    const res = await c.request('POST', '/api/v1/auth/password', { next: NEXT });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('reauth_required');
    expect(await events(app, 'auth.password_set_initial')).toEqual([]);
  });

  it('the confirmation must be the provider account already linked to this user', async () => {
    const { a, app } = await boot();
    const c = await passwordless(app, a);
    const other = await c.reauth({ id: '4040', email: null, emailVerified: false });
    expect(other).toBe('/settings/security?oauth=setpw_mismatch');
    expect(await events(app, 'auth.oauth_setpw_mismatch')).toHaveLength(1);
    const res = await c.request('POST', '/api/v1/auth/password', { next: NEXT });
    expect(res.json().error.code).toBe('reauth_required');
    // Only providers this account has linked can be used, and only by passwordless accounts.
    const google = await c.request('POST', '/api/v1/auth/oauth/google/setpw', {});
    expect(google.statusCode).toBe(409);
    expect(google.json().error.code).toBe('not_linked');
    const withPassword = await a.request({
      method: 'POST',
      url: '/api/v1/auth/oauth/github/setpw',
      payload: {},
    });
    expect(withPassword.statusCode).toBe(409);
    expect(withPassword.json().error.code).toBe('has_password');
  });

  it("another session's grant is refused; the state is bound to its session", async () => {
    const { a, app } = await boot();
    const s1 = await passwordless(app, a);
    const s2 = await signIn(app);
    expect(s2.userId).toBe(s1.userId);
    expect(await s1.reauth()).toBe('/settings/security?oauth=setpw_ready');
    const fromS2 = await s2.request('POST', '/api/v1/auth/password', { next: NEXT });
    expect(fromS2.statusCode).toBe(403);
    expect(fromS2.json().error.code).toBe('reauth_required');
    // A setpw state minted in s1 is useless in s2's browser.
    const started = await s1.request('POST', '/api/v1/auth/oauth/github/setpw', {});
    const state = new URL(started.json().authUrl as string).searchParams.get('state')!;
    const crossed = await callback(
      app,
      'github',
      { code: provider.issue(FRESH), state },
      { [OAUTH_COOKIE]: cookieOf(started, OAUTH_COOKIE)!.value, opportun_session: s2.session },
    );
    expect(crossed.statusCode).toBe(403);
    // s1's grant survived s2's refused attempt and still works, once.
    const fromS1 = await s1.request('POST', '/api/v1/auth/password', { next: NEXT });
    expect(fromS1.statusCode).toBe(204);
  });

  it('full path: confirm with the provider, set the first password, then 2FA and linking work', async () => {
    const { a, app } = await boot();
    const c = await passwordless(app, a);
    expect((await c.request('GET', '/api/v1/auth/2fa')).json()).toMatchObject({
      hasPassword: false,
    });
    expect(await c.reauth()).toBe('/settings/security?oauth=setpw_ready');
    expect(await events(app, 'auth.password_set_reauth')).toHaveLength(1);
    // Without a password, 2FA enrollment cannot be confirmed.
    expect(
      (await c.request('POST', '/api/v1/auth/2fa/enroll', { password: 'anything' })).statusCode,
    ).toBe(403);

    const set = await c.request('POST', '/api/v1/auth/password', { next: NEXT });
    expect(set.statusCode, set.body).toBe(204);
    const fresh = cookieOf(set, 'opportun_session')!.value;
    const freshCsrf = cookieOf(set, 'opportun_csrf')!.value;
    const as = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
      app.inject({
        method,
        url,
        cookies: { opportun_session: fresh, opportun_csrf: freshCsrf },
        headers: { 'x-csrf-token': freshCsrf },
        ...(payload === undefined ? {} : { payload }),
      });
    const audited = await events(app, 'auth.password_set_initial');
    expect(audited).toHaveLength(1);
    expect(audited[0]!.userId).toBe(c.userId);
    expect(
      (await events(app, 'auth.password_changed')).filter((e) => e.userId === c.userId),
    ).toEqual([]);

    expect((await as('GET', '/api/v1/auth/2fa')).json()).toMatchObject({ hasPassword: true });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'fresh@example.com', password: NEXT },
    });
    expect(login.statusCode).toBe(200);
    const enroll = await as('POST', '/api/v1/auth/2fa/enroll', { password: NEXT });
    expect(enroll.statusCode, enroll.body).toBe(200);
    expect(enroll.json().secret).toBeTruthy();
    const link = await as('POST', '/api/v1/auth/oauth/google/link', { password: NEXT });
    expect(link.statusCode, link.body).toBe(200);

    // From now on it is an ordinary password: changing it needs the current one.
    const again = await as('POST', '/api/v1/auth/password', { next: 'yet another password' });
    expect(again.statusCode).toBe(403);
    expect(again.json().error.code).toBe('invalid_current_password');
  });

  it('a normal account still needs its current password', async () => {
    const { a, app } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { next: NEXT },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('invalid_current_password');
    const old = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: A_EMAIL, password: PASSWORD },
    });
    expect(old.statusCode).toBe(200);
    expect(await events(app, 'auth.password_set_initial')).toEqual([]);
  });

  it('is rate-limited like login', async () => {
    const { a } = await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await a.request({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { current: 'wrong password', next: NEXT },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('requires a session', async () => {
    const { app } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      cookies: { opportun_csrf: 'x' },
      headers: { 'x-csrf-token': 'x' },
      payload: { next: NEXT },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('state binding cookie', () => {
  it('on a plain-http dev instance (no Secure possible) is unprefixed but path=/', async () => {
    const { a, app } = await boot();
    await configure(a, 'github');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/github/start?mode=login',
    });
    const cookie = (res.cookies as { name: string; path?: string; domain?: string }[]).find(
      (c) => c.name === 'opportun_oauth',
    );
    expect(cookie).toMatchObject({ path: '/' });
    expect(cookie!.domain).toBeUndefined();
  });

  it('is __Host- prefixed over https: Secure, path=/, no Domain', async () => {
    provider = fakeOAuth();
    const { app } = await testApp(
      // Trust the proxy (default light-my-request peer 127.0.0.1) so OVER_HTTPS is honored and
      // the request is seen as https (issue #333); the cookie scheme follows the request.
      { baseUrl: 'https://opportun.example.com', trustedProxies: ['127.0.0.1'] },
      {
        build: { oauth: { fetch: provider.fetch } },
      },
    );
    try {
      const { a } = await registerTwoUsers(app);
      await configure(a, 'github');
      // Linked directly: the link helper speaks the dev cookie name.
      await exec(
        app,
        "INSERT INTO oauth_accounts (id, user_id, provider, provider_account_id, created_at, updated_at) VALUES ('l1', ?, 'github', '515', 0, 0)",
        a.userId,
      );
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/oauth/github/start?mode=login',
        headers: OVER_HTTPS,
      });
      expect(res.statusCode).toBe(302);
      const cookie = (
        res.cookies as {
          name: string;
          value: string;
          secure?: boolean;
          path?: string;
          domain?: string;
        }[]
      ).find((c) => c.name === '__Host-opportun_oauth');
      expect(cookie).toMatchObject({ secure: true, path: '/' });
      expect(cookie!.domain).toBeUndefined();
      expect(cookieOf(res, 'opportun_oauth')).toBeUndefined();
      const state = new URL(res.headers.location as string).searchParams.get('state')!;
      const code = () => provider.issue({ id: '515', email: null, emailVerified: false });
      // A cookie tossed in under the unprefixed name (a sibling subdomain can set that one)
      // is not read at all.
      const tossed = await callback(
        app,
        'github',
        { code: code(), state },
        {
          opportun_oauth: cookie!.value,
        },
        OVER_HTTPS,
      );
      expect(tossed.statusCode).toBe(403);
      const ok = await callback(
        app,
        'github',
        { code: code(), state },
        {
          '__Host-opportun_oauth': cookie!.value,
        },
        OVER_HTTPS,
      );
      // A refused verification spends nothing: the real cookie still completes the sign-in.
      expect(ok.statusCode).toBe(302);
      expect(ok.headers.location).toBe('/');
      expect(
        (ok.cookies as { name: string; value: string }[]).find(
          (c) => c.name === '__Host-opportun_oauth',
        )?.value,
      ).toBe('');
    } finally {
      await app.close();
    }
  });
});

describe('password-set grant (M-1)', () => {
  it('is single use, per session and user, and lasts five minutes', async () => {
    const { app } = await boot();
    const db = app.db;
    grantPasswordSet(db, 'session-1', 'user-1');
    expect(consumePasswordSetGrant(db, 'session-2', 'user-1')).toBe(false);
    expect(consumePasswordSetGrant(db, 'session-1', 'user-2')).toBe(false);
    expect(consumePasswordSetGrant(db, 'session-1', 'user-1')).toBe(true);
    expect(consumePasswordSetGrant(db, 'session-1', 'user-1')).toBe(false);
    vi.useFakeTimers({ toFake: ['Date'] });
    grantPasswordSet(db, 'session-3', 'user-1');
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    expect(consumePasswordSetGrant(db, 'session-3', 'user-1')).toBe(false);
  });
});
