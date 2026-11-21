// Writes that follow a password check run only while that password is still current
// (https://github.com/bgoleno/opportun/issues/620 point 2, sec's second audit): 2FA enrol and
// activate, and an admin's reset of another account, as a sign-in and a device token already do
// (#539, #561). And a sign-in reads whether 2FA is on under the same lock, so an activation that
// commits during the sign-in gives a pending token, not a full session. Each test parks the step
// right after its check, runs the other request to the end, then lets the step go on.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import { totpCode } from '../src/lib/totp';
import { useApi } from './api';
import { PASSWORD, type TestClient } from './isolation';
import { pauseAt } from './race';

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
    expect((await userRow(app, b.userId)).passwordHash).toBe(before);
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
