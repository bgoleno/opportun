// A device token minted during a password change or reset (https://github.com/bgoleno/opportun/issues/539).
// POST /device-tokens checks the password and then inserts the token. A password change that
// revokes the user's tokens (#523), or an admin reset, could commit between the two, and the new
// token survived it. The insert now happens only while the hash the password was proven against is
// still the user's, under the lock the change and the reset take. Each test parks the mint right
// after its password check, runs the change or reset to completion, then lets the mint go on.
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { deviceTokens } from '../src/db/schema';
import { useApi } from './api';
import { PASSWORD, type TestClient } from './isolation';
import { onSlowTransaction } from '../src/db/gate';
import { pauseAt, settledOrWaiting } from './race';

const boot = useApi();
const NEW_PASSWORD = 'a brand new passphrase 539';

const mint = (c: TestClient) =>
  c.request({
    method: 'POST',
    url: '/api/v1/device-tokens',
    payload: { name: 'Chrome', scopes: ['capture:push'], password: PASSWORD },
  });

const activeTokens = (app: FastifyInstance, c: TestClient) =>
  app.db
    .select()
    .from(deviceTokens)
    .where(and(eq(deviceTokens.userId, c.userId), isNull(deviceTokens.revokedAt)))
    .all();

/** Parks a mint after its password check, runs `meanwhile`, then lets the mint finish. */
async function mintDuring(c: TestClient, meanwhile: () => Promise<void>) {
  const pause = pauseAt('deviceTokens.create.passwordChecked');
  const pending = mint(c);
  await pause.reached;
  await meanwhile();
  pause.release();
  return await pending;
}

describe('a token minted during a password change or reset is not created (#539)', () => {
  it('a password change that revokes the tokens: the held mint gets 403 and creates nothing', async () => {
    const { app, a } = await boot();
    const res = await mintDuring(a, async () => {
      const changed = await a.request({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { current: PASSWORD, next: NEW_PASSWORD, revokeDeviceTokens: true },
      });
      expect(changed.statusCode, changed.body).toBe(204);
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('password_changed');
    expect(await activeTokens(app, a)).toEqual([]);
    expect(
      await app.db.select().from(deviceTokens).where(eq(deviceTokens.userId, a.userId)).all(),
    ).toEqual([]);
  });

  it('an admin reset: the held mint gets 403 and creates nothing', async () => {
    const { app, a, b } = await boot();
    const res = await mintDuring(b, async () => {
      const reset = await a.request({
        method: 'POST',
        url: `/api/v1/admin/users/${b.userId}/reset-password`,
        payload: { password: PASSWORD },
      });
      expect(reset.statusCode, reset.body).toBe(200);
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('password_changed');
    expect(await activeTokens(app, b)).toEqual([]);
  });

  // The lock: a mint that has re-checked the hash inside its transaction holds it, so a change or
  // reset that starts then waits for the insert and revokes the new token with the rest. Without
  // the lock, on Postgres, the change would commit first and the token outlive it. (On SQLite
  // the write gate serialises the two anyway, so there this holds with or without the lock.)
  for (const kind of ['change', 'reset'] as const) {
    it(`a ${kind} that starts while the mint holds the lock waits, then revokes the new token`, async () => {
      const { app, a, b } = await boot();
      onSlowTransaction(() => undefined);
      const owner = kind === 'change' ? a : b;
      const pause = pauseAt('deviceTokens.create.locked');
      const minting = mint(owner);
      await pause.reached;
      const competing =
        kind === 'change'
          ? a.request({
              method: 'POST',
              url: '/api/v1/auth/password',
              payload: { current: PASSWORD, next: NEW_PASSWORD, revokeDeviceTokens: true },
            })
          : a.request({
              method: 'POST',
              url: `/api/v1/admin/users/${b.userId}/reset-password`,
              payload: { password: PASSWORD },
            });
      const seen = await settledOrWaiting(app, competing, pause);
      pause.release();
      const [minted, other] = await Promise.all([minting, competing]);
      expect(seen).toBe('waiting');
      expect(minted.statusCode, minted.body).toBe(201);
      expect(other.statusCode, other.body).toBe(kind === 'change' ? 204 : 200);
      expect(await activeTokens(app, owner)).toEqual([]);
    });
  }

  it('with nothing in between, the same held mint is created (the control)', async () => {
    const { app, a } = await boot();
    const res = await mintDuring(a, async () => undefined);
    expect(res.statusCode, res.body).toBe(201);
    expect(await activeTokens(app, a)).toHaveLength(1);
  });
});
