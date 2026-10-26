import { randomBytes } from 'node:crypto';
import { hash, verify, type Algorithm, type Options } from '@node-rs/argon2';
import { NO_PEPPERS, type PepperSet } from './pepperSet';

export { NO_PEPPERS, pepperSet, type PepperSet } from './pepperSet';

// Argon2id with OWASP baseline parameters (design section 7).
const OPTIONS: Options = {
  // Algorithm is an ambient const enum; 2 is Argon2id.
  algorithm: 2 as Algorithm,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * A valid Argon2id hash of a random throwaway string with the same parameters.
 * Login verifies against it for unknown emails so both failure paths cost the same.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$oShv5KMUOptEl68SJRlL5Q$c7loYA+/FfrJpWYmgCRyqB8yIranTBEKlNXTacc8ARM';

/**
 * Version marker on a stored hash: `p<N>:` before the Argon2 string.
 *
 * Absent means the hash predates versioning, NOT that it was made without a pepper. The live
 * deployment set a pepper before this existed, so its rows are peppered and unprefixed, and
 * reading unprefixed as unpeppered would lock those accounts out. Such a hash is resolved by
 * trying every known pepper and then none, and is upgraded on the first successful login.
 */
const VERSION_PREFIX = /^p(\d{1,4}):/;

/** The pepper version a stored hash names, or 0 when it predates versioning. */
export function hashVersion(hashed: string): number {
  const m = VERSION_PREFIX.exec(hashed);
  return m === null ? 0 : Number(m[1]);
}

const stripVersion = (hashed: string): string => hashed.replace(VERSION_PREFIX, '');

function withPepper(pepper: string | undefined): Options {
  return pepper === undefined || pepper === ''
    ? OPTIONS
    : { ...OPTIONS, secret: Buffer.from(pepper, 'utf8') };
}

/** Hashes with the current pepper and stamps the result with its version. */
export async function hashPassword(pw: string, peppers: PepperSet = NO_PEPPERS): Promise<string> {
  const secret = peppers.byVersion.get(peppers.current);
  const hashed = await hash(pw, withPepper(secret));
  return peppers.current === 0 ? hashed : `p${peppers.current}:${hashed}`;
}

/** Verifies against one specific pepper (or none). Never throws. */
export async function verifyPassword(
  hashed: string,
  pw: string,
  pepper?: string,
): Promise<boolean> {
  try {
    const opts = pepper === undefined || pepper === '' ? undefined : withPepper(pepper);
    return await verify(stripVersion(hashed), pw, opts);
  } catch {
    // Malformed hash: treat as a mismatch, never as a server error.
    return false;
  }
}

/**
 * Login verification, with the stored hash upgraded to the current pepper when it is not
 * already on it. `rehash` tells the caller to store a freshly made hash of the same password.
 *
 * Three cases:
 *  - the hash names a version: only that pepper is tried. If the operator no longer has it,
 *    verification FAILS rather than falling back, because falling back to a weaker pepper (or
 *    to none) on a hash that claims a stronger one is a silent downgrade.
 *  - the hash predates versioning: every known pepper is tried, then none, because such a
 *    hash may or may not be peppered and nothing records which. Success upgrades it, so an
 *    account passes through this path at most once.
 *  - no pepper is configured: a plain verify, and nothing is ever upgraded.
 *
 * Every case above costs a different number of Argon2id calls on its own (0, 1, or
 * versions.length + 1), and that cost is measurable: an attacker timing /auth/login could tell
 * "this email is already upgraded to the current pepper" (1 call) apart from "unknown, or not
 * yet upgraded" (versions.length + 1 calls) during a rotation, the exact distinction DUMMY_HASH
 * exists to prevent and, for this specific split, did not. Every path below is padded with
 * decoy verifyPassword(DUMMY_HASH, ...) calls (result discarded) to the same total,
 * maxCalls = versions.length + 1 -- the slowest branch's own natural cost -- so the call count,
 * and with it the dominant cost of the whole function, is identical regardless of which branch
 * answers or how early within it an answer is found.
 */
export async function verifyPasswordWithUpgrade(
  hashed: string,
  pw: string,
  peppers: PepperSet = NO_PEPPERS,
): Promise<{ ok: boolean; rehash: boolean }> {
  const versions = [...peppers.byVersion.keys()].sort((a, b) => b - a);
  const maxCalls = versions.length + 1;
  let callsMade = 0;
  const pad = async (): Promise<void> => {
    while (callsMade < maxCalls) {
      await verifyPassword(DUMMY_HASH, pw);
      callsMade++;
    }
  };

  const version = hashVersion(hashed);

  if (version !== 0) {
    const secret = peppers.byVersion.get(version);
    if (secret === undefined) {
      await pad();
      return { ok: false, rehash: false };
    }
    callsMade++;
    const ok = await verifyPassword(hashed, pw, secret);
    await pad();
    return { ok, rehash: ok && version !== peppers.current };
  }

  if (peppers.current === 0) {
    // No pepper anywhere: today's behavior, and nothing to upgrade to. versions is empty here,
    // so maxCalls is 1 and this call already satisfies it; pad() below is a no-op.
    callsMade++;
    const ok = await verifyPassword(hashed, pw);
    await pad();
    return { ok, rehash: false };
  }

  // Pre-versioning hash with a pepper configured. Try the peppers newest first, then none.
  // Every success is an upgrade, since any outcome here produces a stamped hash.
  for (const v of versions) {
    callsMade++;
    if (await verifyPassword(hashed, pw, peppers.byVersion.get(v))) {
      await pad();
      return { ok: true, rehash: true };
    }
  }
  callsMade++;
  const legacy = await verifyPassword(hashed, pw);
  await pad();
  return { ok: legacy, rehash: legacy };
}

/**
 * Marks an account with no password (created by OAuth sign-in, FR-S4). Not an Argon2 hash, so
 * verifyPassword treats it as a mismatch for every input, including the stored string itself.
 */
export const UNUSABLE_PASSWORD_PREFIX = '!unusable:';

/** A password_hash value no password can ever match (random, so rows never compare equal). */
export function unusablePasswordHash(): string {
  return UNUSABLE_PASSWORD_PREFIX + randomBytes(16).toString('hex');
}

/** False for an account that signs in only through OAuth. */
export function hasUsablePassword(passwordHash: string): boolean {
  return !passwordHash.startsWith(UNUSABLE_PASSWORD_PREFIX);
}
