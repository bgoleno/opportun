// URL handling for captured tabs. Pure functions, unit-tested. The capture sites (their hosts, job
// ids and job links) are packages/core's, the same ones the server reads
// (https://github.com/bgoleno/opportun/issues/769), through the subpath that has no dependencies.
import {
  CAPTURE_SITES,
  indeed,
  linkedin,
  linkOnHost,
  type CaptureSiteId,
} from '@opportun/core/captureSites';

export type { CaptureSiteId };

/** The server's URL cap for a capture (apps/server/src/routes/common.ts HttpsUrl). */
export const MAX_URL = 2048;

/** Jobs list views that show one posting in a detail pane, named by ?currentJobId=. */
const JOBS_LIST_PATH = /^\/jobs\/(?:search|search-results|collections)(?:\/|$)/;

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
  return url !== null && url.protocol === 'https:' && linkOnHost(url, linkedin.pageHosts);
}

/**
 * Which capture site an https tab URL is on, or null for every other tab: the popup never reads
 * a tab this returns null for. Decided from the URL alone, never from page content. The host is
 * compared as the URL writes it: one with a trailing dot is no capture site's.
 */
export function captureSiteOf(href: string): CaptureSiteId | null {
  const url = parse(href);
  if (url === null || url.protocol !== 'https:') return null;
  return CAPTURE_SITES.find((s) => linkOnHost(url, s.pageHosts))?.id ?? null;
}

/** The host to open a capture site's job on, by the site's own domain. */
const READ_AT: readonly (readonly [domain: string, host: string])[] = [
  ['linkedin.com', 'www.linkedin.com'],
  ['indeed.com', 'www.indeed.com'],
];

/**
 * For a tab on another address of a capture site (its mobile or a country's pages, whose layout no
 * reader knows), the host its jobs are read on, or null for every other tab
 * (https://github.com/bgoleno/opportun/issues/967).
 */
export function readableHostFor(href: string): string | null {
  const url = parse(href);
  if (url === null || captureSiteOf(href) !== null) return null;
  const host = url.hostname.toLowerCase();
  const site = READ_AT.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
  return site === undefined ? null : site[1];
}

/**
 * The job key of an Indeed tab showing one posting, lowercased: `jk` on `/viewjob`, `vjk` on the
 * `/jobs` split view and on the home page `/` (the job open in the right pane, #156). Null for
 * anything else, including a key of the wrong shape: then nothing is sent. The home page with no
 * `vjk` is refused although it shows a job as it loads: nothing in its URL says which one.
 */
export function indeedJobKey(href: string): string | null {
  const url = parse(href);
  if (url === null || captureSiteOf(href) !== indeed.id) return null;
  const key =
    url.pathname === '/viewjob'
      ? url.searchParams.get('jk')
      : url.pathname === '/jobs' || url.pathname === '/'
        ? url.searchParams.get('vjk')
        : null;
  return key !== null && indeed.isJobId(key) ? key.toLowerCase() : null;
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
  if (jk !== null) return indeed.jobPageUrl({ site: indeed.id, board: null, id: jk });
  if (linkOnHost(url, linkedin.pageHosts) && JOBS_LIST_PATH.test(url.pathname)) {
    const id = url.searchParams.get('currentJobId');
    // The tab's own host is kept (uk. stays uk.), so this is not linkedin.jobPageUrl.
    if (id !== null && linkedin.isJobId(id)) return `${url.origin}/jobs/view/${id}/`;
  }
  if (href.length > MAX_URL) return `${url.origin}${url.pathname}`.slice(0, MAX_URL);
  return href;
}
