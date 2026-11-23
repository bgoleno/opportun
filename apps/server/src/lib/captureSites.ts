// The sites the browser extension can capture from, and the identity of a posting on one
// (design D18, D20). Pure functions, no IO.
//
// Why identity rather than the dedupe key: `dedupeKey(company, title, location)` carries a
// location, and a capture only has a location when the optional `capture.linkedin` refine step
// ran. With no AI key, an exhausted budget or a provider error, a capture of the same req as a
// pending alert-email lead keys differently and the two never meet, which is exactly the bug
// (#17) this exists to prevent. `<site>:<jobId>` is exact and needs no model.
//
// The sites are packages/core's CAPTURE_SITES (https://github.com/bgoleno/opportun/issues/769), which
// the extension reads too; a site's recognizer is in its server module (apps/server/src/sites).
import {
  CAPTURE_SITES,
  linkOnHost,
  type NormalizedPosting,
  type SiteIdentity,
} from '@opportun/core';

const byId = new Map<string, SiteIdentity>(CAPTURE_SITES.map((s) => [s.id, s]));

/**
 * The site whose label is `label`, or null. The inverse of siteLabel for a known site: a capture
 * activity names its site only by label ("Captured from Indeed"), so this is how a stored
 * capture is traced back to the site that read it (https://github.com/bgoleno/opportun/issues/93).
 * Case and surrounding whitespace are ignored, so a hand-edited "indeed " still finds Indeed
 * (https://github.com/bgoleno/opportun/issues/96).
 */
export function siteOfLabel(label: string): SiteIdentity | null {
  const wanted = label.trim().toLowerCase();
  if (wanted === '') return null;
  return CAPTURE_SITES.find((s) => s.label.toLowerCase() === wanted) ?? null;
}

/** The site's label, or the id itself when nothing claims it. */
export function siteLabel(siteId: string): string {
  return byId.get(siteId.toLowerCase())?.label ?? siteId;
}

/**
 * The site serving `href`, or null. Https only: a capture is always of an https page. One trailing
 * dot on the host is dropped, and no more; then the host is compared as written.
 */
export function siteOfUrl(href: string): SiteIdentity | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const { protocol, pathname, searchParams } = url;
  const hostname = url.hostname.replace(/\.$/, '');
  const asWritten = { protocol, hostname, pathname, searchParams };
  return CAPTURE_SITES.find((s) => linkOnHost(asWritten, s.pageHosts)) ?? null;
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
  const fromUrl = site.jobFromUrl(new URL(posting.postingUrl as string));
  if (fromUrl !== null) return `${site.id}:${fromUrl.id.toLowerCase()}`;
  // Otherwise a bare externalId is the site's own id only when it has that id's shape.
  return externalId !== '' && site.isJobId(externalId)
    ? `${site.id}:${externalId.toLowerCase()}`
    : null;
}
