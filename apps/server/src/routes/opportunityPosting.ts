// Finding and attaching the posting of an opportunity the user already tracks (FR-O1).
//
// POST /opportunities/:id/find-posting looks the posting up: the job id in a linked message
// first, then the company's ATS board (detected per FR-D9 when the company has no board yet).
// Exactly one confident candidate is attached straight away; several come back for the user to
// choose from, with the ranked board beside them so the picker can search past the confident
// rows; none leaves the opportunity untouched.
//
// POST /opportunities/:id/posting attaches what the user hands over: a candidate from the
// picker, a pasted link (read and extracted the way manual capture does, so prohibited hosts
// are refused with the compliant path) or pasted text, which needs no AI at all.
//
// POST /opportunities/:id/posting/confirm and .../unconfirm (issue #250) let the user assert a
// flagged posting is right without the board ever settling it, and take that back.
//
// POST /opportunities/:id/posting/rederive (issue #264) re-derives a description from the
// capture already on the opportunity's timeline, for a record whose description was corrupted
// by something else (#238) or whose company never had a readable board for Refetch (#255) to
// find anything on.
import { CAPTURE_MAX_TEXT } from '../lib/captureText';
import { keyedFetch } from '../lib/safeFetch';
import { createHash } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { NormalizedPostingSchema, POSTING_STATES } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/client';
import { HttpError } from '../lib/errors';
import { isSystemWritten, replaceAllowedByFlag } from '../lib/postingFingerprint';
import {
  attachPosting,
  attachPostingSaying,
  POSTING_CHANGES,
  recordIdentified,
} from '../lib/postingAttach';
import { confirmPosting, unconfirmPosting } from '../lib/postingConfirm';
import { rederivePosting } from '../lib/postingRederive';
import type { SourceContext } from '../adapters/discoverySource';
import { verifyEmbeddedGreenhouse } from '../lib/greenhouseEmbed';
import {
  describeWorkdayPosting,
  findPosting,
  ownGreenhouseRef,
  type BodyReader,
} from '../lib/postingSearch';
import { racePoint } from '../lib/racePoints';
import type { UserCtx } from '../repos/base';
import { unfinishedDedupeKeys } from '../repos/jobs';
import { POSTING_RECONCILE_KIND } from '../lib/jobKinds';
import { opportunityChanged, stopSearch } from '../lib/postingReconcile';
import {
  basisChanges,
  getOpportunity,
  recordAtsJobRef,
  SearchBasisChanged,
  searchBasisOf,
  setPostingState,
  type BasisField,
  type SearchBasis,
  type OpportunityView as OpportunityRowView,
} from '../repos/opportunities';
import { extract, fetchPageText, PASTE_TEXT_HINT } from './capture';
import { HttpsUrl, IdParams } from './common';
import { OpportunityView } from './opportunities';
import { workflow } from '../obs/workflow';

const CandidateView = z.object({
  posting: NormalizedPostingSchema,
  score: z.number(),
  otherLocations: z.array(z.string()),
});

/**
 * The description the user agreed to lose, named by its fingerprint: text saved since is not covered
 * by that, so it is kept. At `edited` (#858), and to a re-derive (#1010); without it, a description
 * of the user's is always kept.
 */
const DescriptionAgreed = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The posting state the page saw when Find posting was clicked ('none' for no state yet), so a
 * click landing after a background check confirmed the posting does not refetch it (#852).
 */
const FindQuery = z.object({
  seen: z.enum([...POSTING_STATES, 'none']).optional(),
  replaceDescription: DescriptionAgreed.optional(),
});

const FindResponse = z.object({
  /** 'identified' (#398): the opportunity's own careers link got its Greenhouse identity from
   *  Greenhouse's API; no posting was attached. */
  outcome: z.enum([
    'attached',
    'identified',
    'candidates',
    'none',
    'no_board',
    'unreachable',
    'already_confirmed',
  ]),
  /** An attach that changed nothing: a Refetch that found the same job (#835). */
  unchanged: z.literal(true).optional(),
  /** What a Refetch changed (#866): absent on a first attach, and when `unchanged`. */
  changed: z.array(z.enum(POSTING_CHANGES)).optional(),
  /** The posting was confirmed, with the user's own description left as it was, not compared with
   *  the board's. */
  keptDescription: z.literal(true).optional(),
  /** Present when the outcome is 'attached' or 'identified'. */
  opportunity: OpportunityView.optional(),
  candidate: CandidateView.optional(),
  /** Confident candidates ('candidates'), or the ranked board ('none'). */
  candidates: z.array(CandidateView).optional(),
  /** The ranked board behind the confident candidates. */
  board: z.array(CandidateView).optional(),
  needsCareersUrl: z.boolean().optional(),
  /** True when the one candidate came from a link in a message, on a board the company does
   *  not own: the user confirms it rather than the server attaching it. */
  needsConfirmation: z.boolean().optional(),
  hint: z.string().optional(),
  /** What was searched for (#892), opaque: sent back with a row picked from the answer. */
  searchedFor: z.string().optional(),
  /** A large board was read only in part (FR-D10's Workday lookup cap). */
  note: z.string().optional(),
});

const AttachBody = z
  .object({
    /** A candidate from the picker. */
    posting: NormalizedPostingSchema.optional(),
    /**
     * With a candidate: the search it came from (#892). Whatever it says, one that is not the answer's for
     * the opportunity as it now is has been made out of date. A page from before an upgrade has none.
     */
    searchedFor: z.string().optional(),
    url: HttpsUrl.optional(),
    text: z.string().trim().min(1).max(200_000).optional(),
    replaceDescription: DescriptionAgreed.optional(),
  })
  .strict()
  .refine((b) => [b.posting, b.url, b.text].filter((v) => v !== undefined).length === 1, {
    message: 'send exactly one of posting, url or text',
  });

/** A search's basis, for the page that shows its candidates: opaque, and of the stored values exactly. */
const searchKey = (basis: SearchBasis): string =>
  createHash('sha256')
    .update(JSON.stringify([basis.companyId, basis.title, basis.postingUrl]))
    .digest('hex');

const RederiveBody = z
  .object({
    /** The user was asked, and said yes: the description (or their confirmation) may be lost. */
    force: z.boolean().optional(),
    /** The description they were asked about: no other is replaced (#1010). */
    replaceDescription: DescriptionAgreed.optional(),
  })
  .strict();

const RederiveResponse = z.object({
  outcome: z.enum(['merged', 'capture_only', 'no_description_found', 'left_alone']),
  /** Present unless the outcome is 'no_description_found', which changes nothing. */
  opportunity: OpportunityView.optional(),
});

/**
 * True when the description is the user's own writing, which outranks any board (design D11), and
 * they have not agreed to lose it (#858).
 * A description the system wrote (a capture, an earlier attach) may be looked up again, which
 * is what the needs-review banner's button does: before this, any description at all refused
 * the search, and a capture makes that permanently true.
 */
function userWritten(opp: OpportunityRowView, agreed: string | undefined): boolean {
  if (replaceAllowedByFlag(opp, agreed)) return false;
  return !isSystemWritten(opp.descriptionMd, opp.descriptionFingerprint);
}

/**
 * An attach refused because its job is tracked as another of the user's opportunities (its company,
 * title and location are that one's, repos/opportunities.ts claimDedupeKey) says which one
 * (https://github.com/bgoleno/opportun/issues/936). Read as the user: only their own is ever named.
 */
async function namingTracked<T>(db: Db, ctx: UserCtx, attach: () => Promise<T>): Promise<T> {
  try {
    return await attach();
  } catch (err) {
    const existingId = err instanceof HttpError ? err.details?.existingId : undefined;
    if (!(err instanceof HttpError) || err.code !== 'duplicate' || typeof existingId !== 'string') {
      throw err;
    }
    await racePoint('posting.alreadyTracked');
    let tracked: OpportunityRowView;
    try {
      tracked = await getOpportunity(db, ctx, existingId);
    } catch {
      // Deleted or merged meanwhile: the refusal as it was.
      throw err;
    }
    throw new HttpError(409, 'duplicate', undefined, {
      existingId,
      existingTitle: tracked.title,
      existingCompany: tracked.companyName,
    });
  }
}

/** attachPosting and attachPostingSaying, with their refusal for a tracked job naming it. */
const attach = (...args: Parameters<typeof attachPosting>) =>
  namingTracked(args[0], args[1], () => attachPosting(...args));
const attachSaying = (...args: Parameters<typeof attachPostingSaying>) =>
  namingTracked(args[0], args[1], () => attachPostingSaying(...args));

export async function opportunityPostingRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  const db = app.db;

  /**
   * The identity of an opportunity's own embedded Greenhouse link (#398), checked on
   * Greenhouse's API when no board read gave it: the opportunity as written, or null when the
   * link is not one, no known board holds the job, or the link changed meanwhile.
   */
  async function identifyOwnLink(
    ctx: UserCtx,
    opp: OpportunityRowView,
    sctx: Pick<SourceContext, 'fetch' | 'log'>,
  ): Promise<OpportunityRowView | null> {
    const own = ownGreenhouseRef(opp);
    if (own === null || opp.postingUrl == null) return null;
    const ref = await verifyEmbeddedGreenhouse(db, ctx, opp, own.url, sctx);
    if (ref === null) return null;
    const identified = await recordAtsJobRef(db, ctx, opp, ref);
    if (identified === null) {
      // Not written for what the user changed meanwhile (#892), and not for an identity set by another.
      const changed = basisChanges(opp, await getOpportunity(db, ctx, opp.id));
      if (changed.length > 0) throw new SearchBasisChanged(changed);
    }
    return identified;
  }

  /** A search refused for what the user changed meanwhile (#892): said on the timeline, and to them. */
  async function refuseChanged(
    ctx: UserCtx,
    id: string,
    fields: readonly BasisField[],
  ): Promise<never> {
    await stopSearch(db, ctx, id, fields);
    throw opportunityChanged();
  }
  const unlessChanged = async <T>(
    ctx: UserCtx,
    id: string,
    write: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await write();
    } catch (err) {
      if (err instanceof SearchBasisChanged) return await refuseChanged(ctx, id, err.fields);
      throw err;
    }
  };

  const readBody: BodyReader = async (bodyRef) =>
    (await buffer(await app.storage.openAttachment(bodyRef))).toString('utf8');

  api.post(
    '/opportunities/:id/find-posting',
    { schema: { params: IdParams, querystring: FindQuery, response: { 200: FindResponse } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const { id } = req.params;
      const sctx = { fetch: keyedFetch(app.jobs.services.sourceFetch, ctx.userId), log: req.log };
      const current = await getOpportunity(db, ctx, id);
      // The page's click saw the posting not confirmed yet, and a background check has confirmed it
      // since (#852, qa on #865: a click as the check ends). Not a Refetch the user asked for: the
      // posting is answered as it now is, and nothing is read or written.
      const seen = req.query.seen;
      if (seen !== undefined && seen !== 'confirmed' && current.postingState === 'confirmed') {
        return { outcome: 'already_confirmed' as const, opportunity: current };
      }
      // A background check is reading the board for this posting now (#852, qa): a click then
      // would be a second search racing it, writing a second attach. Its own result lands soon.
      // Its unfinished job is the signal, not the state alone (tl on #865): 'searching' left by a
      // check that died, or whose job is gone, must not take Find posting away.
      if (
        current.postingState === 'searching' &&
        (
          await unfinishedDedupeKeys(db, ctx, POSTING_RECONCILE_KIND, [
            `${POSTING_RECONCILE_KIND}:${id}`,
          ])
        ).length > 0
      ) {
        throw new HttpError(
          409,
          'posting_searching',
          "Opportun is still checking this posting on the company's board. Try again shortly.",
        );
      }
      // Checked before any board is read: the user's own description, on a posting already
      // confirmed, has nothing to find. An embedded Greenhouse link still gets its identity, from
      // Greenhouse's API, with the description left as it is (#398, tl on #414). Not confirmed
      // yet, the board is read and a match confirms it, the description kept (#756).
      const agreed = req.query.replaceDescription;
      const usersOwn = userWritten(current, agreed);
      if (usersOwn) {
        const identified = await unlessChanged(ctx, id, () => identifyOwnLink(ctx, current, sctx));
        if (current.postingState === 'confirmed' && identified !== null) {
          // On the timeline, as every other way a posting is found (#813).
          await recordIdentified(db, ctx, id, identified.atsJobRef?.url ?? current.postingUrl!, {
            kept: false,
          });
          return { outcome: 'identified' as const, opportunity: identified };
        }
        // Not confirmed yet (#756, tl): Greenhouse's own answer for its embedded link is the
        // proof, one request and no listing read (#398, #414). It now confirms the posting too,
        // user_confirmed so no later pass reads the user's description as the employer's copy.
        if (identified !== null) {
          const confirmed = await unlessChanged(ctx, id, () =>
            setPostingState(
              db,
              ctx,
              id,
              {
                postingState: 'confirmed',
                postingStateDetail: 'user_confirmed',
                atsJobRef: identified.atsJobRef,
              },
              { ifBasis: searchBasisOf(current) },
            ),
          );
          await recordIdentified(db, ctx, id, identified.atsJobRef?.url ?? current.postingUrl!, {
            kept: true,
          });
          return {
            outcome: 'identified' as const,
            opportunity: confirmed,
            keptDescription: true as const,
          };
        }
        // Otherwise the board is read, and a match confirms it, the description kept. Confirmed
        // already (a Refetch, #812, tl): only its own job refreshes it, below.
      }
      const outcome = await findPosting(db, ctx, id, sctx, { readBody });
      // Whatever it found, or did not, it is for what the opportunity was then (#892): not said of what
      // it is now.
      const { searchedFor } = outcome;
      const asSearched = async (): Promise<OpportunityRowView> => {
        const now = await getOpportunity(db, ctx, id);
        const stale = basisChanges(searchedFor, now);
        if (stale.length > 0) await refuseChanged(ctx, id, stale);
        return now;
      };
      await racePoint('posting.found');
      const now = await asSearched();
      // A confirmed posting with the user's own description is refreshed only from its own job
      // (ownJobRef, found on the board): a title match, or another job a message names, never
      // replaces a confirmed identity by itself. It is offered instead (#812, tl).
      const ownJobOnly =
        usersOwn &&
        current.postingState === 'confirmed' &&
        !(outcome.status === 'exact' && outcome.via === 'posting_link');
      if (ownJobOnly && (outcome.status === 'exact' || outcome.status === 'single')) {
        const note = outcome.note === undefined ? {} : { note: outcome.note };
        return {
          outcome: 'candidates' as const,
          candidates: [outcome.candidate],
          board: [outcome.candidate],
          needsConfirmation: false,
          searchedFor: searchKey(searchedFor),
          ...note,
        };
      }
      if (outcome.status === 'exact' || outcome.status === 'single') {
        // #114: 'single' can carry a large-board truncation note (exact never does, since it
        // only ever comes from an email-linked job id, never a board read). Forwarded onto the
        // timeline entry (attachPosting) and in this response, so a person watching the moment
        // sees it in the toast and it still stands after the toast is gone.
        const { opportunity, changed, keptDescription } = await unlessChanged(ctx, id, () =>
          attachSaying(
            db,
            ctx,
            id,
            outcome.candidate.posting,
            outcome.status === 'exact'
              ? outcome.via === 'posting_link'
                ? 'posting_link'
                : 'email_link'
              : 'board',
            outcome.note,
            // The board this posting was just read from is the proof an embedded Greenhouse job
            // needs (#398): no further request.
            outcome.readFrom === undefined
              ? {
                  sctx: {
                    fetch: keyedFetch(app.jobs.services.sourceFetch, ctx.userId),
                    log: req.log,
                  },
                }
              : { readFrom: outcome.readFrom },
            {
              keepDescription: true,
              byFindPosting: true,
              ifBasis: searchedFor,
              ...(agreed === undefined ? {} : { replaceAgreed: agreed }),
            },
          ),
        );
        const note = outcome.note === undefined ? {} : { note: outcome.note };
        // A Refetch says what it changed, or that it changed nothing (#835, #866, qa on #830 and
        // #860), instead of "Posting attached".
        return {
          outcome: 'attached' as const,
          opportunity,
          candidate: outcome.candidate,
          ...(changed === null
            ? {}
            : changed.length === 0
              ? { unchanged: true as const }
              : { changed }),
          ...(keptDescription ? { keptDescription: true as const } : {}),
          ...note,
        };
      }
      // No board read answered the opportunity's own careers link: its identity can still come
      // from Greenhouse's API, while the posting itself is left to the user to choose (#398).
      const identified = await unlessChanged(ctx, id, () => identifyOwnLink(ctx, now, sctx));
      // That can have asked Greenhouse.
      await asSearched();
      const note = outcome.note === undefined ? {} : { note: outcome.note };
      if (identified !== null && outcome.status !== 'candidates') {
        // On the timeline, as the user-described cases above are (#813, tl on #847).
        await recordIdentified(db, ctx, id, identified.atsJobRef?.url ?? now.postingUrl!, {
          kept: false,
        });
        return { outcome: 'identified' as const, opportunity: identified, ...note };
      }
      if (outcome.status === 'candidates') {
        return {
          outcome: 'candidates' as const,
          candidates: outcome.candidates,
          board: outcome.board,
          needsConfirmation: outcome.via === 'email_link_unverified',
          searchedFor: searchKey(searchedFor),
          ...note,
        };
      }
      if (outcome.status === 'none') {
        return {
          outcome: 'none' as const,
          candidates: outcome.candidates,
          searchedFor: searchKey(searchedFor),
          ...note,
        };
      }
      if (outcome.status === 'unreachable') return { outcome: 'unreachable' as const };
      return {
        outcome: 'no_board' as const,
        needsCareersUrl: outcome.needsCareersUrl,
        hint: PASTE_TEXT_HINT,
      };
    },
  );

  api.post(
    '/opportunities/:id/posting',
    { schema: { params: IdParams, body: AttachBody, response: { 200: OpportunityView } } },
    async (req) => {
      const ctx = app.requireUser(req);
      // The capture workflow (design 14.5), for a posting pasted onto an opportunity.
      return workflow('capture', { userId: ctx.userId }, async () => {
        const { id } = req.params;
        const opp = await getOpportunity(db, ctx, id);
        const { posting, text, url, replaceDescription, searchedFor } = req.body;
        const agreed =
          replaceDescription === undefined ? {} : { replaceAgreed: replaceDescription };
        // Anything handed over here, a picked board row included, comes from the client: an
        // embedded Greenhouse link in it is checked on Greenhouse's API, never taken on trust (#398).
        const identity = {
          sctx: { fetch: keyedFetch(app.jobs.services.sourceFetch, ctx.userId), log: req.log },
        };
        if (posting !== undefined) {
          // Found for a company, title or link that is another now (#892): refused, and the person is
          // told on the spot. What they paste themselves was found by no search.
          const ifBasis = searchBasisOf(opp);
          if (searchedFor !== undefined && searchedFor !== searchKey(ifBasis)) {
            throw opportunityChanged();
          }
          // A Workday board row is listed without its description: fetch it now (FR-D10).
          const described = await describeWorkdayPosting(
            { fetch: keyedFetch(app.jobs.services.sourceFetch, ctx.userId), log: req.log },
            posting,
          );
          // A row picked from the board confirms a posting the user described themselves, the
          // description kept, as Find posting's own match does (#756).
          try {
            return await attach(db, ctx, id, described, 'board', undefined, identity, {
              keepDescription: true,
              ifBasis,
              ...agreed,
            });
          } catch (err) {
            if (err instanceof SearchBasisChanged) throw opportunityChanged();
            throw err;
          }
        }
        if (text !== undefined) {
          return attach(
            db,
            ctx,
            id,
            { company: opp.companyName, title: opp.title, descriptionMd: text },
            'paste',
            undefined,
            identity,
            agreed,
          );
        }
        const page = await fetchPageText(
          keyedFetch(app.jobs.services.sourceFetch, ctx.userId),
          url as string,
        );
        const out = await extract(db, ctx, url, page);
        return attach(
          db,
          ctx,
          id,
          {
            company: out.companyName?.trim() ?? opp.companyName,
            title: out.title?.trim() ?? opp.title,
            // Without an extracted description the page text itself is the description.
            descriptionMd: out.descriptionMd ?? page.slice(0, CAPTURE_MAX_TEXT),
            postingUrl: url ?? out.postingUrl,
            location: out.location,
            remote: out.remote === null ? null : out.remote === 'remote',
            compNote: out.compNote,
          },
          'paste',
          undefined,
          identity,
          agreed,
        );
      });
    },
  );

  api.post(
    '/opportunities/:id/posting/confirm',
    { schema: { params: IdParams, response: { 200: OpportunityView } } },
    async (req) => confirmPosting(db, app.requireUser(req), req.params.id),
  );

  api.post(
    '/opportunities/:id/posting/unconfirm',
    { schema: { params: IdParams, response: { 200: OpportunityView } } },
    async (req) => unconfirmPosting(db, app.requireUser(req), req.params.id),
  );

  api.post(
    '/opportunities/:id/posting/rederive',
    // No `body` schema: like confirm/unconfirm above, this is usually called with none at all,
    // and Fastify's JSON parser hands an empty request through as `null` rather than `{}`.
    { schema: { params: IdParams, response: { 200: RederiveResponse } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const { force, replaceDescription } = RederiveBody.parse(req.body ?? {});
      const outcome = await rederivePosting(
        db,
        ctx,
        req.params.id,
        { fetch: keyedFetch(app.jobs.services.sourceFetch, ctx.userId), log: req.log },
        {
          force,
          ...(replaceDescription === undefined ? {} : { replaceAgreed: replaceDescription }),
        },
      );
      return outcome.kind === 'no_description_found'
        ? { outcome: outcome.kind }
        : { outcome: outcome.kind, opportunity: outcome.opportunity };
    },
  );
}
