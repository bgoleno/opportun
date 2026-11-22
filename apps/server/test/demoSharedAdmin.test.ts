// The shared demo admin has no power over dedicated accounts
// (https://github.com/bgoleno/opportun/issues/563; sec's amendment B on #542, and tl and sec on
// #563's design). demo-admin is a pinned account whose password every invitee knows. On a demo
// server it is an admin only on the routes of an allowlist, each limited to the pinned accounts;
// on every other route, and on any added later, it is an ordinary user. Off the demo, an admin is
// an admin, as before.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_USERS } from '../src/lib/demo/fixture';
import type { Config } from '../src/config';
import { jobs, settings, users } from '../src/db/schema';
import { writeDedicatedMark } from '../src/lib/demoDedicated';
import { SHARED_ADMIN_ROUTES } from '../src/lib/demoSharedAdmin';
import { hashPassword, NO_PEPPERS, pepperSet } from '../src/lib/passwords';
import { insertUserRow, REGISTRATION_OPEN_KEY } from '../src/lib/registration';
import { testApp } from './helpers';
import { PASSWORD, signIn, type TestClient } from './isolation';

const ADMIN = DEMO_USERS[0]!;
const PINNED = DEMO_USERS[1]!;
const DEDICATED = { id: newId(), email: 'reporter@example.com', displayName: 'A Reporter' };

const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()));
});

interface Demo {
  app: FastifyInstance;
  admin: TestClient;
  pinned: TestClient;
  dedicated: TestClient;
}

/**
 * A server with demo-admin (pinned, the admin), one pinned user and one dedicated account, each
 * signed in. The rows are written directly: the seed itself is tested in seedDemo.test.ts. The
 * hashes carry no pepper, so with `peppers` set they show as pending rotation until a sign-in.
 */
async function boot(overrides: Partial<Config> = {}): Promise<Demo> {
  const { app } = await testApp({ demo: true, ...overrides });
  open.push(app);
  const passwordHash = await hashPassword(PASSWORD, NO_PEPPERS);
  const now = Date.now();
  for (const [i, u] of [ADMIN, PINNED, DEDICATED].entries()) {
    await insertUserRow(app.db, { ...u, passwordHash, isAdmin: i === 0, now: now + i });
  }
  await writeDedicatedMark(app.db, DEDICATED.id, now);
  await app.db
    .insert(settings)
    .values({ key: REGISTRATION_OPEN_KEY, userId: null, value: false, updatedAt: now })
    .run();
  return {
    app,
    admin: await signIn(app, ADMIN.email),
    pinned: await signIn(app, PINNED.email),
    dedicated: await signIn(app, DEDICATED.email),
  };
}

const json = <T>(res: { json: () => unknown }) => res.json() as T;

describe("the shared demo admin's admin actions reach pinned accounts only (#563)", () => {
  it("a password reset of a dedicated account is refused, and the account's password still works", async () => {
    const { app, admin } = await boot();
    const res = await admin.request({
      method: 'POST',
      url: `/api/v1/admin/users/${DEDICATED.id}/reset-password`,
      payload: { password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(403);
    // Still signs in with its own password, and its 2FA (none here) was not touched.
    await signIn(app, DEDICATED.email);
  });

  it('a password reset of a pinned account works as today', async () => {
    const { admin } = await boot();
    const res = await admin.request({
      method: 'POST',
      url: `/api/v1/admin/users/${PINNED.id}/reset-password`,
      payload: { password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('the registration switch is refused, read or write, and registration stays closed', async () => {
    const { app, admin } = await boot();
    const write = await admin.request({
      method: 'PATCH',
      url: '/api/v1/admin/registration',
      payload: { open: true, password: PASSWORD },
    });
    expect(write.statusCode, write.body).toBe(403);
    const read = await admin.request({ method: 'GET', url: '/api/v1/admin/registration' });
    expect(read.statusCode, read.body).toBe(403);
    // No user can be created: sign-up is closed.
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'new@example.com', password: 'a long new password', displayName: 'New' },
    });
    expect(signUp.statusCode, signUp.body).toBe(403);
    expect(await app.db.select().from(users).where(eq(users.email, 'new@example.com')).get()).toBe(
      undefined,
    );
  });

  it('the users list shows the pinned accounts only', async () => {
    const { admin } = await boot();
    const res = await admin.request({ method: 'GET', url: '/api/v1/admin/users' });
    expect(res.statusCode, res.body).toBe(200);
    const ids = json<{ items: { id: string }[] }>(res).items.map((u) => u.id);
    expect(ids.sort()).toEqual([ADMIN.id, PINNED.id].sort());
  });

  it('the pepper rotation list shows the pinned accounts only', async () => {
    // A current pepper: every unpeppered hash is pending. demo-admin's own was upgraded at sign-in.
    const { app, admin } = await boot({ peppers: pepperSet(1, { 1: 'a test pepper value' }) });
    // Each sign-in upgraded its hash: put the unpeppered one back on the two other accounts.
    const unpeppered = await hashPassword(PASSWORD, NO_PEPPERS);
    for (const id of [PINNED.id, DEDICATED.id]) {
      await app.db.update(users).set({ passwordHash: unpeppered }).where(eq(users.id, id)).run();
    }
    const res = await admin.request({ method: 'GET', url: '/api/v1/admin/peppers' });
    expect(res.statusCode, res.body).toBe(200);
    const ids = json<{ pending: { id: string }[] }>(res).pending.map((u) => u.id);
    expect(ids).toEqual([PINNED.id]);
  });

  it("the jobs list shows pinned and instance jobs, and a dedicated account's job cannot be retried", async () => {
    const { app, admin } = await boot();
    const now = Date.now();
    const job = (id: string, userId: string | null) => ({
      id,
      kind: 'test.noop',
      payload: {},
      status: 'dead' as const,
      attempts: 3,
      maxAttempts: 3,
      runAt: now,
      userId,
      createdAt: now,
      updatedAt: now,
    });
    await app.db
      .insert(jobs)
      .values([
        job('j-pinned', PINNED.id),
        job('j-instance', null),
        job('j-dedicated', DEDICATED.id),
      ])
      .run();
    const list = await admin.request({ method: 'GET', url: '/api/v1/jobs?limit=100' });
    expect(list.statusCode, list.body).toBe(200);
    const ids = json<{ items: { id: string }[] }>(list).items.map((j) => j.id);
    expect(ids).toContain('j-pinned');
    expect(ids).toContain('j-instance');
    expect(ids).not.toContain('j-dedicated');
    const retryDedicated = await admin.request({
      method: 'POST',
      url: '/api/v1/jobs/j-dedicated/retry',
    });
    expect(retryDedicated.statusCode, retryDedicated.body).toBe(403);
    const retryPinned = await admin.request({ method: 'POST', url: '/api/v1/jobs/j-pinned/retry' });
    expect(retryPinned.statusCode, retryPinned.body).toBe(200);
  });

  it("a dedicated account is never an admin, and keeps its own Settings as anyone's", async () => {
    const { dedicated } = await boot();
    const me = await dedicated.request({ method: 'GET', url: '/api/v1/auth/me' });
    expect(json<{ user: { isAdmin: boolean } }>(me).user.isAdmin).toBe(false);
  });

  it('/auth/me still says demo-admin is an admin, so the allowed pages show', async () => {
    const { admin } = await boot();
    const me = await admin.request({ method: 'GET', url: '/api/v1/auth/me' });
    expect(json<{ user: { isAdmin: boolean } }>(me).user.isAdmin).toBe(true);
  });
});

describe('off the demo, the same admin is an admin everywhere, as before (#563)', () => {
  it('reset, the users list and the registration switch all work on every account', async () => {
    const { admin } = await boot({ demo: false });
    const reset = await admin.request({
      method: 'POST',
      url: `/api/v1/admin/users/${DEDICATED.id}/reset-password`,
      payload: { password: PASSWORD },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    const list = await admin.request({ method: 'GET', url: '/api/v1/admin/users' });
    expect(json<{ items: { id: string }[] }>(list).items.map((u) => u.id)).toContain(DEDICATED.id);
    const registration = await admin.request({
      method: 'PATCH',
      url: '/api/v1/admin/registration',
      payload: { open: false, password: PASSWORD },
    });
    expect(registration.statusCode, registration.body).toBe(200);
  });
});

/**
 * Every admin gate outside the allowlist, as the shared demo admin meets it: refused (403), or the
 * view any user gets. Each row also runs as a pinned, non-admin user, and the two must agree: the
 * shared admin is an ordinary user here. OAuth's rows go through that file's own requireAdmin
 * helper, not a bare ctx.isAdmin.
 */
const NOT_ALLOWED: {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  payload?: Record<string, unknown>;
}[] = [
  { method: 'GET', url: '/api/v1/admin/registration' },
  {
    method: 'PATCH',
    url: '/api/v1/admin/registration',
    payload: { open: true, password: PASSWORD },
  },
  { method: 'GET', url: '/api/v1/admin/oauth-providers' },
  { method: 'GET', url: '/api/v1/admin/oauth-providers/google' },
  {
    method: 'PUT',
    url: '/api/v1/admin/oauth-providers/google',
    payload: { clientId: 'an id', clientSecret: 'a secret', password: PASSWORD },
  },
  {
    method: 'POST',
    url: '/api/v1/admin/oauth-providers/google/import',
    payload: { password: PASSWORD },
  },
  {
    method: 'DELETE',
    url: '/api/v1/admin/oauth-providers/google',
    payload: { password: PASSWORD },
  },
  { method: 'GET', url: '/api/v1/backups' },
  { method: 'POST', url: '/api/v1/backups' },
  { method: 'PUT', url: '/api/v1/obs/settings', payload: { collect: true } },
  { method: 'PUT', url: '/api/v1/obs/export', payload: { password: PASSWORD, enabled: true } },
  { method: 'GET', url: '/api/v1/obs/export' },
  { method: 'POST', url: '/api/v1/obs/export/test', payload: { password: PASSWORD } },
  { method: 'GET', url: '/api/v1/obs/metrics' },
  {
    method: 'POST',
    url: '/api/v1/discovery/sources',
    payload: {
      kind: 'mcp',
      enabled: false,
      config: {
        transport: 'stdio',
        command: 'true',
        args: [],
        tool: 'search_jobs',
        queryArgs: {},
        mapping: { company: 'c', title: 't', descriptionMd: 'd', postingUrl: 'u' },
        itemsPath: 'results',
      },
    },
  },
];

describe('every other admin gate treats the shared demo admin as an ordinary user (#563)', () => {
  it.each(NOT_ALLOWED)('$method $url', async (row) => {
    const { admin, pinned } = await boot();
    const asAdmin = await admin.request(row);
    const asUser = await pinned.request(row);
    expect(asAdmin.statusCode, asAdmin.body).toBe(asUser.statusCode);
    if (asUser.statusCode === 200) expect(asAdmin.json()).toEqual(asUser.json());
  });

  it('each row is refused to a non-admin today, so the row tests something', async () => {
    // A row whose non-admin answer is 200 must differ for a real admin off the demo, or it says
    // nothing about the gate.
    const { admin, pinned } = await boot({ demo: false });
    const sameForBoth: string[] = [];
    for (const row of NOT_ALLOWED) {
      const asAdmin = await admin.request(row);
      const asUser = await pinned.request(row);
      if (
        asAdmin.statusCode === asUser.statusCode &&
        (asUser.statusCode !== 200 ||
          JSON.stringify(asAdmin.json()) === JSON.stringify(asUser.json()))
      ) {
        sameForBoth.push(
          `${row.method} ${row.url} (${asUser.statusCode} ${asUser.body.slice(0, 80)})`,
        );
      }
    }
    expect(sameForBoth).toEqual([]);
  });

  it('every allowlisted route exists', async () => {
    const { app } = await boot();
    for (const entry of SHARED_ADMIN_ROUTES) {
      const [method, url] = entry.split(' ') as ['GET' | 'POST', string];
      expect(app.hasRoute({ method, url }), entry).toBe(true);
    }
  });
});

/**
 * Where the source decides on admin rights. A new file here is a new admin gate: add its routes to
 * NOT_ALLOWED above (or to the allowlist, with a filter and a test), then to this list. The forms
 * it looks for: a read of `.isAdmin` or `users.isAdmin`, a negated or branched `isAdmin`, a
 * `requireAdmin` helper, and a role compared with "admin".
 */
const ADMIN_CHECK =
  /\.isAdmin\b|!\s*isAdmin\b|\bisAdmin\s*(\?|&&|\|\|)|requireAdmin|\brole\s*[!=]==?\s*['"]admin['"]/;
const KNOWN: Record<string, string> = {
  'jobs/discoveryRun.ts': 'a background job, not a request: there is no session to narrow',
  'lib/demoSharedAdmin.ts': 'the allowlist itself',
  'lib/exporter.ts': 'copies the column into an export; not a gate',
  'lib/registration.ts': 'writes the column; not a gate',
  'lib/sessions.ts': 'reads the column into the session context the plugin narrows',
  'repos/base.ts': 'requireAdmin, the one check the admin routes below call (#767)',
  'repos/discovery.ts': 'NOT_ALLOWED: POST /discovery/sources',
  'routes/auth.ts': 'NOT_ALLOWED: /admin/registration; allowlist: users, peppers, reset',
  'routes/backups.ts': 'NOT_ALLOWED: /backups',
  'routes/jobs.ts': 'allowlist: /jobs and its retry',
  'routes/oauthLogin.ts': 'NOT_ALLOWED: /admin/oauth-providers',
  'routes/obsMetrics.ts': 'NOT_ALLOWED: GET /obs/metrics',
  'routes/obsSettings.ts': 'NOT_ALLOWED: /obs/settings, /obs/export',
};

describe('the admin gates in the source are the ones these tests cover (#563)', () => {
  it('no file decides on admin rights outside the known list', async () => {
    const src = join(__dirname, '../src');
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (p.endsWith('.ts') && ADMIN_CHECK.test(await readFile(p, 'utf8'))) {
          found.push(p.slice(src.length + 1));
        }
      }
    };
    await walk(src);
    expect(found.sort()).toEqual(Object.keys(KNOWN).sort());
  });
});
