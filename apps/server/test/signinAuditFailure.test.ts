// https://github.com/bgoleno/opportun/issues/779 (the class of #661, which #723 fixed for resets):
// a sign-in wrote its session and set the cookie, then wrote its audit row. A failed audit write
// then left a working session that no audit row records. Each step here writes its audit row in
// the same transaction as the session or credential it changes, and sets the cookie only after
// that commit: a failed write changes nothing and sets no cookie.
//
// The failure is injected at the audit step itself: the real insert runs, through whatever
// executor the step passed, and then the step throws. A row left behind afterwards would mean the
// write ran outside the step's transaction.
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditLog, sessions, users } from '../src/db/schema';
import { totpCode } from '../src/lib/totp';
import { useApi } from './api';
import { PASSWORD, type TestClient } from './isolation';

/** The audit event whose write fails, or null for none. */
let failing: string | null = null;

vi.mock('../src/lib/audit', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/audit')>();
  return {
    ...real,
    audit: async (...args: Parameters<typeof real.audit>) => {
      await real.audit(...args);
      if (args[1] === failing) throw new Error('audit write failed');
    },
  };
});

afterEach(() => {
  failing = null;
});

const boot = useApi();
const EMAIL_A = 'isolation-a@example.com';
const NEW_PASSWORD = 'a brand new passphrase 779';

const login = (app: FastifyInstance, email = EMAIL_A) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });

/** The session cookie the response sets, if any (a cleared one does not count). */
function sessionCookie(res: LightMyRequestResponse): string | undefined {
  return (res.cookies as { name: string; value: string }[]).find(
    (c) => c.name === 'opportun_session' && c.value !== '',
  )?.value;
}

/**
 * What the failure must leave as it was: the user's row, sessions and the event's audit rows.
 * `spent`: a second factor is checked, and spent, before the step's transaction (#561's claim),
 * and stays spent; the comparison leaves out what that spends, and keeps everything else.
 */
async function state(app: FastifyInstance, userId: string, event: string, spent = false) {
  const user = await app.db.select().from(users).where(eq(users.id, userId)).get();
  const pending = spent
    ? new Set(
        (
          await app.db
            .select({ id: sessions.id, kind: sessions.kind })
            .from(sessions)
            .where(eq(sessions.userId, userId))
            .all()
        )
          .filter((r) => r.kind === 'pending_2fa')
          .map((r) => r.id),
      )
    : new Set<string>();
  return {
    user:
      spent && user !== undefined
        ? { ...user, totpRecovery: 'spent', totpLastStep: 'spent', updatedAt: 'spent' }
        : user,
    sessions: (
      await app.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .orderBy(sessions.id)
        .all()
    ).filter((r) => !pending.has(r.id)),
    audited: (await app.db.select().from(auditLog).where(eq(auditLog.event, event)).all()).filter(
      (r) => r.userId === userId,
    ).length,
  };
}

/** Runs `step` with `event`'s audit write failing; asserts it changed nothing and set no cookie. */
async function failsCleanly(
  app: FastifyInstance,
  userId: string,
  event: string,
  step: () => Promise<LightMyRequestResponse>,
  spent = false,
): Promise<void> {
  const before = await state(app, userId, event, spent);
  failing = event;
  const res = await step();
  failing = null;
  expect(res.statusCode, res.body).toBe(500);
  expect(sessionCookie(res)).toBeUndefined();
  expect(await state(app, userId, event, spent)).toEqual(before);
}

async function enroll(c: TestClient): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/auth/2fa/enroll',
    payload: { password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { secret: string }).secret;
}

/** Turns 2FA on for `c`; returns its secret and recovery codes. */
async function enable(c: TestClient): Promise<{ secret: string; recovery: string[] }> {
  const secret = await enroll(c);
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/auth/2fa/activate',
    payload: { password: PASSWORD, code: totpCode(secret, Date.now()) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { secret, recovery: (res.json() as { recoveryCodes: string[] }).recoveryCodes };
}

async function pendingToken(app: FastifyInstance): Promise<string> {
  const res = await login(app);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { pendingToken: string }).pendingToken;
}

describe('sign-in: the audit row commits with the session (#779)', () => {
  it('a password sign-in whose auth.login write fails leaves no session and sets no cookie', async () => {
    const { app, a } = await boot();
    await failsCleanly(app, a.userId, 'auth.login', () => login(app));
    // And the same sign-in, with the audit write working, signs in and is recorded.
    const ok = await login(app);
    expect(ok.statusCode).toBe(200);
    expect(sessionCookie(ok)).toBeDefined();
    expect((await state(app, a.userId, 'auth.login')).audited).toBe(1);
  });

  it.each(['auth.2fa_verified', 'auth.login'])(
    'a code step whose %s write fails leaves no session and sets no cookie',
    async (event) => {
      const { app, a } = await boot();
      const { secret } = await enable(a);
      const token = await pendingToken(app);
      await failsCleanly(
        app,
        a.userId,
        event,
        () =>
          app.inject({
            method: 'POST',
            url: '/api/v1/auth/2fa/verify',
            // The activation spent the current step; the next one is still in the window.
            payload: { pendingToken: token, code: totpCode(secret, Date.now() + 30_000) },
          }),
        true,
      );
    },
  );

  it('a recovery-code step whose auth.2fa_recovery_used write fails leaves no session', async () => {
    const { app, a } = await boot();
    const { recovery } = await enable(a);
    const token = await pendingToken(app);
    await failsCleanly(
      app,
      a.userId,
      'auth.2fa_recovery_used',
      () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/2fa/verify',
          payload: { pendingToken: token, recoveryCode: recovery[0] },
        }),
      true,
    );
  });

  it('a registration whose auth.register write fails creates no account', async () => {
    const { app, a } = await boot();
    const opened = await a.request({
      method: 'PATCH',
      url: '/api/v1/admin/registration',
      payload: { open: true, password: PASSWORD },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const email = 'new-779@example.com';
    failing = 'auth.register';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: PASSWORD, displayName: 'New' },
    });
    failing = null;
    expect(res.statusCode, res.body).toBe(500);
    expect(sessionCookie(res)).toBeUndefined();
    expect(await app.db.select().from(users).where(eq(users.email, email)).get()).toBeUndefined();
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: PASSWORD, displayName: 'New' },
    });
    expect(again.statusCode, again.body).toBe(201);
  });
});

describe('credential changes: the audit row commits with the change (#779)', () => {
  it('a password change whose audit write fails keeps the old password and sessions', async () => {
    const { app, a } = await boot();
    await failsCleanly(app, a.userId, 'auth.password_changed', () =>
      a.request({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { current: PASSWORD, next: NEW_PASSWORD },
      }),
    );
    // The old session still works, and the old password still signs in.
    expect((await a.request({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(200);
    expect((await login(app)).statusCode).toBe(200);
  });

  it('a 2FA enrolment whose audit write fails stores no secret', async () => {
    const { app, a } = await boot();
    await failsCleanly(app, a.userId, 'auth.2fa_enroll_started', () =>
      a.request({
        method: 'POST',
        url: '/api/v1/auth/2fa/enroll',
        payload: { password: PASSWORD },
      }),
    );
  });

  it('a 2FA activation whose audit write fails leaves 2FA off', async () => {
    const { app, a } = await boot();
    const secret = await enroll(a);
    await failsCleanly(app, a.userId, 'auth.2fa_enabled', () =>
      a.request({
        method: 'POST',
        url: '/api/v1/auth/2fa/activate',
        payload: { password: PASSWORD, code: totpCode(secret, Date.now()) },
      }),
    );
  });

  it('a 2FA removal whose audit write fails leaves 2FA on', async () => {
    const { app, a } = await boot();
    const { recovery } = await enable(a);
    await failsCleanly(
      app,
      a.userId,
      'auth.2fa_disabled',
      () =>
        a.request({
          method: 'POST',
          url: '/api/v1/auth/2fa/disable',
          payload: { password: PASSWORD, recoveryCode: recovery[0] },
        }),
      true,
    );
    expect((await state(app, a.userId, 'auth.2fa_disabled')).user?.totpEnabled).toBe(true);
  });
});
