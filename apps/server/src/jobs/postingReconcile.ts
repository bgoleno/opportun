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
import { z } from 'zod';
import type { SourceContext } from '../adapters/discoverySource';
import type { Db } from '../db/client';
import { isSystemWritten } from '../lib/postingFingerprint';
import { findPosting, type BoardLookup } from '../lib/postingSearch';
import type { UserCtx } from '../repos/base';
import { getOpportunity } from '../repos/opportunities';
import { POSTING_RECONCILE_KIND } from '../lib/jobKinds';
import { requireService, type JobHandler } from './registry';
import { confirm, flag, noBodies, type ReconcileOutcome } from '../lib/postingReconcile';
import { opportunityGone, settleUnfinishedCheck } from '../lib/postingChecks';

export { POSTING_RECONCILE_KIND };

const PayloadSchema = z.object({ opportunityId: z.string().min(1).max(64) });

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
    sctx.log.warn(
      { err, 'opportun.opportunity.id': opportunityId },
      'posting reconciliation failed',
    );
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
      return await confirm(db, ctx, opp, outcome.candidate.posting, outcome.readFrom);
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
    case 'unreachable':
      // Its boards could not be read (#835): the check did not finish, which is not "found
      // nothing". Find posting tries again from the banner.
      return await flag(
        db,
        ctx,
        opportunityId,
        'failed',
        `Couldn't read ${opp.companyName}'s board just now, so nothing was checked. Try Find posting again.`,
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
    let outcome: ReconcileOutcome;
    try {
      outcome = await reconcilePosting(db, user, payload.opportunityId, {
        fetch: requireService(ctx, 'sourceFetch'),
        log: requireService(ctx, 'log'),
      });
    } catch (err) {
      // Deleted, or merged into another, while the board was read (#897): there is nothing left to
      // check, and a retry would only fail again. Looked up rather than read off the error: a
      // missing company is a 404 too, and is a real failure.
      if (!(await opportunityGone(db, user, payload.opportunityId))) throw err;
      await ctx.setResult({ status: 'gone' });
      return;
    }
    await ctx.setResult(outcome);
  },
  // Its posting must not stay `searching`, with its page still saying it is being checked (#869).
  async onDead(db, payload, { userId }) {
    if (userId === null) return;
    await settleUnfinishedCheck(db, { userId, isAdmin: false }, payload.opportunityId);
  },
};
