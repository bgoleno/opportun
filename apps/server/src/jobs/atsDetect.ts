// ATS board detection (FR-D9). For one company: probe the public board APIs of the supported
// ATS providers (Greenhouse, Lever, Ashby) for likely org slugs derived from its name and
// domain; failing that, read the company's own careers page (safeFetch allowPublic: https only,
// prohibited hosts refused, private addresses blocked on every hop) and look for links to those
// boards. The first verified hit is written to the company (ats_kind, ats_ref, ats_verified_at)
// and becomes a discovery source.
//
// Workday (FR-D10) is addressed by tenant plus site on a host whose datacenter label cannot be
// guessed, so it is never probed from a name: a Workday board is learned only from a URL (the
// careers URL itself, or a Workday link on the careers page). Its weekly service window answers
// with redirects, 406, 422 and 5xx; every one of those is transient (AtsDetectTransientError),
// never a recorded 'none', or a Friday-night probe would mark the company boardless. Nothing found: ats_kind 'none', and the company asks the user
// for a careers URL when it has none (needsCareersUrl in the company API).
//
// Re-verification: a weekly instance job queues detection again for every followed company whose
// verification is older than 30 days (or that was never checked), which catches ATS migrations.
//
// Polling follows the company's status (FR-D5): a board source is enabled only while its company
// is followed, on the user's default cron (discovery_default_cron:<userId>, default 0 7 * * *).
// syncFollowedCompany applies a follow or unfollow; setDiscoveryDefaultCron moves the sources
// still on the old default when the user changes it.
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  ATS_SOURCE_KINDS,
  SourceConfigError,
  WORKDAY_HOST,
  WORKDAY_SITE,
  WorkdayConfig,
  type SourceContext,
  type SourceKind,
} from '../adapters/discoverySource';
import { ASHBY_HOST } from '../adapters/sources/ashby';
import { arr, ATS_MAX_BYTES, obj } from '../adapters/sources/atsCommon';
import { GREENHOUSE_HOST } from '../adapters/sources/greenhouse';
import { LEVER_HOST } from '../adapters/sources/lever';
import { fetchWorkdayPage, workdayBoard } from '../adapters/sources/workday';
import type { Db } from '../db/client';
import { companies, discoverySources } from '../db/schema';
import { HttpError } from '../lib/errors';
import { FetchBlockedError } from '../lib/safeFetch';
import type { UserCtx } from '../repos/base';
import { getCompany, type Company } from '../repos/companies';
import {
  createSource,
  splitConfig,
  updateSource,
  type DiscoverySourceRow,
  type SourcePatch,
} from '../repos/discovery';
import { readUserSetting, writeUserSetting } from '../repos/userSettings';
import { requireService, type JobHandler } from './registry';
import { enqueue, userCronProblem } from './runner';
import type { Exec } from '../db/client';

export const ATS_DETECT_KIND = 'company.ats_detect'; // payload {companyId}
export const ATS_REVERIFY_KIND = 'company.ats_reverify';
/** Weekly, Monday 05:00 (before the default 07:00 discovery runs). */
export const ATS_REVERIFY_CRON = '0 5 * * 1';
export const REVERIFY_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-user setting holding the cron new discovery sources get; this when unset. */
export const DISCOVERY_DEFAULT_CRON_SETTING = 'discovery_default_cron';
export const DEFAULT_DISCOVERY_CRON = '0 7 * * *';

export const atsDetectDedupeKey = (companyId: string): string => `${ATS_DETECT_KIND}:${companyId}`;

const SLUG = /^[a-z0-9-]{1,100}$/;
const CAREERS_MAX_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_CANDIDATES = 5;

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

interface Probe {
  kind: AtsKind;
  host: string;
  url(slug: string): string;
  /** True when the 200 body is that provider's board answer AND it is serving a posting. */
  verify(body: unknown): boolean;
}

/**
 * One probe per provider, in probing order; each uses only its own public API host.
 *
 * A board counts as this company's only when it is serving at least one posting. An empty board
 * that merely exists is a decoy: one tracked company kept an empty Ashby board while its postings
 * lived on another provider, and recording the empty one hid the real ATS and made every later search
 * answer "nothing on the board". A company that genuinely has no openings is recorded as 'none'
 * and asked for its careers URL, and weekly re-verification picks the board up once it posts.
 */
export const ATS_PROBES: readonly Probe[] = [
  {
    kind: 'ats_greenhouse',
    host: GREENHOUSE_HOST,
    // The jobs list rather than the board's metadata, which cannot show whether it is serving
    // anything. Without `content=true` the response carries titles and ids only.
    url: (slug) => `https://${GREENHOUSE_HOST}/v1/boards/${slug}/jobs`,
    verify: (body) => arr(obj(body).jobs).length > 0,
  },
  {
    kind: 'ats_lever',
    host: LEVER_HOST,
    url: (slug) => `https://${LEVER_HOST}/v0/postings/${slug}?mode=json&limit=1`,
    verify: (body) => Array.isArray(body) && body.length > 0,
  },
  {
    kind: 'ats_ashby',
    host: ASHBY_HOST,
    url: (slug) => `https://${ASHBY_HOST}/posting-api/job-board/${slug}`,
    verify: (body) => arr(obj(body).jobs).length > 0,
  },
];

// ---------------------------------------------------------------------------
// Slug candidates and careers-page links (pure)

function asciiLower(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The registrable label of a domain: initech.io -> initech, www.initech.co.uk -> initech. */
export function domainLabel(domain: string | null | undefined): string | null {
  if (domain == null || domain.trim() === '') return null;
  let host = domain.trim().toLowerCase();
  try {
    host = new URL(host.includes('://') ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  const labels = host
    .replace(/\.$/, '')
    .split('.')
    .filter((l) => l.length > 0);
  if (labels[0] === 'www') labels.shift();
  if (labels.length < 2) return labels[0] ?? null;
  const last = labels.at(-1) ?? '';
  const second = labels.at(-2) ?? '';
  // Second-level public suffixes under a country code (co.uk, com.au, ...).
  const index =
    labels.length >= 3 && last.length === 2 && /^(?:co|com|org|net|ac|gov|edu)$/.test(second)
      ? labels.length - 3
      : labels.length - 2;
  return labels.at(index) ?? null;
}

/** Candidate org slugs, in probing order: alnum-only name, hyphenated name, domain label. */
export function slugCandidates(name: string, domain: string | null | undefined): string[] {
  const lower = asciiLower(name);
  const out = [
    lower.replace(/[^a-z0-9]+/g, ''),
    lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    domainLabel(domain)?.replace(/[^a-z0-9-]+/g, '') ?? '',
  ];
  return [...new Set(out.filter((s) => SLUG.test(s)))];
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

/** Board links in a careers page's href/src attributes, deduplicated, in page order. */
export function scanCareersHtml(html: string): AtsBoard[] {
  const out: AtsBoard[] = [];
  const seen = new Set<string>();
  const attr = /\b(?:href|src)=(?:"([^"]{0,2048})"|'([^']{0,2048})'|([^\s"'>]{1,2048}))/gi;
  for (const m of html.matchAll(attr)) {
    const board = boardFromUrl(m[1] ?? m[2] ?? m[3] ?? '');
    if (board === null) continue;
    const key = `${board.kind}:${board.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(board);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detection

type ProbeResult = 'hit' | 'miss' | 'error';

async function probe(sctx: SourceContext, p: Probe, slug: string): Promise<ProbeResult> {
  let res;
  try {
    res = await sctx.fetch(p.url(slug), { allowHosts: [p.host], maxBytes: ATS_MAX_BYTES });
  } catch (err) {
    sctx.log.warn({ kind: p.kind, slug, err }, 'ats probe failed');
    return 'error';
  }
  if (res.status === 429 || res.status >= 500) return 'error';
  if (res.status < 200 || res.status >= 300) return 'miss';
  try {
    return p.verify(JSON.parse(res.body.toString('utf8'))) ? 'hit' : 'miss';
  } catch {
    return 'miss';
  }
}

/**
 * A Workday board is verified by its CXS listing serving at least one posting. Only an unknown
 * site (404) or an empty one is a miss: the service window's redirects, 406, 422 and 5xx, and
 * anything else unexpected, are errors, so detection retries instead of concluding 'none'.
 */
async function probeWorkday(sctx: SourceContext, board: AtsBoard): Promise<ProbeResult> {
  let page;
  try {
    page = await fetchWorkdayPage(sctx, workdayBoard(boardConfig(board)), 0, 1);
  } catch (err) {
    if (err instanceof SourceConfigError) return 'miss';
    sctx.log.warn({ kind: board.kind, slug: board.slug, err }, 'ats probe failed');
    return 'error';
  }
  return page.jobPostings.length > 0 ? 'hit' : 'miss';
}

async function probeBoard(sctx: SourceContext, board: AtsBoard): Promise<ProbeResult> {
  if (board.kind === 'ats_workday') return probeWorkday(sctx, board);
  const p = ATS_PROBES.find((candidate) => candidate.kind === board.kind);
  return p === undefined ? 'miss' : probe(sctx, p, board.slug);
}

export type CareersPageOutcome = 'absent' | 'blocked' | 'no_board_links' | 'links_unverified';

export type DetectOutcome =
  | {
      status: 'found';
      kind: AtsKind;
      org: string;
      /** Workday only: the tenant's host, which carries its datacenter label. */
      host?: string;
      via: 'current' | 'slug' | 'careers_page';
      sourceId: string;
    }
  | { status: 'none'; careersPage: CareersPageOutcome; detail?: string | undefined }
  | { status: 'skipped'; reason: 'missing' };

/** Transient probe or page failures: the job retries rather than concluding 'none'. */
export class AtsDetectTransientError extends Error {
  override name = 'AtsDetectTransientError';
}

function isAtsKind(kind: string | null): kind is AtsKind {
  return kind !== null && (ATS_SOURCE_KINDS as readonly string[]).includes(kind);
}

/** A five-field cron expression cron-parser accepts (bounded), running at most hourly. */
export const CronSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .superRefine((cron, ctx) => {
    const problem = userCronProblem(cron);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
  });

/** The user's discovery default cron (setting discovery_default_cron), else 0 7 * * *. */
export async function discoveryDefaultCron(exec: Exec, ctx: UserCtx): Promise<string> {
  return await readUserSetting(
    exec,
    ctx,
    DISCOVERY_DEFAULT_CRON_SETTING,
    CronSchema,
    DEFAULT_DISCOVERY_CRON,
  );
}

/** The company's ATS discovery sources. */
async function companyAtsSources(
  db: Db,
  ctx: UserCtx,
  companyId: string,
): Promise<DiscoverySourceRow[]> {
  return await db
    .select()
    .from(discoverySources)
    .where(
      and(
        eq(discoverySources.userId, ctx.userId),
        eq(discoverySources.companyId, companyId),
        inArray(discoverySources.kind, ATS_SOURCE_KINDS as SourceKind[]),
      ),
    )
    .all();
}

/**
 * Makes `kind`/`org` the company's one board source: created unless it exists, and the company's
 * other ATS sources disabled (the company moved boards). Polling follows the company's status
 * (FR-D5): the source is enabled, on the user's default cron when it has none, only while the
 * company is followed, and disabled otherwise.
 */
async function ensureBoardSource(
  db: Db,
  ctx: UserCtx,
  company: Company,
  board: AtsBoard,
): Promise<string> {
  const existing = await companyAtsSources(db, ctx, company.id);
  const enabled = company.status === 'followed';
  const same = existing.find(
    (s) =>
      s.kind === board.kind && boardOfSource(s.kind, splitConfig(s).config)?.slug === board.slug,
  );
  let sourceId: string;
  if (same === undefined) {
    sourceId = (
      await createSource(db, ctx, {
        kind: board.kind,
        config: boardConfig(board),
        enabled,
        scheduleCron: await discoveryDefaultCron(db, ctx),
        companyId: company.id,
      })
    ).id;
  } else {
    sourceId = same.id;
    const patch: SourcePatch = {};
    if (same.enabled !== enabled) patch.enabled = enabled;
    if (enabled && same.scheduleCron === null)
      patch.scheduleCron = await discoveryDefaultCron(db, ctx);
    if (Object.keys(patch).length > 0) await updateSource(db, ctx, same.id, patch);
  }
  for (const other of existing) {
    if (other.id !== sourceId && other.enabled) {
      await updateSource(db, ctx, other.id, { enabled: false });
    }
  }
  return sourceId;
}

/** Records a verified board on the company row and as its discovery source. */
async function recordHit(db: Db, ctx: UserCtx, company: Company, board: AtsBoard): Promise<string> {
  const sourceId = await ensureBoardSource(db, ctx, company, board);
  const now = Date.now();
  await db
    .update(companies)
    .set({ atsKind: board.kind, atsRef: board.slug, atsVerifiedAt: now, updatedAt: now })
    .where(and(eq(companies.userId, ctx.userId), eq(companies.id, company.id)))
    .run();
  return sourceId;
}

/**
 * The board the company was last verified on. A Workday ats_ref (`<tenant>/<site>`) does not
 * carry the host, so it is read back from the company's source for that board.
 */
async function recordedBoard(db: Db, ctx: UserCtx, company: Company): Promise<AtsBoard | null> {
  const { atsKind: kind, atsRef: ref } = company;
  if (!isAtsKind(kind) || ref === null) return null;
  if (kind !== 'ats_workday') return SLUG.test(ref) ? { kind, slug: ref } : null;
  for (const source of await companyAtsSources(db, ctx, company.id)) {
    const board = boardOfSource(source.kind, splitConfig(source).config);
    if (board?.kind === kind && board.slug === ref) return board;
  }
  return null;
}

/**
 * Brings the company's polling in line with its status (FR-D5), after a follow or unfollow.
 * Followed with a verified board: that board's source exists and is enabled. Followed and never
 * checked: detection is queued (a hit registers the source enabled). Not followed: every ATS
 * source of the company is disabled.
 */
export async function syncFollowedCompany(db: Db, ctx: UserCtx, company: Company): Promise<void> {
  if (company.status === 'followed') {
    const board = await recordedBoard(db, ctx, company);
    if (board !== null) {
      await ensureBoardSource(db, ctx, company, board);
    } else if (company.atsKind === null) {
      await enqueueAtsDetect(db, ctx, company.id);
    }
    return;
  }
  for (const source of await companyAtsSources(db, ctx, company.id)) {
    if (source.enabled) await updateSource(db, ctx, source.id, { enabled: false });
  }
}

/**
 * Sets the user's discovery default cron. Every company ATS source still on the previous
 * default moves to the new one (its schedule row re-synced); a source given its own cron keeps
 * it. Returns how many sources moved.
 */
export async function setDiscoveryDefaultCron(db: Db, ctx: UserCtx, cron: string): Promise<number> {
  const previous = await discoveryDefaultCron(db, ctx);
  await writeUserSetting(db, ctx, DISCOVERY_DEFAULT_CRON_SETTING, cron);
  if (previous === cron) return 0;
  const onDefault = await db
    .select({ id: discoverySources.id })
    .from(discoverySources)
    .where(
      and(
        eq(discoverySources.userId, ctx.userId),
        isNotNull(discoverySources.companyId),
        inArray(discoverySources.kind, ATS_SOURCE_KINDS as SourceKind[]),
        eq(discoverySources.scheduleCron, previous),
      ),
    )
    .all();
  for (const { id } of onDefault) await updateSource(db, ctx, id, { scheduleCron: cron });
  return onDefault.length;
}

async function recordNone(db: Db, ctx: UserCtx, companyId: string): Promise<void> {
  const now = Date.now();
  await db
    .update(companies)
    .set({ atsKind: 'none', atsRef: null, atsVerifiedAt: now, updatedAt: now })
    .where(and(eq(companies.userId, ctx.userId), eq(companies.id, companyId)))
    .run();
}

/** Runs detection for one of the user's companies. */
export async function detectAts(
  db: Db,
  ctx: UserCtx,
  companyId: string,
  sctx: SourceContext,
): Promise<DetectOutcome> {
  let company: Company;
  try {
    company = await getCompany(db, ctx, companyId);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) {
      return { status: 'skipped', reason: 'missing' };
    }
    throw err;
  }
  let transient = false;
  const tryBoard = async (board: AtsBoard): Promise<boolean> => {
    const result = await probeBoard(sctx, board);
    if (result === 'error') transient = true;
    return result === 'hit';
  };
  const found = async (board: AtsBoard, via: 'current' | 'slug' | 'careers_page') =>
    ({
      status: 'found',
      kind: board.kind,
      org: board.slug,
      ...(board.host === undefined ? {} : { host: board.host }),
      via,
      sourceId: await recordHit(db, ctx, company, board),
    }) as const;

  // 1. The board the company was last verified on (re-verification).
  const current = await recordedBoard(db, ctx, company);
  if (current !== null && (await tryBoard(current))) return await found(current, 'current');
  // 2. Slug candidates from the name and domain, each against every slug-addressed provider
  //    (never Workday: ATS_PROBES has no Workday entry, there is no slug to guess).
  for (const slug of slugCandidates(company.name, company.domain)) {
    for (const p of ATS_PROBES) {
      const board = { kind: p.kind, slug };
      if (await tryBoard(board)) return await found(board, 'slug');
    }
  }
  // 3. Board links on the company's own careers page.
  let careersPage: CareersPageOutcome = 'absent';
  let detail: string | undefined;
  const ownBoard = company.careersUrl === null ? null : boardFromUrl(company.careersUrl);
  if (ownBoard?.kind === 'ats_workday') {
    // A Workday site is a JavaScript shell with no links to scan, and during the service window
    // the page fetch would follow the outage redirect to a page that has none either: probe the
    // site's own board instead.
    careersPage = 'links_unverified';
    if (await tryBoard(ownBoard)) return await found(ownBoard, 'careers_page');
  } else if (company.careersUrl !== null) {
    try {
      const res = await sctx.fetch(company.careersUrl, {
        allowHosts: [],
        allowPublic: true,
        maxBytes: CAREERS_MAX_BYTES,
      });
      if (res.status < 200 || res.status >= 300) {
        if (res.status === 429 || res.status >= 500) transient = true;
        careersPage = 'no_board_links';
        detail = `careers page answered HTTP ${res.status}`;
      } else {
        // Issue #20: a careers URL that just redirects straight into a board's own site (most
        // visibly Workday, whose landing page is a JS shell with no links to scan) was invisible
        // here before safeFetch exposed the final URL — scanning its body for links always found
        // none, since there was nothing to scan but the shell. res.url is that final URL.
        const redirectedBoard = boardFromUrl(res.url);
        const links = scanCareersHtml(res.body.toString('utf8')).slice(0, MAX_PAGE_CANDIDATES);
        const candidates = redirectedBoard === null ? links : [redirectedBoard, ...links];
        careersPage = candidates.length === 0 ? 'no_board_links' : 'links_unverified';
        for (const link of candidates) {
          if (await tryBoard(link)) return await found(link, 'careers_page');
        }
      }
    } catch (err) {
      if (!(err instanceof FetchBlockedError)) throw err;
      if (err.reason === 'timeout') {
        throw new AtsDetectTransientError('the careers page timed out; retrying');
      }
      // Refused by policy (prohibited host, private address, non-https, oversized): final.
      careersPage = 'blocked';
      detail = err.message;
      sctx.log.warn({ companyId, reason: err.reason }, 'careers page fetch blocked');
    }
  }
  if (transient) {
    throw new AtsDetectTransientError('an ATS probe or the careers page failed; retrying');
  }
  await recordNone(db, ctx, company.id);
  return { status: 'none', careersPage, ...(detail === undefined ? {} : { detail }) };
}

/** Queues detection for one of the user's companies (at most one unfinished per company). */
export async function enqueueAtsDetect(db: Db, ctx: UserCtx, companyId: string): Promise<string> {
  return enqueue(
    db,
    ATS_DETECT_KIND,
    { companyId },
    { dedupeKey: atsDetectDedupeKey(companyId), userId: ctx.userId },
  );
}

const PayloadSchema = z.object({ companyId: z.string().min(1).max(64) });

export const atsDetectJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: ATS_DETECT_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 3,
  async run(db, payload, ctx) {
    if (ctx.userId === null) throw new Error(`${ATS_DETECT_KIND} needs a user`);
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    const outcome = await detectAts(db, user, payload.companyId, {
      fetch: requireService(ctx, 'sourceFetch'),
      log: requireService(ctx, 'log'),
    });
    await ctx.setResult(outcome);
  },
};

/** Followed companies whose board check is missing or older than REVERIFY_AFTER_MS. */
export async function queueReverification(db: Db, now: number = Date.now()): Promise<number> {
  const stale = await db
    .select({ id: companies.id, userId: companies.userId })
    .from(companies)
    .where(
      and(
        eq(companies.status, 'followed'),
        or(isNull(companies.atsVerifiedAt), lt(companies.atsVerifiedAt, now - REVERIFY_AFTER_MS)),
      ),
    )
    .all();
  for (const c of stale) {
    await enqueueAtsDetect(db, { userId: c.userId, isAdmin: false }, c.id);
  }
  return stale.length;
}

export const atsReverifyJob: JobHandler<Record<string, never>> = {
  kind: ATS_REVERIFY_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  maxAttempts: 1,
  async run(db, _payload, ctx) {
    await ctx.setResult({ queued: await queueReverification(db) });
  },
};
