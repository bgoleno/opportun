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
    ]) {
      expect(submissionFieldProblem({ websiteUrl: good }), good).toBeNull();
    }
  });

  it('reports the first problem in a fixed order, whatever order the keys came in', () => {
    expect(submissionFieldProblem({ websiteUrl: 'x', firstName: '' })).toEqual({
      field: 'firstName',
      code: 'field_name_invalid',
    });
  });
});
