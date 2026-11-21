// Password reset of last resort (FR-S1), shared by the operator CLI and the admin route: a
// strong temporary password, every session ended, every device token revoked and every sign-in
// provider unlinked (a reset is also compromise recovery, so it cuts every credential, a provider
// someone else linked included: #573), and TOTP 2FA turned off so a user who lost both phone and
// recovery codes can get back in and re-enroll (plan Review Focus 3).
import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { lockScope, withTransaction, type Db } from '../db/client';
import { deviceTokens, oauthAccounts, users } from '../db/schema';
import { hashPassword, NO_PEPPERS, passwordScope, type PepperSet } from './passwords';
import { destroyAllSessions } from './sessions';
import { clearTwoFactor } from './twoFactor';

/** 24 random bytes as base64url: 32 characters, 192 bits. */
export function temporaryPassword(): string {
  return randomBytes(24).toString('base64url');
}

export interface PasswordReset {
  /** The temporary password. The caller shows it once and must never log, store or audit it. */
  password: string;
  /** The providers the reset unlinked, sorted, so the caller can say which to link again. */
  unlinkedProviders: string[];
}

/** Resets `userId`'s password and returns the temporary one. */
export async function resetUserPassword(
  db: Db,
  userId: string,
  peppers: PepperSet = NO_PEPPERS,
): Promise<PasswordReset> {
  const password = temporaryPassword();
  const passwordHash = await hashPassword(password, peppers);
  const unlinked = await withTransaction(db, async (tx) => {
    // The lock a token minted after a password check takes (#539): see passwordScope.
    await lockScope(tx, passwordScope(userId));
    await tx
      .update(users)
      .set({ passwordHash, updatedAt: Date.now() })
      .where(eq(users.id, userId))
      .run();
    await clearTwoFactor(tx, userId);
    const now = Date.now();
    await tx
      .update(deviceTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)))
      .run();
    // Every session and pending 2FA token, under the lock (#561): see the password change.
    await destroyAllSessions(tx, userId);
    // Every linked provider, under the same lock (#573): a link callback or a provider sign-in
    // writes under it only while its session, or its link, still exists (oauthLogin.ts).
    return await tx
      .delete(oauthAccounts)
      .where(eq(oauthAccounts.userId, userId))
      .returning({ provider: oauthAccounts.provider })
      .all();
  });
  return { password, unlinkedProviders: unlinked.map((r) => r.provider).sort() };
}
