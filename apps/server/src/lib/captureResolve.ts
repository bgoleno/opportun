// A job capture becomes an opportunity (design D1, D2, D3, D11, D12, D15, D20, D22, D23, D24).
//
// Capturing a job is an act of interest, not an act of filing: "I won't capture something I am
// not interested in" (owner decision, 2026-10-19). So a capture never produces a review-queue card. It
// produces an opportunity at `interested`, from all three starting states.
//
// This closes #17 and the FR-D7 gap behind it. FR-D7 already says a lead that cannot be
// resolved automatically is "queued for one-click user capture: the user opens the posting link
// in their own browser and captures it via the extension". The paste path implemented that
// (routes/capture.ts resolveLeadInPlace, reached with a resultId); the extension path stored a
// second `[multi-posted]` lead beside the first instead.
//
// Everything runs through one path (D22): a capture with no matching lead creates the discovery
// result and immediately accepts it, so every opportunity a capture makes genuinely has a
// result behind it and `sourceKind: 'discovery'` with `sourceRef` is accurate rather than a
// convenient lie. No SOURCE_KINDS enum migration.
//
// C-1: nothing here fetches anything. The posting URL is provenance metadata.
import { enqueue } from './jobQueue';
import {
  CAPTURE_SITES,
  cardKey,
  dedupeGroupKey,
  dedupeKey,
  sameTitle,
  type NormalizedPosting,
  type OpportunityStage,
} from '@opportun/core';
import { and, asc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  boundLockWaits,
  isLockWaitEnded,
  lockScope,
  withTransaction,
  type Db,
  type Exec,
} from '../db/client';
import { ilike, jsonText, likePrefix } from '../db/dialect';
import { discoveryResults, discoveryRuns, discoverySources, opportunities } from '../db/schema';
import { POSTING_RECONCILE_KIND } from './jobKinds';
import { sanitizePosting } from './postingSanitize';
import { CAPTURE_SLOT } from './captureLimit';
import { HttpError } from './errors';
import { racePoint } from './racePoints';
import { boardFromUrl } from './atsBoard';
import { postingIdentity, siteLabel, siteOfUrl } from './captureSites';
import { sourceLabel } from './sourceLabels';
import { descriptionFingerprint } from './postingFingerprint';
import { createActivity } from '../repos/activities';
import type { UserCtx } from '../repos/base';
import {
  createRun,
  ensureChannelSource,
  findChainTarget,
  getResult,
  ingestScope,
  insertResult,
  setDisposition,
  setResolution,
  type DiscoveryResultView,
} from '../repos/discovery';
import {
  afterStageChange,
  createOpportunity,
  DescriptionChanged,
  getOpportunity,
  setPostingState,
  transitionOpportunityIn,
  updateOpportunity,
  type OpportunityView,
} from '../repos/opportunities';
import { continuesTrace } from '../obs/workflow';

export interface CaptureInput {
  posting: NormalizedPosting;
  /** The page text as the extension read it, kept whole on the timeline (D12). */
  captureText: string;
  /** Which site it came from, for the timeline entry and the merge heading (D5). */
  siteId: string;
  /** Says which step after the save gave up a wait (#914). */
  log?: Pick<FastifyBaseLogger, 'warn'>;
}

export interface CaptureResolution {
  opportunityId: string;
  /** The discovery result this capture is now recorded as. */
  resultId: string;
  createdOpportunity: boolean;
  /** The stage it was moved to, or null when the stage was left alone (D3). */
  stageMovedTo: OpportunityStage | null;
  /** The stage it is at, read at the end. */
  currentStage: OpportunityStage;
  /** Other leads for the same job, accepted against the same opportunity (D23), its card's included. */
  linkedLeadIds: string[];
  /** How many of them were on the card of the lead it completed. */
  linked: number;
  /**
   * What became of the captured description, when there is something to say: `added` to an opportunity
   * that was there, or `kept` the one it had. Neither when the stored text is the captured one already,
   * or when the fill gave up (`filled`).
   */
  description?: 'added' | 'kept';
  /** False when the capture is saved and the details the opportunity lacked are not (#914). */
  filled: boolean;
}

/** The note on the stage entry a capture makes. */
const CAPTURED_NOTE = 'Captured from the browser extension.';

/** Stages a capture advances to `interested`. Everything else is left exactly as it is (D3). */
const ADVANCES_FROM: ReadonlySet<OpportunityStage> = new Set(['discovered', 'dismissed']);

/**
 * The rows of this user that might carry `identity`, as SQL. postingIdentity decides; this only
 * has to let through every way a lead can store the job id, so the decision runs on a handful
 * of rows rather than on all of the user's results (https://github.com/bgoleno/opportun/issues/80):
 * - `externalId` as `<site>:<id>` (the extension) or the bare `<id>` (an alert parser), in any
 *   case, since postingIdentity lowercases both;
 * - the id only in the posting URL, beside another source's opaque `externalId` or none. A
 *   substring is enough here: a longer id that contains this one, or the same characters on
 *   another site, is let through and then rejected by postingIdentity.
 * `identity` is already lowercase (postingIdentity), and so is every candidate.
 */
function mayCarryIdentity(identity: string): SQL {
  const bare = identity.slice(identity.indexOf(':') + 1);
  const externalId = jsonText(discoveryResults.posting, 'externalId');
  return or(
    inArray(sql`lower(trim(${externalId}))`, [identity, bare]),
    ilike(jsonText(discoveryResults.posting, 'postingUrl'), bare),
  ) as SQL;
}

/**
 * A result's identity, read beside a capture's. postingIdentity, and one case more: a job alert's
 * result whose own link gives none, and whose bare id is the capture's, is the capture's posting.
 * That is a lead whose job was found on the company's board (jobs/leadResolve.ts merged): the board's
 * link has replaced the site's, and the alert's id is all that is left of it. Only the alert parsers
 * store a bare id that is a site's; from any other source it is opaque
 * (tl, https://github.com/bgoleno/opportun/issues/967#issuecomment-7120119028).
 */
function identityBeside(capture: string | null, result: DiscoveryResultView): string | null {
  const own = postingIdentity(result.posting);
  if (own !== null || capture === null || result.sourceKind !== 'alert_email') return own;
  const bare = (result.posting.externalId ?? '').trim().toLowerCase();
  return bare !== '' && capture === `${siteOfIdentity(capture)}:${bare}` ? capture : null;
}

/** Results of this user whose posting is the same req as `posting`. */
async function resultsWithIdentity(
  db: Exec,
  ctx: UserCtx,
  identity: string,
): Promise<DiscoveryResultView[]> {
  const rows = await db
    .select({ id: discoveryResults.id })
    .from(discoveryResults)
    .where(and(eq(discoveryResults.userId, ctx.userId), mayCarryIdentity(identity)))
    .all();
  const found: DiscoveryResultView[] = [];
  for (const row of rows) {
    const result = await getResult(db, ctx, row.id);
    // The scan is a prefilter: identity is what decides, so a Greenhouse lead whose opaque id
    // happens to be the same digits, or a URL that merely contains them, is not a match.
    if (identityBeside(identity, result) === identity) found.push(result);
  }
  return found;
}

/** Results of this user carrying `key`, whatever their disposition. */
async function resultsWithKey(db: Exec, ctx: UserCtx, key: string): Promise<DiscoveryResultView[]> {
  const rows = await db
    .select({ id: discoveryResults.id })
    .from(discoveryResults)
    .where(and(eq(discoveryResults.userId, ctx.userId), eq(discoveryResults.dedupeKey, key)))
    .all();
  const results: DiscoveryResultView[] = [];
  // One at a time: they all run on the transaction's one client.
  for (const r of rows) results.push(await getResult(db, ctx, r.id));
  return results;
}

/** Sources whose cards open a posting on the site itself, whatever the address they hold. */
const READ_ON_THE_SITE: ReadonlySet<string> = new Set(['alert_email', 'mcp']);

/**
 * Whether a lead's link can be one that opens the captured posting without saying so: none, one on a
 * site's own pages that names no job (a sponsored link with no job key), or one on some other host (a
 * short link). Not one on a site's mobile or country pages or a board's, which name a posting in a way
 * nothing here reads, and not text that is no link.
 */
function saysNothingOfThePosting(link: string | null | undefined): boolean {
  if (link == null || link.trim() === '') return true;
  let host: string;
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (siteOfUrl(link) !== null) return true;
  const labels = host.split('.');
  return !CAPTURE_SITES.some((s) => labels.includes(s.id)) && boardFromUrl(link) === null;
}

/**
 * Pending cards with no id that can be read (a short link, a sponsored one with no job key), of the
 * capture's company and whole title. The last resort: nothing may follow such a link (C-1), and the
 * user captured the posting it opened. The location is ignored, as on one card (cardKey). Never a
 * board's card, the user's own paste or one resolved on a board, and never one with an id of its
 * own, or a link that names one: that is another posting (tl, as above).
 */
async function pendingWithoutId(
  db: Exec,
  ctx: UserCtx,
  posting: NormalizedPosting,
  key: string,
): Promise<DiscoveryResultView[]> {
  const members = (await cardOf(db, ctx, posting, key)).filter(
    (r) =>
      READ_ON_THE_SITE.has(r.sourceKind) &&
      r.resolution !== 'resolved_ats' &&
      postingIdentity(r.posting) === null &&
      saysNothingOfThePosting(r.posting.postingUrl) &&
      !(r.sourceKind === 'alert_email' && isAnyJobId(r.posting.externalId ?? '')),
  );
  const results: DiscoveryResultView[] = [];
  // One at a time: they all run on the transaction's one client.
  for (const { id } of members) results.push(await getResult(db, ctx, id));
  return results;
}

const isAnyJobId = (id: string): boolean => CAPTURE_SITES.some((s) => s.isJobId(id.trim()));

/** What a capture needs of a posting on a card, without its description. */
interface CardMember {
  id: string;
  dedupeKey: string;
  sourceKind: DiscoveryResultView['sourceKind'];
  resolution: DiscoveryResultView['resolution'];
  posting: NormalizedPosting;
}

/**
 * The user's pending results on one card (cardKey): `key` is the stored key they are found by. In one
 * read, and without their descriptions, which can be 50,000 characters each: a card can have very
 * many, and they are found under the user's locks (sec on #976 and #980).
 */
async function cardOf(
  db: Exec,
  ctx: UserCtx,
  posting: NormalizedPosting,
  key: string,
): Promise<CardMember[]> {
  const card = cardKey(key, posting.company, posting.title);
  const field = (name: string) => jsonText(discoveryResults.posting, name);
  const rows = await db
    .select({
      id: discoveryResults.id,
      dedupeKey: discoveryResults.dedupeKey,
      sourceKind: discoverySources.kind,
      resolution: discoveryResults.resolution,
      company: field('company'),
      title: field('title'),
      location: field('location'),
      postingUrl: field('postingUrl'),
      externalId: field('externalId'),
    })
    .from(discoveryResults)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
    .innerJoin(discoverySources, eq(discoverySources.id, discoveryRuns.sourceId))
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        eq(discoveryResults.disposition, 'pending'),
        likePrefix(discoveryResults.dedupeKey, `${dedupeGroupKey(key)}|`),
      ),
    )
    .orderBy(asc(discoveryResults.createdAt), asc(discoveryResults.id))
    .all();
  return rows.flatMap(
    ({ id, dedupeKey: stored, sourceKind, resolution, company, title, ...rest }) =>
      stored !== null &&
      company !== null &&
      title !== null &&
      cardKey(stored, company, title) === card
        ? [{ id, dedupeKey: stored, sourceKind, resolution, posting: { company, title, ...rest } }]
        : [],
  );
}

async function opportunityWithKey(
  db: Exec,
  ctx: UserCtx,
  key: string,
): Promise<OpportunityView | null> {
  const row = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.dedupeKey, key)))
    .get();
  return row === undefined ? null : await getOpportunity(db, ctx, row.id);
}

/** The holder of a key a capture must not attach to, and why. */
interface KeptApart {
  opportunity: OpportunityView;
  /** `posting`: every lead behind it is a different posting on the same site. `level`: its title is
   *  another level's, which the key strips. */
  why: 'posting' | 'level';
}

interface Match {
  opportunity: OpportunityView | null;
  /**
   * The live opportunity holding the capture's dedupe key that it must not attach to. The capture
   * then gets its own opportunity, flagged as a possible duplicate of this one.
   */
  keptApartFrom: KeptApart | null;
  /** The leads have no id that can be read: matched by company and whole title alone. */
  withoutId: boolean;
  /** Pending leads this capture consumes, best first. */
  leads: DiscoveryResultView[];
  /** Leads for this req already accepted, so a re-capture reuses one instead of adding noise. */
  accepted: DiscoveryResultView[];
}

/** The site part of a `<site>:<id>` identity. */
const siteOfIdentity = (identity: string): string => identity.slice(0, identity.indexOf(':'));

/**
 * True when two posting identities say the postings are different reqs. Only ids on the same
 * site can say that: a LinkedIn job id and an Indeed job key say nothing about each other, so a
 * LinkedIn capture of the req behind a pending Indeed alert lead still key-matches it, as it did
 * before Indeed was a capture site (https://github.com/bgoleno/opportun/issues/73).
 */
function identitiesContradict(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a !== b && siteOfIdentity(a) === siteOfIdentity(b);
}

/**
 * What this capture already corresponds to. Posting identity first, dedupe key second (D20):
 * the key carries a location, and a capture only has one when the optional `capture.linkedin`
 * refine step ran, so a key-only match misses exactly when AI is unavailable.
 */
async function findMatch(db: Exec, ctx: UserCtx, posting: NormalizedPosting): Promise<Match> {
  const identity = postingIdentity(posting);
  const key = dedupeKey(posting.company, posting.title, posting.location);

  const byIdentity = identity === null ? [] : await resultsWithIdentity(db, ctx, identity);
  // The dedupe key is the weaker signal, so a key match only counts when it does not contradict
  // an identity: stripSeniority makes "Staff PM" and "Principal PM" at one company share a key,
  // and those are different reqs the user decides about, not this capture.
  const byKey = (await resultsWithKey(db, ctx, key)).filter(
    (r) =>
      sameTitle(r.posting.title, posting.title) &&
      !identitiesContradict(identity, identityBeside(identity, r)),
  );

  const ids = new Set(byIdentity.map((r) => r.id));
  const keyOnly = byKey.filter((r) => !ids.has(r.id));
  const found = [...byIdentity, ...keyOnly];
  // Not when the posting has a result of its own already: then it is that one's, and a card that came
  // later is another posting until its own is captured.
  const lastResort =
    byIdentity.length > 0 || found.some((r) => r.disposition === 'pending')
      ? []
      : await pendingWithoutId(db, ctx, posting, key);
  // A lead found by id is the posting; one found by its key is it too, for all anyone knows.
  const leads = [...pendingOf(byIdentity), ...pendingOf(keyOnly), ...pendingOf(lastResort)];
  const withoutId = lastResort.length > 0;

  // An accepted candidate names the opportunity directly, which is the only way to reach one
  // by identity: opportunities carry no externalId column.
  const accepted = found.filter((r) => r.disposition === 'accepted');
  for (const decided of accepted) {
    if (decided.opportunityId !== null) {
      const opp = await getOpportunity(db, ctx, decided.opportunityId).catch(() => null);
      // One ingest linked, found by its key alone, names its role while that is open: after that another
      // posting of its place is a new opening, for a capture as for Accept (#990). By its id it is the
      // very posting.
      const isOver =
        decided.rankSkipReason === 'linked' &&
        !ids.has(decided.id) &&
        opp !== null &&
        OVER.has(opp.stage);
      if (opp !== null && !isOver) {
        return { opportunity: opp, keptApartFrom: null, leads, withoutId, accepted };
      }
    }
  }
  // An opportunity carries no identity of its own, so the key is all there is to go on.
  // D20's residual case: a key collision with nothing to contradict it attaches, visibly and
  // reversibly, rather than failing the capture.
  const holder = await keyHolder(db, ctx, key, identity, posting.title);
  return { ...holder, leads, withoutId, accepted };
}

/** Stages at which a role is over: another location of it is a new one (the owner). */
const OVER: ReadonlySet<OpportunityStage> = new Set(['closed', 'dismissed']);

/**
 * The open opportunity that holds the key of another posting on this card; the oldest, if several.
 * Not one the captured posting has just been kept apart from.
 */
async function holderOfCard(
  db: Exec,
  ctx: UserCtx,
  card: readonly CardMember[],
  keptApartFrom: KeptApart | null,
): Promise<OpportunityView | null> {
  const keys = [...new Set(card.map((r) => r.dedupeKey))];
  const held = new Set<string | null>();
  for (let i = 0; i < keys.length; i += ROWS_AT_ONCE) {
    const rows = await db
      .select({ dedupeKey: opportunities.dedupeKey })
      .from(opportunities)
      .where(
        and(
          eq(opportunities.userId, ctx.userId),
          inArray(opportunities.dedupeKey, keys.slice(i, i + ROWS_AT_ONCE)),
        ),
      )
      .all();
    for (const row of rows) held.add(row.dedupeKey);
  }
  const holders: OpportunityView[] = [];
  const read: LeadsRead = new Map();
  for (const r of card) {
    if (!held.has(r.dedupeKey)) continue;
    const { opportunity } = await keyHolder(
      db,
      ctx,
      r.dedupeKey,
      postingIdentity(r.posting),
      r.posting.title,
      read,
    );
    if (opportunity === null || OVER.has(opportunity.stage)) continue;
    if (opportunity.id !== keptApartFrom?.opportunity.id) holders.push(opportunity);
  }
  return holders.sort((x, y) => x.createdAt - y.createdAt)[0] ?? null;
}

/** Rows of one statement (SQLite's bound on its variables is far above). */
const ROWS_AT_ONCE = 500;

/** Accepts pending results of the user's into one opportunity: a card can have very many. */
async function acceptPending(
  tx: Exec,
  ctx: UserCtx,
  ids: readonly string[],
  opportunityId: string,
): Promise<void> {
  for (let i = 0; i < ids.length; i += ROWS_AT_ONCE) {
    await tx
      .update(discoveryResults)
      .set({ disposition: 'accepted', opportunityId, updatedAt: Date.now() })
      .where(
        and(
          eq(discoveryResults.userId, ctx.userId),
          eq(discoveryResults.disposition, 'pending'),
          inArray(discoveryResults.id, ids.slice(i, i + ROWS_AT_ONCE)),
        ),
      )
      .run();
  }
}

/**
 * The leads the user accepted, or a capture took, into an opportunity. Not one ingest linked (#971):
 * nobody decided it, and it gave the opportunity nothing, so it says neither who holds a key nor where
 * a description came from (sec on https://github.com/bgoleno/opportun/pull/985).
 */
async function leadsBehind(
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

/** The leads behind each opportunity already looked at: a card can have many postings of one key. */
type LeadsRead = Map<string, DiscoveryResultView[]>;

/** A lead of a location of its own, under a key that is not `key`. */
const isElsewhere = (r: DiscoveryResultView, key: string): boolean =>
  (r.posting.location ?? '').trim() !== '' && r.dedupeKey !== null && r.dedupeKey !== key;

/**
 * The opportunity holding `key`, split by whether this capture may attach to it.
 *
 * The opportunity has no identity of its own, but the leads accepted against it do. When every
 * one of them is a different posting on the capture's site, the key match is the same
 * contradiction findMatch already drops for leads: for Indeed, whose capture carries no
 * location, "Senior" and "Principal" at one company, or one title in two cities, share a key on
 * every capture after the first (https://github.com/bgoleno/opportun/issues/73). An opportunity
 * with no leads, or with any lead that does not contradict, keeps D20's attach, when its own title is
 * the same whole title (sameTitle): one at another level is another job, whatever is behind it.
 *
 * A lead of another location of the role (it has one, and is stored under another key) says nothing of
 * who holds this key: Accept chains those (#971), and they made the next capture of the role's own page
 * a second opportunity.
 */
async function keyHolder(
  db: Exec,
  ctx: UserCtx,
  key: string,
  identity: string | null,
  title: string,
  read: LeadsRead = new Map(),
): Promise<Pick<Match, 'opportunity' | 'keptApartFrom'>> {
  const opp = await opportunityWithKey(db, ctx, key);
  if (opp === null) return { opportunity: null, keptApartFrom: null };
  let leads = identity === null ? [] : read.get(opp.id);
  if (leads === undefined) {
    leads = await leadsBehind(db, ctx, opp.id);
    read.set(opp.id, leads);
  }
  const behind = leads.filter((r) => !isElsewhere(r, key));
  const contradicted =
    behind.length > 0 &&
    behind.every((r) => identitiesContradict(identity, identityBeside(identity, r)));
  if (contradicted)
    return { opportunity: null, keptApartFrom: { opportunity: opp, why: 'posting' } };
  return sameTitle(opp.title, title)
    ? { opportunity: opp, keptApartFrom: null }
    : { opportunity: null, keptApartFrom: { opportunity: opp, why: 'level' } };
}

/** Pending leads, the one to complete first: the sole `needs_capture`, else the oldest. */
function pendingOf(results: DiscoveryResultView[]): DiscoveryResultView[] {
  const pending = results
    .filter((r) => r.disposition === 'pending')
    .sort((x, y) => x.createdAt - y.createdAt);
  const needsCapture = pending.filter((r) => r.resolution === 'needs_capture');
  if (needsCapture.length !== 1) return pending;
  const first = needsCapture[0] as DiscoveryResultView;
  return [first, ...pending.filter((r) => r.id !== first.id)];
}

/**
 * Records a lead folded into this opportunity, the way the accept route's `attachTo` branch
 * does (design D2, D23). Without it a capture silently eats a lead and leaves nothing saying
 * which, which is what D20 leaned on to call the residual key-collision case reversible.
 */
async function recordFoldedLead(
  db: Exec,
  ctx: UserCtx,
  opportunityId: string,
  lead: Pick<CardMember, 'sourceKind' | 'posting'>,
): Promise<void> {
  const p = lead.posting;
  await createActivity(db, ctx, opportunityId, {
    kind: 'link',
    title: `Also posted via ${sourceLabel(lead.sourceKind)}`,
    bodyMd: [`${p.company}: ${p.title}`, p.location ?? null]
      .filter((l): l is string => l !== null)
      .join('\n'),
    occurredAt: Date.now(),
    participants: [],
    externalUrl: p.postingUrl ?? null,
  });
}

/** The capture's own text on the timeline, before any description is written (D12). */
async function recordCapture(
  db: Exec,
  ctx: UserCtx,
  opportunityId: string,
  input: CaptureInput,
): Promise<void> {
  await createActivity(db, ctx, opportunityId, {
    kind: 'capture',
    title: `Captured from ${siteLabel(input.siteId)}`,
    bodyMd: input.captureText,
    occurredAt: Date.now(),
    participants: [],
    externalUrl: input.posting.postingUrl ?? null,
  });
}

/**
 * Whether an opportunity's description is a stand-in for the captured page: the text an accepted lead
 * of this very posting came with (the same id on the same site), exactly as it was stored, and
 * nothing the system has written since. The user editing it, by one space even, makes it theirs.
 * Never a lead resolved on a board: that text is the employer's (D4).
 */
async function isStandIn(
  db: Exec,
  ctx: UserCtx,
  opp: OpportunityView,
  identity: string | null,
): Promise<boolean> {
  if (identity === null || opp.descriptionMd == null || opp.descriptionFingerprint != null) {
    return false;
  }
  return (await leadsBehind(db, ctx, opp.id)).some(
    (r) =>
      r.resolution !== 'resolved_ats' &&
      identityBeside(identity, r) === identity &&
      r.posting.descriptionMd === opp.descriptionMd,
  );
}

/**
 * Fills what the opportunity lacks, and puts the page in place of a stand-in for it (isStandIn). Never
 * blanks a field, and replaces no other description, whoever wrote it. True when it wrote the
 * description.
 *
 * The description rule is narrower than `isSystemWritten`, deliberately. That predicate asks
 * "did the system write this", which is the right question for the board merge (it may replace
 * its own earlier stand-in) and the wrong one here: the reconcile job's merged output matches
 * its own fingerprint, so a re-capture would have overwritten the employer's copy with the
 * aggregator's page text and then skipped the re-search that would have restored it. The ATS
 * copy wins every conflict (design D4), and a capture fills missing fields only (D15, D24).
 *
 * The description is written only while it is still the one read (`ifDescription`): an edit the user
 * saves meanwhile wins, and the rest is filled.
 *
 * A location that would make it another opportunity of the user's (its company, title and that
 * location, 409 duplicate) is left out, and the rest is filled, as the posting check does
 * (lib/postingReconcile): the capture is recorded by now, so refusing it would have it recorded again
 * with each retry (em and tl on https://github.com/bgoleno/opportun/issues/914). It is not said:
 * `filled: false` is for what can be added by hand, and this would be refused there too. Called in one
 * transaction: each try is a savepoint, and a wait that ends in a later one undoes them all.
 */
async function fillOpportunity(
  db: Exec,
  ctx: UserCtx,
  opp: OpportunityView,
  posting: NormalizedPosting,
  identity: string | null,
): Promise<boolean> {
  let patch: Parameters<typeof updateOpportunity>[3] = {};
  const hasDescription = opp.descriptionMd != null && opp.descriptionMd.trim() !== '';
  if (posting.descriptionMd && (!hasDescription || (await isStandIn(db, ctx, opp, identity)))) {
    patch.descriptionMd = posting.descriptionMd;
    patch.descriptionFingerprint = descriptionFingerprint(posting.descriptionMd);
  }
  if (opp.postingUrl == null && posting.postingUrl != null) patch.postingUrl = posting.postingUrl;
  if (opp.location == null && posting.location != null) patch.location = posting.location;
  if (opp.remote == null && posting.remote != null) patch.remote = posting.remote;
  if (opp.compNote == null && posting.compNote != null) patch.compNote = posting.compNote;
  for (;;) {
    if (Object.keys(patch).length === 0) return false;
    const writes = patch.descriptionMd !== undefined;
    try {
      const { descriptionMd, descriptionFingerprint: fingerprint } = opp;
      await updateOpportunity(
        db,
        ctx,
        opp.id,
        patch,
        writes ? { ifDescription: { descriptionMd, descriptionFingerprint: fingerprint } } : {},
      );
      return writes;
    } catch (err) {
      // Each is left out at most once, so this ends.
      patch = { ...patch };
      if (err instanceof DescriptionChanged && writes) {
        delete patch.descriptionMd;
        delete patch.descriptionFingerprint;
      } else if (isDuplicate(err) && patch.location !== undefined) {
        delete patch.location;
      } else {
        throw err;
      }
    }
  }
}

const isDuplicate = (err: unknown): boolean => err instanceof HttpError && err.code === 'duplicate';

/**
 * createOpportunity's override, only when this capture was kept apart from the key's holder. The
 * new opportunity then has no dedupe key and records the holder as a possible duplicate (#9), so
 * the user still sees the two side by side. Without a kept-apart holder the unique key stays the
 * guard against two captures racing into two opportunities.
 */
const forceIfKeptApart = (keptApartFrom: KeptApart | null): { force?: boolean } =>
  keptApartFrom === null ? {} : { force: true };

/** Says on the new opportunity's timeline which similar one it was kept apart from, and why. */
async function recordKeptApart(
  db: Exec,
  ctx: UserCtx,
  opportunityId: string,
  { opportunity: other, why }: KeptApart,
  siteId: string,
): Promise<void> {
  await createActivity(db, ctx, opportunityId, {
    kind: 'link',
    title:
      why === 'level'
        ? 'Kept apart from a job at another level'
        : `Kept apart from a different ${siteLabel(siteId)} posting`,
    bodyMd: [`${other.companyName}: ${other.title}`, other.location ?? null]
      .filter((l): l is string => l !== null)
      .join('\n'),
    occurredAt: Date.now(),
    participants: [],
    externalUrl: other.postingUrl ?? null,
  });
}

/**
 * Advances `discovered` and `dismissed` to `interested`; leaves every other stage alone (D3). Reads
 * the stage under the lock: two captures of one posting would otherwise both read `discovered`, and
 * the second would fail on a move to where it already is.
 */
async function advance(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  waitMs: number,
): Promise<OpportunityView | null> {
  return await withTransaction(
    db,
    async (tx) => {
      await boundLockWaits(tx, waitMs);
      const { stage } = await getOpportunity(tx, ctx, opportunityId);
      if (!ADVANCES_FROM.has(stage)) return null;
      await racePoint('captureResolve.advance.locked');
      return await transitionOpportunityIn(tx, ctx, opportunityId, {
        to: 'interested',
        // Leaving a terminal stage needs this; a capture of something dismissed means the user
        // changed their mind (owner decision, 2026-10-19).
        ...(stage === 'dismissed' ? { reopen: true } : {}),
        note: CAPTURED_NOTE,
      });
    },
    // A bounded wait for the lock (#309): resolveCapture runs in the user's capture slot.
    { scope: ingestScope(ctx), lockTimeoutMs: waitMs },
  );
}

/** Stores the capture as a new accepted lead of the user's extension channel source. */
async function createLead(
  db: Exec,
  ctx: UserCtx,
  posting: NormalizedPosting,
): Promise<DiscoveryResultView> {
  const source = await ensureChannelSource(db, ctx, 'extension');
  const run = await createRun(db, ctx, { sourceId: source.id });
  return await insertResult(db, ctx, {
    runId: run.id,
    posting,
    dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
    // A capture always carries the page text, so the lead is complete by construction.
    resolution: 'full',
  });
}

const FILLED_FIELDS = ['postingUrl', 'location', 'remote', 'compNote'] as const;

/**
 * The lead's posting with what the capture knows and the lead lacks, and nothing else, but for the
 * description when the lead is this very posting (`samePosting`): what it has is then a stand-in for
 * the page, a snippet or a pasted text, and the page replaces it. Not when that text is the
 * employer's own, found on its board (D4). A field the
 * capture has no value for is not added, not even as null. A rank call in flight compares the
 * posting's stored text to the text it ranked (setRankingIfPostingIs), so a capture that adds
 * nothing must leave the text exactly as it was, or the paid score is refused for a key a row had
 * never had (https://github.com/bgoleno/opportun/issues/268).
 */
function fillFrom(
  lead: NormalizedPosting,
  capture: NormalizedPosting,
  samePosting: boolean,
): NormalizedPosting {
  const filled: NormalizedPosting = {
    ...lead,
    descriptionMd: samePosting
      ? capture.descriptionMd || lead.descriptionMd
      : lead.descriptionMd || capture.descriptionMd,
  };
  for (const field of FILLED_FIELDS) {
    // eslint-disable-next-line security/detect-object-injection -- field is a FILLED_FIELDS literal
    const value = capture[field];
    // eslint-disable-next-line security/detect-object-injection -- same fixed field name
    if (lead[field] == null && value != null) Object.assign(filled, { [field]: value });
  }
  return filled;
}

/** CaptureResolution's `description`, from the opportunity as it is at the end. */
function describe(
  opp: OpportunityView,
  posting: NormalizedPosting,
  added: boolean,
  filled: boolean,
): Pick<CaptureResolution, 'description'> {
  if (added) return { description: 'added' };
  const own = opp.descriptionMd ?? '';
  if (!filled || !posting.descriptionMd || own.trim() === '') return {};
  return own === posting.descriptionMd ? {} : { description: 'kept' };
}

/** What is logged for a step after the save that gave up a wait (#914): its name, nothing else. */
type GaveUp =
  | 'saved capture: the kept-apart note gave up a lock wait'
  | 'saved capture: the fill gave up a lock wait'
  | 'saved capture: the stage move gave up a lock wait'
  | 'saved capture: what follows a stage move gave up a lock wait'
  | 'saved capture: the posting state gave up a lock wait';

interface Settled {
  opportunity: OpportunityView;
  resultId: string;
  createdOpportunity: boolean;
  keptApartFrom: KeptApart | null;
  linkedLeadIds: string[];
  linked: number;
}

/**
 * Looks for what the capture corresponds to, and records the row that says it was taken. A run's
 * check reads a pending row from another source as another posting of the same job and stores its
 * own, so a capture's row is accepted before anyone can see it. Takes only the transaction, so
 * nothing here can reach the database around it.
 */
async function settleLead(
  tx: Exec,
  ctx: UserCtx,
  posting: NormalizedPosting,
  identity: string | null,
): Promise<Settled> {
  // The user's lock, ahead of any row write (lock order, repos/submissionReview.ts submissionScope):
  // createOpportunity's company lookup takes it later, after setResolution or createLead has
  // written a row, and a writer holding it while it waits on that row would close a cycle (40P01).
  // The ingest lock is already held, taken by withTransaction below.
  // The same bounded wait as the ingest lock (#309): nothing is written yet, so a slow holder of
  // this one gets the capture refused cleanly too, not a 500 at statement_timeout.
  await lockScope(tx, `user:${ctx.userId}`, { timeoutMs: CAPTURE_SLOT.lockTimeoutMs });
  const match = await findMatch(tx, ctx, posting);
  await racePoint('captureResolve.matched.locked');
  const [primary, ...rest] = match.leads;
  // The card of a lead this consumes: every other location of the role still to be decided goes with
  // it (the owner, on https://github.com/bgoleno/opportun/issues/967). Their own ids say nothing here:
  // the user was shown one card, and captured it.
  const card =
    primary === undefined || primary.dedupeKey === null
      ? []
      : (await cardOf(tx, ctx, primary.posting, primary.dedupeKey)).filter(
          (r) => r.id !== primary.id,
        );

  let opportunity = match.opportunity;
  let keptApartFrom = match.keptApartFrom;
  let resultId: string;
  let createdOpportunity = false;

  if (primary !== undefined) {
    // The lead keeps its own identity (company, title, so its dedupe key) and gains the
    // description it was waiting for, exactly as the paste path's resolveLeadInPlace does.
    // One whose description a board gave stays known as that: the text is the employer's, and a later
    // capture must not take it for a stand-in (isStandIn).
    const onBoard = primary.resolution === 'resolved_ats';
    const filled = await setResolution(tx, ctx, primary.id, {
      resolution: onBoard ? 'resolved_ats' : 'full',
      resolvedSourceRef: onBoard ? primary.resolvedSourceRef : (posting.postingUrl ?? null),
      posting: fillFrom(
        primary.posting,
        posting,
        !onBoard && identity !== null && identityBeside(identity, primary) === identity,
      ),
    });
    resultId = filled.id;
    // The matched lead's own key may differ from the capture's, which is routine when the two
    // describe the location differently. A live opportunity holding *that* key is the same job
    // tracked already, and creating a second one would throw 409.
    // So is the key createOpportunity would claim, of the posting as it is now: a board or this capture
    // can have given the lead a location since its own was stored. The user's lock is held, so the
    // answers hold until the create.
    const { company, title, location } = filled.posting;
    for (const key of new Set([filled.dedupeKey, dedupeKey(company, title, location)])) {
      if (opportunity !== null || key === null) continue;
      const holder = await keyHolder(tx, ctx, key, identity, title);
      opportunity = holder.opportunity;
      keptApartFrom ??= holder.keptApartFrom;
    }
    // Then one that holds the key of another location on the card, and then the one an earlier location
    // of the role went to, as Accept does (findChainTarget), unless this posting has just been kept
    // apart from the holder of its key as another posting. One at another level is another job, which
    // refuses itself alone.
    opportunity ??= await holderOfCard(tx, ctx, card, keptApartFrom);
    if (opportunity === null && filled.dedupeKey !== null && keptApartFrom?.why !== 'posting') {
      const chained = await findChainTarget(tx, ctx, filled.dedupeKey, filled.posting);
      if (chained !== undefined && chained !== keptApartFrom?.opportunity.id) {
        opportunity = await getOpportunity(tx, ctx, chained);
      }
    }
    if (opportunity === null) {
      opportunity = await createOpportunity(
        tx,
        ctx,
        {
          companyName: filled.posting.company,
          title: filled.posting.title,
          descriptionMd: filled.posting.descriptionMd ?? null,
          // Of a lead with no id that can be read, the page's own link, which the user captured: whoever
          // sent the lead does not choose the one the opportunity shows (sec on #980).
          postingUrl:
            (match.withoutId ? posting.postingUrl : null) ?? filled.posting.postingUrl ?? null,
          location: filled.posting.location ?? null,
          remote: filled.posting.remote ?? null,
          compNote: filled.posting.compNote ?? null,
          roleTargetId: filled.roleTargetId,
          sourceKind: 'discovery',
          sourceRef: filled.id,
        },
        forceIfKeptApart(keptApartFrom),
      );
      createdOpportunity = true;
    }
    await setDisposition(tx, ctx, filled.id, 'accepted', opportunity.id);
    if (!createdOpportunity) await recordFoldedLead(tx, ctx, opportunity.id, filled);
  } else if (opportunity === null) {
    const lead = await createLead(tx, ctx, posting);
    resultId = lead.id;
    opportunity = await createOpportunity(
      tx,
      ctx,
      {
        companyName: lead.posting.company,
        title: lead.posting.title,
        descriptionMd: lead.posting.descriptionMd ?? null,
        postingUrl: lead.posting.postingUrl ?? null,
        location: lead.posting.location ?? null,
        remote: lead.posting.remote ?? null,
        compNote: lead.posting.compNote ?? null,
        roleTargetId: lead.roleTargetId,
        sourceKind: 'discovery',
        sourceRef: lead.id,
      },
      forceIfKeptApart(keptApartFrom),
    );
    createdOpportunity = true;
    await setDisposition(tx, ctx, lead.id, 'accepted', opportunity.id);
  } else {
    // Re-capturing a job already tracked reuses the lead that recorded it rather than piling
    // up one extension lead per capture.
    const holder = opportunity;
    const reusable = match.accepted.find((r) => r.opportunityId === holder.id);
    if (reusable !== undefined) {
      resultId = reusable.id;
    } else {
      const lead = await createLead(tx, ctx, posting);
      resultId = lead.id;
      await setDisposition(tx, ctx, lead.id, 'accepted', opportunity.id);
    }
  }

  // Leads this capture did not consume are linked rather than left pending: they would 409
  // against the now-live opportunity on every later accept (D23). So is the rest of the card.
  const linkedLeadIds: string[] = [];
  const others = new Map<string, Pick<CardMember, 'id' | 'sourceKind' | 'posting'>>(
    [...rest, ...card].map((r) => [r.id, r]),
  );
  await acceptPending(tx, ctx, [...others.keys()], opportunity.id);
  for (const other of others.values()) {
    await recordFoldedLead(tx, ctx, opportunity.id, other);
    linkedLeadIds.push(other.id);
  }
  // Said to be the system's with the description itself: a description without its fingerprint reads
  // as the user's own for good (tl on #955). The row is nobody else's yet, so nothing waits.
  if (createdOpportunity && opportunity.descriptionMd != null && opportunity.descriptionMd !== '') {
    opportunity = await updateOpportunity(tx, ctx, opportunity.id, {
      descriptionFingerprint: descriptionFingerprint(opportunity.descriptionMd),
    });
  }
  // At Interested with its creation, for the same reason: a step of its own could be skipped when its
  // lock was not to be had, and the capture then said the job was already tracked (#956).
  if (createdOpportunity) {
    await racePoint('captureResolve.created.locked');
    opportunity = await transitionOpportunityIn(tx, ctx, opportunity.id, {
      to: 'interested',
      note: CAPTURED_NOTE,
    });
  }
  return {
    opportunity,
    resultId,
    createdOpportunity,
    keptApartFrom,
    linkedLeadIds,
    linked: card.length,
  };
}

/**
 * Resolves one job capture to an opportunity at `interested`.
 *
 * The look and the row it leads to are one transaction under the lock a run's ingest takes, or a
 * run storing the posting at that moment leaves the board's pending card next to the capture's
 * accepted row (https://github.com/bgoleno/opportun/issues/268). The rest is sequential, as the
 * accept route is: what it writes only adds to an opportunity and a row a run already respects.
 */
export async function resolveCapture(
  db: Db,
  ctx: UserCtx,
  input: CaptureInput,
): Promise<CaptureResolution> {
  const posting = sanitizePosting(input.posting);
  const identity = postingIdentity(posting);
  // A bounded wait for the lock (#309): the caller runs this in the user's capture slot.
  const settled = await withTransaction(db, (tx) => settleLead(tx, ctx, posting, identity), {
    scope: ingestScope(ctx),
    lockTimeoutMs: CAPTURE_SLOT.lockTimeoutMs,
  });

  const { opportunity, resultId, createdOpportunity, keptApartFrom, linkedLeadIds, linked } =
    settled;

  await racePoint('captureResolve.settled');
  // Bounded as the locks above: nothing is on the timeline yet, so a wait that runs out is
  // capture_busy (withCaptureSlot), and the capture made again is recorded once (#914). It finds
  // what settleLead made.
  await withTransaction(db, async (tx) => {
    await boundLockWaits(tx, CAPTURE_SLOT.lockTimeoutMs);
    await recordCapture(tx, ctx, opportunity.id, { ...input, posting });
  });
  // The capture is saved from here on: settleLead's transaction and the entry are committed. So no
  // wait below makes the answer an error: "try again" would be untrue, and a retry would record it
  // twice (tl on https://github.com/bgoleno/opportun/pull/318, and on
  // https://github.com/bgoleno/opportun/issues/914). A step that cannot have its locks in time is
  // skipped. The one exception is the check's own job, queued at the end: swallowing that would leave
  // `searching` with no check behind it, so it may throw, as it always could.
  // One budget for them all: each step waits for what is left as it starts, and 1 ms when nothing is,
  // so a step nobody blocks still goes through. A step with several waits can overrun it, the fill by
  // its attempt's, user's and row's if three holders block it one after another: some 15 s, and 1 ms
  // for each step after.
  await racePoint('captureResolve.recorded');
  const deadline = Date.now() + CAPTURE_SLOT.lockTimeoutMs;
  const waitMs = (): number => Math.max(1, deadline - Date.now());
  /** The step's outcome, or null when it gave up a wait. Any other error throws. */
  async function unlessBlocked<T>(
    gaveUp: GaveUp,
    fn: () => Promise<T>,
  ): Promise<{ value: T } | null> {
    try {
      return { value: await fn() };
    } catch (err) {
      if (!isLockWaitEnded(err)) throw err;
      input.log?.warn({ 'opportun.opportunity.id': opportunity.id }, gaveUp);
      return null;
    }
  }
  const bounded = <T>(fn: (tx: Exec) => Promise<T>): Promise<T> =>
    withTransaction(db, async (tx) => {
      await boundLockWaits(tx, waitMs());
      return await fn(tx);
    });

  if (createdOpportunity && keptApartFrom !== null) {
    await unlessBlocked('saved capture: the kept-apart note gave up a lock wait', () =>
      bounded((tx) => recordKeptApart(tx, ctx, opportunity.id, keptApartFrom, input.siteId)),
    );
  }

  let filled = true;
  let describedIt = false;
  if (!createdOpportunity) {
    // updateOpportunity keeps its own lock order (the attempt, the user, rows): a savepoint in this
    // transaction, which holds nothing before it.
    const fill = await unlessBlocked('saved capture: the fill gave up a lock wait', () =>
      bounded((tx) => fillOpportunity(tx, ctx, opportunity, posting, identity)),
    );
    filled = fill !== null;
    describedIt = fill?.value ?? false;
  }

  // Before the stage move, whose lock a run or an alert may hold.
  await racePoint('captureResolve.saved');
  // A created one has moved already, with its creation.
  const stage = createdOpportunity
    ? { value: opportunity }
    : await unlessBlocked('saved capture: the stage move gave up a lock wait', () =>
        advance(db, ctx, opportunity.id, waitMs()),
      );
  const moved = stage?.value ?? null;
  // Its own step: the move is committed, whatever becomes of what follows it. A company's lookup
  // lost here is queued again by the opportunity's next move.
  if (moved !== null) {
    await unlessBlocked('saved capture: what follows a stage move gave up a lock wait', () =>
      afterStageChange(db, ctx, moved),
    );
  }

  const current = await getOpportunity(db, ctx, opportunity.id);
  if (current.postingState !== 'confirmed') {
    await unlessBlocked('saved capture: the posting state gave up a lock wait', () =>
      bounded((tx) =>
        setPostingState(tx, ctx, opportunity.id, {
          postingState: 'searching',
          postingStateDetail: null,
        }),
      ),
    );
    // Queued whatever was skipped: without `searching` the check still runs, and nothing on the page
    // says one does, so Find posting is not refused meanwhile.
    await enqueue(
      db,
      POSTING_RECONCILE_KIND,
      { opportunityId: opportunity.id },
      {
        dedupeKey: `${POSTING_RECONCILE_KIND}:${opportunity.id}`,
        userId: ctx.userId,
        // Continues the capture trace when queued from inside it (14.5), not otherwise.
        continueTrace: continuesTrace(),
      },
    );
  }

  return {
    opportunityId: opportunity.id,
    resultId,
    createdOpportunity,
    stageMovedTo: moved === null ? null : 'interested',
    currentStage: current.stage,
    ...describe(current, posting, describedIt, filled),
    linkedLeadIds,
    linked,
    filled,
  };
}
