// posting.reconcile (design D4 to D8, D11, D21, D25, D26, D27). After a browser capture puts
// an opportunity in the pipeline with the page's own text on it, this looks the same job up on
// the company's own ATS board and makes the employer's copy authoritative.
//
// The engine is findPosting (lib/postingSearch), not opportunity.enrich (D21). They are
// different machines: findPosting reads the ATS adapters' fixed API hosts and detects a
// company's board per FR-D9, and it is the only one of the two that can report "several
// plausible rows", which D8 needs. enrich guesses company domains and fetches arbitrary public
// pages, which this design's own non-goal rules out, and its `already_detailed` early return is
// permanently true once a capture has written a description.
//
// Nothing is ever lost and nothing is ever stomped:
//   - the employer's text is stored verbatim and the capture's extras are appended as passages
//     the model selected out of the captured page (lib/postingMerge);
//   - a description the user edited by hand is left alone and flagged instead (D11);
//   - fields are filled where empty and never blanked (D7);
//   - anything short of one confident match writes nothing and raises a flag (D8).
import {
  AiUnavailableError,
  PostingMergeOutputSchema,
  renderPrompt,
  runStructured,
} from '@opportun/ai';
import type { NormalizedPosting, PostingStateDetail } from '@opportun/core';
import { z } from 'zod';
import type { SourceContext } from '../adapters/discoverySource';
import type { Db } from '../db/client';
import { buildAiDeps } from '../lib/ai';
import { HttpError } from '../lib/errors';
import { extractAtsJobRefs } from '../lib/atsJobRef';
import { boardFromUrl } from './atsDetect';
import { CAPTURE_MAX_TEXT } from '../routes/capture';
import { descriptionFingerprint, isSystemWritten } from '../lib/postingFingerprint';
import { mergePostingText } from '../lib/postingMerge';
import { findPosting, type BoardLookup, type BodyReader } from '../lib/postingSearch';
import { sanitizePosting } from '../lib/postingSanitize';
import { siteLabel } from '../lib/captureSites';
import { sourceLabel } from '../lib/sourceLabels';
import { createActivity, listActivities, updateActivity } from '../repos/activities';
import type { UserCtx } from '../repos/base';
import {
  getOpportunity,
  setPostingState,
  updateOpportunity,
  type OpportunityView,
} from '../repos/opportunities';
import { POSTING_RECONCILE_KIND } from './discoveryKinds';
import { requireService, type JobHandler } from './registry';

export { POSTING_RECONCILE_KIND };

const PayloadSchema = z.object({ opportunityId: z.string().min(1).max(64) });

/** The board search needs a body reader only for links found in linked mail; none here. */
const noBodies: BodyReader = async () => '';

export interface ReconcileOutcome {
  status: 'confirmed' | 'needs_review';
  detail: PostingStateDetail | null;
}

/**
 * The capture this opportunity was built from, as the extension read it (design D12, D26).
 * Exported for issue #264: re-deriving a description reuses this exact selection (the latest
 * capture activity), rather than a second copy of the same "which one" rule.
 */
export async function capturedPage(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
): Promise<{ text: string; siteLabel: string } | null> {
  const { items } = await listActivities(db, ctx, opportunityId, { limit: 50, offset: 0 });
  const capture = items
    .filter((a) => a.kind === 'capture' && a.bodyMd != null && a.bodyMd !== '')
    .sort((x, y) => y.occurredAt - x.occurredAt)[0];
  if (capture === undefined) return null;
  // "Captured from LinkedIn" names the site the merge heading has to read.
  const from = /^Captured from (.+)$/.exec(capture.title)?.[1];
  return { text: capture.bodyMd as string, siteLabel: from ?? siteLabel('linkedin') };
}

/** The passages the capture carries that the ATS text does not, or [] when AI is unavailable. */
async function selectPassages(
  db: Db,
  ctx: UserCtx,
  atsText: string,
  captureText: string,
): Promise<string[]> {
  const { getActivePrompt } = await import('../repos/prompts');
  const prompt = await getActivePrompt(db, ctx, 'posting.merge');
  if (prompt === undefined) return [];
  const cap = (s: string): string =>
    s.length > CAPTURE_MAX_TEXT ? `${s.slice(0, CAPTURE_MAX_TEXT)}\n[truncated]` : s;
  try {
    const out = await runStructured(await buildAiDeps(db, ctx), 'posting.merge', {
      system: renderPrompt(prompt.body, {
        ats_untrusted: cap(atsText),
        capture_untrusted: cap(captureText),
      }),
      prompt: 'Return the passages the captured page carries that the ATS posting does not.',
      schema: PostingMergeOutputSchema,
      promptId: prompt.id,
    });
    return [...out.passages];
  } catch (err) {
    // No key, no budget, a provider error: the ATS copy alone is a good answer (D6).
    if (err instanceof AiUnavailableError) return [];
    throw err;
  }
}

/** The req identity of an ATS posting, when its URL carries one (D25: often it does not). */
function refOf(posting: NormalizedPosting): ReturnType<typeof extractAtsJobRefs>[number] | null {
  if (posting.postingUrl == null) return null;
  return extractAtsJobRefs(posting.postingUrl, 1)[0] ?? null;
}

/**
 * The one timeline marker each reconcile outcome owns (issue #247). A repeat run landing on
 * the same outcome refreshes this note's body and timestamp in place rather than piling up a
 * near-duplicate; a real transition to a different outcome gets a fresh one, because that is
 * history worth keeping. History starts now: there is no stored timestamp for a posting
 * confirmed before this existed, and backfilling one would be a guess, not a record.
 */
// 'user_confirmed' (issue #250) is excluded: reconcile()'s own guard returns before flag() or
// confirm() can ever be called with it, so this map never needs to speak for that outcome --
// postingConfirm.ts writes its own distinct note directly, never through here.
type ReconcileOutcomeKind = 'confirmed' | Exclude<PostingStateDetail, 'user_confirmed'>;
const RECONCILE_NOTE_TITLES: Record<ReconcileOutcomeKind, string> = {
  confirmed: "Posting confirmed on the company's board",
  ambiguous: 'Posting search found more than one candidate',
  none_found: "Posting not found on the company's board",
  no_board: 'No ATS board detected for this company',
  edited: 'Posting check skipped: description already edited',
  failed: 'Posting check failed',
};
const KNOWN_RECONCILE_TITLES = new Set(Object.values(RECONCILE_NOTE_TITLES));

/**
 * Writes or refreshes this opportunity's reconcile marker, immediately after the state change
 * it accompanies (setPostingState), same as opportunityEnrich.ts's own addNote follows its
 * updateOpportunity: adjacent in the same function, not one shared database transaction.
 * listActivities/createActivity/updateActivity are typed to a top-level `Db`, not the narrower
 * `Exec` a transaction handle satisfies, so nesting this under setPostingState's own
 * transaction would mean widening those three repo functions for every other caller to buy
 * atomicity for a window a crash has to land in exactly between two already-fast, already
 * sequential writes -- the same risk this file already accepts between updateOpportunity and
 * setPostingState in confirm(). Not worth that blast radius for this.
 */
async function writeReconcileNote(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  outcomeKind: ReconcileOutcomeKind,
  body: string,
): Promise<void> {
  // eslint-disable-next-line security/detect-object-injection -- outcomeKind is a ReconcileOutcomeKind literal
  const title = RECONCILE_NOTE_TITLES[outcomeKind];
  // Newest first (listActivities' own default sort): the first match is the most recent one.
  const { items } = await listActivities(db, ctx, opportunityId, { limit: 50, offset: 0 });
  const marker = items.find((a) => a.kind === 'note' && KNOWN_RECONCILE_TITLES.has(a.title));
  if (marker !== undefined && marker.title === title) {
    await updateActivity(db, ctx, marker.id, { bodyMd: body, occurredAt: Date.now() });
    return;
  }
  await createActivity(db, ctx, opportunityId, {
    kind: 'note',
    title,
    bodyMd: body,
    occurredAt: Date.now(),
    participants: [],
    externalUrl: null,
  });
}

async function flag(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  // Never 'user_confirmed' (issue #250): flag() always pairs with needs_review below, and
  // that detail is only ever valid beside confirmed.
  detail: Exclude<PostingStateDetail, 'user_confirmed'>,
  noteBody: string,
): Promise<ReconcileOutcome> {
  await setPostingState(db, ctx, opportunityId, {
    postingState: 'needs_review',
    postingStateDetail: detail,
  });
  await writeReconcileNote(db, ctx, opportunityId, detail, noteBody);
  return { status: 'needs_review', detail };
}

/**
 * Stores the ATS posting over the capture, keeping what the capture alone carried. Exported for
 * issue #264: re-deriving a description from a stored capture, when a confident board match
 * exists after all, runs this exact merge rather than a second one that could drift from it.
 */
export async function confirm(
  db: Db,
  ctx: UserCtx,
  opp: OpportunityView,
  found: NormalizedPosting,
): Promise<ReconcileOutcome> {
  const posting = sanitizePosting(found);
  const atsText = posting.descriptionMd ?? '';
  const capture = await capturedPage(db, ctx, opp.id);

  let description = atsText;
  if (atsText !== '' && capture !== null && capture.text.trim() !== '') {
    const passages = await selectPassages(db, ctx, atsText, capture.text);
    description = mergePostingText({
      atsText,
      captureText: capture.text,
      passages,
      siteLabel: capture.siteLabel,
      company: opp.companyName,
    });
  }

  const patch: Parameters<typeof updateOpportunity>[3] = {};
  if (description !== '') {
    patch.descriptionMd = description;
    patch.descriptionFingerprint = descriptionFingerprint(description);
  }
  // The board's URL is the canonical one; the capture's survives on its timeline entry (D26).
  if (posting.postingUrl != null) patch.postingUrl = posting.postingUrl;
  // ATS value where it has one, what is already there where it does not. Never blanked (D7).
  if (posting.location != null) patch.location = posting.location;
  if (posting.remote != null) patch.remote = posting.remote;
  if (posting.compNote != null) patch.compNote = posting.compNote;
  if (Object.keys(patch).length > 0) {
    try {
      await updateOpportunity(db, ctx, opp.id, patch);
    } catch (err) {
      // updateOpportunity recomputes the dedupe key whenever `location` changes, and the ATS
      // states one on nearly every success, so a live opportunity already holding that key
      // would otherwise cost the user the description they captured for. The description is
      // the point; the location is not worth losing it over.
      if (!(err instanceof HttpError) || err.statusCode !== 409) throw err;
      const retry = { ...patch };
      delete retry.location;
      await updateOpportunity(db, ctx, opp.id, retry);
    }
  }

  // Issue #247: name what changed on the timeline, not just that something did. `board` comes
  // straight from the URL (atsDetect), independent of refOf's stricter job-id extraction, so
  // the label is still known even when no req id could be parsed out of it (D25).
  const board = posting.postingUrl == null ? null : boardFromUrl(posting.postingUrl);
  const boardLabel = board === null ? "the company's careers page" : sourceLabel(board.kind);
  // mergePostingText returns the ATS text verbatim, trimmed, when nothing from the capture
  // survived its grounding/dedup checks: comparing trimmed strings is the direct way to tell
  // whether anything was actually appended, rather than re-deriving its internal decision.
  const merged = patch.descriptionMd !== undefined && description.trim() !== atsText.trim();
  const descriptionNote =
    patch.descriptionMd === undefined
      ? ''
      : merged
        ? " Merged the board's copy with details only the captured page had."
        : " Replaced the description with the board's copy.";
  const changedExtra = [
    posting.location != null ? 'location' : null,
    posting.remote != null ? 'remote' : null,
    posting.compNote != null ? 'compensation' : null,
  ].filter((f): f is string => f !== null);
  const extraNote =
    changedExtra.length === 0 ? '' : ` Took ${changedExtra.join(', ')} from the board.`;
  const body =
    `Found on ${boardLabel}${posting.postingUrl == null ? '' : `: ${posting.postingUrl}`}.` +
    descriptionNote +
    extraNote;

  const ref = refOf(posting);
  await setPostingState(db, ctx, opp.id, {
    postingState: 'confirmed',
    postingStateDetail: null,
    atsJobRef: ref === null ? null : { ...ref, org: ref.org ?? null },
  });
  await writeReconcileNote(db, ctx, opp.id, 'confirmed', body);
  return { status: 'confirmed', detail: null };
}

/**
 * Reconciles one opportunity's posting against the company's own ATS board. Exported for
 * tests, which inject the board lookup the way postingSearch's own tests do.
 */
export async function reconcilePosting(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  sctx: SourceContext,
  opts: { board?: BoardLookup } = {},
): Promise<ReconcileOutcome> {
  try {
    return await reconcile(db, ctx, opportunityId, sctx, opts);
  } catch (err) {
    // `searching` renders a spinner with no action, so anything that escapes here would be a
    // permanent dead end: the job retries, dies, and the banner spins forever. Whatever went
    // wrong, the opportunity ends in a state the user can act on.
    sctx.log.warn({ err, opportunityId }, 'posting reconciliation failed');
    return await flag(
      db,
      ctx,
      opportunityId,
      'failed',
      "Checking the company's board failed. This will be retried automatically.",
    );
  }
}

async function reconcile(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  sctx: SourceContext,
  opts: { board?: BoardLookup },
): Promise<ReconcileOutcome> {
  const opp = await getOpportunity(db, ctx, opportunityId);

  // Issue #250: a user who confirmed a posting themselves made a decision only they can
  // revoke. The guard lives here, not just at this job's one current enqueue site
  // (captureResolve.ts), because the next caller to add a second enqueue site would otherwise
  // reintroduce exactly the bug this exists to prevent -- a background run silently undoing a
  // user's "I checked, this is right" the next time it happens to run. A board match staying
  // re-reconcilable (ordinary `confirmed`, no detail) is deliberately not guarded the same way:
  // a real listing can legitimately go stale, which is a fact worth re-checking, not a decision
  // to protect. Refetch (issue #255) is unaffected: it runs through attachPosting() directly,
  // never through this function, so it was never going to meet this guard either way.
  if (opp.postingState === 'confirmed' && opp.postingStateDetail === 'user_confirmed') {
    return { status: 'confirmed', detail: 'user_confirmed' };
  }

  // A description the user wrote outranks any board (D11, narrowing FR-O1's blanket rule).
  if (!isSystemWritten(opp.descriptionMd, opp.descriptionFingerprint)) {
    return await flag(
      db,
      ctx,
      opportunityId,
      'edited',
      "You have edited this opportunity's description, so the board search left it alone.",
    );
  }

  const outcome = await findPosting(db, ctx, opportunityId, sctx, {
    readBody: noBodies,
    ...(opts.board === undefined ? {} : { board: opts.board }),
  });

  switch (outcome.status) {
    case 'exact':
    case 'single':
      return await confirm(db, ctx, opp, outcome.candidate.posting);
    case 'candidates':
      return await flag(
        db,
        ctx,
        opportunityId,
        'ambiguous',
        `Found ${outcome.candidates.length} possible posting${outcome.candidates.length === 1 ? '' : 's'} for "${opp.title}" at ${opp.companyName}, none confident enough to pick automatically. Choose one from the banner.`,
      );
    case 'none':
      return await flag(
        db,
        ctx,
        opportunityId,
        'none_found',
        `Checked ${opp.companyName}'s board and found no posting matching "${opp.title}".`,
      );
    default:
      return await flag(
        db,
        ctx,
        opportunityId,
        'no_board',
        `No ATS board could be detected for ${opp.companyName}.`,
      );
  }
}

export const postingReconcileJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: POSTING_RECONCILE_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 3,
  async run(db, payload, ctx) {
    if (ctx.userId === null) throw new Error(`${POSTING_RECONCILE_KIND} needs a user`);
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    const outcome = await reconcilePosting(db, user, payload.opportunityId, {
      fetch: requireService(ctx, 'sourceFetch'),
      log: requireService(ctx, 'log'),
    });
    await ctx.setResult(outcome);
  },
};
