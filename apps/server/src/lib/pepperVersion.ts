// The pepper version the server last booted with (https://github.com/bgoleno/opportun/issues/606),
// so a CLI that sets a password can tell its own pepper environment is not the server's.
//
// A CLI run from source reads the pepper from its own environment, not the server's. After a
// rotation, a run with only OPPORTUN_PEPPER (version 1, the new secret) stamped the new hash v1;
// the server checked it against the old secret and the password never signed in, while the reset
// had already ended the sessions and revoked the device tokens.
//
// The row holds the version number only, nothing derived from a secret (tl on #606), and is written
// by the server alone: no settings route reads or accepts it.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { settings, users } from '../db/schema';
import { hashVersion, hasUsablePassword, type PepperSet } from './passwords';

export const PEPPER_VERSION_KEY = 'auth.pepper_current_version';

/** On every boot, after the peppers loaded: 0 when the server runs without one. */
export async function recordPepperVersion(
  db: Db,
  version: number,
  now: number = Date.now(),
): Promise<void> {
  await db
    .insert(settings)
    .values({ key: PEPPER_VERSION_KEY, userId: null, value: version, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: version, updatedAt: now } })
    .run();
}

const variablesFor = (version: number): string => {
  const older = Array.from(
    { length: Math.max(version - 1, 0) },
    (_, i) => `OPPORTUN_PEPPER_V${i + 1}`,
  );
  return [
    'OPPORTUN_PEPPER (the current secret)',
    `OPPORTUN_PEPPER_VERSION=${version}`,
    ...older,
  ].join(', ');
};

/**
 * Why this run's peppers would make a password the server cannot check, or null when they match.
 * Read before anything is hashed or written. A server restart between this check and the CLI's
 * write could change the version under it: a window accepted, as the operator runs both (tl on
 * #606). Names variables, never their values.
 */
export async function stalePepperProblem(db: Db, peppers: PepperSet): Promise<string | null> {
  const mine = peppers.current;
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, PEPPER_VERSION_KEY))
    .get();
  const recorded = row === undefined ? undefined : Number(row.value);
  if (recorded !== undefined && Number.isInteger(recorded)) {
    if (recorded === mine) return null;
    const restart =
      'If you changed the pepper variables for a rotation, restart the server with them before running this.';
    if (recorded === 0) {
      return `The server last started without a pepper, but this run has pepper version ${mine}: run it without OPPORTUN_PEPPER and the OPPORTUN_PEPPER_* variables, as the server is. ${restart}`;
    }
    return `The server last started with pepper version ${recorded}, but this run has ${mine === 0 ? 'no pepper' : `version ${mine}`}. Run it with the server's own: ${variablesFor(recorded)}. ${restart}`;
  }
  // No record: a database whose server has not booted since #606. A stored password hashed under a
  // newer version than this run's says the server has moved past it. Only usable hashes count: an
  // account with no password (a provider sign-in only) has none to compare.
  const hashes = await db.select({ passwordHash: users.passwordHash }).from(users).all();
  const newest = hashes
    .filter((h) => hasUsablePassword(h.passwordHash))
    .reduce((n, h) => Math.max(n, hashVersion(h.passwordHash)), 0);
  if (newest > mine) {
    return `Some stored passwords are hashed with pepper version ${newest}, newer than this run's ${mine === 0 ? 'none' : `version ${mine}`}. Run it with the server's own: ${variablesFor(newest)}.`;
  }
  return null;
}
