import { describe, expect, it } from 'vitest';
import { isNaicsCode, NAICS_2022_INDUSTRY_GROUPS, naicsTitle, NAICS_TIERS } from './naics';
import { sha256Hex } from './sha256';

describe('NAICS 2022 industry groups (https://github.com/bgoleno/opportun/issues/219)', () => {
  it('is every 4-digit code in the Census file, and nothing else', () => {
    // The file has 17 two-digit rows, 3 ranges (31-33, 44-45, 48-49), 96 three-digit, 308
    // four-digit, 689 five-digit and 1012 six-digit.
    expect(NAICS_2022_INDUSTRY_GROUPS).toHaveLength(308);
  });

  it('is exactly what the Census file says: a change to any code or title fails here', () => {
    // SHA-256 of `code<TAB>title<LF>` for each row, in the file's order, taken from the parsed
    // file before the table was written. See the citation in naics.ts.
    const text = NAICS_2022_INDUSTRY_GROUPS.map((g) => `${g.code}\t${g.title}\n`).join('');
    expect(sha256Hex(text)).toBe(
      '5a960494707db6e0fe1051dd27c2c632d4e8a29abb39a2978f96150e1aa1c0b8',
    );
  });

  it('has four digits, unique and in order, with a title on every row', () => {
    const codes = NAICS_2022_INDUSTRY_GROUPS.map((g) => g.code);
    expect(codes.every((c) => /^\d{4}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([...codes].sort());
    expect(
      NAICS_2022_INDUSTRY_GROUPS.every((g) => g.title.trim() === g.title && g.title !== ''),
    ).toBe(true);
  });

  it('reads the 2022 codes, not an earlier edition', () => {
    // 2022 moved software publishing to 5132 from 5112, which is no longer a code.
    expect(naicsTitle('5132')).toBe('Software Publishers');
    expect(isNaicsCode('5112')).toBe(false);
  });

  it('knows a code only if the table has it', () => {
    expect(isNaicsCode('5415')).toBe(true);
    expect(naicsTitle('5415')).toBe('Computer Systems Design and Related Services');
    for (const bad of ['54', '541', '54151', '9999', '', 'abcd', '5415 ', ' 5415', 'toString']) {
      expect(isNaicsCode(bad), bad).toBe(false);
      expect(naicsTitle(bad), bad).toBeUndefined();
    }
  });

  it('has the three tiers', () => {
    expect(NAICS_TIERS).toEqual(['core', 'similar', 'adjacent']);
  });
});
