import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256';

// Reference digests from FIPS 180-4 examples and node:crypto.
describe('sha256Hex', () => {
  it('matches the standard vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });

  it('handles the padding boundaries at 55, 56 and 64 bytes', () => {
    expect(sha256Hex('x'.repeat(55))).toBe(
      'd5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072',
    );
    expect(sha256Hex('x'.repeat(56))).toBe(
      '04c26261370ee7541549d16dee320c723e3fd14671e66a099afe0a377c16888e',
    );
    expect(sha256Hex('x'.repeat(64))).toBe(
      '7ce100971f64e7001e8fe5a51973ecdfe1ced42befe7ee8d5fd6219506b5393c',
    );
  });

  it('hashes the UTF-8 encoding, including astral code points', () => {
    expect(sha256Hex('Zürich 東京 \u{1F511}')).toBe(
      '8ae52d21050202e6479fb9b9dffe366193afc92f59eeee1f381d3a34266746b9',
    );
  });
});
