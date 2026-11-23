// What ATS sites share (https://github.com/bgoleno/opportun/issues/769): a board slug, a job id as
// a board link carries it, and the `{ org }` config of a board source.
import { z } from 'zod';
import type { HostRule, SiteUrl } from './types';

/** A board slug, as the board's public API names it. */
export const ATS_SLUG = /^[a-z0-9-]{1,100}$/;

/** A job id as a board link carries it, by any provider. */
export const ATS_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The source config of a Greenhouse, Lever or Ashby board. */
export const AtsOrgConfig = z.object({ org: z.string().regex(ATS_SLUG) }).strict();

/** A link's path segments, empty ones dropped. */
export function segmentsOf(url: SiteUrl): string[] {
  return url.pathname.split('/').filter((s) => s.length > 0);
}

/**
 * Whether a link is on one of `rules`' hosts, its host compared as the link writes it (lowercased,
 * a trailing dot kept): how links were read before #769. safeFetch's matching, which also drops
 * trailing dots, is `hostMatchesRule`.
 */
export function linkOnHost(url: SiteUrl, rules: readonly HostRule[]): boolean {
  const host = url.hostname.toLowerCase();
  return rules.some((r) => ('exact' in r ? host === r.exact : r.pattern.test(host)));
}
