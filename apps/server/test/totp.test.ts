// TOTP primitive (FR-S3): RFC 6238 Appendix B SHA-1 vectors, window handling, malformed input.
import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  matchTotpStep,
  otpauthUrl,
  totpCode,
  verifyTotp,
} from '../src/lib/totp';

// The RFC 6238 SHA-1 seed "12345678901234567890" in base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32', () => {
  it('round-trips the RFC seed', () => {
    expect(base32Encode(Buffer.from('12345678901234567890'))).toBe(RFC_SECRET);
    expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890');
  });

  it('accepts lowercase, spaces and padding but rejects other characters', () => {
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString()).toBe(
      '12345678901234567890',
    );
    expect(base32Decode('MY======').toString()).toBe('f');
    expect(() => base32Decode('GEZ1')).toThrow();
    expect(() => base32Decode('GEZ!')).toThrow();
  });
});

describe('totpCode', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the RFC 6238 SHA-1 vector at T=%i', (sec, code) => {
    // Appendix B lists 8-digit codes; the 6-digit code is their last six digits.
    expect(totpCode(RFC_SECRET, sec * 1000)).toBe(code);
  });

  it('produces 8 digits on request (RFC vector 94287082 at T=59)', () => {
    expect(totpCode(RFC_SECRET, 59_000, 30, 8)).toBe('94287082');
  });
});

describe('verifyTotp', () => {
  const t = 1_111_111_111_000;

  it('accepts the current, previous and next step within the default window', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, t), t)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, t - 30_000), t)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, t + 30_000), t)).toBe(true);
  });

  it('rejects codes two steps away', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, t - 60_000), t)).toBe(false);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, t + 60_000), t)).toBe(false);
  });

  it('rejects wrong-length, non-numeric and wrong codes', () => {
    const good = totpCode(RFC_SECRET, t);
    expect(verifyTotp(RFC_SECRET, good.slice(1), t)).toBe(false);
    expect(verifyTotp(RFC_SECRET, `${good}0`, t)).toBe(false);
    expect(verifyTotp(RFC_SECRET, 'abcdef', t)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '', t)).toBe(false);
    const wrong = String((Number(good) + 1) % 1_000_000).padStart(6, '0');
    expect(verifyTotp(RFC_SECRET, wrong, t)).toBe(false);
  });

  it('tolerates surrounding whitespace and an inner space (users paste "123 456")', () => {
    const good = totpCode(RFC_SECRET, t);
    expect(verifyTotp(RFC_SECRET, ` ${good.slice(0, 3)} ${good.slice(3)} `, t)).toBe(true);
  });

  it('returns false (does not throw) for a malformed secret', () => {
    expect(verifyTotp('not base32!', '123456', t)).toBe(false);
    expect(verifyTotp('', '123456', t)).toBe(false);
  });
});

describe('matchTotpStep', () => {
  it('returns the matched counter so callers can refuse replays', () => {
    const t = 1_111_111_111_000;
    const step = Math.floor(t / 30_000);
    expect(matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, t), t)).toBe(step);
    expect(matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, t - 30_000), t)).toBe(step - 1);
    expect(matchTotpStep(RFC_SECRET, '000000', t)).toBeNull();
  });
});

describe('generateTotpSecret', () => {
  it('is 20 random bytes as unpadded base32 (32 chars)', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(a).not.toBe(b);
  });
});

describe('otpauthUrl', () => {
  it('builds a Key Uri Format url with issuer label and parameters', () => {
    const url = otpauthUrl(RFC_SECRET, 'ada@example.com');
    expect(url).toBe(
      'otpauth://totp/Opportun:ada%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Opportun&algorithm=SHA1&digits=6&period=30',
    );
    expect(otpauthUrl(RFC_SECRET, 'a@b.c', 'My App')).toContain('otpauth://totp/My%20App:a%40b.c?');
  });
});
