// A fingerprint of the description as the system wrote it (design D11).
//
// FR-O1 keeps an opportunity's fields editable by hand, and a board must never stomp an edit.
// Before this branch that was enforced by refusing to write whenever a description existed at
// all, which a capture makes permanently true. Comparing against the capture's timeline copy
// is not sound either: the description passes through sanitizePosting and updateOpportunity
// while an activity body does not, so equality would report "edited" on every opportunity.
//
// So the system records what it wrote. A current description that still hashes to the stored
// fingerprint is the system's own; anything else is the user's and is left alone.
import { createHash } from 'node:crypto';

export function descriptionFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * True when `description` is the system's own writing, so a board may replace it. A null or
 * empty description is replaceable; a non-empty one with no fingerprint was written before
 * this existed, or by the user, and is not.
 */
export function isSystemWritten(
  description: string | null | undefined,
  fingerprint: string | null | undefined,
): boolean {
  if (description == null || description.trim() === '') return true;
  return fingerprint != null && fingerprint === descriptionFingerprint(description);
}

/**
 * True when a board write may replace the user's own description because the user asked for
 * it: the reconcile job flagged `edited` precisely because the text is theirs, and the only
 * way to reach this is to press the action on that flag (design D11, final review Important 3).
 * Without this the flag offers a button that refuses for the same reason the flag was raised.
 */
export function replaceAllowedByFlag(opp: {
  postingState?: string | null;
  postingStateDetail?: string | null;
}): boolean {
  return opp.postingState === 'needs_review' && opp.postingStateDetail === 'edited';
}
