// Confirming or flagging an opportunity's posting against its ATS board copy
// (https://github.com/bgoleno/opportun/issues/788): the steps the posting-reconcile job takes, in
// lib/ so a user's re-derive (lib/postingRederive.ts) takes the same path without importing the job
// (jobs/postingReconcile.ts), which runs them.
import { CAPTURE_MAX_TEXT } from './captureText';
import { boardFromUrl } from './atsBoard';
import {
  AiUnavailableError,
  PostingMergeOutputSchema,
  renderPrompt,
  runStructured,
} from '@opportun/ai';
import type { NormalizedPosting, PostingStateDetail } from '@opportun/core';
import type { Db } from '../db/client';
import { buildAiDeps } from './ai';
import { HttpError } from './errors';
import { boardReadAtsJobRef, postingAtsJobRefKeeping } from './atsJobRef';
import { descriptionFingerprint } from './postingFingerprint';
import { mergePostingText } from './postingMerge';
import { type BodyReader, type ReadFrom } from './postingSearch';
import { sanitizePosting } from './postingSanitize';
import { siteLabel, siteOfLabel, siteOfUrl } from './captureSites';
import { sourceLabel } from './sourceLabels';
import { createActivity, listActivities, updateActivity } from '../repos/activities';
import type { UserCtx } from '../repos/base';
import {
  getOpportunity,
  setPostingState,
  updateOpportunity,
  type OpportunityView,
} from '../repos/opportunities';

/** The board search needs a body reader only for links found in linked mail; none here. */
export const noBodies: BodyReader = async () => '';

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
): Promise<{ text: string; siteLabel: string; siteId: string | null } | null> {
  const { items } = await listActivities(db, ctx, opportunityId, { limit: 50, offset: 0 });
  const capture = items
    .filter((a) => a.kind === 'capture' && a.bodyMd != null && a.bodyMd !== '')
    .sort((x, y) => y.occurredAt - x.occurredAt)[0];
  if (capture === undefined) return null;
  // "Captured from LinkedIn" names the site the merge heading has to read, and the site whose
  // extraction re-derive runs over the text (https://github.com/bgoleno/opportun/issues/93).
  // recordCapture writes that title for every capture; a title without it is read as LinkedIn,
  // as it always was. When the label names no site (a site label renamed since, or a title edited
  // by hand), the site that claims the capture's stored posting URL is used instead
  // (https://github.com/bgoleno/opportun/issues/96); a label that names a site always wins, since
  // it records the extraction the capture was made with. Neither gives no site.
  const from = /^Captured from (.+)$/.exec(capture.title)?.[1];
  const label = from ?? siteLabel('linkedin');
  const site =
    siteOfLabel(label) ?? (capture.externalUrl == null ? null : siteOfUrl(capture.externalUrl));
  return {
    text: capture.bodyMd as string,
    siteLabel: label,
    siteId: site?.id ?? null,
  };
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

export async function flag(
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
  /** The board `found` was just read from (#398), when it came out of a board read. */
  readFrom?: ReadFrom,
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

  // The row as it is now (#851, qa): the board read can take seconds, and a description the user
  // saved meanwhile is theirs (D11). `opp` is what this run read before the board; anything
  // changed since is left alone, and said so, instead of replaced with the board's copy.
  const now = await getOpportunity(db, ctx, opp.id);
  if (
    now.descriptionMd !== opp.descriptionMd ||
    now.descriptionFingerprint !== opp.descriptionFingerprint
  ) {
    return await flag(
      db,
      ctx,
      opp.id,
      'edited',
      'The description changed while the board was being checked, so the board search left it as it is.',
    );
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

  // The req identity of the URL now stored (D25: often there is none), by the one rule every
  // posting writer shares (lib/atsJobRef, issue #137): a board host's own. A posting out of the
  // board read just made also proves an embedded Greenhouse job's board (#398), with no further
  // request; otherwise a verified one is only kept.
  const storedUrl = posting.postingUrl ?? opp.postingUrl;
  await setPostingState(db, ctx, opp.id, {
    postingState: 'confirmed',
    postingStateDetail: null,
    atsJobRef:
      readFrom !== undefined && posting.postingUrl != null
        ? boardReadAtsJobRef(posting, readFrom, Date.now())
        : postingAtsJobRefKeeping(storedUrl, opp.atsJobRef),
  });
  await writeReconcileNote(db, ctx, opp.id, 'confirmed', body);
  return { status: 'confirmed', detail: null };
}
