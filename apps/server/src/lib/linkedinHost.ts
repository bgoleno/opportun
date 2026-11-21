// Whether a link is on LinkedIn (#655, sec): a contact's LinkedIn link names a LinkedIn profile,
// so wherever one is stored (the contact form, a pack import, LinkedIn's own export) only
// LinkedIn's own domain and its subdomains are taken. The link is metadata, never fetched (C-1).
//
// The domain comes from safeFetch's PROHIBITED_HOSTS, the one place in the server that names it
// (test/safeFetch.test.ts holds that line), less LinkedIn's short-link host, which redirects to
// any site and so names no profile.
import { isProhibitedHost } from './safeFetch';

const SHORT_LINK_HOST = 'lnkd.in';

/** True for an http(s) URL on LinkedIn's domain or a subdomain of it, not its short links. */
export function isLinkedInHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === SHORT_LINK_HOST || host.endsWith(`.${SHORT_LINK_HOST}`)) return false;
  return isProhibitedHost(host);
}
