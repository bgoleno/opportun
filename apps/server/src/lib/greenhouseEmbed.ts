// Proving which Greenhouse board holds a job linked from a company's own careers page
// (https://github.com/bgoleno/opportun/issues/398, tl's criteria 1 and 5).
//
// A link like `https://careers.<company>.com/jobs?gh_jid=<id>` names a Greenhouse job id, but its
// host is the company's and it says nothing reliable about the board (its `board=` parameter can
// name another one, #140). So the link alone never gives an identity. Greenhouse's own API is
// asked, for at most three of the company's known board tokens, whether that board holds the job;
// the first that answers with it gives the identity, and the handoff then goes to that board's
// page (greenhouseBoardJobUrl), never to the link. Nothing is fetched from the company's domain.
//
// The request is made only when a posting link is set or changed (attach, a URL edit) and on
// Find posting, never on a page view, and never by the writers that keep or drop an identity
// without asking (postingAtsJobRefKeeping).
import { boardFromUrl, boardOfSource } from './atsBoard';
import { greenhouseJidOf } from '@opportun/core';
import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { GREENHOUSE_HOST } from '../adapters/sources/greenhouse';
import { ATS_MAX_BYTES } from '../adapters/sources/atsCommon';
import type { SourceContext } from '../adapters/discoverySource';
import type { Db } from '../db/client';
import { companies, discoverySources, opportunities } from '../db/schema';
import { splitConfig } from '../repos/discovery';
import type { UserCtx } from '../repos/base';
import { postingAtsJobRefKeeping, verifiedGreenhouseRef, type AtsJobRef } from './atsJobRef';

/** Greenhouse boards asked about one link, at most (tl's criterion 1). */
export const MAX_TOKENS_TRIED = 3;

/**
 * The time every board check for one link may take in all (#598): each request gets what is left
 * of it, and none starts once it is spent. A save waited up to 15 s a board before, 45 s in all.
 * When it runs out the save goes on with no identity, as when no board holds the job.
 */
export const EMBED_CHECK_BUDGET_MS = 5000;

const TOKEN = /^[a-z0-9-]{1,100}$/;

/**
 * The company's known Greenhouse board tokens, in the order they are tried: its detected board
 * (ATS detection), then its Greenhouse discovery sources, then the boards of its other
 * opportunities' identities, each group newest first (#598: read with no order before, so which
 * three were tried was the database's choice). Never anything read from the link. A company not
 * yet known (`companyId` null: a save naming a new one) has no board.
 */
export async function knownGreenhouseTokens(
  db: Db,
  ctx: UserCtx,
  opp: { id: string; companyId: string | null },
): Promise<string[]> {
  const out: string[] = [];
  if (opp.companyId === null) return out;
  const add = (token: string | null | undefined): void => {
    const t = token?.toLowerCase();
    if (t !== undefined && TOKEN.test(t) && !out.includes(t)) out.push(t);
  };
  const company = await db
    .select({ atsKind: companies.atsKind, atsRef: companies.atsRef })
    .from(companies)
    .where(and(eq(companies.userId, ctx.userId), eq(companies.id, opp.companyId)))
    .get();
  if (company?.atsKind === 'ats_greenhouse') add(company.atsRef);
  const sources = await db
    .select()
    .from(discoverySources)
    .where(
      and(
        eq(discoverySources.userId, ctx.userId),
        eq(discoverySources.companyId, opp.companyId),
        eq(discoverySources.kind, 'ats_greenhouse'),
      ),
    )
    .orderBy(desc(discoverySources.createdAt), desc(discoverySources.id))
    .all();
  for (const source of sources) {
    add(boardOfSource(source.kind, splitConfig(source).config)?.slug);
  }
  const others = await db
    .select({ atsJobRef: opportunities.atsJobRef })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.userId, ctx.userId),
        eq(opportunities.companyId, opp.companyId),
        ne(opportunities.id, opp.id),
      ),
    )
    .orderBy(desc(opportunities.createdAt), desc(opportunities.id))
    .all();
  for (const row of others) {
    if (row.atsJobRef?.kind === 'ats_greenhouse') add(row.atsJobRef.org);
  }
  return out.slice(0, MAX_TOKENS_TRIED);
}

/**
 * What Greenhouse's API says about board `token` and job `jid`: it holds it, it does not, or no
 * answer came (the request failed, timed out, or the board was busy: #685, a later check can ask
 * again). `timeoutMs` undefined is the fetch's own limit.
 */
async function boardHoldsJob(
  sctx: Pick<SourceContext, 'fetch' | 'log'>,
  token: string,
  jid: string,
  timeoutMs: number | undefined,
): Promise<'yes' | 'no' | 'unknown'> {
  let res;
  try {
    res = await sctx.fetch(`https://${GREENHOUSE_HOST}/v1/boards/${token}/jobs/${jid}`, {
      allowHosts: [GREENHOUSE_HOST],
      maxBytes: ATS_MAX_BYTES,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  } catch (err) {
    // The token names the company's board: only the kind is logged (design 14.8).
    sctx.log.warn({ 'opportun.ats.kind': 'ats_greenhouse', err }, 'greenhouse job check failed');
    return 'unknown';
  }
  if (res.status === 429 || res.status >= 500) return 'unknown';
  if (res.status !== 200) return 'no';
  try {
    const body = JSON.parse(res.body.toString('utf8')) as { id?: unknown };
    return String(body.id) === jid ? 'yes' : 'no';
  } catch {
    return 'no';
  }
}

/** What a check found: an identity, or none, and whether some board gave no answer (#685). */
export interface EmbedCheck {
  ref: AtsJobRef | null;
  /** A known board was not asked, or gave no answer, before a yes: a later check may find it. */
  undecided: boolean;
}

/**
 * Asks the company's known boards in turn whether they hold the link's job. With `budgetMs` (a
 * save), every board's request gets an even share of what is left (#685: a board that hangs uses
 * only its own share, so the next are still asked) and none starts once it is spent; null (the
 * background check) leaves each request to the fetch's own limits.
 */
export async function checkEmbeddedGreenhouse(
  db: Db,
  ctx: UserCtx,
  opp: { id: string; companyId: string | null },
  link: string,
  sctx: Pick<SourceContext, 'fetch' | 'log'>,
  now: number,
  budgetMs: number | null,
): Promise<EmbedCheck> {
  if (boardFromUrl(link) !== null) return { ref: null, undecided: false };
  const jid = greenhouseJidOf(link);
  if (jid === null) return { ref: null, undecided: false };
  const tokens = await knownGreenhouseTokens(db, ctx, opp);
  const deadline = budgetMs === null ? null : Date.now() + budgetMs;
  let undecided = false;
  for (const [i, token] of tokens.entries()) {
    let share: number | undefined;
    if (deadline !== null) {
      const left = deadline - Date.now();
      if (left <= 0) return { ref: null, undecided: true };
      share = Math.max(1, Math.floor(left / (tokens.length - i)));
    }
    const said = await boardHoldsJob(sctx, token, jid, share);
    if (said === 'yes') return { ref: verifiedGreenhouseRef(token, jid, now), undecided: false };
    if (said === 'unknown') undecided = true;
  }
  return { ref: null, undecided };
}

/**
 * A verified Greenhouse identity for a `gh_jid` link on a company's own page, or null: the first
 * of the company's known boards whose API answers with that job. One request per token tried, all
 * of them within `budgetMs` (#598).
 */
export async function verifyEmbeddedGreenhouse(
  db: Db,
  ctx: UserCtx,
  opp: { id: string; companyId: string | null },
  link: string,
  sctx: Pick<SourceContext, 'fetch' | 'log'>,
  now: number = Date.now(),
  budgetMs: number = EMBED_CHECK_BUDGET_MS,
): Promise<AtsJobRef | null> {
  return (await checkEmbeddedGreenhouse(db, ctx, opp, link, sctx, now, budgetMs)).ref;
}

/**
 * Sets the identity a check found, only while the opportunity's link is still the one checked
 * and it has none yet (#685): a check that finishes after a later save changed the link, or after
 * another found an identity, writes nothing. The condition is in the UPDATE itself, so there is no
 * window between a read and this write. Answers whether it was set.
 */
export async function setCheckedPostingRef(
  db: Db,
  ctx: UserCtx,
  id: string,
  link: string,
  ref: AtsJobRef,
): Promise<boolean> {
  const updated = await db
    .update(opportunities)
    .set({ atsJobRef: ref, updatedAt: Date.now() })
    .where(
      and(
        eq(opportunities.userId, ctx.userId),
        eq(opportunities.id, id),
        eq(opportunities.postingUrl, link),
        isNull(opportunities.atsJobRef),
      ),
    )
    .returning({ id: opportunities.id })
    .all();
  return updated.length > 0;
}

/** The background check of a saved link whose boards did not all answer in time (#685). */
export const POSTING_CHECK_KIND = 'opportunity.greenhouse_check';

/** One job per opportunity and link at a time: the link itself is hashed into the key. */
export function postingCheckKey(opportunityId: string, link: string): string {
  return `${opportunityId}:${createHash('sha256').update(link).digest('hex').slice(0, 32)}`;
}

/**
 * The identity a posting link gets when it is set or changed outside a board read (attach of a
 * link from mail, a capture or the user; a URL edit): the keeping rule first, so an identity
 * already verified for the same job costs nothing, then the check above for a `gh_jid` link.
 */
export async function resolvePostingAtsJobRef(
  db: Db,
  ctx: UserCtx,
  opp: { id: string; companyId: string | null; atsJobRef: AtsJobRef | null | undefined },
  link: string | null | undefined,
  sctx: Pick<SourceContext, 'fetch' | 'log'>,
): Promise<AtsJobRef | null> {
  const kept = postingAtsJobRefKeeping(link, opp.atsJobRef);
  if (kept !== null || link == null) return kept;
  return await verifyEmbeddedGreenhouse(db, ctx, opp, link, sctx);
}
