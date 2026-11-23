import { describe, expect, it } from 'vitest';
import { possessive } from './possessive';

describe('possessive (https://github.com/bgoleno/opportun/issues/866)', () => {
  it.each([
    ['Soylent', "Soylent's"],
    ['Vandelay Industries', "Vandelay Industries'"],
    ['HOOLI SYSTEMS', "HOOLI SYSTEMS'"],
    ['Acme Inc.', "Acme Inc.'s"],
    ['Xerox', "Xerox's"],
    ['Smith & Sons ', "Smith & Sons'"],
    // Already a possessive: a second ending would be wrong in either form.
    ["McDonald's", "McDonald's"],
    ['Lowe\u2019s', 'Lowe\u2019s'],
    ["The Smiths'", "The Smiths'"],
  ])('%s: %s', (name, expected) => {
    expect(possessive(name)).toBe(expected);
  });
});
