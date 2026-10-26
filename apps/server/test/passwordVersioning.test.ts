// Issue #5: a stored hash carried no record of which pepper made it, so a pepper could never
// be rotated — changing it stranded every existing hash with no way to tell old from new.
//
// Fix: new hashes carry a version prefix naming the pepper that made them, and the verifier
// selects that pepper. Hashes written before this change have NO prefix, and critically they
// may have been made WITH a pepper (the live deployment set one before versioning existed),
// so an unprefixed hash cannot be assumed pepper-less. It is tried against every known pepper
// and then against none, and upgraded to a prefixed hash on the first successful login.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import {
  hashPassword,
  hashVersion,
  pepperSet,
  verifyPasswordWithUpgrade,
  type PepperSet,
} from '../src/lib/passwords';

const PW = 'correct horse battery';
const P1 = 'pepper-one-of-sufficient-length';
const P2 = 'pepper-two-of-sufficient-length';
const KEY = '0'.repeat(64);

/** No pepper at all. */
const none: PepperSet = pepperSet(0, {});
/** v1 current, nothing historical. */
const v1: PepperSet = pepperSet(1, { 1: P1 });
/** v2 current, v1 still known so its hashes keep verifying. */
const v2: PepperSet = pepperSet(2, { 1: P1, 2: P2 });
/** v2 current and v1 forgotten: a rotation done without keeping the old secret. */
const v2Only: PepperSet = pepperSet(2, { 2: P2 });

describe('hash versioning', () => {
  it('stamps a new hash with the pepper version that made it', async () => {
    expect(hashVersion(await hashPassword(PW, v1))).toBe(1);
    expect(hashVersion(await hashPassword(PW, v2))).toBe(2);
  });

  it('leaves an unpeppered hash unstamped, so nothing changes without a pepper', async () => {
    const h = await hashPassword(PW, none);
    expect(hashVersion(h)).toBe(0);
    expect(h.startsWith('$argon2id$')).toBe(true);
  });

  it('reads a pre-versioning hash as having no version', async () => {
    // What every row in an existing database looks like.
    expect(hashVersion('$argon2id$v=19$m=19456,t=2,p=1$abc$def')).toBe(0);
  });
});

describe('rotation', () => {
  it('verifies a v1 hash after rotating to v2, and asks for a rehash', async () => {
    const old = await hashPassword(PW, v1);
    expect(await verifyPasswordWithUpgrade(old, PW, v2)).toEqual({ ok: true, rehash: true });
  });

  it('does not ask for a rehash once the hash is current', async () => {
    const current = await hashPassword(PW, v2);
    expect(await verifyPasswordWithUpgrade(current, PW, v2)).toEqual({
      ok: true,
      rehash: false,
    });
  });

  it('rejects a wrong password against an old-version hash', async () => {
    const old = await hashPassword(PW, v1);
    expect(await verifyPasswordWithUpgrade(old, 'nope', v2)).toEqual({
      ok: false,
      rehash: false,
    });
  });

  it('fails closed when the pepper a hash names has been forgotten', async () => {
    // The operator rotated without keeping v1. The hash is unverifiable; it must not fall
    // back to trying other peppers or to none, which would be a silent downgrade.
    const old = await hashPassword(PW, v1);
    expect(await verifyPasswordWithUpgrade(old, PW, v2Only)).toEqual({
      ok: false,
      rehash: false,
    });
  });
});

describe('upgrading the hashes that already exist', () => {
  it('verifies a pre-versioning hash that was made WITH the current pepper', async () => {
    // The live deployment's rows: peppered, but written before versioning, so unprefixed.
    // Reading "unprefixed" as "no pepper" would lock the account out.
    const legacy = await hashPassword(PW, pepperSet(0, {}));
    const legacyPeppered = await rawPeppered(PW, P1);
    expect(await verifyPasswordWithUpgrade(legacyPeppered, PW, v1)).toEqual({
      ok: true,
      rehash: true,
    });
    expect(await verifyPasswordWithUpgrade(legacy, PW, v1)).toEqual({ ok: true, rehash: true });
  });

  it('verifies a pre-versioning hash made with a pepper that is now historical', async () => {
    const legacyPeppered = await rawPeppered(PW, P1);
    expect(await verifyPasswordWithUpgrade(legacyPeppered, PW, v2)).toEqual({
      ok: true,
      rehash: true,
    });
  });

  it('never upgrades when no pepper is configured', async () => {
    const legacy = await hashPassword(PW, none);
    expect(await verifyPasswordWithUpgrade(legacy, PW, none)).toEqual({
      ok: true,
      rehash: false,
    });
  });

  it('rejects a wrong password against a pre-versioning hash', async () => {
    const legacyPeppered = await rawPeppered(PW, P1);
    expect(await verifyPasswordWithUpgrade(legacyPeppered, 'nope', v2)).toEqual({
      ok: false,
      rehash: false,
    });
  });
});

describe('config', () => {
  const base = { OPPORTUN_MASTER_KEY: KEY, OPPORTUN_BASE_URL: 'http://localhost:3000' };

  it('reads OPPORTUN_PEPPER as version 1, so an existing deployment needs no new variable', () => {
    const peppers = loadConfig({ ...base, OPPORTUN_PEPPER: P1 }).peppers!;
    expect(peppers.current).toBe(1);
    expect(peppers.byVersion.get(1)).toBe(P1);
  });

  it('has no pepper and version 0 when none is set', () => {
    expect(loadConfig(base).peppers).toEqual(pepperSet(0, {}));
  });

  it('keeps an older pepper available for verification during a rotation', () => {
    const peppers = loadConfig({
      ...base,
      OPPORTUN_PEPPER: P2,
      OPPORTUN_PEPPER_VERSION: '2',
      OPPORTUN_PEPPER_V1: P1,
    }).peppers!;
    expect(peppers.current).toBe(2);
    expect(peppers.byVersion.get(1)).toBe(P1);
    expect(peppers.byVersion.get(2)).toBe(P2);
  });

  it('refuses a rotation that would strand every existing hash', () => {
    // Bumping the version without supplying the previous secret makes every v1 hash
    // unverifiable. That is the exact failure #5 exists to prevent, so it is a config error
    // rather than something discovered one locked-out login at a time.
    expect(() =>
      loadConfig({ ...base, OPPORTUN_PEPPER: P2, OPPORTUN_PEPPER_VERSION: '2' }),
    ).toThrow(/OPPORTUN_PEPPER_V1/);
  });

  it('still refuses a short pepper', () => {
    expect(() => loadConfig({ ...base, OPPORTUN_PEPPER: 'short' })).toThrow(/OPPORTUN_PEPPER/);
  });
});

/** An Argon2 hash made with a pepper the way the pre-versioning code made them: no prefix. */
async function rawPeppered(pw: string, pepper: string): Promise<string> {
  const { hash } = await import('@node-rs/argon2');
  return hash(pw, {
    algorithm: 2,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
    secret: Buffer.from(pepper, 'utf8'),
  });
}
