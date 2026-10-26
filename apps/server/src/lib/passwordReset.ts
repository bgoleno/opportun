// Password reset of last resort (FR-S1), shared by the operator CLI and the admin route: a
// strong temporary password, every session ended, every device token revoked (a reset is also
// compromise recovery, so it cuts every credential), and TOTP 2FA turned off so a user who
// lost both phone and recovery codes can get back in and re-enroll (plan Review Focus 3).
import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { withTransaction, type Db } from '../db/client';
import { deviceTokens, users } from '../db/schema';
import { hashPassword, NO_PEPPERS, type PepperSet } from './passwords';
import { destroyAllSessions } from './sessions';
import { clearTwoFactor } from './twoFactor';

/** 24 random bytes as base64url: 32 characters, 192 bits. */
export function temporaryPassword(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Resets `userId`'s password and returns the temporary one. The caller shows it once and
 * must never log, store or audit it.
 */
export async function resetUserPassword(
  db: Db,
  userId: string,
  peppers: PepperSet = NO_PEPPERS,
): Promise<string> {
  const password = temporaryPassword();
  const passwordHash = await hashPassword(password, peppers);
  await withTransaction(db, async (tx) => {
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
  });
  await destroyAllSessions(db, userId);
  return password;
}
