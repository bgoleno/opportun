// Two-factor sign-in state (FR-S3): recovery codes, the pending-2FA login token, and the
// second-factor check shared by login verify and disable. The TOTP secret only ever leaves
// the database through decryptSecret, inside this module and the enroll route.
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { sessions, users } from '../db/schema';
import type { Exec } from '../repos/base';
import { racePoint } from './racePoints';
import { decryptSecret } from './secretBox';
import { matchTotpStep } from './totp';

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** How long the password step stays good for the code step. */
export const PENDING_2FA_TTL_MS = 5 * 60 * 1000;
/** Wrong codes one pending token survives; the next failure deletes it. */
export const MAX_PENDING_FAILURES = 5;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Upper case with spaces and dashes removed, so "abcde-fghij" matches "ABCDEFGHIJ". */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]+/g, '').toUpperCase();
}

export function hashRecoveryCode(code: string): string {
  return sha256(normalizeRecoveryCode(code));
}

/** Ten fresh codes of ten base32 characters (50 bits each); only their hashes are stored. */
export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    // 32 divides 256, so masking a random byte to 5 bits is unbiased.
    const bytes = randomBytes(RECOVERY_CODE_LENGTH);
    codes.push(Array.from(bytes, (b) => BASE32.charAt(b & 31)).join(''));
  }
  return codes;
}

/**
 * Turns 2FA fully off for a user: secret, recovery codes and replay guard all cleared. With
 * `onlySecret`, only while that secret is still the enabled one (a compare-and-set for the
 * disable route); true when a row was cleared.
 */
export async function clearTwoFactor(
  db: Exec,
  userId: string,
  onlySecret?: string,
): Promise<boolean> {
  const row = await db
    .update(users)
    .set({
      totpSecret: null,
      totpEnabled: false,
      totpRecovery: null,
      totpLastStep: null,
      updatedAt: Date.now(),
    })
    .where(
      onlySecret === undefined
        ? eq(users.id, userId)
        : and(eq(users.id, userId), eq(users.totpEnabled, true), eq(users.totpSecret, onlySecret)),
    )
    .returning({ id: users.id })
    .get();
  return row !== undefined;
}

/**
 * A pending-2FA token: proof the password step passed, good for PENDING_2FA_TTL_MS and one
 * successful verify. Stored hashed in sessions with kind 'pending_2fa', which the session
 * cookie lookup never accepts.
 */
export async function createPendingToken(
  db: Db,
  userId: string,
  meta: { ip?: string; userAgent?: string },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db
    .insert(sessions)
    .values({
      id: sha256(token),
      userId,
      kind: 'pending_2fa',
      expiresAt: now + PENDING_2FA_TTL_MS,
      lastSeenAt: now,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      createdAt: now,
    })
    .run();
  return token;
}

/** The user a pending token names (live or not), for keying the per-user verify limit. */
export async function pendingTokenOwner(db: Db, token: string): Promise<string | null> {
  if (token.length === 0) return null;
  const row = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.id, sha256(token)), eq(sessions.kind, 'pending_2fa')))
    .get();
  return row?.userId ?? null;
}

export interface SecondFactor {
  code?: string | undefined;
  recoveryCode?: string | undefined;
}

/**
 * Compare-and-set on the replay guard: records `step` as the user's last accepted TOTP step
 * only if it is newer than the one stored (and 2FA is on). True when this call claimed it.
 * Atomic on its own, so of two requests carrying one code exactly one wins on any engine.
 */
export async function claimTotpStep(exec: Exec, userId: string, step: number): Promise<boolean> {
  const row = await exec
    .update(users)
    .set({ totpLastStep: step })
    .where(
      and(
        eq(users.id, userId),
        eq(users.totpEnabled, true),
        or(isNull(users.totpLastStep), lt(users.totpLastStep, step)),
      ),
    )
    .returning({ id: users.id })
    .get();
  return row !== undefined;
}

interface TwoFactorState {
  secret: string | null;
  enabled: boolean;
  recovery: string[] | null;
}

async function twoFactorState(exec: Exec, userId: string): Promise<TwoFactorState | undefined> {
  return await exec
    .select({
      secret: users.totpSecret,
      enabled: users.totpEnabled,
      recovery: users.totpRecovery,
    })
    .from(users)
    .where(eq(users.id, userId))
    .get();
}

/**
 * Compare-and-set on the recovery list: replaces `previous` with `remaining` only if the
 * stored list still equals `previous` (JSON text equality on SQLite, jsonb on Postgres).
 * True when this call replaced it.
 */
export async function replaceRecoveryCodes(
  exec: Exec,
  userId: string,
  previous: string[],
  remaining: string[],
): Promise<boolean> {
  const row = await exec
    .update(users)
    .set({ totpRecovery: remaining })
    .where(and(eq(users.id, userId), eq(users.totpEnabled, true), eq(users.totpRecovery, previous)))
    .returning({ id: users.id })
    .get();
  return row !== undefined;
}

/**
 * Spends one recovery code: read the list, drop the code, compare-and-set. A miss means
 * another spend changed the list first, so it re-reads and tries once more (a different
 * code is still there and is spent; the same code is gone and is refused).
 */
async function spendRecoveryCode(
  exec: Exec,
  userId: string,
  code: string,
  race: boolean,
): Promise<boolean> {
  const hash = hashRecoveryCode(code);
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = await twoFactorState(exec, userId);
    if (user === undefined || !user.enabled || user.recovery === null) return false;
    if (!user.recovery.includes(hash)) return false;
    if (race && attempt === 0) await racePoint('twoFactor.recovery');
    const remaining = user.recovery.filter((h) => h !== hash);
    if (await replaceRecoveryCodes(exec, userId, user.recovery, remaining)) return true;
  }
  return false;
}

/**
 * Checks a TOTP code or a recovery code against the user's enabled 2FA, spending what it
 * accepts: a TOTP step is never accepted twice (claimTotpStep), and a recovery code is
 * deleted on use. Resolves to the method used, or null on any mismatch. Safe under
 * concurrency: of two requests spending one code, exactly one succeeds.
 */
export async function checkSecondFactor(
  db: Db,
  userId: string,
  factor: SecondFactor,
  now: number = Date.now(),
): Promise<'totp' | 'recovery' | null> {
  if (factor.code !== undefined) {
    const user = await twoFactorState(db, userId);
    if (user === undefined || !user.enabled || user.secret === null) return null;
    const step = matchTotpStep(decryptSecret(db, user.secret), factor.code, now);
    if (step === null) return null;
    await racePoint('twoFactor.totp');
    return (await claimTotpStep(db, userId, step)) ? 'totp' : null;
  }
  if (factor.recoveryCode !== undefined) {
    return (await spendRecoveryCode(db, userId, factor.recoveryCode, true)) ? 'recovery' : null;
  }
  return null;
}

export type RedeemResult =
  | { ok: true; userId: string; method: 'totp' | 'recovery' }
  | { ok: false; code: 'invalid_pending' | 'token_used' }
  | { ok: false; code: 'invalid_code'; userId: string; tokenRevoked: boolean };

/**
 * Compare-and-set claim of a live pending token:
 *   UPDATE sessions SET used_at = :now
 *    WHERE id = :id AND kind = 'pending_2fa' AND used_at IS NULL AND expires_at > :now
 *   RETURNING user_id, failed_attempts
 * Undefined when the token is unknown, already claimed or expired.
 */
export async function claimPendingToken(
  exec: Exec,
  id: string,
  now: number,
): Promise<{ userId: string; failedAttempts: number } | undefined> {
  return await exec
    .update(sessions)
    .set({ usedAt: now })
    .where(
      and(
        eq(sessions.id, id),
        eq(sessions.kind, 'pending_2fa'),
        isNull(sessions.usedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .returning({ userId: sessions.userId, failedAttempts: sessions.failedAttempts })
    .get();
}

/**
 * The login code step. The pending token is claimed (used_at set, claimPendingToken) before
 * the second factor is checked, so of two racing verifies on one token the loser stops at
 * token_used and never spends its code. A wrong code releases the claim and counts a
 * failure; the MAX_PENDING_FAILURES-th failure deletes the token. A redeemed row is kept
 * (until it expires or the user's sessions are cleared) only so a replay reads token_used.
 */
export async function redeemPendingToken(
  db: Db,
  token: string,
  factor: SecondFactor,
  now: number = Date.now(),
): Promise<RedeemResult> {
  if (token.length === 0) return { ok: false, code: 'invalid_pending' };
  const id = sha256(token);
  await racePoint('twoFactor.pendingClaim');
  const claimed = await claimPendingToken(db, id, now);
  if (claimed === undefined) {
    const row = await db
      .select({ usedAt: sessions.usedAt, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.kind, 'pending_2fa')))
      .get();
    if (row === undefined) return { ok: false, code: 'invalid_pending' };
    if (now >= row.expiresAt) {
      await db
        .delete(sessions)
        .where(and(eq(sessions.id, id), eq(sessions.kind, 'pending_2fa')))
        .run();
      return { ok: false, code: 'invalid_pending' };
    }
    // Claimed by a concurrent verify (or released by it a moment ago): not this request's.
    return { ok: false, code: 'token_used' };
  }
  const method = await checkSecondFactor(db, claimed.userId, factor, now);
  if (method !== null) return { ok: true, userId: claimed.userId, method };
  const failed = claimed.failedAttempts + 1;
  if (failed >= MAX_PENDING_FAILURES) {
    await db.delete(sessions).where(eq(sessions.id, id)).run();
    return { ok: false, code: 'invalid_code', userId: claimed.userId, tokenRevoked: true };
  }
  await db
    .update(sessions)
    .set({ usedAt: null, failedAttempts: failed })
    .where(eq(sessions.id, id))
    .run();
  return { ok: false, code: 'invalid_code', userId: claimed.userId, tokenRevoked: false };
}
