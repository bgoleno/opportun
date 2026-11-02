// A job whose title is longer than a posting can store is refused by name
// (https://github.com/bgoleno/opportun/issues/92). Before, it was refused as `no_title_company`,
// which the extension words as "the page had not finished loading". The limit stays where it is
// (NormalizedPosting.title, max 300): only a page that is otherwise a job, with its company and
// description found, gets `title_too_long`. Every page here is synthetic.
import { describe, expect, it } from 'vitest';
import { recognizeIndeedPage } from '../src/lib/indeedCapture';
import { recognizeLinkedInPage } from '../src/lib/linkedinCapture';
import { INDEED_JOB, indeedText } from './fixtures/capture/indeedPages';
import { JOB as LINKEDIN_JOB } from './fixtures/capture/pages';

/** A job title of exactly `n` characters. */
const titleOf = (n: number): string => `Staff Example Engineer ${'x'.repeat(n)}`.slice(0, n);

/** The LinkedIn fixture job with its title, in the tab title and on the page, replaced. */
function linkedInJobTitled(title: string, opts: { onPage?: boolean } = {}) {
  const text = LINKEDIN_JOB.text.replace(
    '\nStaff Platform Engineer\n',
    `\n${opts.onPage === false ? 'Staff Platform Engineer' : title}\n`,
  );
  return { ...LINKEDIN_JOB, title: `${title} | Initech | LinkedIn`, text };
}

/** The Indeed fixture job with its title line replaced. */
function indeedJobTitled(title: string, over: { description?: boolean; company?: string } = {}) {
  const text =
    over.description === false
      ? [title, over.company ?? 'Example Corp', 'Example City, EX'].join('\n')
      : indeedText({ title, company: over.company ?? 'Example Corp' });
  return { ...INDEED_JOB, text };
}

describe('title_too_long: LinkedIn', () => {
  it('refuses a job whose title is over 300 characters by name', () => {
    expect(recognizeLinkedInPage(linkedInJobTitled(titleOf(301)))).toEqual({
      kind: 'unrecognized',
      reason: 'title_too_long',
    });
  });

  it('reads a job whose title is exactly 300 characters', () => {
    expect(recognizeLinkedInPage(linkedInJobTitled(titleOf(300)))).toMatchObject({
      kind: 'job',
      title: titleOf(300),
      company: 'Initech',
    });
  });

  it('keeps no_title_company when the long title is not on the page', () => {
    expect(recognizeLinkedInPage(linkedInJobTitled(titleOf(301), { onPage: false }))).toEqual({
      kind: 'unrecognized',
      reason: 'no_title_company',
    });
  });

  it('keeps the old reason when the description is missing too: the page is not otherwise a job', () => {
    const page = linkedInJobTitled(titleOf(301));
    const noDescription = { ...page, text: page.text.replace('About the job', 'About') };
    expect(recognizeLinkedInPage(noDescription)).toEqual({
      kind: 'unrecognized',
      reason: 'no_title_company',
    });
  });
});

describe('title_too_long: Indeed', () => {
  it('refuses a job whose title line is over 300 characters by name', () => {
    expect(recognizeIndeedPage(indeedJobTitled(titleOf(301)))).toEqual({
      kind: 'unrecognized',
      reason: 'title_too_long',
    });
  });

  it('reads a job whose title line is exactly 300 characters', () => {
    expect(recognizeIndeedPage(indeedJobTitled(titleOf(300)))).toMatchObject({
      kind: 'job',
      title: titleOf(300),
      company: 'Example Corp',
    });
  });

  it('keeps the old reason when the description is missing too: the page is not otherwise a job', () => {
    expect(recognizeIndeedPage(indeedJobTitled(titleOf(301), { description: false }))).toEqual({
      kind: 'unrecognized',
      reason: 'no_title_company',
    });
  });

  it('names the long title, not a wall, when the description quotes sign-in words', () => {
    // The wall check only names text that is not a job; this one is a job but for its title.
    const page = {
      ...INDEED_JOB,
      text: indeedText({
        title: titleOf(301),
        company: 'Example Corp',
        description: 'Create an account or sign in to apply on our portal.',
      }),
    };
    expect(recognizeIndeedPage(page)).toEqual({ kind: 'unrecognized', reason: 'title_too_long' });
  });

  it('keeps no_title_company for a company line over 300 characters', () => {
    expect(
      recognizeIndeedPage(indeedJobTitled('Senior Example Engineer', { company: titleOf(301) })),
    ).toEqual({ kind: 'unrecognized', reason: 'no_title_company' });
  });
});
