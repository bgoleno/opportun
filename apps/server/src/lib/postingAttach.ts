// Attaching a posting to an opportunity (FR-O1). The description is stored as a snapshot, not
// just linked: a req is taken down the moment it is filled, and the user is often still
// interviewing against its text (and tailoring resumes from it).
//
// Two rules the caller cannot override: a description already recorded is never overwritten
// (the user's own edit outranks any board), and the facts the opportunity already carries
// (location, remote, compensation) stay as the user left them. Everything passes
// sanitizePosting, so stored text is plain and within the NormalizedPosting caps.
import type { NormalizedPosting } from '@opportun/core';
import type { Db } from '../db/client';
import type { UserCtx } from '../repos/base';
import { createActivity } from '../repos/activities';
import {
  getOpportunity,
  setPostingState,
  updateOpportunity,
  type OpportunityView,
  type UpdateOpportunityInput,
} from '../repos/opportunities';
import { HttpError } from './errors';
import {
  descriptionFingerprint,
  isSystemWritten,
  replaceAllowedByFlag,
} from './postingFingerprint';
import { sanitizePosting } from './postingSanitize';

/** How the posting was found, for the timeline entry. */
export type AttachSource = 'email_link' | 'board' | 'paste';

const HOW_SAID: ReadonlyMap<AttachSource, string> = new Map([
  ['email_link', 'Found through a link in a linked message.'],
  ['board', "Found on the company's ATS board."],
  ['paste', 'Added by hand.'],
]);
/**
 * The same three sentences, worded for a Refetch on an opportunity that was already confirmed
 * (issue #255) -- distinct wording, not just a distinct title, because the opportunity's own
 * timeline is where the next reader (the owner, months later) tells a stale first attach from
 * a deliberate re-check apart. Without this, a refetch and the original match would read
 * identically on the record.
 */
const HOW_SAID_REFETCH: ReadonlyMap<AttachSource, string> = new Map([
  ['email_link', 'Refetched through a link in a linked message.'],
  ['board', "Refetched from the company's ATS board."],
  ['paste', 'Replaced by hand.'],
]);

/**
 * Stores `raw` as the opportunity's posting and records it on the timeline. Throws 404 when the
 * opportunity is not the caller's, 409 `already_described` when it already has a description,
 * and 422 `invalid_posting` when the posting carries no description text.
 *
 * `note` (issue #114) is findPosting's large-board truncation caveat, carried over onto the
 * timeline entry when a single confident match from a board read only in part is attached
 * automatically: the moment's toast is gone in seconds, but the fact it describes (this board
 * was not read in full) stays true, so it belongs on the durable record, not only in the toast.
 */
export async function attachPosting(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  raw: NormalizedPosting,
  how: AttachSource,
  note?: string,
): Promise<OpportunityView> {
  const posting = sanitizePosting(raw);
  if (posting.descriptionMd == null || posting.descriptionMd === '') {
    throw new HttpError(422, 'invalid_posting', 'That posting has no description text.');
  }
  const current = await getOpportunity(db, ctx, opportunityId);
  // The user's own writing outranks any board (design D11). A description the system wrote,
  // such as a browser capture's page text, is replaceable by the posting it was waiting for.
  if (
    !replaceAllowedByFlag(current) &&
    !isSystemWritten(current.descriptionMd, current.descriptionFingerprint)
  ) {
    throw new HttpError(
      409,
      'already_described',
      'This opportunity already has a description. Edit it instead.',
    );
  }
  // Issue #255: a Refetch calls this on an opportunity already `confirmed`; the timeline says
  // so distinctly rather than reading identically to the first match.
  const refetch = current.postingState === 'confirmed';
  const patch: UpdateOpportunityInput = {
    descriptionMd: posting.descriptionMd,
    // Written together, or the next board run reads this write as a user edit.
    descriptionFingerprint: descriptionFingerprint(posting.descriptionMd),
    postingUrl: posting.postingUrl ?? current.postingUrl,
  };
  if (current.location == null && posting.location != null) patch.location = posting.location;
  if (current.remote == null && posting.remote != null) patch.remote = posting.remote;
  if (current.compNote == null && posting.compNote != null) patch.compNote = posting.compNote;
  await updateOpportunity(db, ctx, opportunityId, patch);
  // A posting the user chose or pasted is settled, not waiting on a board search (design D17).
  const updated = await setPostingState(db, ctx, opportunityId, {
    postingState: 'confirmed',
    postingStateDetail: null,
  });
  const howSaid = (refetch ? HOW_SAID_REFETCH : HOW_SAID).get(how) ?? '';
  await createActivity(db, ctx, opportunityId, {
    kind: 'link',
    title: 'Job posting attached',
    bodyMd: [`${posting.company}: ${posting.title}`, howSaid, note ?? '']
      .filter((l) => l !== '')
      .join('\n'),
    occurredAt: Date.now(),
    participants: [],
    externalUrl: posting.postingUrl,
  });
  return updated;
}
