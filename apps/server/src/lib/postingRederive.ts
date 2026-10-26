// Re-deriving a description from the capture already stored on an opportunity's timeline
// (issue #264). The other half of #246 and #255: #246 stopped a fresh LinkedIn capture from
// swallowing the recommended rail; #255 added Refetch for a company with a readable board.
// Neither helps an opportunity whose description was corrupted by something else (#238) once it
// reaches `confirmed`, or whose company has no ATS board at all -- there was no way to ask the
// product to produce a description again from material it already holds.
//
// `recordCapture` (lib/captureResolve.ts) stores extractPage's raw text verbatim as a 'capture'
// activity's bodyMd, before any narrowing or AI refinement ever touches it. That raw text is
// still sitting on the timeline for every capture made before #246 shipped, carrying the rail
// #246 now cuts at capture time -- so re-deriving must run today's extraction over that stored
// text, never copy it back untouched. Confirmed against the owner's own stored GitHub capture
// (read-only, never committed): `descriptionOf`'s own end markers exist to find where "About
// the job" ends, not to find the rail, and nothing in that real capture stops it between the
// posting and the rail -- so the capture-only path below runs `cutTrailingNoise`
// (lib/linkedinCapture.ts), the same cut extractPage applies at capture time, before extracting
// from it. A straight `descriptionOf` with no pre-cut would have reproduced #246's bug on the
// one path built specifically to repair it.
//
// Design question 3 (#264): a board posting may exist and be better than the capture alone
// (confirm()'s own merge of the ATS copy with capture passages). This tries that exact path
// first -- the same findPosting + confirm() the automatic reconcile job uses, reused verbatim --
// so a company with a readable board gets the richer merged result and never a regression to a
// worse capture-only description. Only when the board search comes back with nothing confident
// (candidates, none or no board) does this fall back to deriving a description from the capture
// text alone.
//
// Design question 5 (#264): that fallback is deliberately the same deterministic `descriptionOf`
// extraction a capture already falls back to when AI is unavailable, not a second AI call. The
// AI step (capture.linkedin) needs the page's own tab title as a prompt variable, and that title
// is never stored once an opportunity exists -- CaptureInput (lib/captureResolve.ts) never
// carries it past the capture route. Synthesizing one would mean feeding the model fabricated
// context to make up for data that was never kept. The deterministic extraction has no such
// gap: it is already the accepted quality bar for a live capture with no AI key, so re-derive
// holds itself to the same bar rather than inventing a second, approximate path.
import type { SourceContext } from '../adapters/discoverySource';
import type { Db } from '../db/client';
import { capturedPage, confirm } from '../jobs/postingReconcile';
import { createActivity } from '../repos/activities';
import type { UserCtx } from '../repos/base';
import { getOpportunity, updateOpportunity, type OpportunityView } from '../repos/opportunities';
import { HttpError } from './errors';
import { cutTrailingNoise, descriptionOf, linesOf } from './linkedinCapture';
import { descriptionFingerprint, isSystemWritten } from './postingFingerprint';
import { findPosting, type BoardLookup, type BodyReader } from './postingSearch';

/** The board search needs a body reader only for links found in linked mail; none here. */
const noBodies: BodyReader = async () => '';

export type RederiveOutcome =
  | { kind: 'merged'; opportunity: OpportunityView }
  | { kind: 'capture_only'; opportunity: OpportunityView }
  /** The capture carried no recognizable "About the job" section; nothing was changed. */
  | { kind: 'no_description_found' };

/**
 * Whether re-deriving would silently overrule a decision only the user gets to make, and so
 * needs an explicit `force` rather than running quietly. Two cases, not one: a description the
 * user actually wrote (design Q2, same `isSystemWritten` check attachPosting and find-posting
 * already gate on), and a posting the user explicitly confirmed themselves (#250) -- reconcile()
 * protects that same decision from an automatic background run, and a manual re-derive deserves
 * no less care, even though it is a person pressing a button rather than a job running on its
 * own schedule.
 */
function blockingReason(opp: OpportunityView): 'already_described' | 'user_confirmed' | null {
  if (opp.postingState === 'confirmed' && opp.postingStateDetail === 'user_confirmed') {
    return 'user_confirmed';
  }
  if (!isSystemWritten(opp.descriptionMd, opp.descriptionFingerprint)) return 'already_described';
  return null;
}

async function note(db: Db, ctx: UserCtx, opportunityId: string, bodyMd: string): Promise<void> {
  await createActivity(db, ctx, opportunityId, {
    kind: 'note',
    title: 'Description re-derived from capture',
    bodyMd,
    occurredAt: Date.now(),
    participants: [],
    externalUrl: null,
  });
}

export async function rederivePosting(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  sctx: SourceContext,
  opts: { force?: boolean; board?: BoardLookup } = {},
): Promise<RederiveOutcome> {
  const opp = await getOpportunity(db, ctx, opportunityId);
  const reason = blockingReason(opp);
  if (reason !== null && opts.force !== true) {
    const message =
      reason === 'user_confirmed'
        ? 'You confirmed this posting yourself. Re-deriving would replace that decision.'
        : 'This opportunity already has a description. Edit it instead.';
    throw new HttpError(409, reason, message);
  }

  const capture = await capturedPage(db, ctx, opportunityId);
  if (capture === null) {
    throw new HttpError(
      409,
      'no_capture',
      'This opportunity has no stored capture to re-derive from.',
    );
  }

  const outcome = await findPosting(db, ctx, opportunityId, sctx, {
    readBody: noBodies,
    ...(opts.board === undefined ? {} : { board: opts.board }),
  });

  if (outcome.status === 'exact' || outcome.status === 'single') {
    await confirm(db, ctx, opp, outcome.candidate.posting);
    await note(
      db,
      ctx,
      opportunityId,
      "A confident match on the company's board took priority, merged with the captured page as usual.",
    );
    return { kind: 'merged', opportunity: await getOpportunity(db, ctx, opportunityId) };
  }

  // A capture made before #246 shipped still carries the rail in its raw stored text (every
  // capture on the owner's instance does, as of issue #264). Cutting it here, the same way
  // extractPage already cuts it at capture time, is not optional: descriptionOf's own end
  // markers exist to find where "About the job" ends, not to find the rail, and a real capture
  // was confirmed (read-only) to have nothing stop it between the posting and the rail. Without
  // this, re-deriving an old capture would reproduce #246's bug on the one path meant to repair
  // it.
  const derived = descriptionOf(linesOf(cutTrailingNoise(capture.text)));
  if (derived === null) return { kind: 'no_description_found' };

  const updated = await updateOpportunity(db, ctx, opportunityId, {
    descriptionMd: derived,
    descriptionFingerprint: descriptionFingerprint(derived),
  });
  await note(
    db,
    ctx,
    opportunityId,
    'No confident match was found on the company’s board, so the board was left out of ' +
      'this change: the description came from the captured page already on this timeline.',
  );
  return { kind: 'capture_only', opportunity: updated };
}
