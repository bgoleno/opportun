// NFR-SEC3 pepper: an optional deployment secret mixed into every new Argon2id hash, with the
// empty default leaving hashes made before the pepper existed valid.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import {
  hashPassword,
  NO_PEPPERS,
  pepperSet,
  verifyPassword,
  verifyPasswordWithUpgrade,
  DUMMY_HASH,
} from '../src/lib/passwords';

vi.mock('@node-rs/argon2', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@node-rs/argon2')>();
  return { ...mod, verify: vi.fn(mod.verify) };
});
const argon2 = await import('@node-rs/argon2');

const PW = 'correct horse battery';
const PEPPER = 'a-deployment-pepper-of-some-length';
const SET = pepperSet(1, { 1: PEPPER });
const KEY = '0'.repeat(64);

afterEach(() => {
  vi.mocked(argon2.verify).mockClear();
});

describe('pepper', () => {
  it('the default (empty) pepper keeps existing hashes valid', async () => {
    const legacy = await hashPassword(PW);
    expect(await verifyPassword(legacy, PW)).toBe(true);
    expect(await verifyPassword(legacy, PW, '')).toBe(true);
  });

  it('a peppered hash verifies only with the same pepper', async () => {
    const peppered = await hashPassword(PW, SET);
    expect(await verifyPassword(peppered, PW, PEPPER)).toBe(true);
    expect(await verifyPassword(peppered, PW)).toBe(false);
    expect(await verifyPassword(peppered, PW, `${PEPPER}x`)).toBe(false);
    expect(await verifyPassword(peppered, 'wrong password', PEPPER)).toBe(false);
  });

  it('with a pepper set, a pre-pepper hash still verifies and asks to be rehashed', async () => {
    const legacy = await hashPassword(PW);
    expect(await verifyPasswordWithUpgrade(legacy, PW, SET)).toEqual({
      ok: true,
      rehash: true,
    });
    const peppered = await hashPassword(PW, SET);
    expect(await verifyPasswordWithUpgrade(peppered, PW, SET)).toEqual({
      ok: true,
      rehash: false,
    });
    expect(await verifyPasswordWithUpgrade(legacy, 'nope', SET)).toEqual({
      ok: false,
      rehash: false,
    });
    // Without a pepper nothing is ever upgraded.
    expect(await verifyPasswordWithUpgrade(legacy, PW, NO_PEPPERS)).toEqual({
      ok: true,
      rehash: false,
    });
  });

  it('config reads OPPORTUN_PEPPER, optional, and refuses a short one', () => {
    const base = { OPPORTUN_MASTER_KEY: KEY, OPPORTUN_BASE_URL: 'http://localhost:3000' };
    expect(loadConfig(base).peppers).toEqual(NO_PEPPERS);
    expect(loadConfig({ ...base, OPPORTUN_PEPPER: PEPPER }).peppers).toEqual(SET);
    expect(() => loadConfig({ ...base, OPPORTUN_PEPPER: 'short' })).toThrow(/OPPORTUN_PEPPER/);
  });

  describe('verifyPasswordWithUpgrade pays the same argon2 cost on every branch', () => {
    // An active rotation with two configured pepper versions: this is exactly the precondition
    // the timing leak needs (issue found in the main-branch security review). maxCalls is the
    // slowest branch's natural cost under this set: every known version (2) plus the final
    // no-pepper/legacy check (1).
    const PEPPER1 = 'rotation-pepper-one-of-some-length';
    const PEPPER2 = 'rotation-pepper-two-of-some-length';
    const ROTATING = pepperSet(2, { 1: PEPPER1, 2: PEPPER2 });
    const maxCalls = ROTATING.byVersion.size + 1;

    async function callCount(hashed: string, pw: string): Promise<number> {
      vi.mocked(argon2.verify).mockClear();
      await verifyPasswordWithUpgrade(hashed, pw, ROTATING);
      return vi.mocked(argon2.verify).mock.calls.length;
    }

    it('an unknown-email dummy hash costs the same as every other branch', async () => {
      expect(await callCount(DUMMY_HASH, PW)).toBe(maxCalls);
    });

    it('a known email with a legacy (unstamped) hash costs the same as every other branch', async () => {
      const legacy = await hashPassword(PW, NO_PEPPERS);
      expect(await callCount(legacy, PW)).toBe(maxCalls);
    });

    it('a hash already stamped with the current pepper version costs the same as every other branch', async () => {
      const current = await hashPassword(PW, ROTATING);
      expect(await callCount(current, PW)).toBe(maxCalls);
    });

    it('a hash stamped with an older, still-configured pepper version costs the same as every other branch', async () => {
      const older = await hashPassword(PW, pepperSet(1, { 1: PEPPER1 }));
      expect(await callCount(older, PW)).toBe(maxCalls);
    });

    it('a hash stamped with a version no longer configured costs the same as every other branch', async () => {
      const orphaned = await hashPassword(PW, pepperSet(99, { 99: 'a-retired-pepper-of-length' }));
      expect(await callCount(orphaned, PW)).toBe(maxCalls);
    });

    it('a match found on the very first version tried still pays the full cost', async () => {
      // ROTATING's versions are tried newest-first (2, then 1): a legacy hash matches only on
      // the final "no pepper at all" fallback, the one true positive this loop can produce
      // without ever matching version 2 or 1 first. Covered by the legacy-hash case above; this
      // case instead confirms a same-pepper early match (version 2, tried first) is also padded.
      const current = await hashPassword(PW, ROTATING);
      vi.mocked(argon2.verify).mockClear();
      const result = await verifyPasswordWithUpgrade(current, PW, ROTATING);
      expect(result).toEqual({ ok: true, rehash: false });
      expect(vi.mocked(argon2.verify).mock.calls.length).toBe(maxCalls);
    });

    it('does not change any ok/rehash outcome, only the call count', async () => {
      const legacy = await hashPassword(PW, NO_PEPPERS);
      expect(await verifyPasswordWithUpgrade(legacy, PW, ROTATING)).toEqual({
        ok: true,
        rehash: true,
      });
      const current = await hashPassword(PW, ROTATING);
      expect(await verifyPasswordWithUpgrade(current, PW, ROTATING)).toEqual({
        ok: true,
        rehash: false,
      });
      const orphaned = await hashPassword(PW, pepperSet(99, { 99: 'a-retired-pepper-of-length' }));
      expect(await verifyPasswordWithUpgrade(orphaned, PW, ROTATING)).toEqual({
        ok: false,
        rehash: false,
      });
      expect(await verifyPasswordWithUpgrade(DUMMY_HASH, PW, ROTATING)).toEqual({
        ok: false,
        rehash: false,
      });
    });
  });
});
