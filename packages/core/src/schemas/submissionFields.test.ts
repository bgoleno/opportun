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

  it('reports the first problem in a fixed order, whatever order the keys came in', () => {
    expect(submissionFieldProblem({ websiteUrl: 'x', firstName: '' })).toEqual({
      field: 'firstName',
      code: 'field_name_invalid',
    });
  });
});
