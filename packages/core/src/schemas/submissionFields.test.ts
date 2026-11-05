// The checks on the detail fields prefill reads by name (assisted apply M3a,
// https://github.com/bgoleno/opportun/issues/181). The server's route tests cover the 422s;
// these pin the rule itself.
import { describe, expect, it } from 'vitest';
import {
  SUBMISSION_NAME_FIELDS,
  SUBMISSION_NAME_MAX_LENGTH,
  SUBMISSION_URL_FIELDS,
  submissionFieldProblem,
} from './submission';

describe('submissionFieldProblem', () => {
  it('names the fields it checks', () => {
    expect(SUBMISSION_NAME_FIELDS).toEqual(['firstName', 'lastName']);
    expect(SUBMISSION_URL_FIELDS).toEqual(['linkedinUrl', 'websiteUrl']);
    expect(SUBMISSION_NAME_MAX_LENGTH).toBe(100);
  });

  it('passes good values, and leaves every other key alone', () => {
    expect(
      submissionFieldProblem({
        firstName: 'Zoë',
        lastName: 'N'.repeat(100),
        linkedinUrl: 'https://www.linkedin.com/in/jane-doe-example',
        websiteUrl: 'http://jane.example.com/a?b=c#d',
        links: 'anything at all\nover lines',
        fullName: ' spaced ',
      }),
    ).toBeNull();
    expect(submissionFieldProblem({})).toBeNull();
  });

  it('a name: one line of plain text, trimmed, 1 to 100 characters', () => {
    for (const bad of [
      '',
      ' ',
      'N'.repeat(101),
      'a\nb',
      'a\rb',
      'a\u0007b',
      'a\u2029b',
      ' a',
      'a ',
    ]) {
      expect(submissionFieldProblem({ lastName: bad })).toEqual({
        field: 'lastName',
        code: 'field_name_invalid',
      });
    }
    // 100 characters as a person counts them, not UTF-16 units.
    expect(submissionFieldProblem({ firstName: '😀'.repeat(100) })).toBeNull();
  });

  it('a link: an absolute http or https address with a host and no spaces', () => {
    for (const bad of [
      'javascript:alert(1)',
      'mailto:jane@example.com',
      'file:///etc/hosts',
      '//jane.example.com',
      'jane.example.com',
      'https://',
      'https://jane.example.com/a b',
      'https://jane.example.com ',
    ]) {
      expect(submissionFieldProblem({ websiteUrl: bad })).toEqual({
        field: 'websiteUrl',
        code: 'field_url_invalid',
      });
    }
  });

  // #186, tl's ruling: the review must render exactly what is filled, so a name carries no
  // invisible format character, except a joiner or non-joiner between two letters, which some
  // scripts need in names.
  it('a name refuses format and bidi control characters (#186)', () => {
    for (const bad of [
      'Jane\u202EExample', // right-to-left override
      'Jane\u202AExample', // left-to-right embedding
      'Jane\u2066Example', // left-to-right isolate
      'Jane\u2069',
      'Jane\u200BExample', // zero width space
      'Jane\u2060Example', // word joiner
      '\uFEFFJane', // byte order mark
      'Jane\u00ADExample', // soft hyphen
      '\u200DJane', // a joiner with no letter before it
      'Jane\u200C', // a non-joiner with no letter after it
      'Jane \u200D Example', // a joiner between spaces
      'Jane-\u200CExample', // a non-joiner after punctuation
      'Jane\u200D\u200DExample', // two in a row: the first has no letter after it
    ]) {
      expect(submissionFieldProblem({ firstName: bad }), JSON.stringify(bad)).toEqual({
        field: 'firstName',
        code: 'field_name_invalid',
      });
    }
  });

  it('a name refuses U+115F, the Hangul choseong filler (#196, tl)', () => {
    for (const bad of ['Jane\u115FExample', '\u115FJane', 'Jane\u115F']) {
      expect(submissionFieldProblem({ firstName: bad })).toEqual({
        field: 'firstName',
        code: 'field_name_invalid',
      });
    }
    expect(submissionFieldProblem({ lastName: 'Doe\u115F' })).toEqual({
      field: 'lastName',
      code: 'field_name_invalid',
    });
  });

  it('a name refuses U+1160, the Hangul jungseong filler (#196, tl)', () => {
    for (const bad of ['Jane\u1160Example', '\u1160Jane', 'Jane\u1160']) {
      expect(submissionFieldProblem({ firstName: bad })).toEqual({
        field: 'firstName',
        code: 'field_name_invalid',
      });
    }
    expect(submissionFieldProblem({ lastName: 'Doe\u1160' })).toEqual({
      field: 'lastName',
      code: 'field_name_invalid',
    });
  });

  it('a name refuses U+3164, the Hangul filler (#196, tl)', () => {
    for (const bad of ['Jane\u3164Example', '\u3164Jane', 'Jane\u3164']) {
      expect(submissionFieldProblem({ firstName: bad })).toEqual({
        field: 'firstName',
        code: 'field_name_invalid',
      });
    }
    expect(submissionFieldProblem({ lastName: 'Doe\u3164' })).toEqual({
      field: 'lastName',
      code: 'field_name_invalid',
    });
  });

  it('a name refuses U+FFA0, the halfwidth Hangul filler (#196, tl)', () => {
    for (const bad of ['Jane\uFFA0Example', '\uFFA0Jane', 'Jane\uFFA0']) {
      expect(submissionFieldProblem({ firstName: bad })).toEqual({
        field: 'firstName',
        code: 'field_name_invalid',
      });
    }
    expect(submissionFieldProblem({ lastName: 'Doe\uFFA0' })).toEqual({
      field: 'lastName',
      code: 'field_name_invalid',
    });
  });

  it('a name refuses U+2800, the braille pattern blank (#196, tl)', () => {
    for (const bad of ['Jane\u2800Example', '\u2800Jane', 'Jane\u2800']) {
      expect(submissionFieldProblem({ firstName: bad })).toEqual({
        field: 'firstName',
        code: 'field_name_invalid',
      });
    }
    expect(submissionFieldProblem({ lastName: 'Doe\u2800' })).toEqual({
      field: 'lastName',
      code: 'field_name_invalid',
    });
  });

  it('a name refuses U+034F, the combining grapheme joiner (#196, tl)', () => {
    for (const bad of ['Jane\u034FExample', '\u034FJane', 'Jane\u034F']) {
      expect(submissionFieldProblem({ firstName: bad })).toEqual({
        field: 'firstName',
        code: 'field_name_invalid',
      });
    }
    expect(submissionFieldProblem({ lastName: 'Doe\u034F' })).toEqual({
      field: 'lastName',
      code: 'field_name_invalid',
    });
  });

  it('a name keeps a variation selector: it renders the same base character (#196, tl)', () => {
    for (const good of ['\u845B\u{E0100}', 'Ja\uFE0Fne', 'Jane\uFE0E']) {
      expect(submissionFieldProblem({ firstName: good }), JSON.stringify(good)).toBeNull();
    }
  });

  it('a name keeps a joiner or non-joiner between two letters or marks (#186, tl)', () => {
    for (const good of [
      '\u0915\u094D\u200D\u0937', // Devanagari: KA, VIRAMA, ZWJ, SSA
      '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645', // Persian, with a non-joiner
      'Ja\u200Dne',
      'Ja\u200Cne',
    ]) {
      expect(submissionFieldProblem({ lastName: good }), JSON.stringify(good)).toBeNull();
    }
  });

  it('a link refuses a username or password, and any format character (#186)', () => {
    for (const bad of [
      'https://user:pw@jane.example.com/',
      'https://user@jane.example.com/',
      'https://:pw@jane.example.com/',
      'https://www.linkedin.com@jane.example.com/in/jane',
      // tl and sec on #194: extra slashes or a backslash after the scheme, which the URL
      // parser skips, so the text right after // reads as no authority at all.
      'https:///user:pw@evil.example/in/jane',
      'https://\\user:pw@evil.example/',
      'https:////www.linkedin.com@evil.example/in/jane',
      'https:///user@evil.example/',
      'https://jane.example.com/\u202Efdp.exe',
      'https://jane.example.com/a\u200Bb',
      'https://jane.example.com/?q=\u2066x',
      'https://jane.example.com/#\uFEFF',
      'https://jane\u00AD.example.com/',
    ]) {
      expect(submissionFieldProblem({ linkedinUrl: bad }), JSON.stringify(bad)).toEqual({
        field: 'linkedinUrl',
        code: 'field_url_invalid',
      });
    }
  });

  it('an @ in a link’s path, query or fragment is not a username', () => {
    for (const good of [
      'https://medium.com/@jane-example',
      'https://jane.example.com/?contact=jane@example.com',
      'https://jane.example.com/#@top',
      'https://jane.example.com/a%40b',
      // A backslash ends the host, so this @ is in the path: the host is www.linkedin.com
      // (qa on #194).
      'https://www.linkedin.com\\@other.example/',
    ]) {
      expect(submissionFieldProblem({ websiteUrl: good }), good).toBeNull();
    }
  });

  it('an email: a light shape check, and no invisible characters (#203, tl)', () => {
    for (const good of [
      'jane@example.com',
      'jane.doe+apply@sub.example.co.uk',
      'j\u00F6rg@example.de',
      '\u7528\u6237@\u4F8B\u5B50.example',
    ]) {
      expect(submissionFieldProblem({ email: good }), good).toBeNull();
    }
    const refused: [string, string][] = [
      ['two @', 'jane@doe@example.com'],
      // Only the exactly-one-@ rule catches this one: every piece would pass on its own.
      ['two @, each side with a dot', 'jane@doe.example@example.com'],
      ['nothing before @', '@example.com'],
      ['no domain', 'jane@'],
      ['no dot in the domain', 'jane@localhost'],
      ['a dot first in the domain', 'jane@.example.com'],
      ['a dot last in the domain', 'jane@example.'],
      ['a space', 'jane doe@example.com'],
      ['no @', 'jane.example.com'],
      [
        'too long',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@example.com',
      ],
      ['a zero width space', 'jane\u200B@example.com'],
      ['a joiner (no exception here)', 'ja\u200Dne@example.com'],
      ['a bidi override', 'jane@exa\u202Emple.com'],
      ['a Hangul filler', 'jane\u3164@example.com'],
      ['a control character', 'jane\u0007@example.com'],
      ['a line separator', 'jane\u2028@example.com'],
      ['a leading space', ' jane@example.com'],
      ['empty', ''],
    ];
    for (const [what, bad] of refused) {
      expect(submissionFieldProblem({ email: bad }), what).toEqual({
        field: 'email',
        code: 'field_email_invalid',
      });
    }
  });

  it('a phone: ASCII digits and a few separators, a leading +, an optional extension (#203, tl)', () => {
    for (const good of [
      '+1 (555) 123-4567',
      '555.123.4567',
      '+44 20 7946 0958 ext. 12',
      '555-1234 x89',
      '555/123 4567',
      '555 0100 EXT 7',
    ]) {
      expect(submissionFieldProblem({ phone: good }), good).toBeNull();
    }
    const refused: [string, string][] = [
      ['a letter', '555-CALL-NOW'],
      ['a + mid-number', '555+1234'],
      ['two +', '++1 555 0100'],
      ['too few digits', '12'],
      ['too many digits', '111111111111111111111'],
      ['too long', '1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1'],
      ['a non-ASCII digit', '555 \u0661\u0662\u0663'],
      ['an extension with no digits', '555 0100 ext'],
      ['a zero width space', '555\u200B0100'],
      ['a bidi override', '555 \u202E0100'],
      ['a braille blank', '555\u28000100'],
      ['a trailing space', '555 0100 '],
      ['empty', ''],
    ];
    for (const [what, bad] of refused) {
      expect(submissionFieldProblem({ phone: bad }), what).toEqual({
        field: 'phone',
        code: 'field_phone_invalid',
      });
    }
  });

  it('a phone over 40 characters is refused for its length alone (#203, #211 item 1)', () => {
    // 11 digits and only allowed separators, so the digit count and the pattern both accept it.
    const fortyOne = `${'1 '.repeat(10)}${'-'.repeat(20)}1`;
    expect(fortyOne).toHaveLength(41);
    expect(submissionFieldProblem({ phone: fortyOne })).toEqual({
      field: 'phone',
      code: 'field_phone_invalid',
    });
    // One separator fewer is the longest it takes.
    const forty = `${'1 '.repeat(10)}${'-'.repeat(19)}1`;
    expect(forty).toHaveLength(40);
    expect(submissionFieldProblem({ phone: forty })).toBeNull();
  });

  it('reports the first problem in a fixed order, whatever order the keys came in', () => {
    expect(submissionFieldProblem({ websiteUrl: 'x', firstName: '' })).toEqual({
      field: 'firstName',
      code: 'field_name_invalid',
    });
  });
});
