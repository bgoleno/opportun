import { describe, expect, it } from 'vitest';
import { SENIORITY_LEVELS, seniorityLabel, seniorityRangeText } from './seniority';

describe('seniorityLabel', () => {
  it('names exact ladder values', () => {
    expect(seniorityLabel(1)).toBe('Junior');
    expect(seniorityLabel(4)).toBe('Staff');
    expect(seniorityLabel(10)).toBe('Executive');
    expect(SENIORITY_LEVELS.map((l) => seniorityLabel(l.value))).toEqual(
      SENIORITY_LEVELS.map((l) => l.label),
    );
  });

  it('falls back to Level N for values off the ladder', () => {
    expect(seniorityLabel(0)).toBe('Level 0');
    expect(seniorityLabel(42)).toBe('Level 42');
  });

  it('returns null for no value', () => {
    expect(seniorityLabel(null)).toBeNull();
    expect(seniorityLabel(undefined)).toBeNull();
  });
});

describe('seniorityRangeText', () => {
  it('renders closed, half-open and open ranges', () => {
    expect(seniorityRangeText(4, 5)).toBe('Staff to Principal');
    expect(seniorityRangeText(4, 4)).toBe('Staff');
    expect(seniorityRangeText(3, null)).toBe('Senior or above');
    expect(seniorityRangeText(null, 5)).toBe('up to Principal');
    expect(seniorityRangeText(null, undefined)).toBe('any');
    expect(seniorityRangeText(42, null)).toBe('Level 42 or above');
  });
});
