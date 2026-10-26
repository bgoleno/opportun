// FR-S3 two-factor sign-in: enroll, activate, two-step login, recovery codes, disable, and
// recovery of last resort through the operator reset (plan Review Focus 3).
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main as cliResetPassword } from '../src/cli/resetPassword';
import { auditLog, sessions, users } from '../src/db/schema';
import { decryptSecret } from '../src/lib/secretBox';
import { totpCode } from '../src/lib/totp';
import { useApi } from './api';
import { captureLogs, testApp } from './helpers';
import { registerTwoUsers, type TestClient } from './isolation';

const PASSWORD = 'correct horse battery';
const A_EMAIL = 'isolation-a@example.com';
const B_EMAIL = 'isolation-b@example.com';
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const STEP = 30_000;

const boot = useApi();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

function cookie(res: LightMyRequestResponse, name: string): string | undefined {
  return (res.cookies as { name: string; value: string }[]).find((c) => c.name === name)?.value;
}

function login(app: FastifyInstance, email: string, password = PASSWORD, ip?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
    ...(ip === undefined ? {} : { remoteAddress: ip }),
  });
}

function verify(app: FastifyInstance, payload: Record<string, unknown>, ip?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/2fa/verify',
    payload,
    ...(ip === undefined ? {} : { remoteAddress: ip }),
  });
}

function me(app: FastifyInstance, session: string) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    cookies: { opportun_session: session },
  });
}

/** Enrolls and activates 2FA for `c`; returns the base32 secret and the recovery codes. */
async function enable(c: TestClient): Promise<{ secret: string; recoveryCodes: string[] }> {
  const enrolled = await c.request({
    method: 'POST',
    url: '/api/v1/auth/2fa/enroll',
    payload: { password: PASSWORD },
  });
  expect(enrolled.statusCode).toBe(200);
  const { secret } = enrolled.json() as { secret: string };
  const activated = await c.request({
    method: 'POST',
    url: '/api/v1/auth/2fa/activate',
    payload: { password: PASSWORD, code: totpCode(secret, Date.now()) },
  });
  expect(activated.statusCode).toBe(200);
  return { secret, recoveryCodes: (activated.json() as { recoveryCodes: string[] }).recoveryCodes };
}

async function pendingFor(app: FastifyInstance, email: string, ip?: string): Promise<string> {
  const res = await login(app, email, PASSWORD, ip);
  expect(res.statusCode).toBe(200);
  const body = res.json() as { requires2fa: boolean; pendingToken: string };
  expect(body.requires2fa).toBe(true);
  return body.pendingToken;
}

async function events(app: FastifyInstance, userId: string): Promise<string[]> {
  return (
    await app.db
      .select({ event: auditLog.event })
      .from(auditLog)
      .where(eq(auditLog.userId, userId))
      .all()
  ).map((r) => r.event);
}

describe('2FA enrollment', () => {
  it('enroll returns a secret, otpauth url and QR data url; the stored secret is encrypted', async () => {
    const { app, a } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/enroll',
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { secret: string; otpauthUrl: string; qrDataUrl: string };
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauthUrl).toContain(`secret=${body.secret}`);
    expect(body.otpauthUrl).toContain('otpauth://totp/Opportun:isolation-a%40example.com');
    expect(body.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    const row = (await app.db.select().from(users).where(eq(users.id, a.userId)).get())!;
    expect(row.totpEnabled).toBe(false);
    expect(row.totpSecret).not.toBeNull();
    expect(row.totpSecret).not.toContain(body.secret);
    expect(decryptSecret(app.db, row.totpSecret!)).toBe(body.secret);

    const status = await a.request({ method: 'GET', url: '/api/v1/auth/2fa' });
    expect(status.json()).toEqual({ enabled: false, recoveryCodesLeft: 0, hasPassword: true });
  });

  it('requires a session (and CSRF) to enroll', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/2fa/enroll' });
    expect(res.statusCode).toBe(403); // CSRF first: no cookie, no header
    const status = await app.inject({ method: 'GET', url: '/api/v1/auth/2fa' });
    expect(status.statusCode).toBe(401);
  });

  it('activate refuses a wrong code, then enables with the right one and returns 10 codes once', async () => {
    const { app, a } = await boot();
    const noEnroll = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/activate',
      payload: { password: PASSWORD, code: '123456' },
    });
    expect(noEnroll.statusCode).toBe(409);
    expect(noEnroll.json().error.code).toBe('not_enrolled');

    const { secret } = (
      await a.request({
        method: 'POST',
        url: '/api/v1/auth/2fa/enroll',
        payload: { password: PASSWORD },
      })
    ).json() as { secret: string };
    const wrong = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/activate',
      payload: { password: PASSWORD, code: totpCode(secret, Date.now() + 5 * STEP) },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('invalid_code');

    const ok = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/activate',
      payload: { password: PASSWORD, code: totpCode(secret, Date.now()) },
    });
    expect(ok.statusCode).toBe(200);
    const { recoveryCodes } = ok.json() as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    for (const c of recoveryCodes) expect(c).toMatch(/^[A-Z2-7]{10}$/);
    expect(new Set(recoveryCodes).size).toBe(10);

    const row = (await app.db.select().from(users).where(eq(users.id, a.userId)).get())!;
    expect(row.totpEnabled).toBe(true);
    expect(row.totpRecovery).toHaveLength(10);
    const stored = JSON.stringify(row.totpRecovery);
    for (const c of recoveryCodes) expect(stored).not.toContain(c);

    // Shown once: activating again is refused, and nothing re-exposes the codes or secret.
    const again = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/activate',
      payload: { password: PASSWORD, code: totpCode(secret, Date.now() + STEP) },
    });
    expect(again.statusCode).toBe(409);
    const reEnroll = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/enroll',
      payload: { password: PASSWORD },
    });
    expect(reEnroll.statusCode).toBe(409);
    expect(reEnroll.json().error.code).toBe('already_enabled');
    const status = await a.request({ method: 'GET', url: '/api/v1/auth/2fa' });
    expect(status.json()).toEqual({ enabled: true, recoveryCodesLeft: 10, hasPassword: true });
    expect(await events(app, a.userId)).toContain('auth.2fa_enabled');
  });
});

describe('two-step login', () => {
  it('a 2FA user gets requires2fa and a pending token, and no session cookie', async () => {
    const { app, a } = await boot();
    await enable(a);
    const res = await login(app, A_EMAIL);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ requires2fa: true, pendingToken: expect.any(String) });
    expect(cookie(res, 'opportun_session')).toBeUndefined();
    expect(cookie(res, 'opportun_csrf')).toBeUndefined();
  });

  it('the pending token is not a session: as a cookie it authenticates nothing', async () => {
    const { app, a } = await boot();
    await enable(a);
    const pending = await pendingFor(app, A_EMAIL);
    expect((await me(app, pending)).statusCode).toBe(401);
    // ...and it survives that probe: the cookie path never touches pending rows.
    const rows = await app.db.select().from(sessions).where(eq(sessions.kind, 'pending_2fa')).all();
    expect(rows).toHaveLength(1);
  });

  it('verify with a TOTP code issues a real session; the pending token is single-use', async () => {
    const { app, a } = await boot();
    const { secret } = await enable(a);
    vi.setSystemTime(T0 + 2 * STEP);
    const pending = await pendingFor(app, A_EMAIL);
    const res = await verify(app, { pendingToken: pending, code: totpCode(secret, Date.now()) });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(a.userId);
    const session = cookie(res, 'opportun_session');
    expect(session).toBeDefined();
    expect(cookie(res, 'opportun_csrf')).toBeDefined();
    expect((await me(app, session!)).json().user.id).toBe(a.userId);

    const reuse = await verify(app, {
      pendingToken: pending,
      code: totpCode(secret, Date.now() + STEP),
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe('token_used');
    expect(await events(app, a.userId)).toEqual(
      expect.arrayContaining(['auth.2fa_challenge', 'auth.2fa_verified', 'auth.login']),
    );
  });

  it('a spent pending token is token_used before any code check, so a second code is not burnt', async () => {
    const { app, a } = await boot();
    const { recoveryCodes } = await enable(a);
    const pending = await pendingFor(app, A_EMAIL);
    const first = await verify(app, { pendingToken: pending, recoveryCode: recoveryCodes[0] });
    expect(first.statusCode).toBe(200);
    // The loser of a race (here: simply the second call) never reaches the code check.
    const second = await verify(app, { pendingToken: pending, recoveryCode: recoveryCodes[1] });
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe('token_used');
    expect(cookie(second, 'opportun_session')).toBeUndefined();
    const status = await a.request({ method: 'GET', url: '/api/v1/auth/2fa' });
    expect(status.json()).toEqual({ enabled: true, recoveryCodesLeft: 9, hasPassword: true });
    // ...and the unburnt code still works on a fresh password step.
    const later = await verify(app, {
      pendingToken: await pendingFor(app, A_EMAIL),
      recoveryCode: recoveryCodes[1],
    });
    expect(later.statusCode).toBe(200);
  });

  it('refuses a replay of an already-accepted TOTP code', async () => {
    const { app, a } = await boot();
    const { secret } = await enable(a);
    vi.setSystemTime(T0 + 3 * STEP);
    const code = totpCode(secret, Date.now());
    const first = await verify(app, { pendingToken: await pendingFor(app, A_EMAIL), code });
    expect(first.statusCode).toBe(200);
    const replay = await verify(app, { pendingToken: await pendingFor(app, A_EMAIL), code });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('invalid_code');
  });

  it('a wrong code is 401 and audited, and the pending token stays usable', async () => {
    const { app, a } = await boot();
    const { secret } = await enable(a);
    vi.setSystemTime(T0 + 4 * STEP);
    const pending = await pendingFor(app, A_EMAIL);
    const bad = await verify(app, {
      pendingToken: pending,
      code: totpCode(secret, Date.now() + 10 * STEP),
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('invalid_code');
    expect(cookie(bad, 'opportun_session')).toBeUndefined();
    expect(await events(app, a.userId)).toContain('auth.2fa_failed');
    const good = await verify(app, { pendingToken: pending, code: totpCode(secret, Date.now()) });
    expect(good.statusCode).toBe(200);
  });

  it('an expired pending token is refused', async () => {
    const { app, a } = await boot();
    const { secret } = await enable(a);
    const pending = await pendingFor(app, A_EMAIL);
    vi.setSystemTime(T0 + 5 * 60 * 1000 + 1);
    const res = await verify(app, { pendingToken: pending, code: totpCode(secret, Date.now()) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_pending');
  });

  it('an unknown pending token or a body with both or neither factor is refused', async () => {
    const { app } = await boot();
    expect((await verify(app, { pendingToken: 'nope', code: '123456' })).statusCode).toBe(401);
    expect(
      (await verify(app, { pendingToken: 'x', code: '123456', recoveryCode: 'AAAAAAAAAA' }))
        .statusCode,
    ).toBe(400);
    expect((await verify(app, { pendingToken: 'x' })).statusCode).toBe(400);
  });

  it('rate limits verify like login', async () => {
    const { app, a } = await boot();
    await enable(a);
    const pending = await pendingFor(app, A_EMAIL);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (await verify(app, { pendingToken: pending, code: '000000' }, '203.0.113.9')).statusCode,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('caps code guesses per user, however many IPs and pending tokens the attacker uses', async () => {
    const { app, a, b } = await boot();
    const { secret } = await enable(a);
    const sb = await enable(b);
    vi.setSystemTime(T0 + 12 * STEP);
    // Ten attackers, each from its own IP with its own pending token, one wrong guess each.
    for (let i = 1; i <= 10; i++) {
      const ip = `198.51.100.${i}`;
      const res = await verify(
        app,
        { pendingToken: await pendingFor(app, A_EMAIL, ip), code: '000000' },
        ip,
      );
      expect(res.statusCode, ip).toBe(401);
    }
    // The user's bucket is empty: even the right code from a fresh IP waits.
    const fresh = '198.51.100.200';
    const blocked = await verify(
      app,
      { pendingToken: await pendingFor(app, A_EMAIL, fresh), code: totpCode(secret, Date.now()) },
      fresh,
    );
    expect(blocked.statusCode).toBe(429);
    // Another user is not affected by A's bucket.
    const other = '198.51.100.201';
    const okB = await verify(
      app,
      {
        pendingToken: await pendingFor(app, B_EMAIL, other),
        code: totpCode(sb.secret, Date.now()),
      },
      other,
    );
    expect(okB.statusCode).toBe(200);
  });

  it('a pending token dies after 5 failed codes: the 6th try fails even with the right code', async () => {
    const { app, a } = await boot();
    const { secret } = await enable(a);
    vi.setSystemTime(T0 + 14 * STEP);
    const pending = await pendingFor(app, A_EMAIL);
    for (let i = 0; i < 5; i++) {
      const res = await verify(app, { pendingToken: pending, code: '000000' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('invalid_code');
    }
    const sixth = await verify(app, { pendingToken: pending, code: totpCode(secret, Date.now()) });
    expect(sixth.statusCode).toBe(401);
    expect(sixth.json().error.code).toBe('invalid_pending');
    expect(
      await app.db.select().from(sessions).where(eq(sessions.kind, 'pending_2fa')).all(),
    ).toHaveLength(0);
    // A fresh password step works as normal.
    const again = await verify(app, {
      pendingToken: await pendingFor(app, A_EMAIL),
      code: totpCode(secret, Date.now()),
    });
    expect(again.statusCode).toBe(200);
  });

  it('a user without 2FA still signs in in one step', async () => {
    const { app } = await boot();
    const res = await login(app, B_EMAIL);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(B_EMAIL);
    expect(cookie(res, 'opportun_session')).toBeDefined();
  });
});

describe('recovery codes (lost phone, codes kept)', () => {
  it('each recovery code signs in exactly once, tolerating case and dashes', async () => {
    const { app, a } = await boot();
    const { recoveryCodes } = await enable(a);
    const code = recoveryCodes[0]!;
    const typed = `${code.slice(0, 5).toLowerCase()}-${code.slice(5)}`;
    const first = await verify(app, {
      pendingToken: await pendingFor(app, A_EMAIL),
      recoveryCode: typed,
    });
    expect(first.statusCode).toBe(200);
    expect(cookie(first, 'opportun_session')).toBeDefined();
    expect(await events(app, a.userId)).toContain('auth.2fa_recovery_used');

    const second = await verify(app, {
      pendingToken: await pendingFor(app, A_EMAIL),
      recoveryCode: code,
    });
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe('invalid_code');

    // The other nine still work.
    const other = await verify(app, {
      pendingToken: await pendingFor(app, A_EMAIL),
      recoveryCode: recoveryCodes[1]!,
    });
    expect(other.statusCode).toBe(200);
    const status = await a.request({ method: 'GET', url: '/api/v1/auth/2fa' });
    expect(status.json()).toEqual({ enabled: true, recoveryCodesLeft: 8, hasPassword: true });
  });
});

describe('operator reset (no phone, no codes)', () => {
  it('the CLI password reset also clears 2FA, so the temporary password signs in in one step', async () => {
    const { app, a } = await boot();
    await enable(a);
    const out: string[] = [];
    const code = await cliResetPassword({
      db: app.db,
      email: A_EMAIL,
      io: { stdout: (l) => out.push(l), stderr: () => undefined },
    });
    expect(code).toBe(0);
    const row = (await app.db.select().from(users).where(eq(users.id, a.userId)).get())!;
    expect(row.totpEnabled).toBe(false);
    expect(row.totpSecret).toBeNull();
    expect(row.totpRecovery).toBeNull();
    const res = await login(app, A_EMAIL, out[0]!);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(a.userId);
    expect(cookie(res, 'opportun_session')).toBeDefined();
  });
});

describe('disable', () => {
  it('requires a valid code; afterwards login is one step again', async () => {
    const { app, a } = await boot();
    const { secret } = await enable(a);
    vi.setSystemTime(T0 + 6 * STEP);
    const wrong = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/disable',
      payload: { password: PASSWORD, code: totpCode(secret, Date.now() + 10 * STEP) },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('invalid_code');
    const none = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/disable',
      payload: { password: PASSWORD },
    });
    expect(none.statusCode).toBe(400);

    const ok = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/disable',
      payload: { password: PASSWORD, code: totpCode(secret, Date.now()) },
    });
    expect(ok.statusCode).toBe(204);
    const row = (await app.db.select().from(users).where(eq(users.id, a.userId)).get())!;
    expect(row.totpEnabled).toBe(false);
    expect(row.totpSecret).toBeNull();
    expect(row.totpRecovery).toBeNull();
    expect(await events(app, a.userId)).toContain('auth.2fa_disabled');
    const res = await login(app, A_EMAIL);
    expect(cookie(res, 'opportun_session')).toBeDefined();
  });

  it('accepts a recovery code', async () => {
    const { a } = await boot();
    const { recoveryCodes } = await enable(a);
    const ok = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/disable',
      payload: { password: PASSWORD, recoveryCode: recoveryCodes[3] },
    });
    expect(ok.statusCode).toBe(204);
  });

  it('refuses when 2FA is not enabled', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/disable',
      payload: { password: PASSWORD, code: '123456' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('re-authentication (a hijacked cookie alone changes nothing)', () => {
  const WRONG = 'not the password at all';

  it('enroll needs the current password', async () => {
    const { app, a } = await boot();
    const missing = await a.request({ method: 'POST', url: '/api/v1/auth/2fa/enroll' });
    expect(missing.statusCode).toBe(400);
    const wrong = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/enroll',
      payload: { password: WRONG },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('invalid_password');
    expect(
      (await app.db.select().from(users).where(eq(users.id, a.userId)).get())!.totpSecret,
    ).toBeNull();
    const audits = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'auth.reauth_failed'))
      .all();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toEqual({ action: '2fa.enroll' });
  });

  it('activate needs the current password even with the right code', async () => {
    const { app, a } = await boot();
    const { secret } = (
      await a.request({
        method: 'POST',
        url: '/api/v1/auth/2fa/enroll',
        payload: { password: PASSWORD },
      })
    ).json() as { secret: string };
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/activate',
      payload: { code: totpCode(secret, Date.now()), password: WRONG },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('invalid_password');
    expect(
      (await app.db.select().from(users).where(eq(users.id, a.userId)).get())!.totpEnabled,
    ).toBe(false);
  });

  it('disable needs the current password, and a wrong one spends no code', async () => {
    const { app, a } = await boot();
    const { recoveryCodes } = await enable(a);
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/disable',
      payload: { recoveryCode: recoveryCodes[0], password: WRONG },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('invalid_password');
    const row = (await app.db.select().from(users).where(eq(users.id, a.userId)).get())!;
    expect(row.totpEnabled).toBe(true);
    expect(row.totpRecovery).toHaveLength(10);
  });

  it('wrong passwords are rate limited like login', async () => {
    const { a } = await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (
          await a.request({
            method: 'POST',
            url: '/api/v1/auth/2fa/enroll',
            payload: { password: WRONG },
          })
        ).statusCode,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('isolation', () => {
  it("one user's pending token never verifies with the other user's code (both directions)", async () => {
    const { app, a, b } = await boot();
    const sa = await enable(a);
    const sb = await enable(b);
    vi.setSystemTime(T0 + 8 * STEP);
    const pa = await pendingFor(app, A_EMAIL);
    const pb = await pendingFor(app, B_EMAIL);

    const bWithA = await verify(app, { pendingToken: pb, code: totpCode(sa.secret, Date.now()) });
    expect(bWithA.statusCode).toBe(401);
    const aWithB = await verify(app, { pendingToken: pa, code: totpCode(sb.secret, Date.now()) });
    expect(aWithB.statusCode).toBe(401);
    const aRecB = await verify(app, { pendingToken: pa, recoveryCode: sb.recoveryCodes[0] });
    expect(aRecB.statusCode).toBe(401);
    const bRecA = await verify(app, { pendingToken: pb, recoveryCode: sa.recoveryCodes[0] });
    expect(bRecA.statusCode).toBe(401);

    // Each still signs in as themselves only.
    const okA = await verify(app, { pendingToken: pa, code: totpCode(sa.secret, Date.now()) });
    expect(okA.json().user.id).toBe(a.userId);
    const okB = await verify(app, { pendingToken: pb, code: totpCode(sb.secret, Date.now()) });
    expect(okB.json().user.id).toBe(b.userId);
  });

  it("enabling 2FA for one user leaves the other's status and login untouched", async () => {
    const { app, a, b } = await boot();
    await enable(a);
    expect((await b.request({ method: 'GET', url: '/api/v1/auth/2fa' })).json()).toEqual({
      enabled: false,
      recoveryCodesLeft: 0,
      hasPassword: true,
    });
    expect(cookie(await login(app, B_EMAIL), 'opportun_session')).toBeDefined();
    await enable(b);
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/disable',
      payload: { password: PASSWORD, code: '000000' },
    });
    expect(res.statusCode).toBe(403);
    const bRow = (await app.db.select().from(users).where(eq(users.id, b.userId)).get())!;
    expect(bRow.totpEnabled).toBe(true);
  });
});

describe('secrecy', () => {
  it('the secret and recovery codes never reach logs or the audit trail', async () => {
    const logs = captureLogs();
    const { app } = await testApp({ logLevel: 'trace' }, { logStream: logs });
    try {
      const { a } = await registerTwoUsers(app);
      const { secret, recoveryCodes } = await enable(a);
      await verify(app, {
        pendingToken: await pendingFor(app, A_EMAIL),
        recoveryCode: recoveryCodes[0],
      });
      const audit = JSON.stringify(await app.db.select().from(auditLog).all());
      const logText = logs.text();
      expect(logText).toContain('/api/v1/auth/2fa/verify'); // the capture saw the requests
      for (const s of [secret, ...recoveryCodes]) {
        expect(audit).not.toContain(s);
        expect(logText).not.toContain(s);
      }
    } finally {
      await app.close();
    }
  });
});
