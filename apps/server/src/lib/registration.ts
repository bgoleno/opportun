// The registration transaction (FR-S2), shared by the /auth/register route and the demo
// seeder (issue #280): the first account becomes admin and closes registration; later ones
// need it reopened. Extracted rather than duplicated, because re-deriving hashPassword's
// pepper handling or the first-admin race guard by hand in a second place is exactly the kind
// of drift a faithful extraction avoids. The route still computes the password hash itself
// (it needs the request's configured peppers) and still does its own session start, audit
// row and HTTP response; only the transaction that decides admin-or-not and writes the row
// moved here.
import { count, eq } from 'drizzle-orm';
import { newId } from '@opportun/core';
import { withTransaction, type Exec } from '../db/client';
import { settings, users } from '../db/schema';
import { racePoint } from './racePoints';

export const REGISTRATION_OPEN_KEY = 'registration_open';

export class RegistrationClosedError extends Error {}

export async function isRegistrationOpen(db: Pick<Exec, 'select'>): Promise<boolean> {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, REGISTRATION_OPEN_KEY))
    .get();
  return row?.value === true;
}

/**
 * Whether a visitor could register right now, which is not the same question as
 * isRegistrationOpen above: the first account on an instance is always allowed regardless of
 * that flag (registerUser never checks it when existing === 0), and before any account exists
 * there is no settings row at all, so isRegistrationOpen alone reads as false on a genuinely
 * fresh instance -- the one case this must answer true for. Mirrors registerUser's own
 * first-or-open check; keep the two in sync if either changes.
 */
export async function canRegister(db: Pick<Exec, 'select'>): Promise<boolean> {
  const existing = (await db.select({ n: count() }).from(users).get())?.n ?? 0;
  return existing === 0 || (await isRegistrationOpen(db));
}

export interface RegisterUserInput {
  email: string;
  /** Already hashed (hashPassword with the caller's own peppers); this never hashes. */
  passwordHash: string;
  displayName: string;
  /** Pinned id, for the demo seeder's deterministic accounts. Generated with newId() when
   *  omitted, exactly as the route has always done. */
  id?: string;
  /** For createdAt/updatedAt and the registration_open row's updatedAt, so a caller seeding
   *  several accounts can give each a distinct, ordered timestamp. Date.now() when omitted. */
  now?: number;
}

/**
 * The first account to register becomes admin and closes registration (FR-S2); every later
 * one needs it reopened first. Throws RegistrationClosedError when it is not, and whatever
 * db.insert throws on a duplicate email (isUniqueViolation), unchanged from before this was
 * extracted: the caller still decides what either means (HTTP 403/409 for the route, nothing
 * special for the seeder beyond letting it propagate).
 */
export async function registerUser(
  db: Exec,
  input: RegisterUserInput,
): Promise<typeof users.$inferSelect> {
  const now = input.now ?? Date.now();
  await racePoint('auth.register');
  // Scope 'registration': two first registrations cannot both count zero users and both
  // become admin (Postgres advisory lock; the write gate on SQLite).
  return withTransaction(
    db,
    async (tx) => {
      const existing = (await tx.select({ n: count() }).from(users).get())?.n ?? 0;
      const first = existing === 0;
      if (!first && !(await isRegistrationOpen(tx))) throw new RegistrationClosedError();
      await racePoint('auth.register.locked');
      const row = await tx
        .insert(users)
        .values({
          id: input.id ?? newId(),
          email: input.email,
          passwordHash: input.passwordHash,
          displayName: input.displayName,
          isAdmin: first,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      if (first) {
        // FR-S2: the instance locks after its first account; admins reopen it.
        await tx
          .insert(settings)
          .values({ key: REGISTRATION_OPEN_KEY, userId: null, value: false, updatedAt: now })
          .onConflictDoUpdate({ target: settings.key, set: { value: false, updatedAt: now } })
          .run();
      }
      return row;
    },
    { scope: 'registration' },
  );
}
