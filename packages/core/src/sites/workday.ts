// Workday (https://github.com/bgoleno/opportun/issues/769): the identity half of its site module
// (FR-D10). Its network half is apps/server/src/sites/workday.ts. The rules below are moved
// unchanged from apps/server/src/adapters/discoverySource.ts, lib/atsBoard.ts and lib/atsJobRef.ts.
//
// A career site is addressed by tenant plus site on the tenant's own host, whose datacenter label
// (`wd1`, `wd5`, `wd12`) cannot be derived, so a board is only ever learned from a link that carries
// it. A board is therefore `<tenant>/<site>` with its host beside it, and a job its path as well.
import { z } from 'zod';
import { ATS_JOB_ID } from './ats';
import {
  segmentsOf,
  type BoardRef,
  type HostRule,
  type JobRef,
  type SiteIdentity,
  type SiteUrl,
} from './types';

/** A career site's host: `<tenant>.<datacenter>.myworkdayjobs.com`. */
export const WORKDAY_HOST = /^([a-z0-9][a-z0-9-]{0,62})\.wd[0-9]{1,3}\.myworkdayjobs\.com$/;
/** A site id as it appears in the path (`Initech_Careers`, `globexexternalcareers`). */
export const WORKDAY_SITE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** A Workday board: the tenant's host (with its datacenter), the tenant and the site. */
export const WorkdayConfig = z
  .object({
    host: z.string().regex(WORKDAY_HOST),
    tenant: z.string(),
    site: z.string().regex(WORKDAY_SITE),
  })
  .strict()
  .refine((c) => WORKDAY_HOST.exec(c.host)?.[1] === c.tenant, {
    message: 'tenant must be the first label of the host',
  });
export type WorkdayConfig = z.infer<typeof WorkdayConfig>;

/** A Workday path may start with a locale (`/en-US/<site>/...`). */
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;
/** myworkdaysite.com's host: the datacenter alone, no tenant (issue #20). */
const SITE_DOMAIN_HOST = /^wd([0-9]{1,3})\.myworkdaysite\.com$/;

/**
 * What the module may reach: a tenant's own host. Declared, and held to by the contract test, but no
 * allow-list is built from it: a request allows the one host of the config it is made for (tl and sec,
 * https://github.com/bgoleno/opportun/issues/769#issuecomment-7122518060).
 */
const TENANTS: readonly HostRule[] = [
  { pattern: WORKDAY_HOST, example: 'acme.wd5.myworkdayjobs.com' },
];
/** Hosts a link is read from: the tenant's, and the second domain of the same career sites. */
const PAGES: readonly HostRule[] = [
  ...TENANTS,
  { pattern: SITE_DOMAIN_HOST, example: 'wd5.myworkdaysite.com' },
];

/**
 * A career site link: `https://<tenant>.<dc>.myworkdayjobs.com[/<locale>]/<site>/...`, or the CXS
 * API form `/wday/cxs/<tenant>/<site>/...`. A bare host root names no site.
 */
function boardOnTenantHost(host: string, segments: string[]): BoardRef | null {
  const tenant = WORKDAY_HOST.exec(host)?.[1];
  if (tenant === undefined) return null;
  let site: string | undefined;
  if (segments[0] === 'wday') {
    site = segments[1] === 'cxs' && segments[2] === tenant ? segments[3] : undefined;
  } else {
    site = LOCALE.test(segments[0] ?? '') ? segments[1] : segments[0];
  }
  if (site === undefined || !WORKDAY_SITE.test(site)) return null;
  return { site: 'workday', slug: `${tenant}/${site}`, host };
}

/**
 * myworkdaysite.com's alternate address for the same career site (issue #20): the datacenter in
 * the host and the tenant in the path, the reverse of myworkdayjobs.com's own
 * `<tenant>.<dc>.myworkdayjobs.com`; observed shape `wd<N>.myworkdaysite.com/recruiting/
 * <tenant>/<site>/...`, inferred from third-party Workday-integration documentation rather than
 * Workday's own, since Workday publishes no public URL-format reference.
 *
 * Recognition only: the result is normalized to the canonical myworkdayjobs.com host and validated
 * against the exact same pattern a config must already satisfy, so this does not widen what a stored
 * source config may point at: it is a second way to arrive at a host already trusted.
 */
function boardOnSiteDomain(host: string, segments: string[]): BoardRef | null {
  const dc = SITE_DOMAIN_HOST.exec(host)?.[1];
  if (dc === undefined || segments[0] !== 'recruiting') return null;
  const tenant = (segments[1] ?? '').toLowerCase();
  const canonicalHost = `${tenant}.wd${dc}.myworkdayjobs.com`;
  if (!WORKDAY_HOST.test(canonicalHost)) return null;
  const site = segments[2];
  if (site === undefined || !WORKDAY_SITE.test(site)) return null;
  return { site: 'workday', slug: `${tenant}/${site}`, host: canonicalHost };
}

function boardFromUrl(url: SiteUrl): BoardRef | null {
  const host = url.hostname.toLowerCase();
  const segments = segmentsOf(url);
  return boardOnTenantHost(host, segments) ?? boardOnSiteDomain(host, segments);
}

/**
 * The posting part of a Workday link: the segments after `/job/` or `/details/` up to and
 * including the `<title>_<reqId>` one (a location segment may precede it; `/apply` and the like
 * may follow). Workday's public career site uses either marker depending on tenant/version
 * (issue #20); the CXS detail endpoint's own path is `/job/...` regardless, which is why the
 * returned path always starts with `/job/` even when the link read `/details/`.
 */
export function workdayPosting(url: SiteUrl): { externalPath: string; reqId: string } | null {
  const seg = segmentsOf(url);
  const marker = seg.includes('job') ? 'job' : 'details';
  const at = seg.indexOf(marker);
  if (at < 1) return null;
  const after = seg.slice(at + 1);
  // `<location>/<title>_<reqId>` when the second segment carries a requisition, else `<title>_<reqId>`.
  const take = after[1]?.includes('_') === true ? 2 : after[0]?.includes('_') === true ? 1 : 0;
  if (take === 0) return null;
  const slug = after[take - 1] as string;
  const reqId = slug.slice(slug.lastIndexOf('_') + 1);
  if (!ATS_JOB_ID.test(reqId)) return null;
  return { externalPath: `/job/${after.slice(0, take).join('/')}`, reqId };
}

/** The config of a board ref, or a throw: one whose host's first label is not its tenant is none. */
function configOf(board: BoardRef): WorkdayConfig {
  const cut = board.slug.indexOf('/');
  return WorkdayConfig.parse({
    host: board.host,
    tenant: board.slug.slice(0, cut),
    site: board.slug.slice(cut + 1),
  });
}

/**
 * One segment of a posting's path as Workday writes them (`Santa-Clara-CA`, `Title_JR-000001`). No
 * `%`: a URL parser reads `%2e%2e` as `..`, which would re-aim a request elsewhere on the host.
 */
const PATH_SEGMENT = /^[A-Za-z0-9_.~-]{1,300}$/;

/** The segments of `/job/<...>`, or null when one could move a URL's path. */
export function workdayPathSegments(externalPath: string): string[] | null {
  const segments = externalPath.split('/');
  if (segments[0] !== '' || segments[1] !== 'job') return null;
  const rest = segments.slice(2);
  if (rest.length === 0 || rest.some((s) => !PATH_SEGMENT.test(s) || s === '.' || s === '..')) {
    return null;
  }
  return rest;
}

export const workday: SiteIdentity = {
  id: 'workday',
  label: 'Workday',
  category: 'ats',
  sourceKind: 'ats_workday',
  fetchHosts: TENANTS,
  pageHosts: PAGES,
  jobFromUrl(url) {
    const board = boardFromUrl(url);
    const posting = workdayPosting(url);
    if (board === null || posting === null) return null;
    return {
      site: 'workday',
      board: board.slug,
      id: posting.reqId,
      host: board.host!,
      path: posting.externalPath,
    };
  },
  isJobId: (id) => ATS_JOB_ID.test(id),
  jobPageUrl(ref: JobRef) {
    if (ref.board === null) throw new Error('a Workday job page needs its board');
    const { host, site } = configOf({ site: 'workday', slug: ref.board, host: ref.host });
    const segments = ref.path === undefined ? null : workdayPathSegments(ref.path);
    if (segments === null) throw new Error('not a Workday posting path');
    if (!ATS_JOB_ID.test(ref.id) || !segments.at(-1)!.endsWith(`_${ref.id}`)) {
      throw new Error('not the requisition of a Workday posting path');
    }
    return `https://${host}/${site}/job/${segments.join('/')}`;
  },
  board: {
    fromUrl: boardFromUrl,
    configSchema: WorkdayConfig,
    configOf,
    fromConfig(config) {
      const parsed = WorkdayConfig.safeParse(config);
      if (!parsed.success) return null;
      const { host, tenant, site } = parsed.data;
      return { site: 'workday', slug: `${tenant}/${site}`, host };
    },
    pageUrl(board) {
      const { host, site } = configOf(board);
      return `https://${host}/${site}`;
    },
  },
  routes: {
    api: {
      supplies: ['boardListing', 'description'],
      terms: {
        url: 'https://github.com/bgoleno/opportun/issues/113#issuecomment-6572986539',
        checked:
          "the site terms as quoted on #113 (the link above); whether they reach a company's myworkdayjobs.com pages was not checked; in use before the registry, and kept by the owner's decision 10 (docs/assisted-apply/README.md, 2026-11-02) and by #769's",
        decision: 'allowed',
        issue: 'https://github.com/bgoleno/opportun/issues/769',
      },
    },
  },
  samples: {
    jobUrls: [
      'https://initech.wd5.myworkdayjobs.com/Initech_Careers/job/Austin-TX/Staff-Engineer_JR-000001',
      'https://initech.wd5.myworkdayjobs.com/en-US/Initech_Careers/details/Staff-Engineer_JR-000001/apply',
      'https://wd5.myworkdaysite.com/recruiting/initech/Initech_Careers/job/Austin-TX/Staff-Engineer_JR-000001',
    ],
    boardUrls: [
      'https://initech.wd5.myworkdayjobs.com/Initech_Careers',
      'https://initech.wd5.myworkdayjobs.com/en-US/Initech_Careers',
      'https://initech.wd5.myworkdayjobs.com/wday/cxs/initech/Initech_Careers/jobs',
      'https://wd5.myworkdaysite.com/recruiting/initech/Initech_Careers',
    ],
  },
};
