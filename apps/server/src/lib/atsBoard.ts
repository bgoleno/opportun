// What an ATS board link names (https://github.com/bgoleno/opportun/issues/763): the board kinds,
// a board's slug, and reading a board from a URL or a source config. Pure, so repos and lib use
// it without importing the detection job (jobs/atsDetect.ts), which imports the repos back.
import {
  ATS_SOURCE_KINDS,
  WORKDAY_HOST,
  WORKDAY_SITE,
  WorkdayConfig,
} from '../adapters/discoverySource';
import { ASHBY_HOST } from '../adapters/sources/ashby';
import { GREENHOUSE_HOST } from '../adapters/sources/greenhouse';

export const SLUG = /^[a-z0-9-]{1,100}$/;

export type AtsKind = 'ats_greenhouse' | 'ats_lever' | 'ats_ashby' | 'ats_workday';

/**
 * A board a link points at. `slug` is the board key: the org slug, or for Workday
 * `<tenant>/<site>`, whose `host` (carrying the datacenter label) is kept beside it.
 */
export interface AtsBoard {
  kind: AtsKind;
  slug: string;
  host?: string;
}

/** The source config of a board: `{org}`, or Workday's `{host, tenant, site}`. */
export function boardConfig(board: AtsBoard): Record<string, unknown> {
  if (board.kind === 'ats_workday') {
    const cut = board.slug.indexOf('/');
    return { host: board.host, tenant: board.slug.slice(0, cut), site: board.slug.slice(cut + 1) };
  }
  return { org: board.slug };
}

/** The board a source config names; null when it names none (an invalid or foreign config). */
export function boardOfSource(kind: string, config: Record<string, unknown>): AtsBoard | null {
  if (kind === 'ats_workday') {
    const parsed = WorkdayConfig.safeParse(config);
    if (!parsed.success) return null;
    const { host, tenant, site } = parsed.data;
    return { kind, slug: `${tenant}/${site}`, host };
  }
  if (!isAtsKind(kind) || typeof config.org !== 'string' || !SLUG.test(config.org)) return null;
  return { kind, slug: config.org };
}

/** A Workday path may start with a locale (`/en-US/<site>/...`). */
const WORKDAY_LOCALE = /^[a-z]{2}-[A-Z]{2}$/;
/** myworkdaysite.com's host: the datacenter alone, no tenant (issue #20). */
const WORKDAY_SITE_HOST = /^wd([0-9]{1,3})\.myworkdaysite\.com$/;

export function isAtsKind(kind: string | null): kind is AtsKind {
  return kind !== null && (ATS_SOURCE_KINDS as readonly string[]).includes(kind);
}

/**
 * A Workday career site link: `https://<tenant>.<dc>.myworkdayjobs.com[/<locale>]/<site>/...`,
 * or the CXS API form `/wday/cxs/<tenant>/<site>/...`. A bare host root names no site.
 */
function workdayBoardFromPath(host: string, segments: string[]): AtsBoard | null {
  const tenant = WORKDAY_HOST.exec(host)?.[1];
  if (tenant === undefined) return null;
  let site: string | undefined;
  if (segments[0] === 'wday') {
    site = segments[1] === 'cxs' && segments[2] === tenant ? segments[3] : undefined;
  } else {
    site = WORKDAY_LOCALE.test(segments[0] ?? '') ? segments[1] : segments[0];
  }
  if (site === undefined || !WORKDAY_SITE.test(site)) return null;
  return { kind: 'ats_workday', slug: `${tenant}/${site}`, host };
}

/**
 * myworkdaysite.com's alternate address for the same career site (issue #20): the datacenter in
 * the host and the tenant in the path, the reverse of myworkdayjobs.com's own
 * `<tenant>.<dc>.myworkdayjobs.com` — observed shape `wd<N>.myworkdaysite.com/recruiting/
 * <tenant>/<site>/...`, inferred from third-party Workday-integration documentation rather than
 * Workday's own, since Workday publishes no public URL-format reference.
 *
 * Recognition only: the result is normalized to the canonical myworkdayjobs.com host and
 * validated against the exact same WORKDAY_HOST pattern a config must already satisfy
 * (WorkdayConfig, discoverySource.ts), so this does not widen what a stored source config may
 * point at — it teaches boardFromUrl a second way to arrive at a host it already trusted.
 */
function workdayBoardFromSiteDomain(host: string, segments: string[]): AtsBoard | null {
  const dc = WORKDAY_SITE_HOST.exec(host)?.[1];
  if (dc === undefined || segments[0] !== 'recruiting') return null;
  const tenant = (segments[1] ?? '').toLowerCase();
  const canonicalHost = `${tenant}.wd${dc}.myworkdayjobs.com`;
  if (!WORKDAY_HOST.test(canonicalHost)) return null;
  const site = segments[2];
  if (site === undefined || !WORKDAY_SITE.test(site)) return null;
  return { kind: 'ats_workday', slug: `${tenant}/${site}`, host: canonicalHost };
}

/** The ATS board a link points at, if any. */
export function boardFromUrl(raw: string): AtsBoard | null {
  let url: URL;
  try {
    url = new URL(raw.replace(/&amp;/g, '&'), 'https://invalid.invalid/');
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (host.endsWith('.myworkdayjobs.com')) return workdayBoardFromPath(host, segments);
  if (host.endsWith('.myworkdaysite.com')) return workdayBoardFromSiteDomain(host, segments);
  let found: { kind: AtsKind; slug: string | undefined } | null = null;
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    found = {
      kind: 'ats_greenhouse',
      slug: segments[0] === 'embed' ? (url.searchParams.get('for') ?? undefined) : segments[0],
    };
  } else if (host === GREENHOUSE_HOST && segments[0] === 'v1' && segments[1] === 'boards') {
    found = { kind: 'ats_greenhouse', slug: segments[2] };
  } else if (host === 'jobs.lever.co') {
    found = { kind: 'ats_lever', slug: segments[0] };
  } else if (host === 'jobs.ashbyhq.com') {
    found = { kind: 'ats_ashby', slug: segments[0] };
  } else if (host === ASHBY_HOST && segments[0] === 'posting-api' && segments[1] === 'job-board') {
    found = { kind: 'ats_ashby', slug: segments[2] };
  }
  const slug = found?.slug?.toLowerCase();
  if (found === null || slug === undefined || !SLUG.test(slug)) return null;
  return { kind: found.kind, slug };
}
