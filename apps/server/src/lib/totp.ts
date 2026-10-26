// TOTP (RFC 6238 over RFC 4226 HOTP, HMAC-SHA1) for optional two-factor sign-in (FR-S3).
// Zero-dependency on purpose: node:crypto supplies HMAC and the constant-time compare.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SECRET_BYTES = 20;
const DEFAULT_STEP = 30;
const DEFAULT_DIGITS = 6;

/** RFC 4648 base32, upper case, no padding. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

/** Decodes RFC 4648 base32; case, spaces and trailing '=' are tolerated. Throws on other input. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('totp: invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh shared secret: 20 random bytes (RFC 4226 recommends 160 bits), base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

function hotp(key: Buffer, counter: number, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The code for `timeMs` (RFC 6238, T0 = 0). */
export function totpCode(
  secret: string,
  timeMs: number,
  step: number = DEFAULT_STEP,
  digits: number = DEFAULT_DIGITS,
): string {
  return hotp(base32Decode(secret), Math.floor(timeMs / 1000 / step), digits);
}

/**
 * The time step (counter) within ±`window` of `timeMs` whose code equals `code`, or null.
 * Every candidate step is compared (constant time each) so timing does not reveal which step
 * matched. A malformed secret or code is a mismatch, never an exception. Callers that store
 * the returned step can refuse a replay of the same code.
 */
export function matchTotpStep(
  secret: string,
  code: string,
  timeMs: number,
  window = 1,
): number | null {
  const given = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return null;
  }
  if (key.length === 0) return null;
  const counter = Math.floor(timeMs / 1000 / DEFAULT_STEP);
  const a = Buffer.from(given);
  let matched: number | null = null;
  for (let i = -window; i <= window; i++) {
    const b = Buffer.from(hotp(key, counter + i, DEFAULT_DIGITS));
    if (timingSafeEqual(a, b) && matched === null) matched = counter + i;
  }
  return matched;
}

/** True when `code` matches a step within ±`window` of `timeMs` (see matchTotpStep). */
export function verifyTotp(secret: string, code: string, timeMs: number, window = 1): boolean {
  return matchTotpStep(secret, code, timeMs, window) !== null;
}

/** Key Uri Format (otpauth://) for authenticator apps; the QR encodes this. */
export function otpauthUrl(secret: string, email: string, issuer = 'Opportun'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_STEP),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
