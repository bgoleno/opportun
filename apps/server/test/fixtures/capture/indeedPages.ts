// Synthetic Indeed page captures (https://github.com/bgoleno/opportun/issues/73), what the
// extension posts as `{ url, title, text }`.
//
// Public repository fixture rule: everything here is invented. Placeholder company and title,
// lorem-style description, obviously fake hex job keys, no site header or account text, no
// tracking parameters. Nothing here or in its tests fetches indeed.com.
//
// `text` is in the shape of the Indeed capture text contract
// (https://github.com/bgoleno/opportun/issues/73#issuecomment-6568000179), which the extension
// composes from named parts of the job, the same for the split view and /viewjob:
//   1 title, 2 company, 3 meta lines (optional), 4 "Job details" block (optional),
//   5 "Full job description", 6 description lines.
import type { CapturedPage } from './pages';

export const INDEED_JK = '0000000000000a01';
export const INDEED_JOB_URL = `https://www.indeed.com/viewjob?jk=${INDEED_JK}`;

export const INDEED_DESCRIPTION = [
  'About Us',
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Example Corp builds example widgets.',
  'Day to Day',
  'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua: own the example platform.',
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.',
].join('\n');

/** Composes a page text in the contract's order. */
export function indeedText(parts: {
  title: string;
  company: string;
  meta?: string[];
  summary?: string[];
  description?: string;
}): string {
  return [
    parts.title,
    parts.company,
    ...(parts.meta ?? []),
    ...(parts.summary ?? []),
    'Full job description',
    parts.description ?? INDEED_DESCRIPTION,
  ].join('\n');
}

const META = ['4.1', 'Example City, EX', 'Remote'];
const SUMMARY = ['Job details', '$100,000 - $120,000 a year', 'Monday to Friday', 'Full-time'];

/** A single posting with every optional line: meta lines and the job details block. */
export const INDEED_JOB: CapturedPage = {
  url: INDEED_JOB_URL,
  title: 'Senior Example Engineer - Example City, EX - Indeed.com',
  text: indeedText({
    title: 'Senior Example Engineer',
    company: 'Example Corp',
    meta: META,
    summary: SUMMARY,
  }),
};

/** The same posting with no optional lines at all. */
export const INDEED_JOB_MINIMAL: CapturedPage = {
  ...INDEED_JOB,
  text: indeedText({ title: 'Senior Example Engineer', company: 'Example Corp' }),
};

/**
 * The same job captured from the split view: the extension sends the same composed text and the
 * same canonical URL, and the tab title names the search, not the job.
 */
export const INDEED_JOB_SPLIT_VIEW: CapturedPage = {
  ...INDEED_JOB,
  title: 'Example Engineer Jobs in Example City, EX | Indeed',
};

/** A title that itself contains " - ", as job titles can. */
export const INDEED_JOB_DASH_TITLE: CapturedPage = {
  ...INDEED_JOB,
  title: 'Senior Example Engineer - Platform - Example City, EX - Indeed.com',
  text: indeedText({
    title: 'Senior Example Engineer - Platform',
    company: 'Example Corp',
    meta: META,
  }),
};

/**
 * A real job whose words look like a wall: the tab title starts with "Security Check" and the
 * description quotes a verification phrase. A title, a company and a description make it a job.
 */
export const INDEED_JOB_WALL_WORDS: CapturedPage = {
  ...INDEED_JOB,
  title: 'Security Check Analyst - Remote - Indeed.com',
  text: indeedText({
    title: 'Security Check Analyst',
    company: 'Example Corp',
    meta: ['Remote'],
    description: [
      'Lorem ipsum dolor sit amet.',
      'Review pages that say "Additional Verification Required" and "Verify you are human".',
    ].join('\n'),
  }),
};

/** A "Sign In Coordinator" job: its /viewjob tab title starts with "Sign In". */
export const INDEED_JOB_SIGN_IN_TITLE: CapturedPage = {
  ...INDEED_JOB,
  title: 'Sign In Coordinator - Remote - Indeed.com',
  text: indeedText({ title: 'Sign In Coordinator', company: 'Example Corp', meta: ['Remote'] }),
};

/** A job whose description says how to apply in the sign-in prompt's own words. */
export const INDEED_JOB_SIGN_IN_WORDS: CapturedPage = {
  ...INDEED_JOB,
  text: indeedText({
    title: 'Senior Example Engineer',
    company: 'Example Corp',
    description: `${INDEED_DESCRIPTION}\nCreate an account or sign in to apply on our portal.`,
  }),
};

/** An uppercase job key in the URL; the identity and the stored URL are lowercase. */
export const INDEED_JOB_UPPERCASE_KEY: CapturedPage = {
  ...INDEED_JOB,
  url: `https://indeed.com/viewjob?jk=${INDEED_JK.toUpperCase()}`,
};

/** Search results with no job selected: a list, not a posting. */
export const INDEED_SEARCH_RESULTS: CapturedPage = {
  url: 'https://www.indeed.com/jobs?q=example+engineer&l=Remote',
  title: 'Example Engineer Jobs | Indeed',
  text: [
    'Senior Example Engineer',
    'Example Corp',
    'Remote',
    'Staff Example Engineer',
    'Sample Industries',
    'Remote',
  ].join('\n'),
};

/** A company page. */
export const INDEED_COMPANY_PAGE: CapturedPage = {
  url: 'https://www.indeed.com/cmp/Example-Corp',
  title: 'Example Corp Careers and Employment | Indeed',
  text: ['Example Corp', '4.1', 'Snapshot', 'Why join us', 'Reviews', 'Jobs'].join('\n'),
};

/**
 * A verification interstitial in place of the job. The tab title is the job's own, so a test of
 * this fixture pins the text rule alone: the tab title is never read.
 */
export const INDEED_VERIFICATION: CapturedPage = {
  url: INDEED_JOB_URL,
  title: INDEED_JOB.title,
  text: [
    'Additional Verification Required',
    'Verify you are human by completing the action below.',
  ].join('\n'),
};

/** A sign-in prompt in place of the job; the tab title is the job's own, as above. */
export const INDEED_SIGN_IN: CapturedPage = {
  url: INDEED_JOB_URL,
  title: INDEED_JOB.title,
  text: ['Ready to take the next step?', 'Create an account or sign in.', 'Email address'].join(
    '\n',
  ),
};

/** No "Full job description" line: the description has not rendered. */
export const INDEED_JOB_NOT_LOADED: CapturedPage = {
  ...INDEED_JOB,
  text: ['Senior Example Engineer', 'Example Corp', ...META, ...SUMMARY].join('\n'),
};

/** The heading with nothing after it. */
export const INDEED_JOB_EMPTY_DESCRIPTION: CapturedPage = {
  ...INDEED_JOB,
  text: ['Senior Example Engineer', 'Example Corp', 'Full job description'].join('\n'),
};

/** Nothing above the description. */
export const INDEED_JOB_NO_HEADER: CapturedPage = {
  ...INDEED_JOB,
  text: `Full job description\n${INDEED_DESCRIPTION}`,
};

/** A title but no company line before the description. */
export const INDEED_JOB_NO_COMPANY: CapturedPage = {
  ...INDEED_JOB,
  text: `Senior Example Engineer\nFull job description\n${INDEED_DESCRIPTION}`,
};

/** A /viewjob URL whose job key is not one. */
export const INDEED_BAD_JOB_KEY: CapturedPage = {
  ...INDEED_JOB,
  url: 'https://www.indeed.com/viewjob?jk=not-a-job-key',
};

/** A country site, out of scope for now: unclaimed. */
export const INDEED_COUNTRY_SITE: CapturedPage = {
  ...INDEED_JOB,
  url: `https://uk.indeed.com/viewjob?jk=${INDEED_JK}`,
};

/** Every Indeed page the capture refuses, with the reason it gives. */
export const INDEED_REFUSED: Record<string, { page: CapturedPage; reason: string }> = {
  SEARCH_RESULTS: { page: INDEED_SEARCH_RESULTS, reason: 'unsupported_path' },
  COMPANY_PAGE: { page: INDEED_COMPANY_PAGE, reason: 'unsupported_path' },
  BAD_JOB_KEY: { page: INDEED_BAD_JOB_KEY, reason: 'unsupported_path' },
  VERIFICATION: { page: INDEED_VERIFICATION, reason: 'verification_wall' },
  SIGN_IN: { page: INDEED_SIGN_IN, reason: 'verification_wall' },
  JOB_NOT_LOADED: { page: INDEED_JOB_NOT_LOADED, reason: 'no_description' },
  JOB_EMPTY_DESCRIPTION: { page: INDEED_JOB_EMPTY_DESCRIPTION, reason: 'no_description' },
  JOB_NO_HEADER: { page: INDEED_JOB_NO_HEADER, reason: 'no_title_company' },
  JOB_NO_COMPANY: { page: INDEED_JOB_NO_COMPANY, reason: 'no_title_company' },
  COUNTRY_SITE: { page: INDEED_COUNTRY_SITE, reason: 'unsupported_site' },
};
