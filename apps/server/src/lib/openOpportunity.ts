// The opportunity a posting that reaches Discovery already has (#971, and the owner's decision on
// https://github.com/bgoleno/opportun/issues/967): so a job in the pipeline gets no second card and
// no second opportunity. In a file of its own, as ingest (lib/discoveryIngest.ts) and Accept
// (routes/discovery.ts) ask it. A capture finds its own the other way round (lib/captureResolve.ts),
// and the role through findChainTarget, as here.
import type { NormalizedPosting } from '@opportun/core';
import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { Exec } from '../db/client';
import { ilike, jsonText } from '../db/dialect';
import {
  activities,
  discoveryResults,
  discoveryRuns,
  discoverySources,
  opportunities,
} from '../db/schema';
import { createActivity } from '../repos/activities';
import type { UserCtx } from '../repos/base';
import { findChainTarget, type DiscoveryResultView } from '../repos/discovery';
import { postingIdentity } from './captureSites';
import { httpLink } from './httpLink';
import { sourceLabel } from './sourceLabels';

/**
 * The opportunity this very posting (one id on one site) was captured into, if it still exists and
 * is not dismissed. Closed counts: it is the posting that was closed, not a new opening of the role
 * (tl on #971). Nothing is read for a posting without an identity, which a board's is.
 *
 * The capture's own result has the id as its externalId, written with the opportunity. A capture
 * that reused another site's result has no result of its own, so its timeline entry names it too.
 */
export async function capturedInto(
  exec: Exec,
  ctx: UserCtx,
  posting: NormalizedPosting,
): Promise<string | undefined> {
  const identity = postingIdentity(posting);
  if (identity === null) return undefined;
  const result = await exec
    .select({ id: opportunities.id })
    .from(discoveryResults)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
    .innerJoin(discoverySources, eq(discoverySources.id, discoveryRuns.sourceId))
    .innerJoin(opportunities, eq(opportunities.id, discoveryResults.opportunityId))
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        eq(discoverySources.kind, 'extension'),
        ne(discoveryResults.disposition, 'pending'),
        // postingIdentity is lowercase.
        sql`lower(trim(${jsonText(discoveryResults.posting, 'externalId')})) = ${identity}`,
        ne(opportunities.stage, 'dismissed'),
      ),
    )
    .orderBy(asc(opportunities.createdAt), asc(opportunities.id))
    .limit(1)
    .get();
  if (result !== undefined) return result.id;
  const entries = await exec
    .select({ id: opportunities.id, url: activities.externalUrl })
    .from(activities)
    .innerJoin(opportunities, eq(opportunities.id, activities.opportunityId))
    .where(
      and(
        eq(activities.userId, ctx.userId),
        eq(activities.kind, 'capture'),
        isNotNull(activities.externalUrl),
        // Any address with the id in it; postingIdentity decides.
        ilike(activities.externalUrl, identity.slice(identity.indexOf(':') + 1)),
        ne(opportunities.stage, 'dismissed'),
      ),
    )
    .orderBy(asc(opportunities.createdAt), asc(opportunities.id))
    .all();
  return entries.find(
    ({ url }) => postingIdentity({ company: '', title: '', postingUrl: url }) === identity,
  )?.id;
}

/**
 * The opportunity an accepted posting goes to instead of making one: the one this very posting was
 * captured into, else the open one of its card (findChainTarget). `key` is its stored dedupe key.
 */
export async function openOpportunityFor(
  exec: Exec,
  ctx: UserCtx,
  posting: NormalizedPosting,
  key: string,
): Promise<string | undefined> {
  return (
    (await capturedInto(exec, ctx, posting)) ?? (await findChainTarget(exec, ctx, key, posting))
  );
}

/** The timeline entry of another posting of a job already tracked: its source, location and link. */
export async function recordAlsoPosted(
  exec: Exec,
  ctx: UserCtx,
  opportunityId: string,
  result: DiscoveryResultView,
): Promise<void> {
  const p = result.posting;
  await createActivity(exec, ctx, opportunityId, {
    kind: 'link',
    title: `Also posted via ${sourceLabel(result.sourceKind)}`,
    bodyMd: [`${p.company}: ${p.title}`, p.location ?? null]
      .filter((l): l is string => l !== null)
      .join('\n'),
    occurredAt: Date.now(),
    participants: [],
    externalUrl: httpLink(p.postingUrl),
  });
}
