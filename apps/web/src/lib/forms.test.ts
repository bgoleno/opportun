import { describe, expect, it } from 'vitest';
import { optionalWholeNumber } from './forms';

/** The parser behind every whole-number settings field (compensation, seniority). */
const parse = (s: string) => optionalWholeNumber.safeParse(s);

describe('optionalWholeNumber', () => {
  it('accepts a plain whole number', () => {
    expect(parse('210000')).toMatchObject({ success: true, data: 210000 });
  });

  it('accepts thousands separators, which is how people write salaries', () => {
    expect(parse('210,000')).toMatchObject({ success: true, data: 210000 });
    expect(parse('1,234,567')).toMatchObject({ success: true, data: 1234567 });
  });

  it('treats an empty field as no value', () => {
    expect(parse('')).toMatchObject({ success: true, data: null });
    expect(parse('   ')).toMatchObject({ success: true, data: null });
  });

  it('rejects mis-grouped digits rather than silently reading them', () => {
    // 1,23 is a typo, not a number: stripping commas blindly would make it 123.
    for (const bad of ['1,23', '1,2345', ',100', '100,', '1,,000']) {
      expect(parse(bad).success, bad).toBe(false);
    }
  });

  it('rejects what is not a whole number at all', () => {
    for (const bad of ['abc', '12abc', '-5', '1.5', '1e5']) {
      expect(parse(bad).success, bad).toBe(false);
    }
  });
});
