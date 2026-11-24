// What a sign-in goes on to is one of the app's own pages, whatever the address, or what is kept in the
// tab, says (https://github.com/bgoleno/opportun/issues/942; the rule is sec's and tl's on it).
import { QueryClient } from '@tanstack/react-query';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/render';
import { forceLocalSignOut, logout, register } from './auth';
import { KEPT_MS, safeRedirect } from './loginRedirect';

const KEY = 'opportun.loginRedirect';
const CONTROLS = [0, 1, 8, 9, 10, 11, 12, 13, 27, 31].map((n) => String.fromCharCode(n));

/** Each ends at the Dashboard: what it is, or would be to a browser or a router that decodes it. */
export const REFUSED: unknown[] = [
  // Another site: a scheme, protocol-relative, a backslash, what a browser strips.
  'https://evil.example',
  'HTTPS:evil.example',
  'https:/evil.example',
  'javascript:alert(1)',
  'data:text/html,x',
  '//evil.example',
  '///evil.example',
  ' //evil.example',
  '/\\evil.example',
  '\\\\evil.example',
  '/a\\b',
  ...CONTROLS.map((c) => `/${c}/evil.example`),
  ...CONTROLS.map((c) => `/ok${c}next`),
  // The same once it is resolved, or decoded, as often as anyone would.
  '/.//evil.example',
  '/x/..//evil.example',
  '/%2e//evil.example',
  '/%2F/evil.example',
  '/%2f%2Fevil.example',
  '/%252F/evil.example',
  '/%25252F%25252Fevil.example',
  '/%5cevil.example',
  '/%5C%5Cevil.example',
  '/%255cevil.example',
  '/%09/evil.example',
  '/%0d%0a/evil.example',
  '/%00',
  '/x/%252e%252e//evil.example',
  '/x%2f..%2f%2fevil.example',
  // Not decodable, or not soon.
  '/%',
  '/%E0%A4%A',
  '/100%25',
  `/${'%25'.repeat(1)}${'25'.repeat(8)}2F/evil.example`,
  // No page: relative, not text, too long.
  '',
  'evil.example',
  'pipeline',
  '?x',
  '#x',
  undefined,
  null,
  7,
  true,
  ['/pipeline'],
  { pathname: '/pipeline' },
  `/${'x'.repeat(2000)}`,
  // Signing in, in any case and form.
  '/login',
  '/login/',
  '/LOGIN',
  '/Login/?x',
  '/./login',
  '/x/../login',
  '/%6Cogin',
  '/%6cOGIN/',
  '/login?redirect=/pipeline',
  '/register',
  '/register?x',
  '/register/x',
  // What the server answers itself.
  '/api',
  '/api/v1/auth/oauth/github/start?mode=login',
  '/API',
  '/API/x',
  '/./api/x',
  '/%61pi/x',
  '/x/%2e%2e/api/x',
  '/healthz',
  '/assets/app.js',
];
/** And each page as it is gone to. */
const KEPT_AS: [string, string][] = [
  ['/', '/'],
  ['/pipeline?stage=applied', '/pipeline?stage=applied'],
  ['/opportunities/abc#notes', '/opportunities/abc#notes'],
  ['/x/a%2Fb', '/x/a%2Fb'],
  ['/network/a%20b', '/network/a%20b'],
  ['/?tab=https://example.com', '/?tab=https://example.com'],
  ['/discovery?q=%2F%2Fx&y=%5C', '/discovery?q=%2F%2Fx&y=%5C'],
  ['/a/../pipeline', '/pipeline'],
  ['/./inbox', '/inbox'],
  ['/résumés', '/r%C3%A9sum%C3%A9s'],
  // Whole segments: these are pages of their own, or could be.
  ['/apply-x', '/apply-x'],
  ['/login-history', '/login-history'],
  ['/apis', '/apis'],
  ['/x/api', '/x/api'],
  ['/x/login', '/x/login'],
];

describe('safeRedirect', () => {
  it.each(REFUSED.map((t) => [JSON.stringify(t) ?? 'undefined', t]))('refuses %s', (_n, target) => {
    expect(safeRedirect(target)).toBe('/');
  });

  it.each(KEPT_AS)('goes to %j as %j', (target, page) => {
    expect(safeRedirect(target)).toBe(page);
  });
});

describe('what is kept over a provider’s round trip', () => {
  const NOW = 1_795_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const kept = () => window.sessionStorage.getItem(KEY);
  const put = (value: unknown) =>
    window.sessionStorage.setItem(KEY, typeof value === 'string' ? value : JSON.stringify(value));
  /** The app's first load, as a page load makes it. */
  async function firstLoad(pathname = '/', signedIn = true) {
    vi.resetModules();
    const fresh = await import('./loginRedirect');
    const took = fresh.takeAtFirstLoad(pathname, signedIn);
    return { fresh, took };
  }

  it('is gone to from /, signed in, in place of it, and taken', async () => {
    put({ to: '/pipeline?stage=applied#x', at: NOW });
    const { took } = await firstLoad();
    expect(took).toEqual({ href: '/pipeline?stage=applied#x', replace: true });
    expect(kept()).toBeNull();
  });

  it('is taken at the first load only', async () => {
    const { fresh, took } = await firstLoad();
    expect(took).toBeUndefined();
    put({ to: '/pipeline', at: NOW });
    expect(fresh.takeAtFirstLoad('/', true)).toBeUndefined();
  });

  it.each([
    ['/', false],
    ['/pipeline', true],
    ['/settings/security', true],
    ['/register', false],
  ])(
    'a first load at %s (signed in: %s) goes nowhere, and is done with it',
    async (path, signedIn) => {
      put({ to: '/inbox', at: NOW });
      const { took } = await firstLoad(path, signedIn);
      expect(took).toBeUndefined();
      expect(kept()).toBeNull();
    },
  );

  it.each(['/login', '/login/', '/LOGIN'])(
    'a first load at %s leaves it for that page',
    async (path) => {
      put({ to: '/inbox', at: NOW });
      const { took } = await firstLoad(path, false);
      expect(took).toBeUndefined();
      expect(kept()).not.toBeNull();
    },
  );

  it('counts for ten minutes', async () => {
    put({ to: '/inbox', at: NOW - KEPT_MS });
    expect((await firstLoad()).took).toEqual({ href: '/inbox', replace: true });
    put({ to: '/inbox', at: NOW - KEPT_MS - 1 });
    expect((await firstLoad()).took).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['a time to come', { to: '/inbox', at: NOW + 1 }],
    ['a time that is text', { to: '/inbox', at: String(NOW) }],
    ['no time', { to: '/inbox' }],
    ['a time that is no number', '{"to":"/inbox","at":NaN}'],
    ['a time beyond numbers', '{"to":"/inbox","at":1e999}'],
    ['a time before numbers', '{"to":"/inbox","at":-1e999}'],
    ['no page', { at: NOW }],
    ['not an object', '"/inbox"'],
    ['null', 'null'],
    ['not JSON', '/inbox'],
    ['nothing', ''],
  ])('%s is as if there were none, and is removed', async (_n, value) => {
    put(value);
    expect((await firstLoad()).took).toBeUndefined();
    expect(kept()).toBeNull();
  });

  it.each(REFUSED.map((t) => [JSON.stringify(t) ?? 'undefined', t]))(
    'a value changed to %s is refused when it is read',
    async (_n, to) => {
      put({ to, at: NOW });
      expect((await firstLoad()).took).toBeUndefined();
      expect(kept()).toBeNull();
    },
  );

  it('a storage that throws is none', async () => {
    const throws = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(throws);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(throws);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(throws);
    const { fresh, took } = await firstLoad();
    expect(took).toBeUndefined();
    expect(() => fresh.dropKeptRedirect()).not.toThrow();
  });

  describe('is removed', () => {
    const qc = () => new QueryClient();
    beforeEach(() => put({ to: '/inbox', at: NOW }));

    it('by a sign-out', async () => {
      mockApi({ 'POST /auth/logout': { status: 204, body: null } });
      await logout(qc());
      expect(kept()).toBeNull();
    });

    it('not by one the server did not confirm', async () => {
      mockApi({ 'POST /auth/logout': { status: 500, body: { error: { code: 'server_error' } } } });
      await expect(logout(qc())).rejects.toThrow();
      expect(kept()).not.toBeNull();
    });

    it('by a sign-out of this browser alone', () => {
      forceLocalSignOut(qc());
      expect(kept()).toBeNull();
    });

    it('by an account made', async () => {
      mockApi({ 'POST /auth/register': { status: 201, body: { user: { id: 'u1' } } } });
      await register(qc(), {
        displayName: 'A',
        email: 'a@example.com',
        password: 'x'.repeat(12),
        confirm: 'x'.repeat(12),
      });
      expect(kept()).toBeNull();
    });
  });
});

// sec on #942: no caller has the value unchecked, and none goes to it but by the router.
it('nothing else reads the redirect, or what is kept, or goes by the window to it', () => {
  const src = join(__dirname, '..');
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(
    (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== join('lib', 'loginRedirect.ts'),
  );
  expect(files.length).toBeGreaterThan(100);
  const reads =
    /search\(?\)?\.redirect\b|\{[^}]*\bredirect\b[^}]*\}\s*=\s*(Route\.)?useSearch|safeRedirect|signInTarget|opportun\.loginRedirect/;
  expect(files.filter((f) => reads.test(readFileSync(join(src, f), 'utf8')))).toEqual([]);
  const own = readFileSync(join(src, 'lib', 'loginRedirect.ts'), 'utf8');
  expect(own).not.toMatch(/window\.location|reloadDocument|location\.(assign|replace|href)/);
});
