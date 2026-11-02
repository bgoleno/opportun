// The Indeed capture shape check (https://github.com/bgoleno/opportun/issues/73). A single
// posting is read deterministically; everything else is refused with a named reason, and a
// missing anchor is a refusal, never a guess. Fixtures are synthetic (fixtures/capture/indeedPages).
import { describe, expect, it } from 'vitest';
import { recognizeCapturedPage } from '../src/lib/captureRecognizers';
import { recognizeIndeedPage } from '../src/lib/indeedCapture';
import {
  INDEED_DESCRIPTION,
  INDEED_JK,
  INDEED_JOB,
  INDEED_JOB_PARENT_COMPANY,
  INDEED_JOB_SPLIT_VIEW,
  INDEED_JOB_UPPERCASE_KEY,
  INDEED_JOB_URL,
  INDEED_REFUSED,
} from './fixtures/capture/indeedPages';

describe('recognizeIndeedPage', () => {
  it('reads a single posting: job key, canonical URL, title, company, description', () => {
    expect(recognizeIndeedPage(INDEED_JOB)).toEqual({
      kind: 'job',
      jobId: INDEED_JK,
      jobUrl: INDEED_JOB_URL,
      title: 'Senior Example Engineer',
      company: 'Example Corp',
      descriptionMd: INDEED_DESCRIPTION,
    });
  });

  it('reads the split view the same way: the tab title is never used', () => {
    expect(recognizeIndeedPage(INDEED_JOB_SPLIT_VIEW)).toEqual(recognizeIndeedPage(INDEED_JOB));
  });

  it('drops a parent-company note and the rating from the company line', () => {
    expect(recognizeIndeedPage(INDEED_JOB_PARENT_COMPANY)).toMatchObject({
      kind: 'job',
      company: 'Example Corp',
    });
  });

  it('lowercases the job key, and stores the www URL the alert parser stores', () => {
    expect(recognizeIndeedPage(INDEED_JOB_UPPERCASE_KEY)).toMatchObject({
      kind: 'job',
      jobId: INDEED_JK,
      jobUrl: INDEED_JOB_URL,
    });
  });

  it('keeps the page header and job details out of the description', () => {
    const page = recognizeIndeedPage(INDEED_JOB);
    expect(page.kind).toBe('job');
    const description = (page as { descriptionMd: string }).descriptionMd;
    expect(description).not.toMatch(/Apply now|Job details|Example Corp · 4\.1/);
  });

  it('does not take a wall phrase deep inside a description for a wall', () => {
    const filler = Array.from({ length: 60 }, (_, i) => `Lorem ipsum line ${i}.`);
    const text = `${INDEED_JOB.text}\n${filler.join('\n')}\nVerify you are human, says the example.`;
    expect(recognizeIndeedPage({ ...INDEED_JOB, text })).toMatchObject({ kind: 'job' });
  });
});

describe('recognizeCapturedPage: Indeed', () => {
  it('routes an Indeed job to the Indeed recognizer, tagged with its site', () => {
    expect(recognizeCapturedPage(INDEED_JOB)).toMatchObject({
      kind: 'job',
      siteId: 'indeed',
      jobId: INDEED_JK,
    });
  });

  it.each(Object.entries(INDEED_REFUSED))('refuses %s with its named reason', (_name, c) => {
    expect(recognizeCapturedPage(c.page)).toEqual({ kind: 'unrecognized', reason: c.reason });
  });

  it('refuses a host no site claims as unsupported_site, not as not_linkedin', () => {
    expect(
      recognizeCapturedPage({ url: 'https://example.com/jobs/1', title: 'Job', text: 'x' }),
    ).toEqual({ kind: 'unrecognized', reason: 'unsupported_site' });
  });
});
