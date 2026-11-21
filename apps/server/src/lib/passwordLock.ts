// Writes that depend on which password is current, held against a password change or reset
// (#539, https://github.com/bgoleno/opportun/issues/561). A step that proved a password and then
// writes a credential (a session, a pending 2FA token, a device token) writes it only while the
// hash it proved is still the user's, under the per-user lock a change and a reset take
// (passwordScope). A change or reset that commits during the check therefore wins: the step
// writes nothing. One that starts once the step holds the lock waits for the write, and then
// removes it with the rest.
import { and, eq } from 'drizzle-orm';
import { lockScope, withTransaction, type Exec } from '../db/client';
import { users } from '../db/schema';
import { passwordScope } from './passwords';
import { racePoint } from './racePoints';

/** Runs `fn` in a transaction holding the password lock of `userId`. */
export async function withPasswordLock<T>(
  db: Exec,
  userId: string,
  fn: (tx: Exec) => Promise<T>,
): Promise<T> {
  return await withTransaction(db, async (tx) => {
    await lockScope(tx, passwordScope(userId));
    return await fn(tx);
  });
}

export type WhileCurrent<T> = { current: true; value: T } | { current: false };

/**
 * Runs `write` only while `verifiedHash` (the hash the password was just proven against) is still
 * the user's, in one transaction holding the password lock. With `rehashTo`, the check is the
 * upgrade itself: the stored hash becomes `rehashTo` only if it is still `verifiedHash`, so a sign
 * in that rehashes never puts back a password changed meanwhile (tl on #561). `point` is a race
 * point inside the lock, after the check, for tests.
 */
export async function whilePasswordCurrent<T>(
  db: Exec,
  userId: string,
  verifiedHash: string,
  write: (tx: Exec) => Promise<T>,
  opts: { rehashTo?: string; point?: string } = {},
): Promise<WhileCurrent<T>> {
  return await withPasswordLock(db, userId, async (tx) => {
    // After the lock, never before it: read before, the hash could change between the check and
    // the write (tl on #557). The comparison is the query's.
    const same = and(eq(users.id, userId), eq(users.passwordHash, verifiedHash));
    const row =
      opts.rehashTo === undefined
        ? await tx.select({ id: users.id }).from(users).where(same).get()
        : await tx
            .update(users)
            .set({ passwordHash: opts.rehashTo, updatedAt: Date.now() })
            .where(same)
            .returning({ id: users.id })
            .get();
    if (row === undefined) return { current: false };
    if (opts.point !== undefined) await racePoint(opts.point);
    return { current: true, value: await write(tx) };
  });
}
