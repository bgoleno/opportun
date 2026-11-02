// Indeed capture shape check (https://github.com/bgoleno/opportun/issues/73, part A2 of the
// design note on https://github.com/bgoleno/opportun/issues/72). The extension posts the Indeed
// job the user is looking at as { url, title, text }. This module decides, deterministically and
// before any AI or database work, whether that is one job posting, and refuses everything else
// (search results, company pages, the sign-in and verification interstitials, half-rendered
// pages): a refusal is better than a wrong opportunity.
//
// It reads the Indeed capture text contract
// (https://github.com/bgoleno/opportun/issues/73#issuecomment-6568000179). The extension composes
// that text from named parts of the job, the same for the split view and /viewjob:
//   1 title, 2 company, 3 meta lines (optional), 4 "Job details" block (optional),
//   5 the literal line "Full job description", 6 the description lines, and nothing after.
// The URL is always the canonical `https://www.indeed.com/viewjob?jk=<jk>`.
//
// So: line 1 is the title and line 2 the company, exactly as sent (nothing is stripped, the
// rating is its own line); everything after "Full job description" is the description. The tab
// title is never read, for the job or for anything else: in the split view it names the search,
// and on /viewjob it starts with the job title, which can contain " - " or words like "Security
// Check". When an anchor is missing the page is refused with a reason, never guessed at.
//
// Location and pay are not read (a follow-up could read the location from the meta lines), and
// an Indeed capture gets no AI refine until there is a site-neutral prompt.
//
// Jobs only. Profile capture stays LinkedIn.
//
// C-1: the URL is provenance metadata only. Nothing here or downstream ever fetches it.
//
// Pure functions only (no IO), exported for tests.
import { siteOfUrl } from './captureSites';
import { linesOf, MAX_DESCRIPTION, type Recognition } from './linkedinCapture';

const MAX_JOB_FIELD = 300;

/** The contract's line 5, where the posting's own description starts. */
const DESCRIPTION_START = 'full job description';

/**
 * Phrases of the sign-in and verification interstitials Indeed can serve in place of a job. They
 * only name a refusal for text that is not a job already: a posting that quotes one of them is
 * still a posting.
 */
const WALL_TEXT = [
  'additional verification required',
  'verify you are human',
  'create an account or sign in',
];

/** The job key of a canonical single-posting URL, or null. */
function jobKeyOf(raw: string): string | null {
  const site = siteOfUrl(raw);
  if (site === null || site.id !== 'indeed') return null;
  const url = new URL(raw);
  if (url.username !== '' || url.password !== '') return null;
  return site.jobIdFromUrl(url);
}

function looksLikeWall(lines: string[]): boolean {
  const text = lines.join('\n').toLowerCase();
  return WALL_TEXT.some((marker) => text.includes(marker));
}

/** The contract's shape, or the reason the text does not have it. */
function readJob(
  lines: string[],
):
  | { ok: true; title: string; company: string; descriptionMd: string }
  | { ok: false; reason: 'no_title_company' | 'no_description' } {
  const start = lines.findIndex((l) => l.toLowerCase() === DESCRIPTION_START);
  const header = start === -1 ? lines : lines.slice(0, start);
  const [title, company] = header;
  if (
    title === undefined ||
    company === undefined ||
    title.length > MAX_JOB_FIELD ||
    company.length > MAX_JOB_FIELD
  ) {
    return { ok: false, reason: 'no_title_company' };
  }
  if (start === -1) return { ok: false, reason: 'no_description' };
  const descriptionMd = lines
    .slice(start + 1)
    .join('\n')
    .slice(0, MAX_DESCRIPTION)
    .trim();
  if (descriptionMd === '') return { ok: false, reason: 'no_description' };
  return { ok: true, title, company, descriptionMd };
}

/** Decides what a captured Indeed tab is. Never throws; never touches the network. */
export function recognizeIndeedPage(input: {
  url: string;
  title: string;
  text: string;
}): Recognition {
  const jk = jobKeyOf(input.url);
  if (jk === null) return { kind: 'unrecognized', reason: 'unsupported_path' };
  const lines = linesOf(input.text);
  const job = readJob(lines);
  if (!job.ok) {
    return {
      kind: 'unrecognized',
      reason: looksLikeWall(lines) ? 'verification_wall' : job.reason,
    };
  }
  return {
    kind: 'job',
    jobId: jk,
    // The alert parser stores this exact form, so a capture and an alert lead share a URL.
    jobUrl: `https://www.indeed.com/viewjob?jk=${jk}`,
    title: job.title,
    company: job.company,
    descriptionMd: job.descriptionMd,
  };
}
