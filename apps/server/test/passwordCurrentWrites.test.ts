// Writes that follow a password check run only while that password is still current
// (https://github.com/bgoleno/opportun/issues/620 point 2, sec's second audit): 2FA enrol and
// activate, and an admin's reset of another account, as a sign-in and a device token already do
// (#539, #561). And a sign-in reads whether 2FA is on under the same lock, so an activation that
// commits during the sign-in gives a pending token, not a full session. Each test parks the step
// right after its check, runs the other request to the end, then lets the step go on.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { auditLog, users } from '../src/db/schema';
import { totpCode } from '../src/lib/totp';
import { useApi } from './api';
import { PASSWORD, type TestClient } from './isolation';
import { onSlowTransaction } from '../src/db/gate';
import { pauseAt, settledOrWaiting } from './race';

const boot = useApi();
const NEW_PASSWORD = 'a brand new passphrase 620';

const changeOwn = (c: TestClient) =>
  c.request({
    method: 'POST',
    url: '/api/v1/auth/password',
    payload: { current: PASSWORD, next: NEW_PASSWORD },
  });

const userRow = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(users).where(eq(users.id, id)).get())!;

async function enroll(c: TestClient): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/auth/2fa/enroll',
    payload: { password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { secret: string }).secret;
}

/** Holds `request` at `point`, runs `meanwhile` to the end, then lets the request finish. */
async function heldAt<T>(point: string, request: () => Promise<T>, meanwhile: () => Promise<void>) {
  const pause = pauseAt(point);
  const pending = request();
  await pause.reached;
  await meanwhile();
  pause.release();
  return await pending;
}

describe('#620 point 2: a write after a password check needs that password still current', () => {
  it('2FA enrol: a password change during it wins, and no secret is stored', async () => {
    const { app, b } = await boot();
    const res = await heldAt(
      'twoFactor.enroll',
      () =>
        b.request({
          method: 'POST',
          url: '/api/v1/auth/2fa/enroll',
          payload: { password: PASSWORD },
        }),
      async () => {
        expect((await changeOwn(b)).statusCode).toBe(204);
      },
    );
    expect(res.statusCode, res.body).toBe(403);
    // The sentence reaches the user, not just the code (#743: the 403 schema stripped it).
    expect(res.json()).toMatchObject({
      error: {
        code: 'password_changed',
        message:
          'Your password changed while this was being checked. Sign in again and try once more.',
      },
    });
    expect((await userRow(app, b.userId)).totpSecret).toBeNull();
  });

  it('2FA activate: a password change during it wins, and 2FA stays off', async () => {
    const { app, b } = await boot();
    const secret = await enroll(b);
    const res = await heldAt(
      'twoFactor.activate',
      () =>
        b.request({
          method: 'POST',
          url: '/api/v1/auth/2fa/activate',
          payload: { password: PASSWORD, code: totpCode(secret, Date.now()) },
        }),
      async () => {
        expect((await changeOwn(b)).statusCode).toBe(204);
      },
    );
    expect(res.statusCode, res.body).toBe(403);
    // The sentence reaches the user, not just the code (#743: the 403 schema stripped it).
    expect(res.json()).toMatchObject({
      error: {
        code: 'password_changed',
        message:
          'Your password changed while this was being checked. Sign in again and try once more.',
      },
    });
    const row = await userRow(app, b.userId);
    expect(row.totpEnabled).toBe(false);
    expect(row.totpRecovery).toBeNull();
  });

  it("an admin reset: a change of the admin's own password during it wins, and the account is untouched", async () => {
    const { app, a, b } = await boot();
    const before = (await userRow(app, b.userId)).passwordHash;
    const res = await heldAt(
      'admin.resetPassword.checked',
      () =>
        a.request({
          method: 'POST',
          url: `/api/v1/admin/users/${b.userId}/reset-password`,
          payload: { password: PASSWORD },
        }),
      async () => {
        expect((await changeOwn(a)).statusCode).toBe(204);
      },
    );
    expect(res.statusCode, res.body).toBe(403);
    // The sentence reaches the user, not just the code (#743: the 403 schema stripped it).
    expect(res.json()).toMatchObject({
      error: {
        code: 'password_changed',
        message:
          'Your password changed while this was being checked. Sign in again and try once more.',
      },
    });
    expect((await userRow(app, b.userId)).passwordHash).toBe(before);
  });

  // tl on #643: the other half of the claim. A change of the admin's own password that starts
  // while the reset holds its locks waits for it, then commits: it cannot land between the reset's
  // re-check and its writes. On SQLite the write gate serializes every write transaction anyway;
  // on Postgres it is the admin's own password lock that makes the change wait.
  it("a change of the admin's own password started while the reset holds its locks waits for it", async () => {
    const { app, a, b } = await boot();
    onSlowTransaction(() => undefined);
    const pause = pauseAt('admin.resetPassword.locked');
    const resetting = a.request({
      method: 'POST',
      url: `/api/v1/admin/users/${b.userId}/reset-password`,
      payload: { password: PASSWORD },
    });
    await pause.reached;
    const changing = changeOwn(a);
    expect(await settledOrWaiting(app, changing, pause)).toBe('waiting');
    pause.release();
    const [reset, changed] = await Promise.all([resetting, changing]);
    expect(reset.statusCode, reset.body).toBe(200);
    expect(changed.statusCode, changed.body).toBe(204);
  });

  it("a refused reset's audit names the account it was for", async () => {
    const { app, a, b } = await boot();
    await heldAt(
      'admin.resetPassword.checked',
      () =>
        a.request({
          method: 'POST',
          url: `/api/v1/admin/users/${b.userId}/reset-password`,
          payload: { password: PASSWORD },
        }),
      async () => {
        expect((await changeOwn(a)).statusCode).toBe(204);
      },
    );
    const rows = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'auth.reauth_failed'))
      .all();
    expect(rows.map((r) => r.detail)).toContainEqual(
      expect.objectContaining({
        action: 'admin.reset_password',
        reason: 'password_changed',
        targetUserId: b.userId,
      }),
    );
  });

  it('an account deleted while the reset was checking gets no password: 404', async () => {
    const { app, a, b } = await boot();
    const res = await heldAt(
      'admin.resetPassword.checked',
      () =>
        a.request({
          method: 'POST',
          url: `/api/v1/admin/users/${b.userId}/reset-password`,
          payload: { password: PASSWORD },
        }),
      async () => {
        await app.db.delete(users).where(eq(users.id, b.userId)).run();
      },
    );
    expect(res.statusCode, res.body).toBe(404);
  });

  it('a sign-in during a 2FA activation that commits first gets a pending token, not a session', async () => {
    const { app, b } = await boot();
    const secret = await enroll(b);
    const res = await heldAt(
      'auth.login.passwordChecked',
      () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'isolation-b@example.com', password: PASSWORD },
        }),
      async () => {
        const on = await b.request({
          method: 'POST',
          url: '/api/v1/auth/2fa/activate',
          payload: { password: PASSWORD, code: totpCode(secret, Date.now()) },
        });
        expect(on.statusCode, on.body).toBe(200);
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ requires2fa: true });
    expect(res.cookies.filter((c) => c.name === 'opportun_session' && c.value !== '')).toEqual([]);
  });
});
