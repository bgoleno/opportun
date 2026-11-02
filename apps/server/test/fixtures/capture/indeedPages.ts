// Synthetic Indeed page captures (https://github.com/bgoleno/opportun/issues/73), what the
// extension posts as `{ url, title, text }`.
//
// Public repository fixture rule: everything here is invented. Placeholder company and title,
// lorem-style description, obviously fake hex job keys, no site header or account text, no
// tracking parameters. The line layout follows the visible lines of the job panes in the
// screenshots on https://github.com/bgoleno/opportun/issues/72; it was not taken from a live
// page, and nothing here or in its tests fetches indeed.com.
//
// `text` starts at the job's own header (title, then company): the extension sends the job
// container, never the site header, the search box or the results list.
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

/** The job header and details, as the screenshots lay them out. */
const HEADER = [
  'Senior Example Engineer',
  'Example Corp · 4.1',
  'Remote',
  '$100,000 - $120,000 a year -  Full-time',
  'Apply now',
  'Job details',
  '$100,000 - $120,000 a year',
  'Paid time off, Health insurance, 401(k)',
  'Show 3 more',
  'Full-time',
  'Remote',
].join('\n');

/** A single posting, `/viewjob?jk=<jk>`. */
export const INDEED_JOB: CapturedPage = {
  url: INDEED_JOB_URL,
  title: 'Senior Example Engineer - Remote - Indeed.com',
  text: `${HEADER}\nFull job description\n${INDEED_DESCRIPTION}`,
};

/**
 * The same job read from the split view: the extension canonicalizes `vjk=` to the /viewjob
 * URL and sends the job pane. The tab title there names the search, not the job, so the
 * recognizer never reads it.
 */
export const INDEED_JOB_SPLIT_VIEW: CapturedPage = {
  ...INDEED_JOB,
  title: 'Job Search | Indeed',
};

/** A company line carrying a parent-company note, as the first screenshot shows one. */
export const INDEED_JOB_PARENT_COMPANY: CapturedPage = {
  ...INDEED_JOB,
  text: INDEED_JOB.text.replace(
    'Example Corp · 4.1',
    'Example Corp (part of Example Holdings, Co., Ltd.) · 4.1',
  ),
};

/** An uppercase job key in the URL; the identity and the stored URL are lowercase. */
export const INDEED_JOB_UPPERCASE_KEY: CapturedPage = {
  ...INDEED_JOB,
  url: `https://indeed.com/viewjob?jk=${INDEED_JK.toUpperCase()}`,
};

/** Search results with no job selected: a list, not a posting. */
export const INDEED_SEARCH_RESULTS: CapturedPage = {
  url: 'https://www.indeed.com/jobs?q=example+engineer&l=Remote',
  title: 'Example Engineer Jobs, Employment | Indeed',
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

/** The additional-verification interstitial, served on the job's own URL. */
export const INDEED_VERIFICATION: CapturedPage = {
  url: INDEED_JOB_URL,
  title: 'Just a moment...',
  text: [
    'Additional Verification Required',
    'Verify you are human by completing the action below.',
  ].join('\n'),
};

/** A sign-in prompt in place of the job. */
export const INDEED_SIGN_IN: CapturedPage = {
  url: INDEED_JOB_URL,
  title: 'Sign In | Indeed Accounts',
  text: ['Ready to take the next step?', 'Create an account or sign in.', 'Email address'].join(
    '\n',
  ),
};

/** A job page whose description has not rendered. */
export const INDEED_JOB_NOT_LOADED: CapturedPage = {
  ...INDEED_JOB,
  text: HEADER,
};

/** A job page with no header above the description. */
export const INDEED_JOB_NO_HEADER: CapturedPage = {
  ...INDEED_JOB,
  text: `Full job description\n${INDEED_DESCRIPTION}`,
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
  JOB_NO_HEADER: { page: INDEED_JOB_NO_HEADER, reason: 'no_title_company' },
  COUNTRY_SITE: { page: INDEED_COUNTRY_SITE, reason: 'unsupported_site' },
};
