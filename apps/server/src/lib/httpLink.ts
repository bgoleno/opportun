/** `url` when it is an http or https address, as it reads, else null: what may be shown as a link. */
export function httpLink(url: string | null | undefined): string | null {
  if (url == null) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
