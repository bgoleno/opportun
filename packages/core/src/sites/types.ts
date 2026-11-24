// The job-site contract's identity half (https://github.com/bgoleno/opportun/issues/769): what a
// site is and how its links read, pure, so the server, the web and the extension can all import
// it. The network half (fetching postings, checking a job) is the server's, in
// apps/server/src/sites. An ATS board (Greenhouse, Lever) and an aggregator (LinkedIn, Indeed) are
// both sites; each declares the routes it is reached by and what each supplies.
import type { z } from 'zod';

/**
 * The parts of a WHATWG URL a site reads. Core is built without the DOM or Node types, so the
 * shape is declared here; a `URL` from either satisfies it.
 */
export interface SiteUrl {
  readonly protocol: string;
  readonly hostname: string;
  readonly pathname: string;
  readonly searchParams: {
    get(name: string): string | null;
    getAll(name: string): string[];
  };
}

/**
 * A host a site names. `{ exact }` is that host and nothing else, not its subdomains. `{ pattern }`
 * is matched against the whole host, so it must be anchored, and its `example` is a host it
 * matches (the contract test checks look-alikes of it). Keep each pattern one simple host shape:
 * core is linted by security/detect-unsafe-regex.
 */
export type HostRule =
  { readonly exact: string } | { readonly pattern: RegExp; readonly example: string };

/**
 * Lowercased, trimmed, with every trailing dot removed, in one pass over the host.
 */
function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase();
  let end = h.length;
  while (end > 0 && h.charCodeAt(end - 1) === 46 /* . */) end -= 1;
  return h.slice(0, end);
}

/** Whether `host` is the host `rule` names, both sides lowercased with trailing dots removed. */
export function hostMatchesRule(host: string, rule: HostRule): boolean {
  const h = normalizeHost(host);
  if (h.length === 0) return false;
  return 'exact' in rule ? h === normalizeHost(rule.exact) : rule.pattern.test(h);
}

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

/** How a site is reached. */
export type RouteName = 'api' | 'mcp' | 'capture' | 'alertEmail';

/** What a route can bring in. */
export type RouteSupply = 'search' | 'boardListing' | 'byId' | 'description';

/**
 * The site's terms on automated access, as read, and the owner's decision on them. An automated
 * route (api, mcp) whose decision is not 'allowed' is never registered, and the contract test
 * fails if one is. Brian decides, on the issue named; tl and sec do not.
 */
export interface RouteTerms {
  readonly url: string;
  /** When, and on what basis, the terms were last checked. */
  readonly checked: string;
  readonly decision: 'allowed' | 'pending' | 'refused';
  /** The issue that records the decision, as a full URL. */
  readonly issue: string;
}

export interface RouteDecl {
  readonly supplies: readonly RouteSupply[];
  /** Automated routes (api, mcp) only. */
  readonly terms?: RouteTerms;
}

/** A job on a site: its id, and the board (company) it is on when the link names one. */
export interface JobRef {
  readonly site: string;
  readonly board: string | null;
  readonly id: string;
}

/** An ATS board: one company's listing on the site. */
export interface BoardRef {
  readonly site: string;
  readonly slug: string;
}

export interface SiteIdentity {
  /** 'greenhouse', 'linkedin': unique, and the externalId prefix. */
  readonly id: string;
  readonly label: string;
  readonly category: 'ats' | 'aggregator';
  /** An ATS site's discovery source kind, which is also its posting identity kind. */
  readonly sourceKind?: string;
  /**
   * Hosts the server fetches from, by a registered automated route. The ATS allow-list and the
   * outbound telemetry targets are built from these only (sec on #769).
   */
  readonly fetchHosts: readonly HostRule[];
  /** Hosts a link or a page can name: read and captured, never fetched by the server. */
  readonly pageHosts: readonly HostRule[];
  /** The job a link to the site names, or null. */
  jobFromUrl(url: SiteUrl): JobRef | null;
  /** A job of this site named by a link on another host (Greenhouse's gh_jid), or null. */
  embeddedJobFromUrl?(url: SiteUrl): JobRef | null;
  isJobId(id: string): boolean;
  /** The job's public page. */
  jobPageUrl(ref: JobRef): string;
  /** ATS only: the board a link names, its source config and its public page. */
  readonly board?: {
    fromUrl(url: SiteUrl): BoardRef | null;
    readonly configSchema: z.ZodType<Record<string, unknown>>;
    pageUrl(board: BoardRef): string;
  };
  /** The routes the site is reached by. A route absent here does not exist for the site. */
  readonly routes: Partial<Record<RouteName, RouteDecl>>;
  /** Links the contract test reads: jobs, and (ATS) boards. */
  readonly samples: { readonly jobUrls: readonly string[]; readonly boardUrls: readonly string[] };
}
