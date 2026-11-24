// What the sites with a public, slug-addressed board API share
// (https://github.com/bgoleno/opportun/issues/769): building a URL from a slug, asking whether a
// board is live, and reading a listing's links.
import { ATS_SLUG, type BoardRef, type SiteIdentity } from '@opportun/core';
import { arr, ATS_MAX_BYTES, obj } from '../adapters/sources/atsCommon';
import type { SourceContext } from '../adapters/discoverySource';

/** A slug or id of a shape the site uses, or a throw: it cannot move a URL's host or path. */
export function segment(value: string, shape: RegExp, what: string): string {
  if (!shape.test(value)) throw new Error(`not a ${what}`);
  return encodeURIComponent(value);
}

/** A board's slug as a URL segment, or a throw. */
export const slugOf = (board: BoardRef, label: string): string =>
  segment(board.slug, ATS_SLUG, `${label} board slug`);

/**
 * Asks one board API request, moved unchanged from lib/atsDetect.ts's `probe`, except that the
 * fetch may reach the site's own exact hosts only (sec on #769). `serving` reads the 200 body:
 * true when it is that provider's board answer AND it is serving a posting.
 */
export async function askBoard(
  sctx: Pick<SourceContext, 'fetch' | 'log'>,
  site: SiteIdentity,
  board: BoardRef,
  url: (board: BoardRef) => string,
  serving: (body: unknown) => boolean,
): Promise<'yes' | 'no' | 'unknown'> {
  // A slug no board has is no board, not a failed request that detection would retry.
  if (!ATS_SLUG.test(board.slug)) return 'no';
  let res;
  try {
    res = await sctx.fetch(url(board), { allowHosts: site.fetchHosts, maxBytes: ATS_MAX_BYTES });
  } catch (err) {
    // The slug names the company's board: only the ATS kind is logged (14.8).
    sctx.log.warn({ 'opportun.ats.kind': site.sourceKind, err }, 'ats probe failed');
    return 'unknown';
  }
  if (res.status === 429 || res.status >= 500) return 'unknown';
  if (res.status < 200 || res.status >= 300) return 'no';
  try {
    return serving(JSON.parse(res.body.toString('utf8'))) ? 'yes' : 'no';
  } catch {
    return 'no';
  }
}

/** True for a body with a non-empty `jobs` list. */
export const servesJobs = (body: unknown): boolean => arr(obj(body).jobs).length > 0;

/**
 * The items that carry both a title and a link, as links. An item that is not an object throws,
 * which the caller (jobs/opportunityEnrich.ts) reads as no links, as it always has.
 */
export function linksOf(
  items: unknown,
  read: (job: Record<string, unknown>) => { text: unknown; url: unknown },
): { url: string; text: string }[] {
  return arr(items).flatMap((item) => {
    const { text, url } = read(item as Record<string, unknown>);
    return typeof text === 'string' && typeof url === 'string' ? [{ url, text }] : [];
  });
}
