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
import { greenhouseJidOf } from '@opportun/core';
import { and, eq, ne } from 'drizzle-orm';
import { GREENHOUSE_HOST } from '../adapters/sources/greenhouse';
import { ATS_MAX_BYTES } from '../adapters/sources/atsCommon';
import type { SourceContext } from '../adapters/discoverySource';
import type { Db } from '../db/client';
import { companies, discoverySources, opportunities } from '../db/schema';
import { boardFromUrl, boardOfSource } from '../jobs/atsDetect';
import { splitConfig } from '../repos/discovery';
import type { UserCtx } from '../repos/base';
import { postingAtsJobRefKeeping, verifiedGreenhouseRef, type AtsJobRef } from './atsJobRef';

/** Greenhouse boards asked about one link, at most (tl's criterion 1). */
export const MAX_TOKENS_TRIED = 3;

const TOKEN = /^[a-z0-9-]{1,100}$/;

/**
 * The company's known Greenhouse board tokens, in the order they are tried: its detected board
 * (ATS detection), then its Greenhouse discovery sources, then the boards of its other
 * opportunities' identities. Never anything read from the link.
 */
export async function knownGreenhouseTokens(
  db: Db,
  ctx: UserCtx,
  opp: { id: string; companyId: string },
): Promise<string[]> {
  const out: string[] = [];
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
    .all();
  for (const row of others) {
    if (row.atsJobRef?.kind === 'ats_greenhouse') add(row.atsJobRef.org);
  }
  return out.slice(0, MAX_TOKENS_TRIED);
}

/** Whether Greenhouse's API says board `token` holds job `jid`. Any failure is a no. */
async function boardHoldsJob(
  sctx: Pick<SourceContext, 'fetch' | 'log'>,
  token: string,
  jid: string,
): Promise<boolean> {
  let res;
  try {
    res = await sctx.fetch(`https://${GREENHOUSE_HOST}/v1/boards/${token}/jobs/${jid}`, {
      allowHosts: [GREENHOUSE_HOST],
      maxBytes: ATS_MAX_BYTES,
    });
  } catch (err) {
    // The token names the company's board: only the kind is logged (design 14.8).
    sctx.log.warn({ 'opportun.ats.kind': 'ats_greenhouse', err }, 'greenhouse job check failed');
    return false;
  }
  if (res.status !== 200) return false;
  try {
    const body = JSON.parse(res.body.toString('utf8')) as { id?: unknown };
    return String(body.id) === jid;
  } catch {
    return false;
  }
}

/**
 * A verified Greenhouse identity for a `gh_jid` link on a company's own page, or null: the first
 * of the company's known boards whose API answers with that job. One request per token tried.
 */
export async function verifyEmbeddedGreenhouse(
  db: Db,
  ctx: UserCtx,
  opp: { id: string; companyId: string },
  link: string,
  sctx: Pick<SourceContext, 'fetch' | 'log'>,
  now: number = Date.now(),
): Promise<AtsJobRef | null> {
  if (boardFromUrl(link) !== null) return null;
  const jid = greenhouseJidOf(link);
  if (jid === null) return null;
  for (const token of await knownGreenhouseTokens(db, ctx, opp)) {
    if (await boardHoldsJob(sctx, token, jid)) return verifiedGreenhouseRef(token, jid, now);
  }
  return null;
}

/**
 * The identity a posting link gets when it is set or changed outside a board read (attach of a
 * link from mail, a capture or the user; a URL edit): the keeping rule first, so an identity
 * already verified for the same job costs nothing, then the check above for a `gh_jid` link.
 */
export async function resolvePostingAtsJobRef(
  db: Db,
  ctx: UserCtx,
  opp: { id: string; companyId: string; atsJobRef: AtsJobRef | null | undefined },
  link: string | null | undefined,
  sctx: Pick<SourceContext, 'fetch' | 'log'>,
): Promise<AtsJobRef | null> {
  const kept = postingAtsJobRefKeeping(link, opp.atsJobRef);
  if (kept !== null || link == null) return kept;
  return await verifyEmbeddedGreenhouse(db, ctx, opp, link, sctx);
}
