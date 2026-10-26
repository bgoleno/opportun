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

/** True for an https URL on a LinkedIn host: the only tabs the popup offers to capture. */
export function isLinkedInUrl(href: string): boolean {
  const url = parse(href);
  return (
    url !== null && url.protocol === 'https:' && LINKEDIN_HOST.test(url.hostname.toLowerCase())
  );
}

/**
 * The URL to send for a tab. The jobs search split view (/jobs/search/?currentJobId=<id>, and
 * the /jobs/search-results/ and /jobs/collections/ lists) is a list of cards around one
 * detail pane; the server refuses that URL, so it is rewritten to the canonical job view
 * /jobs/view/<id>/ of the posting the pane shows. The text sent is still the visible tab's text. Everything else is unchanged,
 * except that a URL over the server's cap loses its query and fragment.
 */
export function canonicalCaptureUrl(href: string): string {
  const url = parse(href);
  if (url === null) return href;
  if (LINKEDIN_HOST.test(url.hostname.toLowerCase()) && JOBS_LIST_PATH.test(url.pathname)) {
    const id = url.searchParams.get('currentJobId');
    if (id !== null && JOB_ID.test(id)) return `${url.origin}/jobs/view/${id}/`;
  }
  if (href.length > MAX_URL) return `${url.origin}${url.pathname}`.slice(0, MAX_URL);
  return href;
}
