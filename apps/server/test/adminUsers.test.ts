// Admin users list and password reset (FR-S1 reset, plan Task 4), and the pepper wired
// through login. The reset is also the recovery of last resort for a 2FA user with neither
// phone nor recovery codes (plan Review Focus 3).
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { auditLog, sessions, settings, users } from '../src/db/schema';
import { deviceRoute, requireDevice } from '../src/lib/deviceTokens';
import { hashPassword, unusablePasswordHash, verifyPassword } from '../src/lib/passwords';
import { REGISTRATION_OPEN_KEY, registerUser } from '../src/lib/registration';
import { totpCode } from '../src/lib/totp';
import { pepperSet } from '../src/lib/passwords';
import { useApi } from './api';
import { testApp } from './helpers';
import { registerTwoUsers, type TestClient } from './isolation';

const PASSWORD = 'correct horse battery';
const A_EMAIL = 'isolation-a@example.com';
const B_EMAIL = 'isolation-b@example.com';
const PEPPER = 'a-deployment-pepper-of-some-length';

/** A stand-in connector route, to prove a reset cuts device credentials too. */
function deviceProbe(app: FastifyInstance): void {
  app.get('/api/v1/test/device/mail', deviceRoute('mail:push'), async (req) => ({
    userId: requireDevice(req).userId,
  }));
}

const boot = useApi(() => ({ setup: deviceProbe }));

function cookie(res: LightMyRequestResponse, name: string): string | undefined {
  return (res.cookies as { name: string; value: string }[]).find((c) => c.name === name)?.value;
}

function login(app: FastifyInstance, email: string, password = PASSWORD) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
}

function me(app: FastifyInstance, c: TestClient) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    cookies: { opportun_session: c.session },
  });
}

function reset(c: TestClient, id: string) {
  return c.request({ method: 'POST', url: `/api/v1/admin/users/${id}/reset-password` });
}

/** Reopens registration directly (same mechanism seedDemo.ts uses between its own pinned
 *  accounts), so a test can call registerUser a second time in a suite where boot() already
 *  closed it registering a and b. */
function reopenRegistration(app: FastifyInstance): Promise<unknown> {
  const now = Date.now();
  return app.db
    .insert(settings)
    .values({ key: REGISTRATION_OPEN_KEY, userId: null, value: true, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: true, updatedAt: now } })
    .run();
}

function lastSeenOf(res: LightMyRequestResponse, userId: string): number | null | undefined {
  const { items } = res.json() as { items: { id: string; lastSeenAt: number | null }[] };
  return items.find((u) => u.id === userId)?.lastSeenAt;
}

describe('GET /admin/users', () => {
  it('lists every account (no secrets) for the admin', async () => {
    const { a, b } = await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/admin/users' });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: Record<string, unknown>[] };
    expect(items.map((u) => u.email)).toEqual([A_EMAIL, B_EMAIL]);
    expect(items[0]).toEqual({
      id: a.userId,
      email: A_EMAIL,
      displayName: A_EMAIL,
      isAdmin: true,
      totpEnabled: false,
      createdAt: expect.any(Number),
      // Registering also starts a session (issue #281): both accounts have one already.
      lastSeenAt: expect.any(Number),
    });
    expect(items[1]!.id).toBe(b.userId);
    expect(res.body).not.toMatch(/argon2|password|totp_?secret|recovery/i);
  });

  it('is admin-only', async () => {
    const { app, b } = await boot();
    expect((await b.request({ method: 'GET', url: '/api/v1/admin/users' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/users' })).statusCode).toBe(401);
  });

  it('reports null for an account that registered but has never signed in (issue #281)', async () => {
    const { app, a } = await boot();
    // registerUser alone (not the HTTP route, which also calls createSession) leaves
    // last_seen_at at its column default. Registration is closed after boot()'s own a/b, so
    // it is reopened directly first, the same way seedDemo.ts reopens it between its own
    // pinned accounts, rather than registering a third account through the route.
    await reopenRegistration(app);
    const row = await registerUser(app.db, {
      email: 'never-signed-in@example.com',
      passwordHash: unusablePasswordHash(),
      displayName: 'Never Signed In',
    });
    const res = await a.request({ method: 'GET', url: '/api/v1/admin/users' });
    expect(lastSeenOf(res, row.id)).toBeNull();
  });

  it('survives sign-out (issue #320): the value a visit recorded does not revert to "Never"', async () => {
    const { app, a, b } = await boot();
    // boot() already signed b in once (registering starts a session); confirm that alone
    // recorded a visit before doing anything else.
    const beforeLogout = lastSeenOf(
      await a.request({ method: 'GET', url: '/api/v1/admin/users' }),
      b.userId,
    );
    expect(beforeLogout).not.toBeNull();

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { opportun_session: b.session, opportun_csrf: b.csrf },
      headers: { 'x-csrf-token': b.csrf },
    });
    expect(logout.statusCode).toBe(204);
    // The session row really is gone -- this is not a test that happens to pass because
    // logout silently no-ops.
    expect(await app.db.select().from(sessions).where(eq(sessions.userId, b.userId)).all()).toEqual(
      [],
    );

    const afterLogout = lastSeenOf(
      await a.request({ method: 'GET', url: '/api/v1/admin/users' }),
      b.userId,
    );
    expect(afterLogout).toBe(beforeLogout);
  });

  it('ignores a pending_2fa row (issue #281): a password step with no completed code is not a sign-in', async () => {
    const { app, a } = await boot();
    await reopenRegistration(app);
    const row = await registerUser(app.db, {
      email: 'pending-2fa-only@example.com',
      passwordHash: unusablePasswordHash(),
      displayName: 'Pending 2FA Only',
    });
    await app.db
      .insert(sessions)
      .values({
        id: 'pending-2fa-row',
        userId: row.id,
        kind: 'pending_2fa',
        expiresAt: Date.now() + 60_000,
        lastSeenAt: Date.now(),
        createdAt: Date.now(),
      })
      .run();
    const res = await a.request({ method: 'GET', url: '/api/v1/admin/users' });
    expect(lastSeenOf(res, row.id)).toBeNull();
  });
});

describe('GET /admin/registration', () => {
  it('reports the toggle to the admin only', async () => {
    const { a, b } = await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/admin/registration' });
    expect(res.json()).toEqual({ open: false });
    expect((await b.request({ method: 'GET', url: '/api/v1/admin/registration' })).statusCode).toBe(
      403,
    );
  });
});

describe('GET /admin/peppers', () => {
  it('reports no rotation when no pepper is configured', async () => {
    const { a } = await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/admin/peppers' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ currentVersion: 0, pending: [] });
  });

  it('is admin-only', async () => {
    const { app, b } = await boot();
    expect((await b.request({ method: 'GET', url: '/api/v1/admin/peppers' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/peppers' })).statusCode).toBe(
      401,
    );
  });

  it('lists accounts not yet stamped with the current pepper version', async () => {
    const { app } = await testApp({ peppers: pepperSet(2, { 1: 'old-pepper-secret', 2: PEPPER }) });
    try {
      const { a, b } = await registerTwoUsers(app);
      // b has not signed in since the pepper was bumped to version 2: still stamped with 1.
      const bRow = (await app.db.select().from(users).where(eq(users.id, b.userId)).get())!;
      const stale = bRow.passwordHash.replace(/^p\d+:/, 'p1:');
      await app.db.update(users).set({ passwordHash: stale }).where(eq(users.id, b.userId)).run();

      const res = await a.request({ method: 'GET', url: '/api/v1/admin/peppers' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        currentVersion: 2,
        pending: [{ id: b.userId, email: B_EMAIL, displayName: B_EMAIL, lastSignInAt: null }],
      });
    } finally {
      await app.close();
    }
  });

  it('names when a pending account last signed in', async () => {
    const { app } = await testApp({ peppers: pepperSet(2, { 1: 'old-pepper-secret', 2: PEPPER }) });
    try {
      const { a, b } = await registerTwoUsers(app);
      const before = Date.now();
      expect((await login(app, B_EMAIL)).statusCode).toBe(200);
      const after = Date.now();
      // b signed in (recording auth.login), but has still not rehashed since the bump to v2.
      const bRow = (await app.db.select().from(users).where(eq(users.id, b.userId)).get())!;
      const stale = bRow.passwordHash.replace(/^p\d+:/, 'p1:');
      await app.db.update(users).set({ passwordHash: stale }).where(eq(users.id, b.userId)).run();

      const res = await a.request({ method: 'GET', url: '/api/v1/admin/peppers' });
      const { pending } = res.json() as { pending: { lastSignInAt: number | null }[] };
      expect(pending).toHaveLength(1);
      expect(pending[0]!.lastSignInAt).toBeGreaterThanOrEqual(before);
      expect(pending[0]!.lastSignInAt).toBeLessThanOrEqual(after);
    } finally {
      await app.close();
    }
  });

  it('excludes OAuth-only accounts, which have no password to rehash', async () => {
    const { app } = await testApp({ peppers: pepperSet(1, { 1: PEPPER }) });
    try {
      const { a, b } = await registerTwoUsers(app);
      await app.db
        .update(users)
        .set({ passwordHash: unusablePasswordHash() })
        .where(eq(users.id, b.userId))
        .run();

      const res = await a.request({ method: 'GET', url: '/api/v1/admin/peppers' });
      expect(res.json()).toEqual({ currentVersion: 1, pending: [] });
    } finally {
      await app.close();
    }
  });
});

describe('POST /admin/users/:id/reset-password', () => {
  it('sets a temporary password shown once, revokes sessions and audits', async () => {
    const { app, a, b } = await boot();
    expect((await me(app, b)).statusCode).toBe(200);
    const res = await reset(a, b.userId);
    expect(res.statusCode).toBe(200);
    const { temporaryPassword } = res.json() as { temporaryPassword: string };
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(24);

    // Every session the target had is gone.
    expect((await me(app, b)).statusCode).toBe(401);
    // The old password no longer works; the temporary one does.
    expect((await login(app, B_EMAIL)).statusCode).toBe(401);
    const ok = await login(app, B_EMAIL, temporaryPassword);
    expect(ok.statusCode).toBe(200);
    expect(cookie(ok, 'opportun_session')).toBeDefined();
    // The admin's own session is untouched.
    expect((await me(app, a)).statusCode).toBe(200);

    const rows = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'admin.password_reset'))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(a.userId);
    expect(rows[0]!.detail).toEqual({ targetUserId: b.userId });
    expect(JSON.stringify(await app.db.select().from(auditLog).all())).not.toContain(
      temporaryPassword,
    );
  });

  it("revokes the target's device tokens: an existing token fails immediately", async () => {
    const { app, a, b } = await boot();
    const created = await b.request({
      method: 'POST',
      url: '/api/v1/device-tokens',
      payload: { name: 'laptop', scopes: ['mail:push'], password: PASSWORD },
    });
    expect(created.statusCode).toBe(201);
    const { token } = created.json() as { token: string };
    const probe = () =>
      app.inject({
        method: 'GET',
        url: '/api/v1/test/device/mail',
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await probe()).statusCode).toBe(200);
    expect((await reset(a, b.userId)).statusCode).toBe(200);
    expect((await probe()).statusCode).toBe(401);
  });

  it('clears 2FA: a user with neither phone nor recovery codes gets back in', async () => {
    const { app, a, b } = await boot();
    const enrolled = (
      await b.request({
        method: 'POST',
        url: '/api/v1/auth/2fa/enroll',
        payload: { password: PASSWORD },
      })
    ).json() as {
      secret: string;
    };
    const activated = await b.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/activate',
      payload: { password: PASSWORD, code: totpCode(enrolled.secret, Date.now()) },
    });
    expect(activated.statusCode).toBe(200);
    // Phone and codes lost: the password alone only reaches the code step.
    expect((await login(app, B_EMAIL)).json()).toMatchObject({ requires2fa: true });

    const res = await reset(a, b.userId);
    const { temporaryPassword } = res.json() as { temporaryPassword: string };
    const row = (await app.db.select().from(users).where(eq(users.id, b.userId)).get())!;
    expect(row.totpEnabled).toBe(false);
    expect(row.totpSecret).toBeNull();
    expect(row.totpRecovery).toBeNull();
    const back = await login(app, B_EMAIL, temporaryPassword);
    expect(back.statusCode).toBe(200);
    expect(back.json().user.id).toBe(b.userId);
    expect(cookie(back, 'opportun_session')).toBeDefined();
  });

  it('is admin-only and leaves the target untouched otherwise', async () => {
    const { app, a, b } = await boot();
    const res = await reset(b, a.userId);
    expect(res.statusCode).toBe(403);
    expect((await me(app, a)).statusCode).toBe(200);
    expect((await login(app, A_EMAIL)).statusCode).toBe(200);
  });

  it('refuses an unknown id (404) and the admin themselves (409: use password change)', async () => {
    const { app, a } = await boot();
    expect((await reset(a, 'no-such-user')).statusCode).toBe(404);
    const self = await reset(a, a.userId);
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('self_reset');
    expect((await me(app, a)).statusCode).toBe(200);
  });

  it('requires CSRF', async () => {
    const { app, a, b } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${b.userId}/reset-password`,
      cookies: { opportun_session: a.session, opportun_csrf: a.csrf },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf');
  });
});

describe('pepper through the app', () => {
  it('new hashes use the pepper; a pre-pepper hash still signs in and is upgraded', async () => {
    const { app } = await testApp({ peppers: pepperSet(1, { 1: PEPPER }) });
    try {
      const { a } = await registerTwoUsers(app);
      const aHash = (await app.db.select().from(users).where(eq(users.id, a.userId)).get())!
        .passwordHash;
      expect(await verifyPassword(aHash, PASSWORD, PEPPER)).toBe(true);
      expect(await verifyPassword(aHash, PASSWORD)).toBe(false);

      // Simulate an account created before the operator set the pepper.
      const legacy = await hashPassword(PASSWORD);
      await app.db.update(users).set({ passwordHash: legacy }).where(eq(users.id, a.userId)).run();
      const res = await login(app, A_EMAIL);
      expect(res.statusCode).toBe(200);
      const upgraded = (await app.db.select().from(users).where(eq(users.id, a.userId)).get())!
        .passwordHash;
      expect(upgraded).not.toBe(legacy);
      expect(await verifyPassword(upgraded, PASSWORD, PEPPER)).toBe(true);

      // An admin reset under a pepper issues a peppered hash too.
      const b = (await app.db.select().from(users).where(eq(users.email, B_EMAIL)).get())!;
      const loginA = await login(app, A_EMAIL);
      const session = cookie(loginA, 'opportun_session')!;
      const csrf = cookie(loginA, 'opportun_csrf')!;
      const reset = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${b.id}/reset-password`,
        cookies: { opportun_session: session, opportun_csrf: csrf },
        headers: { 'x-csrf-token': csrf },
      });
      const { temporaryPassword } = reset.json() as { temporaryPassword: string };
      const bHash = (await app.db.select().from(users).where(eq(users.id, b.id)).get())!
        .passwordHash;
      expect(await verifyPassword(bHash, temporaryPassword, PEPPER)).toBe(true);
      expect(await verifyPassword(bHash, temporaryPassword)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
