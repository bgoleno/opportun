// The sites the browser extension can capture from, and the identity of a posting on one
// (design D18, D20). Pure functions, no IO.
//
// Why identity rather than the dedupe key: `dedupeKey(company, title, location)` carries a
// location, and a capture only has a location when the optional `capture.linkedin` refine step
// ran. With no AI key, an exhausted budget or a provider error, a capture of the same req as a
// pending alert-email lead keys differently and the two never meet, which is exactly the bug
// (#17) this exists to prevent. `<site>:<jobId>` is exact and needs no model.
//
// Adding a site is adding an entry here plus a recognizer (lib/captureRecognizers.ts). The
// extension's own LinkedIn-specific gates (manifest host permissions, the popup's URL check)
// are a separate piece of work, deliberately not in this seam.
import type { NormalizedPosting } from '@opportun/core';
import { INDEED_JOB_KEY } from './alertParsers/indeed';

export interface CaptureSite {
  /** Stable, lowercase, and the prefix stored in a posting's externalId. */
  id: string;
  /** How the site is named to the user, e.g. in the merge heading. */
  label: string;
  matchesHost(host: string): boolean;
  /** The site's own job id for a posting URL on it, or null. */
  jobIdFromUrl(url: URL): string | null;
  /** True when a bare id has the shape of this site's job ids. */
  isJobId(id: string): boolean;
}

/** The LinkedIn apex, its www host, or a two-letter country subdomain (uk., de.). */
const LINKEDIN_HOST = /^(?:www\.|[a-z][a-z]\.)?linkedin\.com$/;
/** `/jobs/view/<id>` with an optional trailing slash; ids are digits. */
const LINKEDIN_JOB_PATH = /^\/jobs\/view\/(\d{1,20})\/?$/;
const LINKEDIN_JOB_ID = /^\d{1,20}$/;

/**
 * indeed.com and its www host only. Country sites (uk.indeed.com, indeed.co.uk) are out of scope
 * for https://github.com/bgoleno/opportun/issues/73 and stay unclaimed.
 */
const INDEED_HOST = /^(?:www\.)?indeed\.com$/;

/**
 * The job key of an Indeed single-posting URL, `/viewjob?jk=<jk>`. The key rule is the alert
 * parser's own constant, not a second regex: an alert lead stores the same `jk` bare, and the
 * two must agree on what a job key is for the identity match to hold.
 */
function indeedJobKey(url: URL): string | null {
  if (url.pathname !== '/viewjob') return null;
  const jk = url.searchParams.get('jk');
  return jk !== null && INDEED_JOB_KEY.test(jk) ? jk.toLowerCase() : null;
}

export const CAPTURE_SITES: readonly CaptureSite[] = [
  {
    id: 'linkedin',
    label: 'LinkedIn',
    matchesHost: (host) => LINKEDIN_HOST.test(host),
    jobIdFromUrl: (url) => LINKEDIN_JOB_PATH.exec(url.pathname)?.[1] ?? null,
    isJobId: (id) => LINKEDIN_JOB_ID.test(id),
  },
  {
    id: 'indeed',
    label: 'Indeed',
    matchesHost: (host) => INDEED_HOST.test(host),
    jobIdFromUrl: indeedJobKey,
    isJobId: (id) => INDEED_JOB_KEY.test(id),
  },
];

const byId = new Map(CAPTURE_SITES.map((s) => [s.id, s]));

/**
 * The site whose label is `label`, or null. The inverse of siteLabel for a known site: a capture
 * activity names its site only by label ("Captured from Indeed"), so this is how a stored
 * capture is traced back to the site that read it (https://github.com/bgoleno/opportun/issues/93).
 */
export function siteOfLabel(label: string): CaptureSite | null {
  return CAPTURE_SITES.find((s) => s.label === label) ?? null;
}

/** The site's label, or the id itself when nothing claims it. */
export function siteLabel(siteId: string): string {
  return byId.get(siteId.toLowerCase())?.label ?? siteId;
}

/** The site serving `href`, or null. Https only: a capture is always of an https page. */
export function siteOfUrl(href: string): CaptureSite | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return CAPTURE_SITES.find((s) => s.matchesHost(host)) ?? null;
}

/** `<site>:<id>` for a posting captured from a known site, or null. */
export function postingIdentity(posting: NormalizedPosting): string | null {
  const externalId = posting.externalId?.trim() ?? '';
  const at = externalId.indexOf(':');
  if (at > 0) {
    const site = byId.get(externalId.slice(0, at).toLowerCase());
    const id = externalId.slice(at + 1).trim();
    // A prefix no site claims is some other source's opaque id, not an identity.
    return site !== undefined && id !== '' ? `${site.id}:${id.toLowerCase()}` : null;
  }
  const site = posting.postingUrl == null ? null : siteOfUrl(posting.postingUrl);
  if (site === null) return null;
  // The URL's own job id wins over a bare externalId: a source other than the site's alert
  // parser (a user-mapped MCP connector, say) can store its own opaque id beside a site URL, and
  // reading that as the site's id would make it contradict a capture of the very same posting
  // (https://github.com/bgoleno/opportun/issues/73).
  const fromUrl = site.jobIdFromUrl(new URL(posting.postingUrl as string));
  if (fromUrl !== null) return `${site.id}:${fromUrl.toLowerCase()}`;
  // Otherwise a bare externalId is the site's own id only when it has that id's shape.
  return externalId !== '' && site.isJobId(externalId)
    ? `${site.id}:${externalId.toLowerCase()}`
    : null;
}
