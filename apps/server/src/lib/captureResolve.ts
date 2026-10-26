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
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { jsonText } from '../db/dialect';
import { discoveryResults, opportunities } from '../db/schema';
import { POSTING_RECONCILE_KIND } from '../jobs/discoveryKinds';
import { enqueue } from '../jobs/runner';
import { sanitizePosting } from './postingSanitize';
import { postingIdentity, siteLabel } from './captureSites';
import { sourceLabel } from './sourceLabels';
import { descriptionFingerprint } from './postingFingerprint';
import { createActivity } from '../repos/activities';
import type { UserCtx } from '../repos/base';
import {
  createRun,
  ensureChannelSource,
  getResult,
  insertResult,
  setDisposition,
  setResolution,
  type DiscoveryResultView,
} from '../repos/discovery';
import {
  createOpportunity,
  getOpportunity,
  setPostingState,
  transitionOpportunity,
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
 * Every literal `externalId` that could hold this capture's identity, so the candidate scan is
 * an indexed-ish equality test rather than a full table read: `<site>:<id>` as the extension
 * stores it, and the bare `<id>` as an alert-email lead stores it.
 */
function externalIdCandidates(identity: string): string[] {
  const at = identity.indexOf(':');
  const bare = identity.slice(at + 1);
  return [identity, bare];
}

/** Results of this user whose posting is the same req as `posting`. */
async function resultsWithIdentity(
  db: Db,
  ctx: UserCtx,
  identity: string,
): Promise<DiscoveryResultView[]> {
  const rows = await db
    .select({ id: discoveryResults.id })
    .from(discoveryResults)
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        inArray(jsonText(discoveryResults.posting, 'externalId'), externalIdCandidates(identity)),
      ),
    )
    .all();
  const found: DiscoveryResultView[] = [];
  for (const row of rows) {
    const result = await getResult(db, ctx, row.id);
    // The literal scan is a prefilter: identity is what decides, so a Greenhouse lead whose
    // opaque id happens to be the same digits is not a match.
    if (postingIdentity(result.posting) === identity) found.push(result);
  }
  return found;
}

/** Results of this user carrying `key`, whatever their disposition. */
async function resultsWithKey(db: Db, ctx: UserCtx, key: string): Promise<DiscoveryResultView[]> {
  const rows = await db
    .select({ id: discoveryResults.id })
    .from(discoveryResults)
    .where(and(eq(discoveryResults.userId, ctx.userId), eq(discoveryResults.dedupeKey, key)))
    .all();
  return await Promise.all(rows.map((r) => getResult(db, ctx, r.id)));
}

async function opportunityWithKey(
  db: Db,
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
  /** Pending leads this capture consumes, best first. */
  leads: DiscoveryResultView[];
  /** Leads for this req already accepted, so a re-capture reuses one instead of adding noise. */
  accepted: DiscoveryResultView[];
}

/**
 * What this capture already corresponds to. Posting identity first, dedupe key second (D20):
 * the key carries a location, and a capture only has one when the optional `capture.linkedin`
 * refine step ran, so a key-only match misses exactly when AI is unavailable.
 */
async function findMatch(db: Db, ctx: UserCtx, posting: NormalizedPosting): Promise<Match> {
  const identity = postingIdentity(posting);
  const key = dedupeKey(posting.company, posting.title, posting.location);

  const byIdentity = identity === null ? [] : await resultsWithIdentity(db, ctx, identity);
  // The dedupe key is the weaker signal, so a key match only counts when it does not contradict
  // an identity: stripSeniority makes "Staff PM" and "Principal PM" at one company share a key,
  // and those are different reqs the user decides about, not this capture.
  const byKey = (await resultsWithKey(db, ctx, key)).filter((r) => {
    const other = postingIdentity(r.posting);
    return other === null || other === identity;
  });

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
        return { opportunity: opp, leads: pendingOf(candidates), accepted };
      }
    }
  }
  // An opportunity carries no identity of its own, so the key is all there is to go on, and
  // the unique index means a second opportunity under that key could not be created anyway.
  // D20's residual case: a key collision with nothing to contradict it attaches, visibly and
  // reversibly, rather than failing the capture.
  return {
    opportunity: await opportunityWithKey(db, ctx, key),
    leads: pendingOf(candidates),
    accepted,
  };
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
  db: Db,
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

/** Advances `discovered` and `dismissed` to `interested`; leaves every other stage alone (D3). */
async function advance(
  db: Db,
  ctx: UserCtx,
  opp: OpportunityView,
): Promise<OpportunityStage | null> {
  if (!ADVANCES_FROM.has(opp.stage)) return null;
  await transitionOpportunity(db, ctx, opp.id, {
    to: 'interested',
    // Leaving a terminal stage needs this; a capture of something dismissed means the user
    // changed their mind (owner decision, 2026-10-19).
    ...(opp.stage === 'dismissed' ? { reopen: true } : {}),
    note: 'Captured from the browser extension.',
  });
  return 'interested';
}

/** Stores the capture as a new accepted lead of the user's extension channel source. */
async function createLead(
  db: Db,
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

/**
 * Resolves one job capture to an opportunity at `interested`.
 *
 * Not wrapped in a single transaction: `createOpportunity` opens its own, and on the Postgres
 * leg passing the raw db inside a transaction is refused outright (db/client.ts). This follows
 * the existing accept route, which is sequential in the same way; the unique dedupe index is
 * the real guard against two captures racing into two opportunities.
 */
export async function resolveCapture(
  db: Db,
  ctx: UserCtx,
  input: CaptureInput,
): Promise<CaptureResolution> {
  const posting = sanitizePosting(input.posting);
  const match = await findMatch(db, ctx, posting);
  const [primary, ...rest] = match.leads;

  let opportunity = match.opportunity;
  let resultId: string;
  let createdOpportunity = false;

  if (primary !== undefined) {
    // The lead keeps its own identity (company, title, so its dedupe key) and gains the
    // description it was waiting for, exactly as the paste path's resolveLeadInPlace does.
    const filled = await setResolution(db, ctx, primary.id, {
      resolution: 'full',
      resolvedSourceRef: posting.postingUrl ?? null,
      posting: {
        ...primary.posting,
        descriptionMd: primary.posting.descriptionMd || posting.descriptionMd,
        postingUrl: primary.posting.postingUrl ?? posting.postingUrl ?? null,
        location: primary.posting.location ?? posting.location ?? null,
        remote: primary.posting.remote ?? posting.remote ?? null,
        compNote: primary.posting.compNote ?? posting.compNote ?? null,
      },
    });
    resultId = filled.id;
    // The matched lead's own key may differ from the capture's, which is routine when the two
    // describe the location differently. A live opportunity holding *that* key is the same job
    // tracked already, and creating a second one would throw 409 after the lead has already
    // been flipped to `full`: a half-landed capture with no reconcile queued.
    if (opportunity === null && filled.dedupeKey !== null) {
      opportunity = await opportunityWithKey(db, ctx, filled.dedupeKey);
    }
    if (opportunity === null) {
      opportunity = await createOpportunity(db, ctx, {
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
      });
      createdOpportunity = true;
    }
    await setDisposition(db, ctx, filled.id, 'accepted', opportunity.id);
    if (!createdOpportunity) await recordFoldedLead(db, ctx, opportunity.id, filled);
  } else if (opportunity === null) {
    const lead = await createLead(db, ctx, posting);
    resultId = lead.id;
    opportunity = await createOpportunity(db, ctx, {
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
    });
    createdOpportunity = true;
    await setDisposition(db, ctx, lead.id, 'accepted', opportunity.id);
  } else {
    // Re-capturing a job already tracked reuses the lead that recorded it rather than piling
    // up one extension lead per capture.
    const reusable = match.accepted.find((r) => r.opportunityId === opportunity?.id);
    if (reusable !== undefined) {
      resultId = reusable.id;
    } else {
      const lead = await createLead(db, ctx, posting);
      resultId = lead.id;
      await setDisposition(db, ctx, lead.id, 'accepted', opportunity.id);
    }
  }

  await recordCapture(db, ctx, opportunity.id, { ...input, posting });

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

  const stageMovedTo = await advance(db, ctx, await getOpportunity(db, ctx, opportunity.id));

  // Leads this capture did not consume are linked rather than left pending: they would 409
  // against the now-live opportunity on every later accept (D23).
  const linkedLeadIds: string[] = [];
  for (const other of rest) {
    await setDisposition(db, ctx, other.id, 'accepted', opportunity.id);
    await recordFoldedLead(db, ctx, opportunity.id, other);
    linkedLeadIds.push(other.id);
  }

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
