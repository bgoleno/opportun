// The Indeed capture shape check (https://github.com/bgoleno/opportun/issues/73). A single
// posting in the capture text contract's shape is read deterministically; everything else is
// refused with a named reason, and a missing anchor is a refusal, never a guess. Fixtures are
// synthetic (fixtures/capture/indeedPages).
import { describe, expect, it } from 'vitest';
import { recognizeCapturedPage } from '../src/lib/captureRecognizers';
import { recognizeIndeedPage } from '../src/lib/indeedCapture';
import {
  INDEED_DESCRIPTION,
  INDEED_JK,
  INDEED_JOB,
  INDEED_JOB_DASH_TITLE,
  INDEED_JOB_MINIMAL,
  INDEED_JOB_SIGN_IN_TITLE,
  INDEED_JOB_SIGN_IN_WORDS,
  INDEED_JOB_SPLIT_VIEW,
  INDEED_JOB_UPPERCASE_KEY,
  INDEED_JOB_URL,
  INDEED_JOB_WALL_WORDS,
  INDEED_REFUSED,
  indeedText,
} from './fixtures/capture/indeedPages';

const EXPECTED_JOB = {
  kind: 'job',
  jobId: INDEED_JK,
  jobUrl: INDEED_JOB_URL,
  title: 'Senior Example Engineer',
  company: 'Example Corp',
  descriptionMd: INDEED_DESCRIPTION,
};

describe('recognizeIndeedPage', () => {
  it('reads a posting with every optional line: job key, canonical URL, title, company, description', () => {
    expect(recognizeIndeedPage(INDEED_JOB)).toEqual(EXPECTED_JOB);
  });

  it('reads a posting with no optional lines the same way', () => {
    expect(recognizeIndeedPage(INDEED_JOB_MINIMAL)).toEqual(EXPECTED_JOB);
  });

  it('reads the split view the same way: the tab title is never used', () => {
    expect(recognizeIndeedPage(INDEED_JOB_SPLIT_VIEW)).toEqual(EXPECTED_JOB);
  });

  it('keeps a title that contains " - " whole', () => {
    expect(recognizeIndeedPage(INDEED_JOB_DASH_TITLE)).toMatchObject({
      kind: 'job',
      title: 'Senior Example Engineer - Platform',
      company: 'Example Corp',
    });
  });

  it('takes the company exactly as line 2 reads, and never the rating line', () => {
    const page = {
      ...INDEED_JOB,
      text: indeedText({
        title: 'Senior Example Engineer',
        company: 'Example Corp (part of Example Holdings)',
        meta: ['4.1'],
      }),
    };
    expect(recognizeIndeedPage(page)).toMatchObject({
      company: 'Example Corp (part of Example Holdings)',
    });
  });

  it('lowercases the job key, and stores the www URL the alert parser stores', () => {
    expect(recognizeIndeedPage(INDEED_JOB_UPPERCASE_KEY)).toMatchObject({
      kind: 'job',
      jobId: INDEED_JK,
      jobUrl: INDEED_JOB_URL,
    });
  });

  it('keeps the meta lines and the job details block out of the description', () => {
    const page = recognizeIndeedPage(INDEED_JOB);
    expect(page.kind).toBe('job');
    const description = (page as { descriptionMd: string }).descriptionMd;
    expect(description).not.toMatch(/Job details|\$100,000|Example City|4\.1/);
  });

  it('reads a job whose title and description use wall words as a job', () => {
    // "Security Check Analyst": the tab title starts with "Security Check" and the description
    // quotes verification phrases. A title, a company and a description make it a job.
    expect(recognizeIndeedPage(INDEED_JOB_WALL_WORDS)).toMatchObject({
      kind: 'job',
      title: 'Security Check Analyst',
      company: 'Example Corp',
    });
  });

  it('reads a "Sign In Coordinator" job as a job', () => {
    expect(recognizeIndeedPage(INDEED_JOB_SIGN_IN_TITLE)).toMatchObject({
      kind: 'job',
      title: 'Sign In Coordinator',
    });
  });

  it("reads a job whose description uses the sign-in prompt's words as a job", () => {
    expect(recognizeIndeedPage(INDEED_JOB_SIGN_IN_WORDS)).toMatchObject({
      kind: 'job',
      title: 'Senior Example Engineer',
    });
  });

  it('names a wall only from the page text: a wall tab title on a job is ignored', () => {
    expect(recognizeIndeedPage({ ...INDEED_JOB, title: 'Just a moment...' })).toEqual(EXPECTED_JOB);
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
