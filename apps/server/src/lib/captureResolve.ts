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
import { dedupeKey, type NormalizedPosting, type OpportunityStage } from '@opportun/core';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { lockScope, withTransaction, type Db, type Exec } from '../db/client';
import { ilike, jsonText } from '../db/dialect';
import { discoveryResults, opportunities } from '../db/schema';
import { POSTING_RECONCILE_KIND } from '../jobs/discoveryKinds';
import { enqueue } from '../jobs/runner';
import { sanitizePosting } from './postingSanitize';
import { CAPTURE_SLOT } from './captureLimit';
import { racePoint } from './racePoints';
import { postingIdentity, siteLabel } from './captureSites';
import { sourceLabel } from './sourceLabels';
import { descriptionFingerprint } from './postingFingerprint';
import { createActivity } from '../repos/activities';
import type { UserCtx } from '../repos/base';
import {
  createRun,
  ensureChannelSource,
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
  getOpportunity,
  setPostingState,
  transitionOpportunityIn,
  updateOpportunity,
  type OpportunityView,
} from '../repos/opportunities';

export interface CaptureInput {
  posting: NormalizedPosting;
  /** The page text as the extension read it, kept whole on the timeline (D12). */
  captureText: string;
  /** Which site it came from, for the timeline entry and the merge heading (D5). */
  siteId: string;
}

export interface CaptureResolution {
  opportunityId: string;
  /** The discovery result this capture is now recorded as. */
  resultId: string;
  createdOpportunity: boolean;
  /** The stage it was moved to, or null when the stage was left alone (D3). */
  stageMovedTo: OpportunityStage | null;
  /** Other leads for the same job, accepted against the same opportunity (D23). */
  linkedLeadIds: string[];
}

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
    if (postingIdentity(result.posting) === identity) found.push(result);
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

interface Match {
  opportunity: OpportunityView | null;
  /**
   * The live opportunity holding the capture's dedupe key that it must not attach to, because
   * every lead behind it is a different posting on the same site. The capture then gets its own
   * opportunity, flagged as a possible duplicate of this one.
   */
  keptApartFrom: OpportunityView | null;
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
    (r) => !identitiesContradict(identity, postingIdentity(r.posting)),
  );

  const seen = new Set<string>();
  const candidates = [...byIdentity, ...byKey].filter((r) =>
    seen.has(r.id) ? false : (seen.add(r.id), true),
  );

  // An accepted candidate names the opportunity directly, which is the only way to reach one
  // by identity: opportunities carry no externalId column.
  const accepted = candidates.filter((r) => r.disposition === 'accepted');
  for (const decided of accepted) {
    if (decided.opportunityId !== null) {
      const opp = await getOpportunity(db, ctx, decided.opportunityId).catch(() => null);
      if (opp !== null) {
        return { opportunity: opp, keptApartFrom: null, leads: pendingOf(candidates), accepted };
      }
    }
  }
  // An opportunity carries no identity of its own, so the key is all there is to go on.
  // D20's residual case: a key collision with nothing to contradict it attaches, visibly and
  // reversibly, rather than failing the capture.
  const holder = await keyHolder(db, ctx, key, identity);
  return { ...holder, leads: pendingOf(candidates), accepted };
}

/** Accepted leads recorded against an opportunity. */
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
      ),
    )
    .all();
  const results: DiscoveryResultView[] = [];
  // One at a time: they all run on the transaction's one client.
  for (const r of rows) results.push(await getResult(db, ctx, r.id));
  return results;
}

/**
 * The opportunity holding `key`, split by whether this capture may attach to it.
 *
 * The opportunity has no identity of its own, but the leads accepted against it do. When every
 * one of them is a different posting on the capture's site, the key match is the same
 * contradiction findMatch already drops for leads: for Indeed, whose capture carries no
 * location, "Senior" and "Principal" at one company, or one title in two cities, share a key on
 * every capture after the first (https://github.com/bgoleno/opportun/issues/73). An opportunity
 * with no leads, or with any lead that does not contradict, keeps D20's attach.
 */
async function keyHolder(
  db: Exec,
  ctx: UserCtx,
  key: string,
  identity: string | null,
): Promise<Pick<Match, 'opportunity' | 'keptApartFrom'>> {
  const opp = await opportunityWithKey(db, ctx, key);
  if (opp === null || identity === null) return { opportunity: opp, keptApartFrom: null };
  const behind = await leadsBehind(db, ctx, opp.id);
  const contradicted =
    behind.length > 0 &&
    behind.every((r) => identitiesContradict(identity, postingIdentity(r.posting)));
  return contradicted
    ? { opportunity: null, keptApartFrom: opp }
    : { opportunity: opp, keptApartFrom: null };
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
  lead: DiscoveryResultView,
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
  db: Db,
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
 * Fills what the opportunity lacks. Never blanks a field, and never replaces a description
 * that is already there, whoever wrote it.
 *
 * The description rule is narrower than `isSystemWritten`, deliberately. That predicate asks
 * "did the system write this", which is the right question for the board merge (it may replace
 * its own earlier stand-in) and the wrong one here: the reconcile job's merged output matches
 * its own fingerprint, so a re-capture would have overwritten the employer's copy with the
 * aggregator's page text and then skipped the re-search that would have restored it. The ATS
 * copy wins every conflict (design D4), and a capture fills missing fields only (D15, D24).
 */
async function fillOpportunity(
  db: Db,
  ctx: UserCtx,
  opp: OpportunityView,
  posting: NormalizedPosting,
): Promise<void> {
  const patch: Parameters<typeof updateOpportunity>[3] = {};
  const hasDescription = opp.descriptionMd != null && opp.descriptionMd.trim() !== '';
  if (!hasDescription && posting.descriptionMd) {
    patch.descriptionMd = posting.descriptionMd;
    patch.descriptionFingerprint = descriptionFingerprint(posting.descriptionMd);
  }
  if (opp.postingUrl == null && posting.postingUrl != null) patch.postingUrl = posting.postingUrl;
  if (opp.location == null && posting.location != null) patch.location = posting.location;
  if (opp.remote == null && posting.remote != null) patch.remote = posting.remote;
  if (opp.compNote == null && posting.compNote != null) patch.compNote = posting.compNote;
  if (Object.keys(patch).length > 0) await updateOpportunity(db, ctx, opp.id, patch);
}

/**
 * createOpportunity's override, only when this capture was kept apart from the key's holder. The
 * new opportunity then has no dedupe key and records the holder as a possible duplicate (#9), so
 * the user still sees the two side by side. Without a kept-apart holder the unique key stays the
 * guard against two captures racing into two opportunities.
 */
const forceIfKeptApart = (keptApartFrom: OpportunityView | null): { force?: boolean } =>
  keptApartFrom === null ? {} : { force: true };

/** Says on the new opportunity's timeline which similar one it was kept apart from, and why. */
async function recordKeptApart(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  other: OpportunityView,
  siteId: string,
): Promise<void> {
  await createActivity(db, ctx, opportunityId, {
    kind: 'link',
    title: `Kept apart from a different ${siteLabel(siteId)} posting`,
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
): Promise<OpportunityStage | null> {
  const moved = await withTransaction(
    db,
    async (tx) => {
      const { stage } = await getOpportunity(tx, ctx, opportunityId);
      if (!ADVANCES_FROM.has(stage)) return null;
      await racePoint('captureResolve.advance.locked');
      return await transitionOpportunityIn(tx, ctx, opportunityId, {
        to: 'interested',
        // Leaving a terminal stage needs this; a capture of something dismissed means the user
        // changed their mind (owner decision, 2026-10-19).
        ...(stage === 'dismissed' ? { reopen: true } : {}),
        note: 'Captured from the browser extension.',
      });
    },
    // A bounded wait for the lock (#309): resolveCapture runs in the user's capture slot.
    { scope: ingestScope(ctx), lockTimeoutMs: CAPTURE_SLOT.lockTimeoutMs },
  );
  if (moved === null) return null;
  await afterStageChange(db, ctx, moved);
  return 'interested';
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
 * The lead's posting with what the capture knows and the lead lacks, and nothing else: a field the
 * capture has no value for is not added, not even as null. A rank call in flight compares the
 * posting's stored text to the text it ranked (setRankingIfPostingIs), so a capture that adds
 * nothing must leave the text exactly as it was, or the paid score is refused for a key a row had
 * never had (https://github.com/bgoleno/opportun/issues/268).
 */
function fillFrom(lead: NormalizedPosting, capture: NormalizedPosting): NormalizedPosting {
  const filled: NormalizedPosting = {
    ...lead,
    descriptionMd: lead.descriptionMd || capture.descriptionMd,
  };
  for (const field of FILLED_FIELDS) {
    // eslint-disable-next-line security/detect-object-injection -- field is a FILLED_FIELDS literal
    const value = capture[field];
    // eslint-disable-next-line security/detect-object-injection -- same fixed field name
    if (lead[field] == null && value != null) Object.assign(filled, { [field]: value });
  }
  return filled;
}

interface Settled {
  opportunity: OpportunityView;
  resultId: string;
  createdOpportunity: boolean;
  keptApartFrom: OpportunityView | null;
  linkedLeadIds: string[];
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
  await lockScope(tx, `user:${ctx.userId}`);
  const match = await findMatch(tx, ctx, posting);
  await racePoint('captureResolve.matched.locked');
  const [primary, ...rest] = match.leads;

  let opportunity = match.opportunity;
  let keptApartFrom = match.keptApartFrom;
  let resultId: string;
  let createdOpportunity = false;

  if (primary !== undefined) {
    // The lead keeps its own identity (company, title, so its dedupe key) and gains the
    // description it was waiting for, exactly as the paste path's resolveLeadInPlace does.
    const filled = await setResolution(tx, ctx, primary.id, {
      resolution: 'full',
      resolvedSourceRef: posting.postingUrl ?? null,
      posting: fillFrom(primary.posting, posting),
    });
    resultId = filled.id;
    // The matched lead's own key may differ from the capture's, which is routine when the two
    // describe the location differently. A live opportunity holding *that* key is the same job
    // tracked already, and creating a second one would throw 409.
    if (opportunity === null && filled.dedupeKey !== null) {
      const holder = await keyHolder(tx, ctx, filled.dedupeKey, identity);
      opportunity = holder.opportunity;
      keptApartFrom ??= holder.keptApartFrom;
    }
    if (opportunity === null) {
      opportunity = await createOpportunity(
        tx,
        ctx,
        {
          companyName: filled.posting.company,
          title: filled.posting.title,
          descriptionMd: filled.posting.descriptionMd ?? null,
          postingUrl: filled.posting.postingUrl ?? null,
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
  // against the now-live opportunity on every later accept (D23).
  const linkedLeadIds: string[] = [];
  for (const other of rest) {
    await setDisposition(tx, ctx, other.id, 'accepted', opportunity.id);
    await recordFoldedLead(tx, ctx, opportunity.id, other);
    linkedLeadIds.push(other.id);
  }
  return { opportunity, resultId, createdOpportunity, keptApartFrom, linkedLeadIds };
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

  const { opportunity, resultId, createdOpportunity, keptApartFrom, linkedLeadIds } = settled;

  await recordCapture(db, ctx, opportunity.id, { ...input, posting });
  if (createdOpportunity && keptApartFrom !== null) {
    await recordKeptApart(db, ctx, opportunity.id, keptApartFrom, input.siteId);
  }

  if (createdOpportunity) {
    // The create path already stored the description; record that the system wrote it.
    if (opportunity.descriptionMd != null && opportunity.descriptionMd !== '') {
      await updateOpportunity(db, ctx, opportunity.id, {
        descriptionFingerprint: descriptionFingerprint(opportunity.descriptionMd),
      });
    }
  } else {
    await fillOpportunity(db, ctx, opportunity, posting);
  }

  const stageMovedTo = await advance(db, ctx, opportunity.id);

  const current = await getOpportunity(db, ctx, opportunity.id);
  if (current.postingState !== 'confirmed') {
    await setPostingState(db, ctx, opportunity.id, {
      postingState: 'searching',
      postingStateDetail: null,
    });
    await enqueue(
      db,
      POSTING_RECONCILE_KIND,
      { opportunityId: opportunity.id },
      {
        dedupeKey: `${POSTING_RECONCILE_KIND}:${opportunity.id}`,
        userId: ctx.userId,
      },
    );
  }

  return {
    opportunityId: opportunity.id,
    resultId,
    createdOpportunity,
    stageMovedTo,
    linkedLeadIds,
  };
}
