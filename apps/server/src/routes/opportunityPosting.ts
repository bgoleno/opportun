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
import { buffer } from 'node:stream/consumers';
import { NormalizedPostingSchema } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError } from '../lib/errors';
import { isSystemWritten, replaceAllowedByFlag } from '../lib/postingFingerprint';
import { attachPosting } from '../lib/postingAttach';
import { confirmPosting, unconfirmPosting } from '../lib/postingConfirm';
import { rederivePosting } from '../lib/postingRederive';
import { describeWorkdayPosting, findPosting, type BodyReader } from '../lib/postingSearch';
import { getOpportunity, type OpportunityView as OpportunityRowView } from '../repos/opportunities';
import { CAPTURE_MAX_TEXT, extract, fetchPageText, PASTE_TEXT_HINT } from './capture';
import { HttpsUrl, IdParams } from './common';
import { OpportunityView } from './opportunities';

const CandidateView = z.object({
  posting: NormalizedPostingSchema,
  score: z.number(),
  otherLocations: z.array(z.string()),
});

const FindResponse = z.object({
  outcome: z.enum(['attached', 'candidates', 'none', 'no_board']),
  /** Present when the outcome is 'attached'. */
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
  /** A large board was read only in part (FR-D10's Workday lookup cap). */
  note: z.string().optional(),
});

const AttachBody = z
  .object({
    /** A candidate from the picker. */
    posting: NormalizedPostingSchema.optional(),
    url: HttpsUrl.optional(),
    text: z.string().trim().min(1).max(200_000).optional(),
  })
  .strict()
  .refine((b) => [b.posting, b.url, b.text].filter((v) => v !== undefined).length === 1, {
    message: 'send exactly one of posting, url or text',
  });

const RederiveBody = z.object({ force: z.boolean().optional() }).strict();

const RederiveResponse = z.object({
  outcome: z.enum(['merged', 'capture_only', 'no_description_found']),
  /** Present unless the outcome is 'no_description_found', which changes nothing. */
  opportunity: OpportunityView.optional(),
});

/**
 * True when the description is the user's own writing, which outranks any board (design D11).
 * A description the system wrote (a capture, an earlier attach) may be looked up again, which
 * is what the needs-review banner's button does: before this, any description at all refused
 * the search, and a capture makes that permanently true.
 */
function userWritten(opp: OpportunityRowView): boolean {
  if (replaceAllowedByFlag(opp)) return false;
  return !isSystemWritten(opp.descriptionMd, opp.descriptionFingerprint);
}

export async function opportunityPostingRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const readBody: BodyReader = async (bodyRef) =>
    (await buffer(await app.storage.openAttachment(bodyRef))).toString('utf8');

  api.post(
    '/opportunities/:id/find-posting',
    { schema: { params: IdParams, response: { 200: FindResponse } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const { id } = req.params;
      // Checked before any board is read: the user's own description has nothing to find.
      if (userWritten(await getOpportunity(db, ctx, id))) {
        throw new HttpError(
          409,
          'already_described',
          'This opportunity already has a description. Edit it instead.',
        );
      }
      const outcome = await findPosting(
        db,
        ctx,
        id,
        { fetch: app.jobs.services.sourceFetch, log: req.log },
        { readBody },
      );
      if (outcome.status === 'exact' || outcome.status === 'single') {
        // #114: 'single' can carry a large-board truncation note (exact never does, since it
        // only ever comes from an email-linked job id, never a board read). Forwarded onto the
        // timeline entry (attachPosting) and in this response, so a person watching the moment
        // sees it in the toast and it still stands after the toast is gone.
        const opportunity = await attachPosting(
          db,
          ctx,
          id,
          outcome.candidate.posting,
          outcome.status === 'exact' ? 'email_link' : 'board',
          outcome.note,
        );
        const note = outcome.note === undefined ? {} : { note: outcome.note };
        return { outcome: 'attached' as const, opportunity, candidate: outcome.candidate, ...note };
      }
      const note = outcome.note === undefined ? {} : { note: outcome.note };
      if (outcome.status === 'candidates') {
        return {
          outcome: 'candidates' as const,
          candidates: outcome.candidates,
          board: outcome.board,
          needsConfirmation: outcome.via === 'email_link_unverified',
          ...note,
        };
      }
      if (outcome.status === 'none') {
        return { outcome: 'none' as const, candidates: outcome.candidates, ...note };
      }
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
      const { id } = req.params;
      const opp = await getOpportunity(db, ctx, id);
      const { posting, text, url } = req.body;
      if (posting !== undefined) {
        // A Workday board row is listed without its description: fetch it now (FR-D10).
        const described = await describeWorkdayPosting(
          { fetch: app.jobs.services.sourceFetch, log: req.log },
          posting,
        );
        return attachPosting(db, ctx, id, described, 'board');
      }
      if (text !== undefined) {
        return attachPosting(
          db,
          ctx,
          id,
          { company: opp.companyName, title: opp.title, descriptionMd: text },
          'paste',
        );
      }
      const page = await fetchPageText(app.jobs.services.sourceFetch, url as string);
      const out = await extract(db, ctx, url, page);
      return attachPosting(
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
      );
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
      const { force } = RederiveBody.parse(req.body ?? {});
      const outcome = await rederivePosting(
        db,
        ctx,
        req.params.id,
        { fetch: app.jobs.services.sourceFetch, log: req.log },
        { force },
      );
      return outcome.kind === 'no_description_found'
        ? { outcome: outcome.kind }
        : { outcome: outcome.kind, opportunity: outcome.opportunity };
    },
  );
}
