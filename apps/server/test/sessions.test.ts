// getSessionUser's failure shape (issue #108): a lookup that throws is a different condition
// from one that correctly finds no session, and must stay distinguishable to its caller
// rather than being coerced into the same null a clean "not signed in" produces.
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { sessions, users } from '../src/db/schema';
import { createSession, destroySession, getSessionUser } from '../src/lib/sessions';
import { openTestDb } from './helpers';

describe('getSessionUser', () => {
  it('propagates a lookup failure instead of resolving it to null', async () => {
    const broken = {
      select: () => {
        throw new Error('connection lost');
      },
    } as unknown as Db;
    await expect(getSessionUser(broken, 'sometoken')).rejects.toThrow('connection lost');
  });
});

/** sessions.ts's own token hash, duplicated rather than exported (it is private there, same as
 *  twoFactor.ts's own sha256 helper for its pending_2fa rows): a test needs to address a row by
 *  the same id the module computes, not a reason to widen that module's public surface. */
function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function insertBareUser(db: Db, id: string, email: string): Promise<void> {
  const now = Date.now();
  await db
    .insert(users)
    .values({
      id,
      email,
      passwordHash: 'unused-in-these-tests',
      displayName: email,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe('users.lastSeenAt (issue #320): persisted, not derived from live sessions', () => {
  it('createSession writes it immediately, before any touch-interval throttle could fire', async () => {
    const { handle, close } = await openTestDb();
    try {
      const { db } = handle;
      await insertBareUser(db, 'u1', 'u1@example.com');
      const before = Date.now();
      await createSession(db, 'u1', {});
      const row = await db.select({ lastSeenAt: users.lastSeenAt }).from(users).get();
      expect(row?.lastSeenAt).toBeGreaterThanOrEqual(before);
    } finally {
      await close();
    }
  });

  it('survives sign-out: destroySession deletes the session row, not users.lastSeenAt (the #320 bug)', async () => {
    const { handle, close } = await openTestDb();
    try {
      const { db } = handle;
      await insertBareUser(db, 'u1', 'u1@example.com');
      const { token } = await createSession(db, 'u1', {});
      const seenAt = (await db.select({ lastSeenAt: users.lastSeenAt }).from(users).get())
        ?.lastSeenAt;
      expect(seenAt).not.toBeNull();

      await destroySession(db, token);

      expect(await db.select().from(sessions).where(eq(sessions.userId, 'u1')).all()).toEqual([]);
      const after = await db.select({ lastSeenAt: users.lastSeenAt }).from(users).get();
      expect(after?.lastSeenAt).toBe(seenAt);
    } finally {
      await close();
    }
  });

  it('getSessionUser skips the write inside the touch interval, then catches up once it elapses', async () => {
    const { handle, close } = await openTestDb();
    try {
      const { db } = handle;
      await insertBareUser(db, 'u1', 'u1@example.com');
      const { token } = await createSession(db, 'u1', {});
      const signInSeenAt = (await db.select({ lastSeenAt: users.lastSeenAt }).from(users).get())
        ?.lastSeenAt;

      // Immediately: well inside the touch interval, nothing should move.
      await getSessionUser(db, token);
      expect(
        (await db.select({ lastSeenAt: users.lastSeenAt }).from(users).get())?.lastSeenAt,
      ).toBe(signInSeenAt);

      // Back-date the session's own lastSeenAt past the touch interval (comfortably, rather
      // than coupling this test to the exact TOUCH_INTERVAL_MS value) and touch again.
      await db
        .update(sessions)
        .set({ lastSeenAt: Date.now() - 10 * 60 * 1000 })
        .where(eq(sessions.id, tokenId(token)))
        .run();
      const before = Date.now();
      await getSessionUser(db, token);
      const after = await db.select({ lastSeenAt: users.lastSeenAt }).from(users).get();
      expect(after?.lastSeenAt).toBeGreaterThanOrEqual(before);
    } finally {
      await close();
    }
  });

  it('a pending_2fa row never reaches the touch at all: users.lastSeenAt stays untouched', async () => {
    const { handle, close } = await openTestDb();
    try {
      const { db } = handle;
      await insertBareUser(db, 'u1', 'u1@example.com');
      const token = 'a-pending-2fa-token';
      const now = Date.now();
      await db
        .insert(sessions)
        .values({
          id: tokenId(token),
          userId: 'u1',
          kind: 'pending_2fa',
          expiresAt: now + 60_000,
          lastSeenAt: now,
          createdAt: now,
        })
        .run();

      expect(await getSessionUser(db, token)).toBeNull();
      expect(
        (await db.select({ lastSeenAt: users.lastSeenAt }).from(users).get())?.lastSeenAt,
      ).toBeNull();
    } finally {
      await close();
    }
  });
});
