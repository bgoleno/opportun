// Whose a posting is that is on an opportunity: its own, or another of the same role that joined it
// (https://github.com/bgoleno/opportun/issues/1037). A capture asks it of the page it has
// (lib/captureResolve.ts), and the posting check and Re-derive of the pages that are there
// (https://github.com/bgoleno/opportun/issues/1063, lib/postingReconcile.ts).
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { jsonText } from '../db/dialect';
import { discoveryResults, discoveryRuns, discoverySources } from '../db/schema';
import type { Exec, UserCtx } from '../repos/base';
import { getResult, type DiscoveryResultView } from '../repos/discovery';
import type { OpportunityView } from '../repos/opportunities';
import { postingIdentity } from './captureSites';

/** The site part of a `<site>:<id>` identity. */
const siteOfIdentity = (identity: string): string => identity.slice(0, identity.indexOf(':'));
const bareIdOf = (identity: string): string => identity.slice(identity.indexOf(':') + 1);

/**
 * True when two posting identities say the postings are different reqs. Only ids on the same
 * site can say that: a LinkedIn job id and an Indeed job key say nothing about each other, so a
 * LinkedIn capture of the req behind a pending Indeed alert lead still key-matches it, as it did
 * before Indeed was a capture site (https://github.com/bgoleno/opportun/issues/73).
 */
export function identitiesContradict(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a !== b && siteOfIdentity(a) === siteOfIdentity(b);
}

/**
 * A result's identity, read beside a capture's. postingIdentity, and one case more: a job alert's
 * result whose own link gives none, and whose bare id is the capture's, is the capture's posting.
 * That is a lead whose job was found on the company's board (jobs/leadResolve.ts merged): the board's
 * link has replaced the site's, and the alert's id is all that is left of it. Only the alert parsers
 * store a bare id that is a site's; from any other source it is opaque
 * (tl, https://github.com/bgoleno/opportun/issues/967#issuecomment-7120119028).
 */
export function identityBeside(capture: string | null, result: Lead): string | null {
  const own = postingIdentity(result.posting);
  if (own !== null || capture === null || result.sourceKind !== 'alert_email') return own;
  const bare = (result.posting.externalId ?? '').trim().toLowerCase();
  return bare !== '' && capture === `${siteOfIdentity(capture)}:${bare}` ? capture : null;
}

/**
 * The leads the user accepted, or a capture took, into an opportunity. Not one ingest linked (#971):
 * nobody decided it, and it gave the opportunity nothing, so it says neither who holds a key nor where
 * a description came from (sec on https://github.com/bgoleno/opportun/pull/985).
 */
export async function leadsBehind(
  db: Exec,
  ctx: UserCtx,
  opportunityId: string,
): Promise<DiscoveryResultView[]> {
  const rows = await db
    .select({ id: discoveryResults.id })
    .from(discoveryResults)
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        eq(discoveryResults.opportunityId, opportunityId),
        eq(discoveryResults.disposition, 'accepted'),
        or(isNull(discoveryResults.rankSkipReason), ne(discoveryResults.rankSkipReason, 'linked')),
      ),
    )
    .all();
  const results: DiscoveryResultView[] = [];
  // One at a time: they all run on the transaction's one client.
  for (const r of rows) results.push(await getResult(db, ctx, r.id));
  return results;
}

/** A lead of a location of its own, under a key that is not `key`. */
export const isElsewhere = (r: Lead, key: string): boolean =>
  (r.posting.location ?? '').trim() !== '' && r.dedupeKey !== null && r.dedupeKey !== key;

/** What is asked of a result, and not its description: there can be many. */
export type Lead = Pick<DiscoveryResultView, 'id' | 'dedupeKey' | 'sourceKind' | 'createdAt'> & {
  posting: Pick<NormalizedPosting, 'company' | 'title' | 'location' | 'postingUrl' | 'externalId'>;
};

/** The results behind an opportunity, and the one that stands for where it came from. */
interface Behind {
  behind: readonly Lead[];
  origin: Lead | undefined;
}

const placeOf = (location: string | null | undefined): string | null =>
  (location ?? '').trim() === '' ? null : dedupeKey('', '', location);

/** See isKnownOther: the result the opportunity came from, else the oldest of its place. */
function behindOf(opp: OpportunityView, behind: readonly Lead[]): Behind {
  const own = placeOf(opp.location);
  const ofThisPlace = behind.filter((r) => {
    const place = placeOf(r.posting.location);
    return own === null || place === null || place === own;
  });
  const origin =
    behind.find((r) => r.id === opp.sourceRef) ??
    ofThisPlace.sort((x, y) => x.createdAt - y.createdAt)[0];
  return { behind, origin };
}

/**
 * Whether the captured posting is known to be another than the opportunity's own
 * (https://github.com/bgoleno/opportun/issues/1037, tl): both places are there and differ, by the key's
 * own measure, or its id contradicts every lead behind it (of this place, when the places are the same).
 * What it says of its place, its link and its pay is then not the opportunity's.
 *
 * One found by its id is judged by what was stored of it (`sameId`), not by how its place reads this
 * time. It is never another when what was found of it (`found`, by id or key) is the result the
 * opportunity came from, whatever either's place reads as since. With no result of that kind, the oldest
 * of this place behind it stands for it: an opportunity made by hand has its first posting's facts.
 *
 * `read`: what is behind it, for a caller that asks of many postings.
 */
export async function isKnownOther(
  tx: Exec,
  ctx: UserCtx,
  opp: OpportunityView,
  posting: Lead['posting'],
  identity: string | null,
  found: readonly Lead[] = [],
  sameId: readonly Lead[] = [],
  read?: Behind,
): Promise<boolean> {
  const own = placeOf(opp.location);
  const { behind, origin } = read ?? behindOf(opp, await leadsBehind(tx, ctx, opp.id));
  if (found.some((r) => r.id === origin?.id)) return false;
  const places = (sameId.length > 0 ? sameId.map((r) => r.posting) : [posting]).map((p) =>
    placeOf(p.location),
  );
  if (own !== null && places.every((p) => p !== null && p !== own)) return true;
  if (identity === null) return false;
  const contradicts = (r: Lead): boolean =>
    identitiesContradict(identity, identityBeside(identity, r));
  if (sameId.length > 0) return origin !== undefined && contradicts(origin);
  const here = own !== null && places.includes(own);
  const key = dedupeKey(posting.company, posting.title, posting.location);
  const asked = here ? behind.filter((r) => !isElsewhere(r, key)) : behind;
  return asked.length > 0 && asked.every(contradicts);
}

/** The posting a captured page is of, by its link; null when that has no id. */
const identityOfPage = (page: { externalUrl: string | null }): string | null =>
  postingIdentity({ company: '', title: '', postingUrl: page.externalUrl });

/** Whether an opportunity's captured pages are of more than one posting. */
export const ofSeveralPostings = (pages: readonly { externalUrl: string | null }[]): boolean =>
  new Set(pages.map(identityOfPage)).size > 1;

/**
 * Of an opportunity's captured pages, newest first, the one of its own posting: another posting's, of the
 * role at another place say, can have joined since, and what it has is not the opportunity's
 * (https://github.com/bgoleno/opportun/issues/1063). Judged when it is read: the results with the page's
 * id say whose it is (isKnownOther), and a page with none is its own.
 *
 * With none of its own, the newest of the posting that was captured first. For an opportunity made by
 * hand that can be its own, the place respelled since by a posting check; and where only others were
 * ever captured, the first one's page is what the description came from.
 */
export async function ownPage<T extends { externalUrl: string | null }>(
  exec: Exec,
  ctx: UserCtx,
  opp: OpportunityView,
  pages: readonly T[],
): Promise<T | undefined> {
  const accepted = await acceptedInto(exec, ctx, opp.id);
  // As leadsBehind: not one that ingest linked.
  const read = behindOf(
    opp,
    accepted.filter((r) => r.rankSkipReason !== 'linked'),
  );
  // By the id each carries, as there can be as many results as pages: identityBeside then decides.
  const byId = new Map<string, Lead[]>();
  const add = (id: string, r: Lead) => {
    const there = byId.get(id);
    if (there === undefined) byId.set(id, [r]);
    else there.push(r);
  };
  for (const r of accepted) {
    const identity = postingIdentity(r.posting);
    const bare = (r.posting.externalId ?? '').trim().toLowerCase();
    if (identity !== null) add(identity, r);
    else if (bare !== '') add(bare, r);
  }
  const others = new Map<string, boolean>();
  for (const page of pages) {
    const identity = identityOfPage(page);
    if (identity === null) return page;
    let isOther = others.get(identity);
    if (isOther === undefined) {
      const known = [identity, bareIdOf(identity)]
        .flatMap((id) => byId.get(id) ?? [])
        .filter((r) => identityBeside(identity, r) === identity);
      isOther =
        known[0] !== undefined &&
        (await isKnownOther(exec, ctx, opp, known[0].posting, identity, known, known, read));
      others.set(identity, isOther);
    }
    if (!isOther) return page;
  }
  const last = pages.at(-1);
  if (last === undefined) return undefined;
  const first = identityOfPage(last);
  return pages.find((p) => identityOfPage(p) === first);
}

/** The results accepted into an opportunity, those that ingest linked included, in one read. */
async function acceptedInto(
  exec: Exec,
  ctx: UserCtx,
  opportunityId: string,
): Promise<(Lead & { rankSkipReason: string | null })[]> {
  const rows = await exec
    .select({
      id: discoveryResults.id,
      dedupeKey: discoveryResults.dedupeKey,
      createdAt: discoveryResults.createdAt,
      rankSkipReason: discoveryResults.rankSkipReason,
      sourceKind: discoverySources.kind,
      location: jsonText(discoveryResults.posting, 'location'),
      postingUrl: jsonText(discoveryResults.posting, 'postingUrl'),
      externalId: jsonText(discoveryResults.posting, 'externalId'),
    })
    .from(discoveryResults)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
    .innerJoin(discoverySources, eq(discoverySources.id, discoveryRuns.sourceId))
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        eq(discoveryResults.opportunityId, opportunityId),
        eq(discoveryResults.disposition, 'accepted'),
      ),
    )
    .all();
  return rows.map(({ location, postingUrl, externalId, ...row }) => ({
    ...row,
    // The company and the title are asked of a posting that no result has the id of: not of these.
    posting: { company: '', title: '', location, postingUrl, externalId },
  }));
}
