import { describe, expect, it } from 'vitest';
import {
  formatAddress,
  looksLikeHtml,
  MAX_BODY_CHARS,
  normalizeSubject,
  parseAddress,
  toInbound,
  truncateChars,
} from '../src/normalize';
import { raw } from './fakes';

describe('address parsing', () => {
  it.each([
    ['Jane Doe <jane@initech.example>', { name: 'Jane Doe', address: 'jane@initech.example' }],
    ['"Doe, Jane" <jane@initech.example>', { name: 'Doe, Jane', address: 'jane@initech.example' }],
    ['<jane@initech.example>', { name: '', address: 'jane@initech.example' }],
    ['  jane@initech.example  ', { name: '', address: 'jane@initech.example' }],
    ['"Jane \\"JD\\" Doe" <jd@x.example>', { name: 'Jane "JD" Doe', address: 'jd@x.example' }],
    ['Initech Careers', { name: 'Initech Careers', address: '' }],
  ])('parses %s', (input, expected) => {
    expect(parseAddress(input)).toEqual(expected);
  });

  it.each([
    [{ name: 'Jane Doe', address: 'jane@x.example' }, 'Jane Doe <jane@x.example>'],
    [{ name: 'Doe, Jane', address: 'jane@x.example' }, '"Doe, Jane" <jane@x.example>'],
    [{ name: 'Jane "JD" Doe', address: 'jd@x.example' }, '"Jane \\"JD\\" Doe" <jd@x.example>'],
    [{ name: '', address: 'jane@x.example' }, 'jane@x.example'],
    [{ name: 'jane@x.example', address: 'jane@x.example' }, 'jane@x.example'],
    [{ name: 'Careers', address: '' }, 'Careers'],
    [{ name: '', address: '' }, ''],
  ])('formats %j', (input, expected) => {
    expect(formatAddress(input)).toBe(expected);
  });
});

describe('subject threading', () => {
  it.each([
    ['Re: RE: Fwd: Senior Engineer at Initech', 'senior engineer at initech'],
    ['FW:  [External]  Senior   Engineer', '[external] senior engineer'],
    ['AW: SV: Hallo', 'hallo'],
    ['Re[2]: Re : Offer', 'offer'],
    ['Regarding your profile', 'regarding your profile'],
    ['', ''],
  ])('normalizes %s', (subject, expected) => {
    expect(normalizeSubject(subject)).toBe(expected);
  });
});

describe('truncation', () => {
  it('cuts to the character budget without splitting a surrogate pair', () => {
    expect(truncateChars('abcdef', 3)).toBe('abc');
    expect(truncateChars('ab😀', 3)).toBe('ab');
    expect(truncateChars('short', 10)).toBe('short');
  });
});

describe('looksLikeHtml', () => {
  it('spots markup, not prose with an angle bracket', () => {
    expect(looksLikeHtml('<html><body><p>Hi</p></body></html>')).toBe(true);
    expect(looksLikeHtml('<div>Hi</div>')).toBe(true);
    expect(looksLikeHtml('Hello<br>there')).toBe(true);
    expect(looksLikeHtml('x < y and y > z')).toBe(false);
    expect(looksLikeHtml('Write to <jane@x.example> please')).toBe(false);
    expect(looksLikeHtml('<br/>')).toBe(true);
    expect(looksLikeHtml('<DIV\nclass="x">')).toBe(true);
  });

  // Review F1: `\b` matched before '.' and '@', so an address like <a.smith@...> or
  // <p.jones@...> made a plain-text reply "HTML" and the tag stripper ate the addresses.
  it('does not take tag-like addresses for markup', () => {
    const quoted =
      'On Mon, Alice <a.smith@acme.com> wrote:\n> Please also loop in <p.jones@acme.com>.';
    expect(looksLikeHtml(quoted)).toBe(false);
    expect(looksLikeHtml('ping <b.lee@x.example> or <br.ops@x.example>')).toBe(false);
    const { message } = toInbound(raw(9, { body: quoted }));
    expect(message.bodyText).toContain('<a.smith@acme.com>');
    expect(message.bodyText).toContain('<p.jones@acme.com>');
  });
});

describe('hostile bodies (review F2)', () => {
  it('normalizes 500k characters of unclosed anchors quickly', () => {
    for (const body of ['<a href='.repeat(62_500), `<html>${'<a href='.repeat(62_500)}`]) {
      const started = performance.now();
      toInbound(raw(10, { body }));
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});

describe('toInbound', () => {
  it('maps a Mail message to the server InboundMessage shape', () => {
    const { message, receivedAt } = toInbound(
      raw(1, {
        subject: 'Re: Senior Engineer',
        sender: '"Doe, Jane" <jane@initech.example>',
        recipients: [
          { name: 'Me', address: 'me@home.example' },
          { name: '', address: 'cc@home.example' },
          { name: 'Me', address: 'me@home.example' },
        ],
        dateSent: '2026-09-30T23:59:00.000Z',
        body: 'Hello\r\nthere',
      }),
    );
    expect(message).toEqual({
      externalId: 'apple-mail:<msg-1@mail.example>',
      threadKey: 'apple-mail-subject:senior engineer',
      from: '"Doe, Jane" <jane@initech.example>',
      to: ['Me <me@home.example>', 'cc@home.example'],
      subject: 'Re: Senior Engineer',
      snippet: 'Hello there',
      bodyText: 'Hello\nthere',
      sentAt: Date.parse('2026-09-30T23:59:00.000Z'),
    });
    expect(receivedAt).toBe(Date.parse(raw(1).dateReceived));
  });

  it('turns an HTML body into text, keeping links', () => {
    const { message } = toInbound(
      raw(2, {
        body: '<html><body><p>Apply <a href="https://x.example/job?a=1&amp;b=2">here</a></p><p>Thanks&nbsp;!</p></body></html>',
      }),
    );
    expect(message.bodyText).toBe('Apply here (https://x.example/job?a=1&b=2)\nThanks !');
    expect(message.snippet).toBe('Apply here (https://x.example/job?a=1&b=2) Thanks !');
  });

  it('accepts recipients as an address-list string', () => {
    const { message } = toInbound(raw(3, { recipients: '"Doe, Jane" <j@x.example>, b@y.example' }));
    expect(message.to).toEqual(['"Doe, Jane" <j@x.example>', 'b@y.example']);
  });

  it('caps the body at 500k characters and the snippet at 200', () => {
    const { message } = toInbound(raw(4, { body: 'x'.repeat(MAX_BODY_CHARS + 10) }));
    expect(message.bodyText.length).toBe(MAX_BODY_CHARS);
    expect(message.snippet.length).toBe(200);
  });

  it('cuts fields to the server schema caps instead of failing the batch', () => {
    const { message } = toInbound(
      raw(6, {
        subject: 's'.repeat(20_000),
        sender: `${'n'.repeat(5000)} <a@x.example>`,
        recipients: Array.from({ length: 600 }, (_, i) => `r${i}@x.example`),
      }),
    );
    expect(message.subject.length).toBe(16_384);
    expect(message.from.length).toBe(4096);
    expect(message.to).toHaveLength(500);
  });

  it('falls back sensibly on missing fields', () => {
    const { message } = toInbound({ id: 'abc', dateReceived: '2026-10-01T00:00:00Z' });
    expect(message).toMatchObject({
      externalId: 'apple-mail:abc',
      threadKey: 'apple-mail:abc',
      from: '(unknown sender)',
      to: [],
      subject: '',
      bodyText: '',
      sentAt: Date.parse('2026-10-01T00:00:00Z'),
    });
  });

  it('hashes an overlong message id to stay within the server cap', () => {
    const { message } = toInbound(raw(5, { id: 'x'.repeat(2000) }));
    expect(message.externalId).toMatch(/^apple-mail:sha256:[0-9a-f]{64}$/);
  });

  it('rejects a message without a usable id or date', () => {
    expect(() => toInbound({ id: '', dateReceived: '2026-10-01T00:00:00Z' })).toThrow(/id/);
    expect(() => toInbound({ id: 'a', dateReceived: 'soon' })).toThrow(/date/);
  });
});
