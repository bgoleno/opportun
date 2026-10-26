// The pepper set, kept in its own module with no dependencies (issue #5).
//
// config.ts needs this type and these constructors; passwords.ts needs them too but also
// pulls in @node-rs/argon2, a native addon. Config is imported extremely early by almost
// everything, so routing it through passwords.ts would drag argon2 into that early chain —
// which, among other things, loads it before a test's `vi.mock('@node-rs/argon2')` can take
// effect and silently gives the real implementation to code under test.

/**
 * The peppers a deployment knows.
 *
 * A pepper is Argon2's own keyed-hash `secret`, so it never lands in the hash string and a
 * database thief without the environment cannot begin to crack. That strength is also the
 * problem issue #5 names: nothing in a stored hash said which pepper made it, so changing one
 * stranded every existing hash with no way to tell an old one from a new one.
 *
 * `current` is the version new hashes are stamped with; 0 means no pepper. `byVersion` holds
 * every secret still needed to verify, which during a rotation is the new one and the old.
 */
export interface PepperSet {
  current: number;
  byVersion: Map<number, string>;
}

export function pepperSet(current: number, secrets: Record<number, string>): PepperSet {
  return {
    current,
    byVersion: new Map(Object.entries(secrets).map(([v, s]) => [Number(v), s])),
  };
}

/** A deployment with no pepper configured. */
export const NO_PEPPERS: PepperSet = pepperSet(0, {});
