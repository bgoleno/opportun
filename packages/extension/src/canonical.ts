// URL handling for captured tabs. Pure functions, unit-tested.

/** The server's URL cap for a capture (apps/server/src/routes/common.ts HttpsUrl). */
export const MAX_URL = 2048;

/** The LinkedIn apex host, its www host, or a two-letter country subdomain (uk., de.). */
const LINKEDIN_HOST = /^(?:www\.|[a-z][a-z]\.)?linkedin\.com$/;

/** Jobs list views that show one posting in a detail pane, named by ?currentJobId=. */
const JOBS_LIST_PATH = /^\/jobs\/(?:search|search-results|collections)(?:\/|$)/;
const JOB_ID = /^\d{1,20}$/;

function parse(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/** True for an https URL on a LinkedIn host. */
export function isLinkedInUrl(href: string): boolean {
  const url = parse(href);
  return (
    url !== null && url.protocol === 'https:' && LINKEDIN_HOST.test(url.hostname.toLowerCase())
  );
}

/**
 * indeed.com and its www host only, as the server's capture site registry claims them. Indeed's
 * country sites (uk.indeed.com, indeed.co.uk) are out of scope
 * (https://github.com/bgoleno/opportun/issues/74) and stay unread.
 */
const INDEED_HOST = /^(?:www\.)?indeed\.com$/;

/**
 * An Indeed job key. The same rule as the server's `INDEED_JOB_KEY` (the alert parser's): the
 * extension cannot import server code, so it keeps this copy, and a test (indeed.test.ts) pins
 * the two equal.
 */
export const INDEED_JOB_KEY = /^[0-9a-f]{8,32}$/i;

/** The sites the popup may read, and the only tabs it reads at all. */
export type CaptureSiteId = 'linkedin' | 'indeed';

/**
 * Which capture site an https tab URL is on, or null for every other tab: the popup never reads
 * a tab this returns null for. Decided from the URL alone, never from page content.
 */
export function captureSiteOf(href: string): CaptureSiteId | null {
  const url = parse(href);
  if (url === null || url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (LINKEDIN_HOST.test(host)) return 'linkedin';
  if (INDEED_HOST.test(host)) return 'indeed';
  return null;
}

/**
 * The job key of an Indeed tab showing one posting, lowercased: `jk` on `/viewjob`, `vjk` on the
 * `/jobs` split view (the job open in the pane). Null for anything else, including a key of the
 * wrong shape: then nothing is sent.
 */
export function indeedJobKey(href: string): string | null {
  const url = parse(href);
  if (url === null || captureSiteOf(href) !== 'indeed') return null;
  const key =
    url.pathname === '/viewjob'
      ? url.searchParams.get('jk')
      : url.pathname === '/jobs'
        ? url.searchParams.get('vjk')
        : null;
  return key !== null && INDEED_JOB_KEY.test(key) ? key.toLowerCase() : null;
}

/**
 * The URL to send for a tab. The jobs search split view (/jobs/search/?currentJobId=<id>, and
 * the /jobs/search-results/ and /jobs/collections/ lists) is a list of cards around one
 * detail pane; the server refuses that URL, so it is rewritten to the canonical job view
 * /jobs/view/<id>/ of the posting the pane shows. The text sent is still the visible tab's text. Everything else is unchanged,
 * except that a URL over the server's cap loses its query and fragment.
 *
 * An Indeed job, on `/viewjob` or in the `/jobs` split view, is always sent as
 * `https://www.indeed.com/viewjob?jk=<jk>` (the capture text contract,
 * https://github.com/bgoleno/opportun/issues/73#issuecomment-6568000179).
 */
export function canonicalCaptureUrl(href: string): string {
  const url = parse(href);
  if (url === null) return href;
  const jk = indeedJobKey(href);
  if (jk !== null) return `https://www.indeed.com/viewjob?jk=${jk}`;
  if (LINKEDIN_HOST.test(url.hostname.toLowerCase()) && JOBS_LIST_PATH.test(url.pathname)) {
    const id = url.searchParams.get('currentJobId');
    if (id !== null && JOB_ID.test(id)) return `${url.origin}/jobs/view/${id}/`;
  }
  if (href.length > MAX_URL) return `${url.origin}${url.pathname}`.slice(0, MAX_URL);
  return href;
}
