// Lead resolution (FR-D7). A partial lead (an alert email or a URL-only manual capture: a company,
// a title, maybe a link, no description) is matched against the ATS boards of companies the user
// already knows. A confident match fills the description and link from the ATS posting
// (resolution 'resolved_ats'); otherwise the lead stays 'needs_capture' for the user to capture.
//
// Where ATS postings come from, in order:
//   1. postings already cached as results of the company's ATS sources (no network);
//   2. a live lookup through a LiveAtsLookup. The default asks the registered adapter for the
//      source's kind (the shipped Greenhouse, Lever and Ashby adapters), so the only endpoints
//      ever fetched are those adapters' fixed ATS API hosts through safeFetch.
// The lead's own posting URL is never fetched: it is often a LinkedIn job link, which stays
// metadata only (and safeFetch refuses prohibited hosts in any case).
import type { NormalizedPosting } from '@opportun/core';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  ATS_SOURCE_KINDS,
  getSource,
  hasSource,
  type SourceContext,
} from '../adapters/discoverySource';
import type { Db } from '../db/client';
import { jsonText } from '../db/dialect';
import { companies, discoveryResults, discoveryRuns, discoverySources } from '../db/schema';
import { HttpError } from '../lib/errors';
import { sanitizePosting } from '../lib/postingSanitize';
import type { UserCtx } from '../repos/base';
import {
  getResult,
  setResolution,
  splitConfig,
  type DiscoveryResultView,
  type DiscoverySourceRow,
} from '../repos/discovery';
import { DISCOVERY_RANK_KIND, LEAD_RESOLVE_KIND } from './discoveryKinds';
import { requireService, type JobHandler } from './registry';
import { enqueue } from './runner';

export { LEAD_RESOLVE_KIND };

/** Minimum normalized title token overlap for a confident match. */
export const TITLE_MATCH_THRESHOLD = 0.6;
/** Cached ATS results considered per lead (newest first). */
const MAX_CACHED = 500;
/** Postings read from one live board at most. */
const MAX_LIVE = 2000;

/**
 * The seam Task 9's adapters satisfy: the postings currently on the ATS board `source` points
 * at, raw (they are sanitized here). Tests inject their own.
 */
export type LiveAtsLookup = (
  sctx: SourceContext,
  source: DiscoverySourceRow,
) => Promise<NormalizedPosting[]>;

/** The default live lookup: the registered adapter for an ATS kind; nothing for other kinds. */
export const registryLiveLookup: LiveAtsLookup = async (sctx, source) => {
  if (!ATS_SOURCE_KINDS.includes(source.kind) || !hasSource(source.kind)) return [];
  const { config } = splitConfig(source);
  const out: NormalizedPosting[] = [];
  for await (const item of getSource(source.kind).fetchPostings(sctx, config, null)) {
    out.push(item.posting);
    if (out.length >= MAX_LIVE) break;
  }
  return out;
};

/** Lowercase, diacritics removed, letters and digits only (company names compare on this). */
export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .normalize('NFKD')
      .toLowerCase()
      .replace(/\p{M}/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0),
  );
}

/** Shared tokens over the larger token set: 1 for the same words, 0 for none in common. */
export function titleOverlap(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  const larger = Math.max(ta.size, tb.size);
  if (larger === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / larger;
}

function isPartial(p: NormalizedPosting): boolean {
  return p.descriptionMd == null || p.descriptionMd.trim() === '';
}

/** The best-matching full posting (first wins a tie, so pass newest first). */
function bestMatch(
  lead: NormalizedPosting,
  candidates: NormalizedPosting[],
): NormalizedPosting | null {
  let best: NormalizedPosting | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (isPartial(c)) continue;
    const score = titleOverlap(lead.title, c.title);
    if (score >= TITLE_MATCH_THRESHOLD && score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** The user's ATS sources for companies whose name matches the lead's company. */
async function atsSourcesFor(db: Db, ctx: UserCtx, company: string): Promise<DiscoverySourceRow[]> {
  const wanted = normalizeName(company);
  if (wanted === '') return [];
  const companyIds = (
    await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.userId, ctx.userId))
      .all()
  )
    .filter((c) => normalizeName(c.name) === wanted)
    .map((c) => c.id);
  if (companyIds.length === 0) return [];
  return await db
    .select()
    .from(discoverySources)
    .where(
      and(
        eq(discoverySources.userId, ctx.userId),
        inArray(discoverySources.companyId, companyIds),
        inArray(discoverySources.kind, [...ATS_SOURCE_KINDS]),
      ),
    )
    .all();
}

async function cachedPostings(
  db: Db,
  ctx: UserCtx,
  sourceIds: string[],
): Promise<NormalizedPosting[]> {
  return (
    await db
      .select({ posting: discoveryResults.posting })
      .from(discoveryResults)
      .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
      .where(
        and(
          eq(discoveryResults.userId, ctx.userId),
          inArray(discoveryRuns.sourceId, sourceIds),
          isNotNull(jsonText(discoveryResults.posting, 'descriptionMd')),
        ),
      )
      .orderBy(desc(discoveryResults.createdAt), desc(discoveryResults.id))
      .limit(MAX_CACHED)
      .all()
  ).map((r) => r.posting as NormalizedPosting);
}

function merged(lead: NormalizedPosting, ats: NormalizedPosting): NormalizedPosting {
  return {
    ...lead,
    descriptionMd: ats.descriptionMd ?? null,
    postingUrl: ats.postingUrl ?? lead.postingUrl ?? null,
    location: lead.location ?? ats.location ?? null,
    remote: lead.remote ?? ats.remote ?? null,
    compNote: lead.compNote ?? ats.compNote ?? null,
    postedAt: lead.postedAt ?? ats.postedAt ?? null,
  };
}

export type LeadOutcome =
  | { status: 'resolved_ats'; ref: string | null; via: 'cache' | 'live' }
  | { status: 'needs_capture' }
  | { status: 'skipped'; reason: 'missing' | 'not_partial' | 'not_pending' };

/** Resolves one of the user's partial leads. Never fetches the lead's own URL. */
export async function resolveLead(
  db: Db,
  ctx: UserCtx,
  resultId: string,
  sctx: SourceContext,
  opts: { live?: LiveAtsLookup } = {},
): Promise<LeadOutcome> {
  let result: DiscoveryResultView;
  try {
    result = await getResult(db, ctx, resultId);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) {
      return { status: 'skipped', reason: 'missing' };
    }
    throw err;
  }
  if (result.disposition !== 'pending') return { status: 'skipped', reason: 'not_pending' };
  const lead = result.posting;
  if (!isPartial(lead)) return { status: 'skipped', reason: 'not_partial' };

  const sources = await atsSourcesFor(db, ctx, lead.company);
  let match: NormalizedPosting | null = null;
  let via: 'cache' | 'live' = 'cache';
  if (sources.length > 0) {
    match = bestMatch(
      lead,
      await cachedPostings(
        db,
        ctx,
        sources.map((s) => s.id),
      ),
    );
    if (match === null) {
      const live = opts.live ?? registryLiveLookup;
      via = 'live';
      for (const source of sources) {
        let postings: NormalizedPosting[];
        try {
          postings = (await live(sctx, source)).map(sanitizePosting);
        } catch (err) {
          // One unreachable board does not fail the lead; it can still be captured by hand.
          sctx.log.warn({ sourceId: source.id, err }, 'lead resolution lookup failed');
          continue;
        }
        match = bestMatch(lead, postings);
        if (match !== null) break;
      }
    }
  }
  if (match === null) {
    await setResolution(db, ctx, result.id, {
      resolution: 'needs_capture',
      resolvedSourceRef: null,
    });
    return { status: 'needs_capture' };
  }
  const ref = match.externalId ?? match.postingUrl ?? null;
  await setResolution(db, ctx, result.id, {
    resolution: 'resolved_ats',
    resolvedSourceRef: ref,
    posting: merged(lead, match),
  });
  return { status: 'resolved_ats', ref, via };
}

const PayloadSchema = z.object({ resultId: z.string().min(1).max(64) });

export const leadResolveJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: LEAD_RESOLVE_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 3,
  async run(db, payload, ctx) {
    if (ctx.userId === null) throw new Error(`${LEAD_RESOLVE_KIND} needs a user`);
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    const outcome = await resolveLead(db, user, payload.resultId, {
      fetch: requireService(ctx, 'sourceFetch'),
      log: requireService(ctx, 'log'),
    });
    await ctx.setResult(outcome);
    // Rank once the lead is as complete as it will get (resolved or not).
    if (outcome.status !== 'skipped' || outcome.reason === 'not_partial') {
      await enqueue(
        db,
        DISCOVERY_RANK_KIND,
        { resultId: payload.resultId },
        { dedupeKey: `${DISCOVERY_RANK_KIND}:${payload.resultId}`, userId: user.userId },
      );
    }
  },
};
