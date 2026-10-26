// opportunity.enrich job (issue #16). An opportunity auto-created from recruiter outreach
// (FR-M3) enters the pipeline with nothing but a company and a title. This job does what the
// user would do next by hand: find the company's careers page, find the posting named in the
// outreach, and fill the record (description, posting URL, location, remote, comp note).
//
// Many smaller companies host jobs on their own site, so the careers page is found
// heuristically: the company's stored careers URL first, then candidate domains (the outreach
// sender's domain when it is not a mail platform, then domains derived from the company name)
// verified by the company's name appearing on the homepage, then common /careers paths and
// career-ish links on the homepage. Commercial ATS boards linked from the careers page are
// listed through their public APIs; everything else is matched from the page's own links.
//
// Every external fetch goes through safeFetch in allowPublic mode (https, public addresses,
// prohibited hosts refused), bounded in size and count. The posting text is extracted with the
// capture.extract task when an AI key exists, else the raw page text becomes the description.
// When nothing can be found the job leaves a note on the opportunity naming what to do.
import { AiUnavailableError, CaptureOutputSchema, renderPrompt, runStructured } from '@opportun/ai';
import { decodeEntities, newId } from '@opportun/core';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { htmlToText } from '../adapters/gmail';
import { ASHBY_HOST } from '../adapters/sources/ashby';
import { GREENHOUSE_HOST } from '../adapters/sources/greenhouse';
import { LEVER_HOST } from '../adapters/sources/lever';
import { fetchWorkdayDetail, workdayBoard } from '../adapters/sources/workday';
import type { Db } from '../db/client';
import { activities, communications, companies, opportunities, roleTargets } from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import { FetchBlockedError, PROHIBITED_HOSTS, type safeFetch } from '../lib/safeFetch';
import type { UserCtx } from '../repos/base';
import { getActivePrompt } from '../repos/prompts';
import { updateOpportunity } from '../repos/opportunities';
import { sanitizeDescriptionText } from '../lib/postingSanitize';
import { workdayPosting } from '../lib/atsJobRef';
import {
  atsDetectDedupeKey,
  ATS_DETECT_KIND,
  boardConfig,
  boardFromUrl,
  scanCareersHtml,
} from './atsDetect';
import { TITLE_MATCH_THRESHOLD, titleOverlap } from './leadResolve';
import { enqueue } from './runner';
import { requireService, type JobContext, type JobHandler } from './registry';

export const OPPORTUNITY_ENRICH_KIND = 'opportunity.enrich';
export const enrichDedupeKey = (opportunityId: string): string =>
  `${OPPORTUNITY_ENRICH_KIND}:${opportunityId}`;

const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const BOARD_MAX_BYTES = 25 * 1024 * 1024;
const DESCRIPTION_MAX = 50_000;
/** Candidate-domain probes per run; keeps a weird company name from fanning out. */
const MAX_DOMAIN_PROBES = 5;

/** Mail platforms and ATS mail hosts whose sender domain says nothing about the employer.
 *  Seeded from PROHIBITED_HOSTS (the C-1 list) so those hosts are never named here. */
const PLATFORM_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  ...PROHIBITED_HOSTS,
  'indeed.com',
  'ziprecruiter.com',
  'glassdoor.com',
  'wellfound.com',
  'hi.wellfound.com',
  'dice.com',
  'greenhouse.io',
  'greenhouse-mail.io',
  'lever.co',
  'hire.lever.co',
  'ashbyhq.com',
  'smartrecruiters.com',
  'myworkday.com',
  'icims.com',
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
]);

export const CAREERS_PATHS = [
  '/careers',
  '/careers/',
  '/jobs',
  '/join',
  '/join-us',
  '/company/careers',
  '/about/careers',
] as const;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** The domain of the LAST address in a From header (display-name spoof safe), lowercased. */
export function senderDomain(from: string): string | null {
  const addresses = from.match(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/g);
  const last = addresses?.at(-1);
  const domain = last?.split('@')[1]?.toLowerCase().replace(/\.$/, '') ?? null;
  if (domain === null || !domain.includes('.')) return null;
  const registrable = domain.split('.').slice(-2).join('.');
  if (PLATFORM_MAIL_DOMAINS.has(domain) || PLATFORM_MAIL_DOMAINS.has(registrable)) return null;
  return domain;
}

/** ascii-lowered, alphanumeric-collapsed text, for fuzzy "is this name on this page" checks. */
function collapse(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Trailing corporate-suffix tokens, shared by coreName (which then collapses) and wordName
 *  (which keeps the remaining words separate, for pageNamesCompany's word-boundary checks). */
const CORP_SUFFIX = /\b(inc|llc|ltd|corp|corporation|gmbh|co)\b\.?$/i;

/** Legal-suffix-free company name ("Northwind, Inc." -> "northwind"). */
function coreName(name: string): string {
  return collapse(name.replace(CORP_SUFFIX, ''));
}

/**
 * Domains worth probing for the company's site, most trustworthy first: the outreach sender's
 * domain (when not a mail platform), then name-derived guesses. Each is verified against the
 * homepage before use, so a wrong guess costs one fetch, never wrong data.
 */
export function candidateDomains(companyName: string, sender: string | null): string[] {
  const out: string[] = [];
  if (sender !== null) out.push(sender);
  const core = coreName(companyName);
  if (core.length >= 3) {
    for (const tld of ['com', 'co', 'io', 'ai']) out.push(`${core}.${tld}`);
  }
  return [...new Set(out)].slice(0, MAX_DOMAIN_PROBES);
}

/** Lowercased, diacritics stripped, but letters/digits NOT collapsed together: unlike collapse(),
 *  this keeps word boundaries, which pageNamesCompany needs and collapse() destroys by design. */
function fold(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Suffix-stripped name, words still separated ("Northwind Robotics, Inc." -> "Northwind Robotics").
 *  Falls back to the untouched name on the near-impossible case of a name that IS only a suffix,
 *  rather than ever operating on an empty string. */
function wordName(name: string): string {
  // Trimmed first: CORP_SUFFIX anchors on $, so untrimmed trailing space (a declared field's
  // own text, or one "|"-segment of it) would stop the suffix from ever matching.
  const trimmed = name.trim();
  const stripped = trimmed.replace(CORP_SUFFIX, '').trim();
  return stripped === '' ? trimmed : stripped;
}

/** The ASCII letter/digit words in a name, folded and suffix-stripped. Empty for a name with no
 *  Latin/ASCII-ish content at all (CJK, e.g.), which routes pageNamesCompany to its substring
 *  fallback below instead of a word-boundary check that has nothing to tokenize. */
function asciiWords(name: string): string[] {
  return fold(wordName(name)).match(/[a-z0-9]+/g) ?? [];
}

function sameWords(a: string[], b: string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((w, i) => w === b[i]);
}

/**
 * A page's self-declared identity: <title> text and <meta property="og:site_name" |
 * name="application-name"> content, read from the raw markup. sanitizeDescriptionText cannot
 * supply these: it strips the <title> tag but keeps its inner text inline with everything else
 * (losing which words were the title), and a <meta> tag is void, so its content attribute carries
 * no text node at all -- stripping the tag loses the value completely. Every occurrence is kept,
 * not just the first: a hostile page can bury a fake pair earlier in the document (the <head>
 * shape issue #238 fixed), and an extra candidate here only costs one failed comparison, never a
 * wrong write the way that bug did. Capped defensively against a page with many of them.
 */
function declaredNames(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)) {
    out.push(decodeEntities(m[1] ?? ''));
  }
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/(?:property|name)\s*=\s*["'](?:og:site_name|application-name)["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (content?.[1] !== undefined) out.push(decodeEntities(content[1]));
  }
  return out.slice(0, 20);
}

/** "Stripe | Payment Processing" -> ["Stripe", "Payment Processing"]: a declared field is often
 *  the company name plus a tagline, not the name alone. */
const SEGMENT_BREAK = /[|\-–—:·•]/;

/**
 * True when the company's own name is good evidence this page is theirs. A wrong link is worse
 * than no link (issue #239's own framing), so every path below only ever strengthens toward
 * "no", never loosens toward "yes" the way a bare substring search over raw HTML did (markup,
 * class names and URLs all used to count as evidence; "Vanta" matched inside "advantage", "Joy"
 * matched inside "enjoy", and a 568KB page with its name as a JSON key anywhere would pass).
 *
 * A declared title or site-name field matching the name's words exactly -- one whole
 * `|`/`-`-delimited segment of it, not a word embedded in a longer one -- counts even for a
 * short or numeric name ("F5", "C1"): exact equality on a page's own self-authored identity
 * field cannot be fooled by an unrelated longer word the way embedding can, so it does not need
 * the length floor a looser check does. Failing that, the page's visible text (sanitized, so
 * markup/class names/URLs are never read as words) matching the name as a whole word or phrase
 * is the fallback -- word-boundaried, so "Vanta" can never match inside "advantage" -- kept to
 * names with at least 3 characters of real signal, the floor this check always had.
 *
 * A name with no ASCII letters or digits at all (CJK, e.g.) has nothing to tokenize or
 * boundary-match, so it falls back to a literal substring check instead: weaker, but substring
 * collisions among non-Latin scripts are far rarer than among short English words, and the
 * alternative is never being able to verify such a company's site at all.
 */
export function pageNamesCompany(html: string, companyName: string): boolean {
  const words = asciiWords(companyName);
  if (words.length === 0) {
    const name = fold(wordName(companyName));
    if (name.length < 2) return false;
    const text = sanitizeDescriptionText(html) ?? '';
    return fold(`${declaredNames(html).join(' ')} ${text}`).includes(name);
  }
  for (const declared of declaredNames(html)) {
    for (const segment of declared.split(SEGMENT_BREAK)) {
      if (sameWords(asciiWords(segment), words)) return true;
    }
  }
  if (words.join('').length < 3) return false;
  const phrase = new RegExp(`\\b${words.join('\\W+')}\\b`);
  if (phrase.test(fold(sanitizeDescriptionText(html) ?? ''))) return true;
  return declaredNames(html).some((d) => phrase.test(fold(d)));
}

export interface PageAnchor {
  url: string;
  text: string;
}

/** Anchors with their visible text, resolved against the page URL; bounded. */
export function anchorsOf(html: string, baseUrl: string): PageAnchor[] {
  const out: PageAnchor[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*\bhref=(?:"([^"]{1,2048})"|'([^']{1,2048})')[^>]*>([^]{0,500}?)<\/a\s*>/gi;
  for (const m of html.matchAll(re)) {
    if (out.length >= 300) break;
    const href = (m[1] ?? m[2] ?? '').replace(/&amp;/g, '&').trim();
    if (href === '' || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    let url: string;
    try {
      url = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    if (!url.startsWith('https://') && !url.startsWith('http://')) continue;
    const text = htmlToText(m[3] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    const key = `${url}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, text });
  }
  return out;
}

/** The most careers-looking link on a page, by link text first, then by path. */
export function careersLink(anchors: PageAnchor[]): string | null {
  const byText = anchors.find((a) =>
    /\b(careers?|jobs?|join (us|the team)|we('|’)re hiring|work (with|for) us|open (positions|roles))\b/i.test(
      a.text,
    ),
  );
  if (byText !== undefined) return byText.url;
  const byPath = anchors.find((a) => /\/(careers?|jobs|join(-us)?)(\/|$)/i.test(a.url));
  return byPath?.url ?? null;
}

/** True when a page reads like a careers/jobs page rather than an arbitrary 200. */
export function looksLikeCareersPage(html: string): boolean {
  return (
    /\b(open (positions|roles)|current openings|we('|’)re hiring|job (openings|listings)|apply now|join (us|the|our) team)\b/i.test(
      html,
    ) ||
    /\/(job|jobs|careers?|positions?|openings?)\//i.test(html) ||
    scanCareersHtml(html).length > 0
  );
}

/** The last meaningful path segment of a URL, hyphens and underscores as spaces. */
function urlSlugText(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter((s) => s.length > 0);
    return (segments.at(-1) ?? '').replace(/[-_]+/g, ' ').replace(/\.\w{1,5}$/, '');
  } catch {
    return '';
  }
}

/** The anchor that best matches the opportunity title, when it clears the lead threshold. */
export function bestTitleMatch(
  anchors: PageAnchor[],
  title: string,
): { url: string; score: number } | null {
  let best: { url: string; score: number } | null = null;
  for (const a of anchors) {
    const score = Math.max(titleOverlap(title, a.text), titleOverlap(title, urlSlugText(a.url)));
    if (score >= TITLE_MATCH_THRESHOLD && (best === null || score > best.score)) {
      best = { url: a.url, score };
    }
  }
  return best;
}

/** Dollar amounts in text, "k" suffixes expanded; for the comp-floor check. */
export function dollarAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(
    // eslint-disable-next-line security/detect-unsafe-regex -- bounded repetitions only, no nesting
    /\$?[ \t]{0,3}([0-9]{1,3}(?:,[0-9]{3}){1,3}|[0-9]{2,7})[ \t]{0,3}(k\b)?/gi,
  )) {
    const raw = Number((m[1] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(raw)) continue;
    const value = m[2] === undefined ? raw : raw * 1000;
    if (value >= 20_000 && value <= 5_000_000) out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetching

export interface Page {
  url: string;
  html: string;
}

/**
 * GETs a public page; null on any refusal, block or non-2xx (candidates just move on). Exported
 * for companyDomainResolve.ts, which verifies a candidate homepage the same way this module
 * verifies a candidate careers page.
 */
export async function getPage(fetch: typeof safeFetch, url: string): Promise<Page | null> {
  let res;
  try {
    res = await fetch(url, { allowHosts: [], allowPublic: true, maxBytes: PAGE_MAX_BYTES });
  } catch (err) {
    if (err instanceof FetchBlockedError) return null;
    return null;
  }
  if (res.status < 200 || res.status >= 300) return null;
  return { url, html: res.body.toString('utf8') };
}

/**
 * The text of a Workday posting link, read from the CXS detail endpoint on the tenant's own host
 * (FR-D10): the rendered posting page is a JavaScript shell whose text is only site chrome.
 * `undefined` when the URL is not a Workday posting; null when its detail cannot be read.
 */
export async function workdayPostingText(
  fetch: typeof safeFetch,
  url: string,
): Promise<string | null | undefined> {
  const board = boardFromUrl(url);
  if (board?.kind !== 'ats_workday') return undefined;
  try {
    // Inside the try: boardFromUrl reads a protocol-relative link against a base, `new URL`
    // without one throws, and an unreadable link must end on the note, not fail the job.
    const path = workdayPosting(new URL(url));
    if (path === null) return null;
    const detail = await fetchWorkdayDetail(
      { fetch },
      workdayBoard(boardConfig(board)),
      path.externalPath,
    );
    const html = (detail as { jobPostingInfo?: { jobDescription?: unknown } } | null)
      ?.jobPostingInfo?.jobDescription;
    // sanitizeDescriptionText, not htmlToText (issue #238): this is posting text, and htmlToText's
    // contract is email bodies, same reasoning as the page-fetch path below.
    return sanitizeDescriptionText(html);
  } catch {
    return null;
  }
}

/** Public board APIs of the three known ATS providers, as title+url anchors. */
export async function boardAnchors(
  fetch: typeof safeFetch,
  board: { kind: string; slug: string },
): Promise<PageAnchor[]> {
  const spec =
    board.kind === 'ats_greenhouse'
      ? {
          host: GREENHOUSE_HOST,
          url: `https://${GREENHOUSE_HOST}/v1/boards/${board.slug}/jobs`,
          pick: (body: unknown): PageAnchor[] => {
            const jobs = (body as { jobs?: unknown[] })?.jobs ?? [];
            return jobs.flatMap((j) => {
              const job = j as { title?: unknown; absolute_url?: unknown };
              return typeof job.title === 'string' && typeof job.absolute_url === 'string'
                ? [{ url: job.absolute_url, text: job.title }]
                : [];
            });
          },
        }
      : board.kind === 'ats_lever'
        ? {
            host: LEVER_HOST,
            url: `https://${LEVER_HOST}/v0/postings/${board.slug}?mode=json`,
            pick: (body: unknown): PageAnchor[] =>
              (Array.isArray(body) ? body : []).flatMap((j) => {
                const job = j as { text?: unknown; hostedUrl?: unknown };
                return typeof job.text === 'string' && typeof job.hostedUrl === 'string'
                  ? [{ url: job.hostedUrl, text: job.text }]
                  : [];
              }),
          }
        : board.kind === 'ats_ashby'
          ? {
              host: ASHBY_HOST,
              url: `https://${ASHBY_HOST}/posting-api/job-board/${board.slug}`,
              pick: (body: unknown): PageAnchor[] => {
                const jobs = (body as { jobs?: unknown[] })?.jobs ?? [];
                return jobs.flatMap((j) => {
                  const job = j as { title?: unknown; jobUrl?: unknown };
                  return typeof job.title === 'string' && typeof job.jobUrl === 'string'
                    ? [{ url: job.jobUrl, text: job.title }]
                    : [];
                });
              },
            }
          : null;
  if (spec === null) return [];
  let res;
  try {
    res = await fetch(spec.url, { allowHosts: [spec.host], maxBytes: BOARD_MAX_BYTES });
  } catch {
    return [];
  }
  if (res.status < 200 || res.status >= 300) return [];
  try {
    return spec.pick(JSON.parse(res.body.toString('utf8'))).slice(0, 500);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The job

type OppRow = typeof opportunities.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;

/** The earliest message linked to the opportunity: the outreach that created it. */
async function sourceFrom(db: Db, ctx: UserCtx, opportunityId: string): Promise<string | null> {
  return (
    (
      await db
        .select({ from: communications.from })
        .from(communications)
        .where(
          and(
            eq(communications.userId, ctx.userId),
            eq(communications.opportunityId, opportunityId),
          ),
        )
        .orderBy(asc(communications.sentAt))
        .limit(1)
        .get()
    )?.from ?? null
  );
}

async function addNote(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  title: string,
  body: string,
): Promise<void> {
  await db
    .insert(activities)
    .values({
      id: newId(),
      userId: ctx.userId,
      opportunityId,
      kind: 'note',
      title,
      bodyMd: body,
      occurredAt: Date.now(),
      participants: [],
      externalUrl: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
}

/** Shared "not readable" note for a posting that was found but yielded no usable text. */
async function notePostingUnreadable(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  careersUrl: string,
  problem: string,
): Promise<EnrichOutcome> {
  await addNote(
    db,
    ctx,
    opportunityId,
    'Posting found but not readable',
    `${problem} Open it in your browser and use Discovery > Capture posting with the pasted text.`,
  );
  return { outcome: 'no_match', careersUrl };
}

/**
 * Finds the careers page for the opportunity's company: the stored careers URL first, else
 * verified candidate domains probed on common paths and homepage links. A guessed page is NOT
 * persisted here: a name collision can pass the homepage check (observed live: a company name
 * resolved to an unrelated company's .io domain), so the guess only sticks once the posting
 * itself matches.
 */
async function findCareersPage(
  db: Db,
  ctx: UserCtx,
  fetch: typeof safeFetch,
  opp: OppRow,
  company: CompanyRow,
): Promise<{ page: Page; guessed: boolean } | null> {
  if (company.careersUrl !== null && company.careersUrl !== '') {
    const page = await getPage(fetch, company.careersUrl);
    return page === null ? null : { page, guessed: false };
  }
  for (const domain of candidateDomains(
    company.name,
    senderDomain((await sourceFrom(db, ctx, opp.id)) ?? ''),
  )) {
    const home = await getPage(fetch, `https://${domain}/`);
    if (home === null || !pageNamesCompany(home.html, company.name)) continue;
    let found: Page | null = null;
    for (const path of CAREERS_PATHS) {
      const page = await getPage(fetch, `https://${domain}${path}`);
      if (page !== null && looksLikeCareersPage(page.html)) {
        found = page;
        break;
      }
    }
    if (found === null) {
      const link = careersLink(anchorsOf(home.html, home.url));
      if (link !== null) {
        const page = await getPage(fetch, link);
        if (page !== null && looksLikeCareersPage(page.html)) found = page;
      }
    }
    if (found !== null) return { page: found, guessed: true };
  }
  return null;
}

/** Persists a confirmed careers page on the company and queues the regular ATS detection. */
async function saveCareersUrl(db: Db, ctx: UserCtx, companyId: string, url: string): Promise<void> {
  await db
    .update(companies)
    .set({ careersUrl: url, updatedAt: Date.now() })
    .where(and(eq(companies.userId, ctx.userId), eq(companies.id, companyId)))
    .run();
  await enqueue(
    db,
    ATS_DETECT_KIND,
    { companyId },
    { dedupeKey: atsDetectDedupeKey(companyId), userId: ctx.userId },
  );
}

/**
 * capture.extract when an AI key exists; the raw page text is the fallback description when no
 * AI is configured. When the AI runs but returns nothing usable, `descriptionMd` is null rather
 * than that same raw text (issue #238): a bad parse must not silently become the description, and
 * the caller treats null the same as a posting that could not be read at all.
 */
async function extractFields(
  db: Db,
  ctx: UserCtx,
  url: string,
  text: string,
): Promise<{
  descriptionMd: string | null;
  location?: string;
  remote?: boolean;
  compNote?: string;
}> {
  const bounded = text.slice(0, DESCRIPTION_MAX);
  const fallback = { descriptionMd: bounded };
  const prompt = await getActivePrompt(db, ctx, 'capture.extract');
  if (prompt === undefined) return fallback;
  try {
    const out = await runStructured(await buildAiDeps(db, ctx), 'capture.extract', {
      system: renderPrompt(prompt.body, { page_url_untrusted: url, page_untrusted: bounded }),
      prompt: 'Extract the job posting and return the result.',
      schema: CaptureOutputSchema,
      promptId: prompt.id,
    });
    const extracted = out.descriptionMd?.trim();
    return {
      descriptionMd: extracted === undefined || extracted === '' ? null : extracted,
      ...(out.location == null ? {} : { location: out.location }),
      ...(out.remote == null ? {} : { remote: out.remote === 'remote' }),
      ...(out.compNote == null ? {} : { compNote: out.compNote }),
    };
  } catch (err) {
    if (err instanceof AiUnavailableError) return fallback;
    throw err;
  }
}

/** The lowest compensation floor across active role targets, in whole units. */
async function compFloor(db: Db, ctx: UserCtx): Promise<number | null> {
  const rows = await db
    .select({ min: roleTargets.compMin })
    .from(roleTargets)
    .where(
      and(
        eq(roleTargets.userId, ctx.userId),
        eq(roleTargets.active, true),
        isNotNull(roleTargets.compMin),
      ),
    )
    .all();
  const mins = rows.map((r) => r.min).filter((m): m is number => m !== null);
  return mins.length === 0 ? null : Math.min(...mins);
}

export type EnrichOutcome =
  | { outcome: 'enriched'; postingUrl: string }
  | { outcome: 'no_careers_page' }
  | { outcome: 'no_match'; careersUrl: string }
  | { outcome: 'skipped'; reason: 'missing' | 'already_detailed' };

export async function enrichOpportunity(
  db: Db,
  ctx: UserCtx,
  fetch: typeof safeFetch,
  opportunityId: string,
): Promise<EnrichOutcome> {
  const row = await db
    .select({ opp: opportunities, company: companies })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, opportunityId)))
    .get();
  if (row === undefined) return { outcome: 'skipped', reason: 'missing' };
  const { opp, company } = row;
  if (opp.descriptionMd !== null && opp.descriptionMd !== '') {
    return { outcome: 'skipped', reason: 'already_detailed' };
  }

  const careers = await findCareersPage(db, ctx, fetch, opp, company);
  if (careers === null) {
    await addNote(
      db,
      ctx,
      opp.id,
      'Posting details not found automatically',
      `No careers page could be found for ${company.name}. If you know the posting URL, use Discovery > Capture posting to fill the details, or set the company's careers URL under Discovery > Companies.`,
    );
    return { outcome: 'no_careers_page' };
  }

  const page = careers.page;
  // Issue #260: persisted as soon as a guess exists, not only once a posting match confirms
  // it. detectAts() (queued inside saveCareersUrl) is the real gate -- it makes a live round
  // trip to the actual ATS vendor and only ever records a hit when real postings come back, so
  // this is the same bar already trusted for every other detected company, just triggered
  // earlier instead of behind a posting match that most pages never got. Waiting for a match
  // was circular: reliable matching needs the board that detection only ever ran to find once
  // a match had already happened.
  if (careers.guessed) await saveCareersUrl(db, ctx, company.id, page.url);

  const anchors = anchorsOf(page.html, page.url);
  for (const board of scanCareersHtml(page.html).slice(0, 3)) {
    anchors.push(...(await boardAnchors(fetch, board)));
  }
  const best = bestTitleMatch(anchors, opp.title);
  if (best === null) {
    await addNote(
      db,
      ctx,
      opp.id,
      'Posting not matched on the careers page',
      `The careers page ${page.url} lists no posting matching "${opp.title}". The role may be unlisted or named differently; use Discovery > Capture posting with the posting URL or text to fill the details.`,
    );
    return { outcome: 'no_match', careersUrl: page.url };
  }

  const workdayText = await workdayPostingText(fetch, best.url);
  const postingPage = workdayText === undefined ? await getPage(fetch, best.url) : null;
  const text =
    workdayText !== undefined
      ? workdayText
      : postingPage === null
        ? null
        : // A non-HTML body (e.g. a URL answering with JSON) is never stored verbatim (issue
          // #238): there is no sanitizer for an unknown non-HTML shape, so it is unreadable.
          /^\s*</.test(postingPage.html)
          ? sanitizeDescriptionText(postingPage.html)
          : null;
  if (text === null || text.trim().length === 0) {
    return notePostingUnreadable(
      db,
      ctx,
      opp.id,
      page.url,
      `The posting at ${best.url} could not be fetched.`,
    );
  }

  const fields = await extractFields(db, ctx, best.url, text);
  if (fields.descriptionMd === null) {
    return notePostingUnreadable(
      db,
      ctx,
      opp.id,
      page.url,
      `The posting at ${best.url} could not be parsed into a readable description.`,
    );
  }
  await updateOpportunity(db, ctx, opp.id, {
    descriptionMd: fields.descriptionMd,
    ...(opp.postingUrl == null ? { postingUrl: best.url } : {}),
    ...(opp.location == null && fields.location !== undefined ? { location: fields.location } : {}),
    ...(opp.remote == null && fields.remote !== undefined ? { remote: fields.remote } : {}),
    ...(opp.compNote == null && fields.compNote !== undefined ? { compNote: fields.compNote } : {}),
  });
  await addNote(
    db,
    ctx,
    opp.id,
    'Posting details filled from the careers page',
    `Matched "${opp.title}" to ${best.url} and filled the description${fields.location === undefined ? '' : ', location'}${fields.compNote === undefined ? '' : ', compensation'}.`,
  );

  // The hard-constraint guard's data arrives late on this path: the outreach said nothing,
  // but the posting states pay. Below the floor, the user gets a flag, not a silent entry.
  const floor = await compFloor(db, ctx);
  if (floor !== null && fields.compNote !== undefined) {
    const amounts = dollarAmounts(fields.compNote);
    if (amounts.length > 0 && Math.max(...amounts) < floor) {
      await addNote(
        db,
        ctx,
        opp.id,
        'Stated pay is below your compensation floor',
        `The posting states ${fields.compNote.slice(0, 200)}, below the ${floor.toLocaleString('en-US')} minimum of your role targets. Consider dismissing this opportunity.`,
      );
      await db
        .update(communications)
        .set({ needsReview: true, updatedAt: Date.now() })
        .where(and(eq(communications.userId, ctx.userId), eq(communications.opportunityId, opp.id)))
        .run();
    }
  }
  return { outcome: 'enriched', postingUrl: best.url };
}

const PayloadSchema = z.object({ opportunityId: z.string().min(1).max(64) }).strict();

export const opportunityEnrichJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: OPPORTUNITY_ENRICH_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 2,
  async run(db, payload, ctx: JobContext) {
    if (ctx.userId === null) throw new Error('opportunity.enrich needs a user');
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    const fetch = requireService(ctx, 'sourceFetch');
    await ctx.setResult(await enrichOpportunity(db, user, fetch, payload.opportunityId));
  },
};

/** Queues enrichment for a just-created outreach opportunity (idempotent per opportunity). */
export async function enqueueEnrich(db: Db, userId: string, opportunityId: string): Promise<void> {
  await enqueue(
    db,
    OPPORTUNITY_ENRICH_KIND,
    { opportunityId },
    { dedupeKey: enrichDedupeKey(opportunityId), userId },
  );
}
