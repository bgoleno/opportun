// A sign-in started during its password check, outliving a password change or reset
// (https://github.com/bgoleno/opportun/issues/561, the class of #539). Each test parks a step right
// after it proved the password, runs the change or reset to the end, then lets the step go on.
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { auditLog, sessions, users } from '../src/db/schema';
import { totpCode } from '../src/lib/totp';
import { useApi } from './api';
import { PASSWORD, type TestClient } from './isolation';
import { onSlowTransaction } from '../src/db/gate';
import { pauseAt, settledOrWaiting } from './race';

const boot = useApi();

/** Enrolls `c` in 2FA; returns the base32 secret, not yet active. */
async function enroll(c: TestClient): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/auth/2fa/enroll',
    payload: { password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { secret: string }).secret;
}

const resetBy = (admin: TestClient, target: TestClient) =>
  admin.request({
    method: 'POST',
    url: `/api/v1/admin/users/${target.userId}/reset-password`,
    payload: { password: PASSWORD },
  });

const EMAIL = { a: 'isolation-a@example.com', b: 'isolation-b@example.com' } as const;
const NEW_PASSWORD = 'a brand new passphrase 561';

const login = (app: FastifyInstance, email: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });

const changeOwn = (c: TestClient) =>
  c.request({
    method: 'POST',
    url: '/api/v1/auth/password',
    payload: { current: PASSWORD, next: NEW_PASSWORD },
  });

/** Every sessions row the user has, sessions and pending 2FA tokens alike. */
const rowsOf = async (app: FastifyInstance, userId: string) =>
  await app.db.select().from(sessions).where(eq(sessions.userId, userId)).all();

/** Turns 2FA on for `c`; returns its secret. */
async function enable(c: TestClient): Promise<string> {
  const secret = await enroll(c);
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/auth/2fa/activate',
    payload: { password: PASSWORD, code: totpCode(secret, Date.now()) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return secret;
}

/** Parks a login after its password check, runs `meanwhile`, then lets the login finish. */
async function loginDuring(app: FastifyInstance, email: string, meanwhile: () => Promise<void>) {
  const pause = pauseAt('auth.login.passwordChecked');
  const pending = login(app, email);
  await pause.reached;
  await meanwhile();
  pause.release();
  return await pending;
}

const refused = (res: { statusCode: number; json: () => unknown; cookies: unknown }) => {
  expect(res.statusCode).toBe(401);
  expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_credentials');
  expect(
    (res.cookies as { name: string; value: string }[]).filter(
      (c) => c.name === 'opportun_session' && c.value !== '',
    ),
  ).toEqual([]);
};

const userRow = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(users).where(eq(users.id, id)).get())!;

describe('2FA set up during a password check does not survive a reset (#561, criterion 3)', () => {
  it('an activate held past its checks is refused after a reset, and 2FA stays off', async () => {
    const { app, a, b } = await boot();
    const secret = await enroll(b);
    const pause = pauseAt('twoFactor.activate');
    const activating = b.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/activate',
      payload: { password: PASSWORD, code: totpCode(secret, Date.now()) },
    });
    await pause.reached;
    const reset = await resetBy(a, b);
    expect(reset.statusCode, reset.body).toBe(200);
    pause.release();
    const res = await activating;
    expect(res.statusCode, res.body).not.toBe(200);
    const row = await userRow(app, b.userId);
    expect(row.totpEnabled).toBe(false);
    expect(row.totpSecret).toBeNull();
    expect(row.totpRecovery).toBeNull();
    expect(
      await app.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, b.userId)))
        .all(),
    ).toEqual([]);
  });
});

describe('a login held after its password check is refused by a change or reset (#561)', () => {
  it('a password change: the held login gets 401 and starts no session', async () => {
    const { app, a } = await boot();
    const res = await loginDuring(app, EMAIL.a, async () => {
      expect((await changeOwn(a)).statusCode).toBe(204);
    });
    refused(res);
    // Only the session the change itself gave the changer.
    expect(await rowsOf(app, a.userId)).toHaveLength(1);
  });

  it('an admin reset: the held login gets 401, and the account has no session', async () => {
    const { app, a, b } = await boot();
    const res = await loginDuring(app, EMAIL.b, async () => {
      expect((await resetBy(a, b)).statusCode).toBe(200);
    });
    refused(res);
    expect(await rowsOf(app, b.userId)).toEqual([]);
  });

  it('is audited as a failed login, with the reason', async () => {
    const { app, a, b } = await boot();
    await loginDuring(app, EMAIL.b, async () => {
      expect((await resetBy(a, b)).statusCode).toBe(200);
    });
    const failed = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, b.userId), eq(auditLog.event, 'auth.login_failed')))
      .all();
    expect(failed.map((r) => r.detail)).toEqual([{ email: EMAIL.b, reason: 'password_changed' }]);
  });

  it('with 2FA, a password change: no pending token is written', async () => {
    const { app, b } = await boot();
    await enable(b);
    const res = await loginDuring(app, EMAIL.b, async () => {
      expect((await changeOwn(b)).statusCode).toBe(204);
    });
    refused(res);
    expect((await rowsOf(app, b.userId)).map((r) => r.kind)).toEqual(['session']);
  });

  it('with 2FA, an admin reset: no pending token is written', async () => {
    const { app, a, b } = await boot();
    await enable(b);
    const res = await loginDuring(app, EMAIL.b, async () => {
      expect((await resetBy(a, b)).statusCode).toBe(200);
    });
    refused(res);
    expect(await rowsOf(app, b.userId)).toEqual([]);
  });

  it('with nothing in between, the same held login signs in (the control)', async () => {
    const { app, b } = await boot();
    const res = await loginDuring(app, EMAIL.b, async () => undefined);
    expect(res.statusCode, res.body).toBe(200);
    // Its session, beside the one b registered with.
    expect(await rowsOf(app, b.userId)).toHaveLength(2);
  });
});

describe('a 2FA code step held after its code check is refused by a change or reset (#561)', () => {
  async function verifyDuring(
    app: FastifyInstance,
    secret: string,
    meanwhile: () => Promise<void>,
  ) {
    const started = await login(app, EMAIL.b);
    const { pendingToken } = started.json() as { pendingToken: string };
    const pause = pauseAt('auth.2faVerify.redeemed');
    const verifying = app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/verify',
      payload: { pendingToken, code: totpCode(secret, Date.now() + 30_000) },
    });
    await pause.reached;
    await meanwhile();
    pause.release();
    return await verifying;
  }

  it('an admin reset: the held verify starts no session', async () => {
    const { app, a, b } = await boot();
    const secret = await enable(b);
    const res = await verifyDuring(app, secret, async () => {
      expect((await resetBy(a, b)).statusCode).toBe(200);
    });
    expect(res.statusCode, res.body).toBe(401);
    expect(await rowsOf(app, b.userId)).toEqual([]);
  });

  it('a password change: the held verify starts no session', async () => {
    const { app, b } = await boot();
    const secret = await enable(b);
    const res = await verifyDuring(app, secret, async () => {
      expect((await changeOwn(b)).statusCode).toBe(204);
    });
    expect(res.statusCode, res.body).toBe(401);
    expect((await rowsOf(app, b.userId)).map((r) => r.kind)).toEqual(['session']);
  });

  it('with nothing in between, the same held verify signs in (the control)', async () => {
    const { app, b } = await boot();
    const secret = await enable(b);
    const res = await verifyDuring(app, secret, async () => undefined);
    expect(res.statusCode, res.body).toBe(200);
  });
});

// The lock: a login that has checked the hash inside its transaction holds it, so a change or
// reset that starts then waits for the session, and deletes it with the rest. Without the lock,
// on Postgres, the change would commit first and the session outlive it. (On SQLite the write
// gate serialises the two anyway, so there this holds with or without the lock.)
describe('a change or reset that starts while a login holds the lock waits, then deletes its session (#561)', () => {
  for (const kind of ['change', 'reset'] as const) {
    it(`a ${kind}`, async () => {
      const { app, a, b } = await boot();
      onSlowTransaction(() => undefined);
      const owner = b;
      const pause = pauseAt('auth.login.locked');
      const loggingIn = login(app, EMAIL.b);
      await pause.reached;
      const competing = kind === 'change' ? changeOwn(b) : resetBy(a, b);
      const seen = await settledOrWaiting(app, competing, pause);
      pause.release();
      const [signedIn, other] = await Promise.all([loggingIn, competing]);
      expect(seen).toBe('waiting');
      expect(signedIn.statusCode, signedIn.body).toBe(200);
      expect(other.statusCode, other.body).toBe(kind === 'change' ? 204 : 200);
      // The login's session went with the rest: only the change's own, or none after a reset.
      expect(await rowsOf(app, owner.userId)).toHaveLength(kind === 'change' ? 1 : 0);
    });
  }
});

// What a password change leaves, against a reset or a code step that waits on its lock
// (tl on #571). The change parks inside its transaction, after it deleted the sessions.
describe('a change holding the password lock (#561)', () => {
  it("a reset that runs right after the change commits ends the changer's new session too", async () => {
    const { app, a, b } = await boot();
    const pause = pauseAt('auth.passwordChange.committed');
    const changing = changeOwn(b);
    await pause.reached;
    expect((await resetBy(a, b)).statusCode).toBe(200);
    pause.release();
    const changed = await changing;
    expect(changed.statusCode, changed.body).toBe(204);
    expect(await rowsOf(app, b.userId)).toEqual([]);
    const cookie = (changed.cookies as { name: string; value: string }[]).find(
      (c) => c.name === 'opportun_session',
    );
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { opportun_session: cookie!.value },
    });
    expect(me.statusCode).toBe(401);
  });

  it("a reset waiting behind it ends the changer's new session too", async () => {
    const { app, a, b } = await boot();
    onSlowTransaction(() => undefined);
    const pause = pauseAt('auth.passwordChange.locked');
    const changing = changeOwn(b);
    await pause.reached;
    const resetting = resetBy(a, b);
    expect(await settledOrWaiting(app, resetting, pause)).toBe('waiting');
    pause.release();
    const [changed, reset] = await Promise.all([changing, resetting]);
    expect(changed.statusCode, changed.body).toBe(204);
    expect(reset.statusCode, reset.body).toBe(200);
    expect(await rowsOf(app, b.userId)).toEqual([]);
    // The cookie the change handed out signs nobody in.
    const cookie = (changed.cookies as { name: string; value: string }[]).find(
      (c) => c.name === 'opportun_session',
    );
    expect(cookie?.value).toBeTruthy();
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { opportun_session: cookie!.value },
    });
    expect(me.statusCode).toBe(401);
  });

  it('a code step that starts while it holds the lock finds its pending token gone', async () => {
    const { app, b } = await boot();
    onSlowTransaction(() => undefined);
    const secret = await enable(b);
    const started = await login(app, EMAIL.b);
    const { pendingToken } = started.json() as { pendingToken: string };
    const pause = pauseAt('auth.passwordChange.locked');
    const changing = changeOwn(b);
    await pause.reached;
    const verifying = app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/verify',
      payload: { pendingToken, code: totpCode(secret, Date.now() + 30_000) },
    });
    // Held while the change is: by the write gate on SQLite, and on Postgres by the row lock on
    // its pending token, which the change has deleted and not yet committed. A row lock is not
    // one settledOrWaiting counts, so this looks for the step not having finished instead.
    let settled = false;
    const mark = () => {
      settled = true;
    };
    void verifying.then(mark, mark);
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
    } finally {
      pause.release();
    }
    const [changed, verified] = await Promise.all([changing, verifying]);
    expect(changed.statusCode, changed.body).toBe(204);
    expect(verified.statusCode, verified.body).toBe(401);
    expect((await rowsOf(app, b.userId)).map((r) => r.kind)).toEqual(['session']);
  });
});

// https://github.com/bgoleno/opportun/issues/662: a code step refused because the password changed
// says so (password_changed), not that the sign-in took too long (invalid_pending).
describe('a code step after a password change or reset is refused as password_changed (#662)', () => {
  const verify = (app: FastifyInstance, pendingToken: string, secret: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/verify',
      payload: { pendingToken, code: totpCode(secret, Date.now() + 30_000) },
    });
  const codeOf = (res: { json: () => unknown }) =>
    (res.json() as { error: { code: string } }).error.code;

  it('a password change between the password and the code', async () => {
    const { app, b } = await boot();
    const secret = await enable(b);
    const { pendingToken } = (await login(app, EMAIL.b)).json() as { pendingToken: string };
    expect((await changeOwn(b)).statusCode).toBe(204);
    const res = await verify(app, pendingToken, secret);
    expect(res.statusCode, res.body).toBe(401);
    expect(codeOf(res)).toBe('password_changed');
    // Only the changer's own new session: no session for the code step, and the token is gone.
    expect((await rowsOf(app, b.userId)).map((r) => r.kind)).toEqual(['session']);
    // Spent: asking again is the plain refusal.
    expect(codeOf(await verify(app, pendingToken, secret))).toBe('invalid_pending');
  });

  it('an admin reset between the password and the code', async () => {
    const { app, a, b } = await boot();
    const secret = await enable(b);
    const { pendingToken } = (await login(app, EMAIL.b)).json() as { pendingToken: string };
    expect((await resetBy(a, b)).statusCode).toBe(200);
    const res = await verify(app, pendingToken, secret);
    expect(res.statusCode, res.body).toBe(401);
    expect(codeOf(res)).toBe('password_changed');
    expect(await rowsOf(app, b.userId)).toEqual([]);
  });

  it('a change after the code step claimed its token (tl on #662): refused, and no session', async () => {
    const { app, b } = await boot();
    const secret = await enable(b);
    const { pendingToken } = (await login(app, EMAIL.b)).json() as { pendingToken: string };
    const pause = pauseAt('auth.2faVerify.redeemed');
    const verifying = verify(app, pendingToken, secret);
    await pause.reached;
    expect((await changeOwn(b)).statusCode).toBe(204);
    pause.release();
    const res = await verifying;
    expect(res.statusCode, res.body).toBe(401);
    expect(codeOf(res)).toBe('password_changed');
    expect((await rowsOf(app, b.userId)).map((r) => r.kind)).toEqual(['session']);
  });

  it('a change leaves no live pending token: a marked one is never claimed', async () => {
    const { app, b } = await boot();
    await enable(b);
    expect((await login(app, EMAIL.b)).statusCode).toBe(200);
    expect((await changeOwn(b)).statusCode).toBe(204);
    const pending = (await rowsOf(app, b.userId)).filter((r) => r.kind === 'pending_2fa');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.revokedReason).toBe('password_changed');
    expect(pending[0]!.usedAt).not.toBeNull();
  });

  it('an unknown token is still invalid_pending (the control)', async () => {
    const { app, b } = await boot();
    const secret = await enable(b);
    const res = await verify(app, 'not-a-pending-token-aaaaaaaaaaaaaaaa', secret);
    expect(res.statusCode).toBe(401);
    expect(codeOf(res)).toBe('invalid_pending');
  });
});
