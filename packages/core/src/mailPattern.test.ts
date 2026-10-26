import { describe, expect, it } from 'vitest';
import { matchesMailPattern, parseMailPattern, suggestMailPattern } from './mailPattern';

/** [pattern, address, expected] */
const CASES: [string, string, boolean][] = [
  ['recruiter@agency-c.example', 'recruiter@agency-c.example', true],
  ['recruiter@agency-c.example', 'other@agency-c.example', false],
  ['*@gmail.com', 'me@gmail.com', true],
  // Review Focus 1: case folds on both sides.
  ['*@gmail.com', 'Alex@GMAIL.com', true],
  ['*@gmail.com', 'alex@mail.gmail.com', false],
  ['gmail.com', 'me@gmail.com', true],
  ['*@*.enterprise.com', 'hr@jobs.enterprise.com', true],
  ['*@*.enterprise.com', 'hr@enterprise.com', false],
  ['*.subdomain.enterprise.com', 'hr@a.subdomain.enterprise.com', true],
  // The spec's footgun: subdomains of gmail.com, which is nothing.
  ['*.gmail.com', 'me@gmail.com', false],
];

describe('matchesMailPattern', () => {
  it.each(CASES)('%s vs %s -> %s', (pattern, address, expected) => {
    const parsed = parseMailPattern(pattern);
    expect(parsed, `pattern ${pattern} should parse`).not.toBeNull();
    expect(matchesMailPattern(address, parsed!)).toBe(expected);
  });

  it('never lets a local-part wildcard cross the @', () => {
    const parsed = parseMailPattern('*@enterprise.com');
    expect(matchesMailPattern('hr@evil.test', parsed!)).toBe(false);
    expect(matchesMailPattern('hr@enterprise.com.evil.test', parsed!)).toBe(false);
  });

  it('matches several wildcards in one local part', () => {
    const parsed = parseMailPattern('a*b*c@acme.test');
    expect(matchesMailPattern('axxbyyc@acme.test', parsed!)).toBe(true);
    expect(matchesMailPattern('abd@acme.test', parsed!)).toBe(false);
  });

  it('stays linear on a pathological wildcard run', () => {
    // '*' expands to an unbounded quantifier; a run of them must not backtrack explosively.
    const parsed = parseMailPattern(`${'*'.repeat(40)}z@acme.test`);
    // Date.now rather than performance, which this package's tsconfig does not type.
    const started = Date.now();
    expect(matchesMailPattern(`${'a'.repeat(400)}@acme.test`, parsed!)).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('matches a wildcard inside one local-part component', () => {
    const parsed = parseMailPattern('no*@acme.test');
    expect(matchesMailPattern('noreply@acme.test', parsed!)).toBe(true);
    expect(matchesMailPattern('reply@acme.test', parsed!)).toBe(false);
  });
});

describe('parseMailPattern', () => {
  // I2: a domain that cannot exist must not parse. A deny rule that silently matches nothing
  // is a privacy failure, and these flow into the Gmail query as `-from:` terms, where an
  // unbalanced quote makes the query malformed and stops the sync outright.
  it.each([
    '',
    '@',
    'a@b@c',
    'user@',
    '@domain.com',
    'nodot',
    '   ',
    '*@corp.com>',
    '*@ev"il.test',
    String.raw`*@a\b.test`,
    '*@-corp.com',
    '*@corp-.com',
    '*@corp..com',
    '*@corp.com.',
  ])('rejects %j', (input) => {
    expect(parseMailPattern(input)).toBeNull();
  });

  it('stays linear on a long run of hyphens', () => {
    // The obvious label regex, [a-z0-9]([a-z0-9-]*[a-z0-9])?, is ambiguous: the inner class
    // overlaps the trailing one, so a non-matching label backtracks. Domains are capped at
    // 255 characters, but a bounded blowup is still a blowup.
    const started = Date.now();
    expect(parseMailPattern(`*@${'-'.repeat(200)}x.com`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('reads a bare domain as any local part at that exact domain', () => {
    expect(parseMailPattern('gmail.com')).toEqual({
      local: '*',
      domain: 'gmail.com',
      subdomains: false,
    });
  });

  it('reads a leading *. as subdomains only', () => {
    expect(parseMailPattern('*.enterprise.com')).toEqual({
      local: '*',
      domain: 'enterprise.com',
      subdomains: true,
    });
  });
});

describe('suggestMailPattern', () => {
  it('offers the address form for a subdomain pattern that matches no real sender', () => {
    expect(suggestMailPattern('*.gmail.com')).toContain('*@gmail.com');
  });

  it('offers the address form for a bare domain', () => {
    expect(suggestMailPattern('gmail.com')).toContain('*@gmail.com');
  });

  it('never suggests the input back', () => {
    for (const input of ['*.gmail.com', 'gmail.com', '@gmail.com']) {
      expect(suggestMailPattern(input)).not.toContain(input);
    }
  });

  it('suggests nothing for an already-explicit pattern', () => {
    expect(suggestMailPattern('*@gmail.com')).toEqual([]);
  });
});
