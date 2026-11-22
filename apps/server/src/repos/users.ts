// The users table, as the routes read and write it (https://github.com/bgoleno/opportun/issues/766;
// docs/architecture.md 6.2): no route queries `users` itself. Sign-in reads an account before
// there is a session, and the admin screens read every account, so these functions take a user id
// (or an email) rather than a UserCtx: each says whose row it reads.
//
// The compare-and-set writes take an Exec, the transaction a caller already holds (with its
// password lock, #539 and #561): they are written as before, inside that transaction, and the
// lock and its ordering stay with the caller.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { users } from '../db/schema';
import type { Db, Exec } from './base';

/** A whole users row. */
export type UserRow = typeof users.$inferSelect;

/** The account with this email, if any. */
export async function userByEmail(db: Exec, email: string): Promise<UserRow | undefined> {
  return db.select().from(users).where(eq(users.email, email)).get();
}

/** The account with this id, if any. */
export async function userById(db: Exec, id: string): Promise<UserRow | undefined> {
  return db.select().from(users).where(eq(users.id, id)).get();
}

/** The id of the account with this id, if it exists. */
export async function findUserId(db: Exec, id: string): Promise<{ id: string } | undefined> {
  return db.select({ id: users.id }).from(users).where(eq(users.id, id)).get();
}

/** Whether two-factor sign-in is on for this account (false when there is no such account). */
export async function isTotpEnabled(db: Exec, id: string): Promise<boolean> {
  const row = await db
    .select({ totpEnabled: users.totpEnabled })
    .from(users)
    .where(eq(users.id, id))
    .get();
  return row?.totpEnabled === true;
}

/** What the 2FA status screen shows: on or off, the recovery codes, the password hash. */
export async function twoFactorStatusRow(db: Exec, id: string) {
  return db
    .select({
      enabled: users.totpEnabled,
      recovery: users.totpRecovery,
      hash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.id, id))
    .get();
}

/** Whether 2FA is on, and its stored (encrypted) secret. */
export async function totpSecretRow(db: Exec, id: string) {
  return db
    .select({ enabled: users.totpEnabled, secret: users.totpSecret })
    .from(users)
    .where(eq(users.id, id))
    .get();
}

/** Stores a new enrollment's secret, only while 2FA is still off. Undefined when it is on. */
export async function setEnrollmentSecret(
  tx: Exec,
  id: string,
  encryptedSecret: string,
): Promise<{ id: string } | undefined> {
  return tx
    .update(users)
    .set({ totpSecret: encryptedSecret, updatedAt: Date.now() })
    .where(and(eq(users.id, id), eq(users.totpEnabled, false)))
    .returning({ id: users.id })
    .get();
}

/**
 * Turns 2FA on: only for the secret the code was verified against, and only once. Undefined when
 * it is already on, or the secret changed since (a re-enroll).
 */
export async function activateTotp(
  tx: Exec,
  id: string,
  verifiedSecret: string,
  values: { recoveryHashes: string[]; lastStep: number },
): Promise<{ id: string } | undefined> {
  return tx
    .update(users)
    .set({
      totpEnabled: true,
      totpRecovery: values.recoveryHashes,
      totpLastStep: values.lastStep,
      updatedAt: Date.now(),
    })
    .where(
      and(eq(users.id, id), eq(users.totpEnabled, false), eq(users.totpSecret, verifiedSecret)),
    )
    .returning({ id: users.id })
    .get();
}

/** Sets the password hash, only while the stored one is still `currentHash`. */
export async function setPasswordIfUnchanged(
  tx: Exec,
  id: string,
  currentHash: string,
  nextHash: string,
): Promise<{ id: string } | undefined> {
  return tx
    .update(users)
    .set({ passwordHash: nextHash, updatedAt: Date.now() })
    .where(and(eq(users.id, id), eq(users.passwordHash, currentHash)))
    .returning({ id: users.id })
    .get();
}

/** Whether the account's stored password hash is still `hash`. */
export async function passwordHashIs(tx: Exec, id: string, hash: string): Promise<boolean> {
  const row = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, id), eq(users.passwordHash, hash)))
    .get();
  return row !== undefined;
}

/** Which accounts an admin list shows: every one, or only these ids (the shared demo's). */
export type AccountScope = { only?: Iterable<string> };

function scoped(scope: AccountScope) {
  return scope.only === undefined ? undefined : inArray(users.id, [...scope.only]);
}

/** Settings > Users: every account in scope, oldest first. */
export async function listAccounts(db: Db, scope: AccountScope) {
  return db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isAdmin: users.isAdmin,
      totpEnabled: users.totpEnabled,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
    })
    .from(users)
    .where(scoped(scope))
    .orderBy(asc(users.createdAt), asc(users.id))
    .all();
}

/** Every account in scope with its password hash, oldest first (the pepper rotation status). */
export async function listAccountHashes(db: Db, scope: AccountScope) {
  return db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(scoped(scope))
    .orderBy(asc(users.createdAt), asc(users.id))
    .all();
}

/** The account's password hash, if the account exists. */
export async function passwordHashRow(db: Exec, id: string): Promise<{ hash: string } | undefined> {
  return db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, id)).get();
}

/** Whether 2FA is on, as the account's row has it (undefined when there is no such account). */
export async function totpEnabledRow(
  db: Exec,
  id: string,
): Promise<{ totpEnabled: boolean } | undefined> {
  return db.select({ totpEnabled: users.totpEnabled }).from(users).where(eq(users.id, id)).get();
}

/** The id of the account with this email, if any. */
export async function findUserIdByEmail(
  db: Exec,
  email: string,
): Promise<{ id: string } | undefined> {
  return db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
}

/** The account's display name, if the account exists. */
export async function displayNameOf(db: Exec, id: string): Promise<string | undefined> {
  return (await db.select({ n: users.displayName }).from(users).where(eq(users.id, id)).get())?.n;
}

/** Writes a new account row as given (sign-in with a provider creates one, in its transaction). */
export async function insertUser(tx: Exec, row: typeof users.$inferInsert): Promise<void> {
  await tx.insert(users).values(row).run();
}
