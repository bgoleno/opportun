// What a signed-in user who is not an admin gets from every admin route
// (https://github.com/bgoleno/opportun/issues/767): 403 with the body { error: { code: 'forbidden' } }.
// The routes check this through one helper, requireAdmin (repos/base.ts); this pins the answer
// each of them gave before that helper existed, route by route, so the refactor cannot change it.
// Each request carries a body that passes the route's schema, so it reaches the admin check.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { useApi } from './api';

const boot = useApi();
const PASSWORD = { password: 'correct horse battery' };

const ADMIN_ROUTES: {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  payload?: Record<string, unknown>;
}[] = [
  { method: 'GET', url: '/api/v1/admin/registration' },
  { method: 'PATCH', url: '/api/v1/admin/registration', payload: { open: true, ...PASSWORD } },
  { method: 'GET', url: '/api/v1/admin/users' },
  { method: 'GET', url: '/api/v1/admin/peppers' },
  { method: 'POST', url: '/api/v1/admin/users/some-user/reset-password', payload: PASSWORD },
  { method: 'GET', url: '/api/v1/admin/oauth-providers' },
  { method: 'GET', url: '/api/v1/admin/oauth-providers/google' },
  {
    method: 'PUT',
    url: '/api/v1/admin/oauth-providers/google',
    payload: { clientId: 'id', clientSecret: 'secret', ...PASSWORD },
  },
  { method: 'POST', url: '/api/v1/admin/oauth-providers/google/import', payload: PASSWORD },
  { method: 'DELETE', url: '/api/v1/admin/oauth-providers/google', payload: PASSWORD },
  { method: 'GET', url: '/api/v1/backups' },
  { method: 'POST', url: '/api/v1/backups' },
  { method: 'POST', url: '/api/v1/jobs/some-job/retry' },
  { method: 'PUT', url: '/api/v1/obs/settings', payload: { collect: true } },
  { method: 'PUT', url: '/api/v1/obs/export', payload: { enabled: false, ...PASSWORD } },
  { method: 'POST', url: '/api/v1/obs/export/test', payload: PASSWORD },
];

describe('a non-admin gets 403 forbidden from every admin route (#767)', () => {
  for (const route of ADMIN_ROUTES) {
    it(`${route.method} ${route.url}`, async () => {
      const { b } = await boot();
      const res = await b.request(route);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: { code: 'forbidden' } });
    });
  }
});

const ROUTES_DIR = fileURLToPath(new URL('../src/routes', import.meta.url));

describe('admin checks go through requireAdmin (#767)', () => {
  it('no route checks isAdmin inline to refuse a caller', async () => {
    const offenders: string[] = [];
    for (const name of await readdir(ROUTES_DIR)) {
      if (!name.endsWith('.ts')) continue;
      const lines = (await readFile(join(ROUTES_DIR, name), 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (/\.isAdmin\)\s*(?:throw|return)/.test(line) || /function requireAdmin/.test(line)) {
          offenders.push(`${name}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
