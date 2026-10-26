// Workday board adapter (FR-D10). A Workday career site is addressed by tenant plus site on the
// tenant's own host, `<tenant>.<dc>.myworkdayjobs.com`, whose datacenter label (`wd1`, `wd5`,
// `wd12`) is learned from a URL and never derived. The candidate-experience (CXS) endpoints
// behind each company's careers site are public and unauthenticated, the same class as the
// other ATS adapters (C-2). Only the board's own host is ever allowed; values are passed on raw
// and the engine sanitizes every posting (the description HTML included) like any source's.
//
// The CXS contract, probed live on 2026-10-17 against tenant globexnetworks, site
// globexexternalcareers (after the weekly service window ended):
//
//   POST https://<tenant>.<dc>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
//     content-type: application/json, accept: application/json
//     body {"appliedFacets":{},"limit":N,"offset":N,"searchText":""}
//     -> 200 {total, jobPostings: [{title, externalPath, timeType, locationsText, postedOn,
//             bulletFields: ["<reqId>"]}]}
//     Paged by offset/limit at the site's own default of 20 (some tenants reportedly refuse a
//     larger limit, which would fail discovery while detection's limit-1 probe still passed).
//     `total` is read from the first page (Workday reports it there; later pages may say 0).
//     A 2000-posting board is therefore 100 listing requests.
//
//   GET https://<tenant>.<dc>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/job/<externalPath
//       without its leading /job/>
//     accept: application/json
//     -> 200 {jobPostingInfo: {id, title, jobDescription (HTML, ~7k chars), location, country,
//             posted, startDate, jobReqId, externalUrl, ...}, hiringOrganization: {name}}
//
// The weekly service window (observed 2026-10-17 01:45 PT, Workday-wide) answers a 302 to
// `<dc>.myworkday.com/wday/drs/outage`, a 303 to `community.workday.com/maintenance-page`, 406
// on a bare host root, 422 with an empty message, or a 500 whose body is a JavaScript redirect
// to the maintenance page. Every one of those, and any 5xx, is WorkdayUnavailableError: an
// ordinary retryable failure, never a SourceConfigError, or a weekend run would mark a real
// board as misconfigured. A request carrying a body or headers never follows a redirect
// (safeFetch), so a redirect surfaces here as FetchBlockedError('redirect_blocked').
import type { NormalizedPosting } from '@opportun/core';
import { FetchBlockedError, type SafeFetchResponse } from '../../lib/safeFetch';
import {
  registerBuiltinSource,
  SourceConfigError,
  WorkdayConfig,
  type DiscoverySource,
  type SourceContext,
} from '../discoverySource';
import {
  arr,
  ATS_MAX_BYTES,
  ATS_TIMEOUT_MS,
  obj,
  remoteFromLocation,
  str,
  timeMs,
} from './atsCommon';

export type WorkdayBoard = WorkdayConfig;

export const WORKDAY_PAGE_SIZE = 20;
/** A runaway board (or a server ignoring offset) stops here: 2000 postings. */
const MAX_PAGES = 100;
const DETAIL_MAX_BYTES = 2 * 1024 * 1024;
const JSON_HEADERS = { accept: 'application/json' };
/**
 * One externalPath segment as Workday writes them (`Santa-Clara-CA`, `Title_JR-000001`). No `%`:
 * a URL parser reads `%2e%2e` as `..`, which would re-aim the detail GET elsewhere on the host.
 */
const PATH_SEGMENT = /^[A-Za-z0-9_.~-]{1,300}$/;

/**
 * The tenant's site is in its maintenance window (or otherwise briefly unavailable). Retryable:
 * the run fails, the runner retries later, and detection never reads it as "no board".
 */
export class WorkdayUnavailableError extends Error {
  override name = 'WorkdayUnavailableError';
}

/**
 * A redirect off a CXS request: the one signal that proves the service window (an unknown site
 * or posting can answer the window's other statuses too, the 500 JavaScript page included).
 */
export class WorkdayOutageError extends WorkdayUnavailableError {
  override name = 'WorkdayOutageError';
}

/**
 * Detail requests one run makes at most. A requisition this source already stored costs none
 * (SourceContext.knownExternalIds), so a daily rerun of an unchanged 2000-posting board is its
 * 100 listing requests and no detail; a first sync of a large board takes a few runs.
 */
export const WORKDAY_MAX_DETAILS_PER_RUN = 200;

/** Detail failures in a row (none a proven outage) after which the run stops as transient. */
export const WORKDAY_DETAIL_FAILURES_IN_A_ROW = 3;

/** The board from a source config; an invalid config cannot be fixed by retrying. */
export function workdayBoard(config: unknown): WorkdayBoard {
  const parsed = WorkdayConfig.safeParse(config);
  if (!parsed.success) {
    throw new SourceConfigError('invalid Workday config: needs the host, tenant and site');
  }
  return parsed.data;
}

const cxsBase = (b: WorkdayBoard): string => `https://${b.host}/wday/cxs/${b.tenant}/${b.site}`;

export const workdayJobsUrl = (b: WorkdayBoard): string => `${cxsBase(b)}/jobs`;

/** The detail URL for a listing's externalPath (`/job/<location>/<title>_<reqId>`), if usable. */
export function workdayDetailUrl(b: WorkdayBoard, externalPath: string): string | null {
  const segments = externalPath.split('/');
  if (segments[0] !== '' || segments[1] !== 'job') return null;
  const rest = segments.slice(2);
  if (rest.length === 0 || rest.some((s) => !PATH_SEGMENT.test(s) || s === '.' || s === '..')) {
    return null;
  }
  return `${cxsBase(b)}/job/${rest.join('/')}`;
}

/** The public posting page for an externalPath (`https://<host>/<site>/job/...`). */
const postingPageUrl = (b: WorkdayBoard, externalPath: string): string =>
  `https://${b.host}/${b.site}${externalPath}`;

const label = (b: WorkdayBoard): string => `Workday board ${b.tenant}/${b.site}`;

/**
 * The message of a retryable failure. It names both causes: the weekly service window, and a
 * tenant or site that does not exist (which can answer the same way), since the source shows
 * it for as long as the failure lasts.
 */
const unreachable = (b: WorkdayBoard, what: string): string =>
  `${label(b)} unreachable (service window or unknown tenant/site); check the careers URL if this persists (${what})`;

/** One CXS request; maintenance signals become WorkdayUnavailableError. */
async function cxs(
  sctx: Pick<SourceContext, 'fetch'>,
  b: WorkdayBoard,
  url: string,
  post: unknown,
): Promise<SafeFetchResponse> {
  try {
    return await sctx.fetch(url, {
      allowHosts: [b.host],
      maxBytes: post === undefined ? DETAIL_MAX_BYTES : ATS_MAX_BYTES,
      timeoutMs: ATS_TIMEOUT_MS,
      headers: JSON_HEADERS,
      ...(post === undefined
        ? {}
        : { post: { contentType: 'application/json', body: JSON.stringify(post) } }),
    });
  } catch (err) {
    if (err instanceof FetchBlockedError && err.reason === 'redirect_blocked') {
      throw new WorkdayOutageError(unreachable(b, 'redirected'));
    }
    throw err;
  }
}

/** True for the statuses Workday answers during its service window, and any 5xx. */
export function isWorkdayUnavailableStatus(status: number): boolean {
  return status === 406 || status === 422 || status === 429 || status >= 500;
}

function parseJson(b: WorkdayBoard, res: SafeFetchResponse): unknown {
  try {
    return JSON.parse(res.body.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${label(b)} returned invalid JSON`);
  }
}

function checkStatus(b: WorkdayBoard, res: SafeFetchResponse): void {
  if (isWorkdayUnavailableStatus(res.status)) {
    throw new WorkdayUnavailableError(unreachable(b, `HTTP ${res.status}`));
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${label(b)} answered HTTP ${res.status}`);
  }
}

/** One listing page. A 404 is a site Workday does not know: a SourceConfigError. */
export async function fetchWorkdayPage(
  sctx: Pick<SourceContext, 'fetch'>,
  b: WorkdayBoard,
  offset: number,
  limit: number = WORKDAY_PAGE_SIZE,
): Promise<{ total: number; jobPostings: unknown[] }> {
  const res = await cxs(sctx, b, workdayJobsUrl(b), {
    appliedFacets: {},
    limit,
    offset,
    searchText: '',
  });
  if (res.status === 404) throw new SourceConfigError(`Workday has no site ${b.tenant}/${b.site}`);
  checkStatus(b, res);
  const body = obj(parseJson(b, res));
  const total = typeof body.total === 'number' && Number.isInteger(body.total) ? body.total : 0;
  return { total, jobPostings: arr(body.jobPostings) };
}

/** One posting's detail body, or null when it is gone (404) or its path is unusable. */
export async function fetchWorkdayDetail(
  sctx: Pick<SourceContext, 'fetch'>,
  b: WorkdayBoard,
  externalPath: string,
): Promise<unknown> {
  const url = workdayDetailUrl(b, externalPath);
  if (url === null) return null;
  const res = await cxs(sctx, b, url, undefined);
  if (res.status === 404) return null;
  checkStatus(b, res);
  return parseJson(b, res);
}

/**
 * The requisition id of a listing row, read from its externalPath (`.../<title>_<reqId>`), the
 * same way a posting link is read (lib/atsJobRef), so a stored posting and a link agree.
 * bulletFields is tenant-configured (it may hold a location), so it is only the last resort.
 */
export function workdayReqId(row: Record<string, unknown>): string | null {
  const tail = str(row.externalPath)?.split('/').at(-1) ?? '';
  if (tail.includes('_')) {
    const id = tail.slice(tail.lastIndexOf('_') + 1);
    if (id !== '') return id;
  }
  return str(arr(row.bulletFields)[0]);
}

/** A listing row, filled from its detail body when there is one. */
export function mapWorkdayPosting(
  b: WorkdayBoard,
  listingRow: unknown,
  detail: unknown,
): NormalizedPosting {
  const row = obj(listingRow);
  const body = obj(detail);
  const info = obj(body.jobPostingInfo);
  const externalPath = str(row.externalPath);
  const location = str(info.location) ?? str(row.locationsText);
  const remoteType = str(info.remoteType);
  return {
    company: str(obj(body.hiringOrganization).name) ?? b.tenant,
    title: str(info.title) ?? str(row.title) ?? '',
    descriptionMd: str(info.jobDescription),
    postingUrl:
      str(info.externalUrl) ?? (externalPath === null ? null : postingPageUrl(b, externalPath)),
    location,
    remote:
      remoteType !== null && /\bremote\b/i.test(remoteType) ? true : remoteFromLocation(location),
    compNote: null,
    externalId: workdayReqId(row) ?? str(info.jobReqId),
    postedAt: timeMs(info.startDate),
  };
}

/**
 * The board's listing rows, paged until the first page's total is reached or a page comes back
 * short, each posting once by its externalPath (unique per posting; a row can shift between
 * pages while they are read).
 */
export async function* workdayListing(
  sctx: SourceContext,
  b: WorkdayBoard,
): AsyncGenerator<Record<string, unknown>> {
  for await (const rows of workdayListingPages(sctx, b)) yield* rows;
}

/** What a listing read saw: the first page's total, and whether a page limit cut it short. */
interface ListingState {
  total: number;
  truncated: boolean;
}

/**
 * At most `maxPages` listing pages of a board, for an interactive lookup (find-posting), with
 * the board's total and whether the limit cut the read short.
 */
export async function readWorkdayListing(
  sctx: SourceContext,
  b: WorkdayBoard,
  maxPages: number,
): Promise<{ rows: Record<string, unknown>[]; total: number; truncated: boolean }> {
  const state: ListingState = { total: 0, truncated: false };
  const rows: Record<string, unknown>[] = [];
  for await (const page of workdayListingPages(sctx, b, maxPages, state)) rows.push(...page);
  return { rows, ...state };
}

/** workdayListing, one page of (deduplicated) rows at a time. */
async function* workdayListingPages(
  sctx: SourceContext,
  b: WorkdayBoard,
  maxPages: number = MAX_PAGES,
  state: ListingState = { total: 0, truncated: false },
): AsyncGenerator<Record<string, unknown>[]> {
  const seen = new Set<string>();
  let total = 0;
  for (let index = 0; index < Math.min(maxPages, MAX_PAGES); index++) {
    const offset = index * WORKDAY_PAGE_SIZE;
    const pageRows = await fetchWorkdayPage(sctx, b, offset);
    if (index === 0) {
      total = pageRows.total;
      state.total = total;
    }
    const rows: Record<string, unknown>[] = [];
    for (const raw of pageRows.jobPostings) {
      const row = obj(raw);
      const key = str(row.externalPath) ?? workdayReqId(row);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      rows.push(row);
    }
    yield rows;
    if (pageRows.jobPostings.length < WORKDAY_PAGE_SIZE) return;
    if (offset + WORKDAY_PAGE_SIZE >= total) return;
  }
  // The page limit stopped a read the board's total says is not finished.
  state.truncated = true;
}

export const workdaySource: DiscoverySource = {
  kind: 'ats_workday',
  async *fetchPostings(sctx, config) {
    const b = workdayBoard(config);
    let failuresInARow = 0;
    let details = 0;
    let deferred = 0;
    for await (const rows of workdayListingPages(sctx, b)) {
      const ids = rows.map(workdayReqId).filter((id): id is string => id !== null);
      const known = (await sctx.knownExternalIds?.(ids)) ?? new Set<string>();
      for (const row of rows) {
        const path = str(row.externalPath);
        const id = workdayReqId(row);
        let detail: unknown = null;
        if (id !== null && known.has(id)) {
          // Stored by an earlier run: yielded bare so the engine counts it a duplicate, and no
          // detail is fetched for it.
          yield { posting: mapWorkdayPosting(b, row, null), nextCursor: null };
          continue;
        }
        if (path !== null && details >= WORKDAY_MAX_DETAILS_PER_RUN) {
          // Over the cap: left out entirely (not stored bare), so a later run still describes it.
          deferred += 1;
          continue;
        }
        if (path !== null) {
          details += 1;
          try {
            detail = await fetchWorkdayDetail(sctx, b, path);
            failuresInARow = 0;
          } catch (err) {
            // A proven outage ends the run (it retries). Any other failure costs this posting its
            // description only: it is yielded bare (a needs_capture lead) and the run goes on,
            // unless details keep failing, which is the board being unreachable after all.
            if (err instanceof WorkdayOutageError) throw err;
            failuresInARow += 1;
            sctx.log.warn({ board: label(b), externalPath: path, err }, 'workday detail failed');
            if (failuresInARow >= WORKDAY_DETAIL_FAILURES_IN_A_ROW) {
              throw new WorkdayUnavailableError(
                unreachable(b, `${failuresInARow} posting details failed in a row`),
              );
            }
          }
        }
        yield { posting: mapWorkdayPosting(b, row, detail), nextCursor: null };
      }
    }
    if (deferred > 0) {
      sctx.log.info(
        { board: label(b), described: details, deferred },
        'workday detail cap reached; the rest are described on later runs',
      );
    }
  },
};

registerBuiltinSource(workdaySource);
