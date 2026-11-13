// The address of a board's public page on a candidate's row (#296).
import { describe, expect, it } from 'vitest';
import { boardAddress } from './companiesApi';

describe('boardAddress', () => {
  it('names the public page of a Greenhouse, Lever or Ashby board', () => {
    expect(boardAddress('ats_greenhouse', 'acme')).toEqual({
      href: 'https://boards.greenhouse.io/acme',
      text: 'boards.greenhouse.io/acme',
    });
    expect(boardAddress('ats_lever', 'acme')?.href).toBe('https://jobs.lever.co/acme');
    expect(boardAddress('ats_ashby', 'acme')?.href).toBe('https://jobs.ashbyhq.com/acme');
  });

  it('nothing for any other kind, no board, or no name', () => {
    expect(boardAddress('ats_workday', 'acme/External')).toBeNull();
    expect(boardAddress('none', null)).toBeNull();
    expect(boardAddress(null, null)).toBeNull();
    expect(boardAddress('ats_greenhouse', '')).toBeNull();
  });

  it('keeps the board name one path segment in the link', () => {
    expect(boardAddress('ats_greenhouse', 'a/../b')?.href).toBe(
      'https://boards.greenhouse.io/a%2F..%2Fb',
    );
  });
});
