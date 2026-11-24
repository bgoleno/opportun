// Detecting a company's ATS board (https://github.com/bgoleno/opportun/issues/788): the probes,
// the careers-page scan, the board sources a hit records, and detectAts itself, moved whole from
// jobs/atsDetect.ts (tl on #788), so the posting search (lib/postingSearch.ts) runs it without
// importing a job. The jobs that run it on a schedule stay in jobs/atsDetect.ts.
import { userCronProblem } from './jobQueue';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  ATS_SOURCE_KINDS,
  SourceConfigError,
  type SourceContext,
  type SourceKind,
} from '../adapters/discoverySource';
import { siteOfKind, SLUG_SITES } from '../sites';
import { fetchWorkdayPage, workdayBoard } from '../adapters/sources/workday';
import { withTransaction, type Db, type Exec } from '../db/client';
import { companies, discoverySources } from '../db/schema';
import {
  boardConfig,
  boardFromUrl,
  boardOfSource,
  isAtsKind,
  SLUG,
  type AtsBoard,
  type AtsKind,
} from './atsBoard';
import { HttpError } from './errors';
import { racePoint } from './racePoints';
import { FetchBlockedError } from './safeFetch';
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
import { enqueueVendorCheck } from './vendorCheckQueue';

export const ATS_DETECT_KIND = 'company.ats_detect'; // payload {companyId}
export const ATS_REVERIFY_KIND = 'company.ats_reverify';
/** Weekly, Monday 05:00 (before the default 07:00 discovery runs). */
export const ATS_REVERIFY_CRON = '0 5 * * 1';
export const REVERIFY_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-user setting holding the cron new discovery sources get; this when unset. */
export const DISCOVERY_DEFAULT_CRON_SETTING = 'discovery_default_cron';
export const DEFAULT_DISCOVERY_CRON = '0 7 * * *';

export const atsDetectDedupeKey = (companyId: string): string => `${ATS_DETECT_KIND}:${companyId}`;

const CAREERS_MAX_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_CANDIDATES = 5;

// A slug-addressed board is asked by its site module's own probe (apps/server/src/sites, #769), one
// per provider, in SLUG_SITES' order; each uses only its own public API host.
//
// A board counts as this company's only when it is serving at least one posting. An empty board
// that merely exists is a decoy: one tracked company kept an empty Ashby board while its postings
// lived on another provider, and recording the empty one hid the real ATS and made every later search
// answer "nothing on the board". A company that genuinely has no openings is recorded as 'none'
// and asked for its careers URL, and weekly re-verification picks the board up once it posts.

/** The kinds addressed by a slug on a fixed host, in probing order: all `boardApisOnly` reaches. */
export const SLUG_KINDS: readonly AtsKind[] = SLUG_SITES.map(
  (m) => m.identity.sourceKind as AtsKind,
);

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

type ProbeResult = 'yes' | 'no' | 'unknown';

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
    if (err instanceof SourceConfigError) return 'no';
    sctx.log.warn({ 'opportun.ats.kind': board.kind, err }, 'ats probe failed');
    return 'unknown';
  }
  return page.jobPostings.length > 0 ? 'yes' : 'no';
}

async function probeBoard(sctx: SourceContext, board: AtsBoard): Promise<ProbeResult> {
  if (board.kind === 'ats_workday') return probeWorkday(sctx, board);
  const site = siteOfKind(board.kind);
  const probe = site?.api?.probe;
  return site === undefined || probe === undefined
    ? 'no'
    : probe(sctx, { site: site.identity.id, slug: board.slug });
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
  db: Exec,
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
  // discovery_sources has no unique index, and two detections of one company can overlap:
  // posting.reconcile detects inline, outside company.ats_detect's key, so two opportunities at one
  // company can get here together. Only this lock keeps both from reading no source and creating
  // one (https://github.com/bgoleno/opportun/issues/268). It is the company's, like the check.
  return await withTransaction(
    db,
    async (tx) => {
      const existing = await companyAtsSources(tx, ctx, company.id);
      // The company's status as it is now, read inside the lock, not the copy the caller read at the
      // start of a possibly long detection: a Follow that landed while the probe waited on the board
      // has already made the source enabled, and the stale status would switch it off again, until
      // the monthly re-check (https://github.com/bgoleno/opportun/pull/295, tl). A company deleted
      // meanwhile has no status to read; the caller's copy stands.
      const current = await tx
        .select({ status: companies.status })
        .from(companies)
        .where(and(eq(companies.userId, ctx.userId), eq(companies.id, company.id)))
        .get();
      const enabled = (current?.status ?? company.status) === 'followed';
      const same = existing.find(
        (s) =>
          s.kind === board.kind &&
          boardOfSource(s.kind, splitConfig(s).config)?.slug === board.slug,
      );
      await racePoint('atsDetect.board_source.locked');
      let sourceId: string;
      if (same === undefined) {
        sourceId = (
          await createSource(tx, ctx, {
            kind: board.kind,
            config: boardConfig(board),
            enabled,
            scheduleCron: await discoveryDefaultCron(tx, ctx),
            companyId: company.id,
          })
        ).id;
      } else {
        sourceId = same.id;
        const patch: SourcePatch = {};
        if (same.enabled !== enabled) patch.enabled = enabled;
        if (enabled && same.scheduleCron === null)
          patch.scheduleCron = await discoveryDefaultCron(tx, ctx);
        if (Object.keys(patch).length > 0) await updateSource(tx, ctx, same.id, patch);
      }
      for (const other of existing) {
        if (other.id !== sourceId && other.enabled) {
          await updateSource(tx, ctx, other.id, { enabled: false });
        }
      }
      return sourceId;
    },
    { scope: `discovery.board_source:${company.id}` },
  );
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

/** Records that the company has no board detection could find. */
export async function recordNone(db: Db, ctx: UserCtx, companyId: string): Promise<void> {
  const now = Date.now();
  await db
    .update(companies)
    .set({ atsKind: 'none', atsRef: null, atsVerifiedAt: now, updatedAt: now })
    .where(and(eq(companies.userId, ctx.userId), eq(companies.id, companyId)))
    .run();
}

/** How detection runs. */
export interface DetectOptions {
  /**
   * Only the board APIs of the fixed slug-addressed providers (Greenhouse, Lever, Ashby): no
   * request to the company's own careers page, and none to a Workday site, even when one is on
   * record. For a probe nobody asked for (the nightly network probe, #296): the careers page is
   * the one step that reaches a host not fixed in code, an address the user or the AI supplied.
   */
  boardApisOnly?: boolean;
}

/** Runs detection for one of the user's companies. */
export async function detectAts(
  db: Db,
  ctx: UserCtx,
  companyId: string,
  sctx: SourceContext,
  opts: DetectOptions = {},
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
    if (result === 'unknown') transient = true;
    return result === 'yes';
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
  const recorded = await recordedBoard(db, ctx, company);
  const current =
    recorded !== null && opts.boardApisOnly === true && !SLUG_KINDS.includes(recorded.kind)
      ? null
      : recorded;
  // Its error, like a guess's, leaves the company's real board unknown: a guess that hits after it
  // could be a decoy that would replace the board on record, so it seeds every slug's error below
  // (tl on https://github.com/bgoleno/opportun/pull/526).
  let currentErrored = false;
  if (current !== null) {
    const result = await probeBoard(sctx, current);
    if (result === 'yes') return await found(current, 'current');
    if (result === 'unknown') {
      transient = true;
      currentErrored = true;
    }
  }
  // 2. Slug candidates from the name and domain, each against every slug-addressed provider
  //    (never Workday: its site is not slug-addressed, there is no slug to guess).
  //    A guess that errored (a 429, a 5xx, no answer, or one the nightly probe skipped because its
  //    vendor is stopped) leaves that vendor's board unknown, and the company's real board may be
  //    the one it could not see. A board with the same slug on a later vendor can then be a
  //    same-named decoy, so that hit is not recorded: detection ends transient, the company keeps
  //    what it had, and the guesses are made again later (#514). A hit for a slug whose earlier
  //    guesses all answered, after a recorded board that answered, is recorded as before.
  for (const slug of slugCandidates(company.name, company.domain)) {
    let slugErrored = currentErrored;
    for (const kind of SLUG_KINDS) {
      const board = { kind, slug };
      const result = await probeBoard(sctx, board);
      if (result === 'unknown') {
        transient = true;
        slugErrored = true;
      } else if (result === 'yes') {
        if (slugErrored) {
          throw new AtsDetectTransientError(
            'an ATS probe failed before a board with the same name was found; retrying',
          );
        }
        return await found(board, 'slug');
      }
    }
  }
  // 3. Board links on the company's own careers page (never with boardApisOnly).
  let careersPage: CareersPageOutcome = 'absent';
  let detail: string | undefined;
  const careersUrl = opts.boardApisOnly === true ? null : company.careersUrl;
  const ownBoard = careersUrl === null ? null : boardFromUrl(careersUrl);
  if (ownBoard?.kind === 'ats_workday') {
    // A Workday site is a JavaScript shell with no links to scan, and during the service window
    // the page fetch would follow the outage redirect to a page that has none either: probe the
    // site's own board instead.
    careersPage = 'links_unverified';
    if (await tryBoard(ownBoard)) return await found(ownBoard, 'careers_page');
  } else if (careersUrl !== null) {
    try {
      const res = await sctx.fetch(careersUrl, {
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
      // A deadline that passed, with the request out or still waiting for its host's token
      // (rate_wait, #617): nothing was learned about the page, so it is tried again.
      if (err.reason === 'timeout' || err.reason === 'rate_wait') {
        throw new AtsDetectTransientError('the careers page timed out; retrying');
      }
      // Refused by policy (prohibited host, private address, non-https, oversized): final.
      careersPage = 'blocked';
      detail = err.message;
      sctx.log.warn(
        { 'opportun.company.id': companyId, 'opportun.fetch.blocked_reason': err.reason },
        'careers page fetch blocked',
      );
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
  // Queued per user, so one user's many companies cannot hold up another's (#321).
  return await enqueueVendorCheck(
    db,
    ctx,
    ATS_DETECT_KIND,
    { companyId },
    atsDetectDedupeKey(companyId),
  );
}
