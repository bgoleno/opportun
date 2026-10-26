import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { sessions, users } from '../db/schema';
import type { UserCtx } from '../repos/base';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * DAY_MS;
export const SESSION_IDLE_MS = 7 * DAY_MS;
/**
 * Skip the last_seen_at write when the session was touched this recently. Also the granularity
 * of users.last_seen_at while a session stays open (issue #320): both are "last known to within
 * this long," not a precise activity log.
 */
const TOUCH_INTERVAL_MS = 60 * 1000;

function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** New opaque session: 32 random bytes (base64url) to the client, SHA-256 hex stored. */
export async function createSession(
  db: Db,
  userId: string,
  meta: { ip?: string; userAgent?: string },
): Promise<{ token: string; expiresAt: number }> {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + SESSION_ABSOLUTE_MS;
  await db
    .insert(sessions)
    .values({
      id: tokenId(token),
      userId,
      expiresAt,
      lastSeenAt: now,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      createdAt: now,
    })
    .run();
  // Sign-in is the strongest available evidence of a visit (issue #320): getSessionUser's own
  // touch below is throttled to TOUCH_INTERVAL_MS, so a session that never lives that long
  // (someone who signs in, looks around, and closes the tab inside a minute) would otherwise
  // never write users.last_seen_at at all and would keep reading "Never" forever.
  await db.update(users).set({ lastSeenAt: now }).where(eq(users.id, userId)).run();
  return { token, expiresAt };
}

/** Resolves a token to its user, enforcing absolute and sliding idle expiry. */
export async function getSessionUser(db: Db, token: string): Promise<UserCtx | null> {
  if (token.length === 0) return null;
  const id = tokenId(token);
  const row = await db
    .select({
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      isAdmin: users.isAdmin,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    // Only real sessions: a pending_2fa row (password passed, code not yet) is never a login.
    .where(and(eq(sessions.id, id), eq(sessions.kind, 'session')))
    .get();
  if (row === undefined) return null;
  const now = Date.now();
  if (now >= row.expiresAt || now - row.lastSeenAt >= SESSION_IDLE_MS) {
    await db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }
  if (now - row.lastSeenAt >= TOUCH_INTERVAL_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id)).run();
    // users.last_seen_at (issue #320) piggybacks on this same throttled write rather than its
    // own policy: no new per-request write beyond the one this branch already makes. Needs no
    // extra kind='session' guard of its own -- the select above already filtered to it, so a
    // pending_2fa row cannot reach this branch at all (it is verified via 2fa.verify's own
    // kind='pending_2fa' query in twoFactor.ts, a separate path this function never touches).
    // No transaction around the two updates: if this one commits and the next fails,
    // last_seen_at is merely up to TOUCH_INTERVAL_MS staler than it should be and self-corrects
    // on the next touch -- a transaction would buy nothing against a failure mode that benign.
    await db.update(users).set({ lastSeenAt: now }).where(eq(users.id, row.userId)).run();
  }
  return { userId: row.userId, isAdmin: row.isAdmin };
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db
    .delete(sessions)
    .where(eq(sessions.id, tokenId(token)))
    .run();
}

export async function destroyAllSessions(db: Db, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId)).run();
}
