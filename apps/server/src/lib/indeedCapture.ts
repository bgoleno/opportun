// Indeed capture shape check (https://github.com/bgoleno/opportun/issues/73, part A2 of the
// design note on https://github.com/bgoleno/opportun/issues/72). The extension posts the Indeed
// job the user is looking at as { url, title, text }. This module decides, deterministically and
// before any AI or database work, whether that is one job posting, and refuses everything else
// (search results, company pages, the sign-in and verification interstitials, half-rendered
// pages): a refusal is better than a wrong opportunity.
//
// What it relies on, and why:
// - The URL is `/viewjob?jk=<jk>`. The extension canonicalizes the split view's `vjk=` to that
//   form, so the server sees one shape for both layouts.
// - `text` is the job container, starting at the job's own header: the title line, then the
//   company line. The extension never sends the site header or the results list.
// - "Full job description" starts the description.
// - The tab title is never read: in the split view it names the search, not the job.
// When an anchor is missing the page is refused with a reason, never guessed at. Location and
// pay are not read: no line in the fixtures states them in a way that is stable enough, and an
// Indeed capture gets no AI refine until there is a site-neutral prompt.
//
// Jobs only. Profile capture stays LinkedIn.
//
// C-1: the URL is provenance metadata only. Nothing here or downstream ever fetches it.
//
// Pure functions only (no IO), exported for tests.
import { siteOfUrl } from './captureSites';
import { linesOf, MAX_DESCRIPTION, type Recognition } from './linkedinCapture';

const MAX_JOB_FIELD = 300;

/** Where the posting's own description starts. */
const DESCRIPTION_START = 'full job description';

/**
 * The sign-in and verification interstitials Indeed serves in place of a page. They are short,
 * so only the top of the text is searched: a description that happens to quote one of these
 * phrases further down is not a wall.
 */
const WALL_TITLE = /^(?:just a moment|sign in|security check)\b/i;
const WALL_TEXT = [
  'additional verification required',
  'verify you are human',
  'create an account or sign in',
];
const WALL_SCAN_LINES = 40;

/** The job key of a canonical single-posting URL, or null. */
function jobKeyOf(raw: string): string | null {
  const site = siteOfUrl(raw);
  if (site === null || site.id !== 'indeed') return null;
  const url = new URL(raw);
  if (url.username !== '' || url.password !== '') return null;
  return site.jobIdFromUrl(url);
}

export function isVerificationWall(title: string, lines: string[]): boolean {
  if (WALL_TITLE.test(title.trim())) return true;
  const top = lines.slice(0, WALL_SCAN_LINES).join('\n').toLowerCase();
  return WALL_TEXT.some((marker) => top.includes(marker));
}

/**
 * The company line without what Indeed appends to it: a rating (" · 4.1") and a parent-company
 * note (" (part of Example Holdings, Co., Ltd.)").
 */
function companyOf(line: string): string {
  return line
    .replace(/\s*·\s*\d(?:\.\d)?\s*$/, '')
    .replace(/\s*\(part of [^)]*\)\s*$/i, '')
    .trim();
}

/** Decides what a captured Indeed tab is. Never throws; never touches the network. */
export function recognizeIndeedPage(input: {
  url: string;
  title: string;
  text: string;
}): Recognition {
  const lines = linesOf(input.text);
  if (isVerificationWall(input.title, lines)) {
    return { kind: 'unrecognized', reason: 'verification_wall' };
  }
  const jk = jobKeyOf(input.url);
  if (jk === null) return { kind: 'unrecognized', reason: 'unsupported_path' };

  const start = lines.findIndex((l) => l.toLowerCase() === DESCRIPTION_START);
  const header = start === -1 ? lines : lines.slice(0, start);
  const [title, companyLine] = header;
  const company = companyLine === undefined ? '' : companyOf(companyLine);
  if (
    title === undefined ||
    company === '' ||
    title.length > MAX_JOB_FIELD ||
    company.length > MAX_JOB_FIELD
  ) {
    return { kind: 'unrecognized', reason: 'no_title_company' };
  }
  if (start === -1) return { kind: 'unrecognized', reason: 'no_description' };
  const descriptionMd = lines
    .slice(start + 1)
    .join('\n')
    .slice(0, MAX_DESCRIPTION)
    .trim();
  if (descriptionMd === '') return { kind: 'unrecognized', reason: 'no_description' };

  return {
    kind: 'job',
    jobId: jk,
    // The alert parser stores this exact form, so a capture and an alert lead share a URL.
    jobUrl: `https://www.indeed.com/viewjob?jk=${jk}`,
    title,
    company,
    descriptionMd,
  };
}
