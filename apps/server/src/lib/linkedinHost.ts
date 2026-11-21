// Whether a link is on LinkedIn (#655, sec): a contact's LinkedIn link names a LinkedIn profile,
// so wherever one is stored (the contact form, a pack import, LinkedIn's own export) only
// linkedin.com and its subdomains are taken. The link is metadata, never fetched (C-1).

/** True for an http(s) URL whose host is linkedin.com or a subdomain of it. */
export function isLinkedInHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}
