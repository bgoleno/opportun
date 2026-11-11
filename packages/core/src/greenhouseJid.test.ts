import { describe, expect, it } from 'vitest';
import { greenhouseBoardJobUrl, greenhouseJidOf } from './greenhouseJid';

describe('greenhouseJidOf (#398)', () => {
  it.each([
    ['https://careers.example.com/jobs?gh_jid=8136554', '8136554'],
    ['https://careers.airbnb.com/positions/8136554/?gh_jid=8136554', '8136554'],
    ['https://example.com/careers?team=eng&gh_jid=4001234567&utm_source=x', '4001234567'],
    ['https://example.com/?gh_jid=12345678901234567890', '12345678901234567890'],
  ])('reads the numeric gh_jid of %s', (link, jid) => {
    expect(greenhouseJidOf(link)).toBe(jid);
  });

  it.each([
    ['no gh_jid', 'https://careers.example.com/jobs/8136554'],
    ['not numeric', 'https://careers.example.com/jobs?gh_jid=abc123'],
    ['a sign', 'https://careers.example.com/jobs?gh_jid=-5'],
    ['empty', 'https://careers.example.com/jobs?gh_jid='],
    ['over 20 digits', 'https://careers.example.com/jobs?gh_jid=123456789012345678901'],
    ['two different ids', 'https://careers.example.com/jobs?gh_jid=1&gh_jid=2'],
    ['not a link', 'gh_jid=8136554'],
    ['not http', 'ftp://careers.example.com/jobs?gh_jid=8136554'],
    ['null', null],
  ])('has none when %s', (_name, link) => {
    expect(greenhouseJidOf(link)).toBeNull();
  });

  it('accepts the same id given twice', () => {
    expect(greenhouseJidOf('https://example.com/?gh_jid=7&gh_jid=7')).toBe('7');
  });
});

describe('greenhouseBoardJobUrl (#398)', () => {
  it("is the job's page on Greenhouse's own board host", () => {
    expect(greenhouseBoardJobUrl('airbnb', '8136554')).toBe(
      'https://job-boards.greenhouse.io/airbnb/jobs/8136554',
    );
  });

  it('refuses a token or an id that is not of the expected shape', () => {
    expect(() => greenhouseBoardJobUrl('Air Bnb', '8136554')).toThrow();
    expect(() => greenhouseBoardJobUrl('airbnb', '81a')).toThrow();
    expect(() => greenhouseBoardJobUrl('../x', '1')).toThrow();
  });
});
