// Letting the user assert a posting is right themselves (issue #250). The banner's own
// actions (Look again, Choose posting, Add board, Try again) only ever reach a state the
// machine finds on its own; this is the one way a human's own judgement becomes the record.
//
// Confirming is deliberately a sibling of a board match, not the same fact wearing a different
// detail: `postingState: 'confirmed'` with `postingStateDetail: 'user_confirmed'` keeps every
// existing `postingState === 'confirmed'` check (the banner's own null-return, captureResolve's
// re-enqueue guard) treating it as settled for free, while the detail keeps the two provenances
// apart for anyone reading the record later. The matching guard against a background run
// silently undoing this lives in postingReconcile.ts's reconcile(), not here.
import type { UserCtx } from '../repos/base';
import type { Db } from '../db/client';
import { createActivity } from '../repos/activities';
import {
  getOpportunity,
  SearchBasisChanged,
  setPostingState,
  type OpportunityView,
} from '../repos/opportunities';
import { postingAtsJobRefKeeping } from './atsJobRef';
import { HttpError } from './errors';
import { racePoint } from './racePoints';

/** The flagged states a user can stand behind without the board ever confirming it. `edited`
 *  is excluded: that flag already has its own resolution (Review board copy), and confirming
 *  it here would just be a second way to say the same thing with a different trail. */
const CONFIRMABLE_DETAILS = new Set(['ambiguous', 'none_found', 'no_board', 'failed']);

export async function confirmPosting(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
): Promise<OpportunityView> {
  const current = await getOpportunity(db, ctx, opportunityId);
  if (
    current.postingState !== 'needs_review' ||
    current.postingStateDetail === null ||
    !CONFIRMABLE_DETAILS.has(current.postingStateDetail)
  ) {
    throw new HttpError(
      409,
      'not_confirmable',
      'This posting has nothing flagged to confirm.',
      undefined,
      { userFacing: true },
    );
  }
  await racePoint('posting.userConfirm');
  let updated: OpportunityView;
  try {
    updated = await setPostingState(
      db,
      ctx,
      opportunityId,
      {
        postingState: 'confirmed',
        postingStateDetail: 'user_confirmed',
        // The posting the user vouched for carries its own ATS identity, or none (issue #137); a
        // verified `gh_jid` identity stays while the link still names its job (#398).
        atsJobRef: postingAtsJobRefKeeping(current.postingUrl, current.atsJobRef),
      },
      // Made from this link: one saved meanwhile would have its identity (#892).
      { ifBasis: { postingUrl: current.postingUrl } },
    );
  } catch (err) {
    if (!(err instanceof SearchBasisChanged)) throw err;
    throw new HttpError(
      409,
      'opportunity_changed',
      'The posting link changed while you were confirming it, so nothing was confirmed. Check the link, then try again.',
      undefined,
      { userFacing: true },
    );
  }
  await createActivity(db, ctx, opportunityId, {
    kind: 'note',
    title: 'Posting confirmed by you',
    bodyMd:
      'You confirmed this posting is correct after checking it yourself; the board never verified it automatically.',
    occurredAt: Date.now(),
    participants: [],
    externalUrl: null,
  });
  return updated;
}

/**
 * Reverses a mistaken confirm (design question #4). Deliberately simple: resets to
 * `needs_review`/`none_found` rather than the exact reason that was flagged before confirming,
 * since nothing persists that today and reconstructing it is not worth the complexity for what
 * this is actually for -- undoing a mistake, not restoring a precise prior record. A real check
 * (Look again, from the restored banner) re-derives the true state regardless.
 */
export async function unconfirmPosting(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
): Promise<OpportunityView> {
  const current = await getOpportunity(db, ctx, opportunityId);
  if (current.postingState !== 'confirmed' || current.postingStateDetail !== 'user_confirmed') {
    throw new HttpError(
      409,
      'not_user_confirmed',
      'This posting was not confirmed by you.',
      undefined,
      { userFacing: true },
    );
  }
  return await setPostingState(db, ctx, opportunityId, {
    postingState: 'needs_review',
    postingStateDetail: 'none_found',
  });
}
