// Capture ingest, the browser extension's server half (FR-C5, plan Task 13). The extension
// posts the LinkedIn tab the user is looking at as { url, title, text } under a capture:push
// device token (bearer only: deviceRoute, no session, no CSRF).
//
// Order of work: the deterministic shape check (lib/linkedinCapture) runs first, so a feed,
// search page or sign-in wall is refused (422 unrecognized_page) before any AI or database
// work. A profile then upserts a contact (repos/contacts upsertCapturedProfile); a job
// resolves to an opportunity through lib/captureResolve. capture.linkedin refines the fields when AI is available; without
// it (no key, budget, provider error) the deterministic reading is stored as is.
//
// Since 2026-10-19 a job capture no longer lands in the review queue: it resolves to an
// opportunity at `interested`, completing any pending lead for the same req instead of storing
// a second multi-posted one (lib/captureResolve, design D1 and D2, closing #17 and the FR-D7
// gap behind it). A profile capture is unchanged.
//
// C-1: the URL is provenance metadata. This route never fetches it, or anything else.
import {
  AiUnavailableError,
  LinkedInCaptureOutputSchema,
  renderPrompt,
  runStructured,
} from '@opportun/ai';
import { OPPORTUNITY_STAGES, type NormalizedPosting } from '@opportun/core';
import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/client';
import { buildAiDeps } from '../lib/ai';
import { rateLimit } from '../lib/rateLimit';
import { resolveCapture } from '../lib/captureResolve';
import {
  deviceRoute,
  requireDevice,
  requireDeviceToken,
  type DeviceCtx,
} from '../lib/deviceTokens';
import { HttpError } from '../lib/errors';
import { recognizeCapturedPage, type RecognizedPage } from '../lib/captureRecognizers';
import { isGroundedIn, profileSlugOf } from '../lib/linkedinCapture';
import { upsertCapturedProfile } from '../repos/contacts';
import { getActivePrompt } from '../repos/prompts';
import { CAPTURE_MAX_TEXT } from './capture';
import { HttpsUrl } from './common';

export const CAPTURE_TEXT_MAX = 200_000;

const CaptureBody = z
  .object({
    /** The tab's URL: provenance only, never fetched. */
    url: HttpsUrl,
    title: z.string().max(500),
    /** The tab's innerText as the extension extracted it. */
    text: z.string().min(1).max(CAPTURE_TEXT_MAX),
  })
  .strict();

const ProfileResponse = z.object({
  kind: z.literal('profile'),
  contactId: z.string(),
  created: z.boolean(),
  refined: z.boolean(),
});
const JobResponse = z.object({
  kind: z.literal('job'),
  resultId: z.string().nullable(),
  /** Frozen for installed extensions (design D18). Always false for a job capture now. */
  duplicate: z.boolean(),
  refined: z.boolean(),
  /** Added fields: an old build ignores them, a current one reports what happened. */
  opportunityId: z.string(),
  stage: z.enum(OPPORTUNITY_STAGES).nullable(),
});
const CaptureResponse = z.union([ProfileResponse, JobResponse]);

type Refined = z.infer<typeof LinkedInCaptureOutputSchema>;

/** A model-supplied single-line field: control characters flattened, trimmed, capped. */
function field(value: string | null, max: number): string | null {
  if (value === null) return null;
  const clean = value
    // eslint-disable-next-line no-control-regex -- flattening control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean === '' ? null : clean.slice(0, max);
}

/** A model-supplied profile field, kept only when the captured page itself contains it. */
function grounded(value: string | null, max: number, pageText: string): string | null {
  const clean = field(value, max);
  return clean !== null && isGroundedIn(clean, pageText) ? clean : null;
}

/** The page's URL for the model, as recognized (query dropped). */
const pageUrlOf = (page: RecognizedPage): string =>
  page.kind === 'profile' ? page.profileUrl : page.jobUrl;

/**
 * capture.linkedin over the page, or null when AI is unavailable (no prompt, no key, budget,
 * provider error) or the model reads the page as a different kind than the shape check did.
 */
async function refine(
  db: Db,
  ctx: DeviceCtx,
  page: RecognizedPage,
  title: string,
  text: string,
): Promise<Refined | null> {
  const prompt = await getActivePrompt(db, ctx, 'capture.linkedin');
  if (prompt === undefined) return null;
  const body =
    text.length > CAPTURE_MAX_TEXT ? `${text.slice(0, CAPTURE_MAX_TEXT)}\n[truncated]` : text;
  let out: Refined;
  try {
    out = await runStructured(await buildAiDeps(db, ctx), 'capture.linkedin', {
      system: renderPrompt(prompt.body, {
        page_url_untrusted: pageUrlOf(page),
        page_title_untrusted: title,
        page_untrusted: body,
      }),
      prompt: 'Read the captured page and return the result.',
      schema: LinkedInCaptureOutputSchema,
      promptId: prompt.id,
    });
  } catch (err) {
    if (err instanceof AiUnavailableError) return null;
    throw err;
  }
  return out.kind === page.kind ? out : null;
}

export async function connectorCaptureRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  // Same budget as the mail batch route, keyed by the token the auth hook resolved.
  const perToken = rateLimit({
    limit: 30,
    windowMs: 15 * 60 * 1000,
    keyFn: (req) => requireDevice(req).tokenId,
  });

  api.post(
    '/connector/capture',
    {
      ...deviceRoute('capture:push'),
      // Authenticate before the (up to 2 MiB) body is read and validated, not only in the
      // preHandler: an anonymous client never gets the server to buffer and parse a body, and
      // never sees validation detail. The preHandler (deviceRoute) authenticates again. The
      // per-token budget mirrors the mail batch route: captures cost AI and ranking work.
      onRequest: [
        requireDeviceToken('capture:push') as unknown as onRequestAsyncHookHandler,
        perToken as unknown as onRequestAsyncHookHandler,
      ],
      // 200k characters of text can exceed the 1 MiB default once JSON-escaped.
      bodyLimit: 2 * 1024 * 1024,
      schema: {
        body: CaptureBody,
        response: { 200: CaptureResponse, 201: CaptureResponse },
      },
    },
    async (req, reply) => {
      const ctx = requireDevice(req);
      const { url, title, text } = req.body;
      const page = recognizeCapturedPage({ url, title, text });
      if (page.kind === 'unrecognized') {
        throw new HttpError(422, 'unrecognized_page', undefined, { reason: page.reason });
      }
      const refined = await refine(db, ctx, page, title, text);

      if (page.kind === 'profile') {
        const slug = profileSlugOf(page.profileUrl) as string;
        const { contact, created } = await upsertCapturedProfile(db, ctx, {
          profileUrl: page.profileUrl,
          slug,
          // The name is the page's own; the model never renames a contact.
          name: page.name,
          // Model fields must be grounded in the page: an injected About section must not be
          // able to plant an employer (a referral candidate) that the page never shows.
          headline: grounded(refined?.headline ?? null, 300, text) ?? page.headline,
          company: grounded(refined?.company ?? null, 200, text),
          title: grounded(refined?.title ?? null, 300, text),
        });
        return reply.code(created ? 201 : 200).send({
          kind: 'profile' as const,
          contactId: contact.id,
          created,
          refined: refined !== null,
        });
      }

      // Title and company come from the page (they are the lead's dedupe identity); the model
      // adds what the shape check does not read. sanitizePosting cleans all of it on insert.
      const posting: NormalizedPosting = {
        company: page.company,
        title: page.title,
        location: field(refined?.location ?? null, 300),
        compNote: field(refined?.compNote ?? null, 500),
        descriptionMd: refined?.descriptionMd?.trim() || page.descriptionMd,
        postingUrl: page.jobUrl,
        externalId: `linkedin:${page.jobId}`,
      };
      // Capturing a job is an act of interest, so it resolves to an opportunity at
      // `interested` rather than to a review-queue card (design D1). A capture is therefore
      // never a duplicate: it completes the lead it matches instead of twinning it (#17).
      //
      // The response shape is frozen for already-installed extensions, which classify an
      // unrecognized success body as a hard server error (packages/extension/src/api.ts).
      // `duplicate` stays in the contract and is now always false for a job capture; an old
      // build therefore says "already in your review queue" where a current one says what
      // actually happened. Wrong copy, not a broken capture.
      const resolved = await resolveCapture(db, ctx, {
        posting,
        captureText: text,
        siteId: page.siteId,
      });
      return reply.code(resolved.createdOpportunity ? 201 : 200).send({
        kind: 'job' as const,
        resultId: resolved.resultId,
        duplicate: false,
        refined: refined !== null,
        opportunityId: resolved.opportunityId,
        stage: resolved.stageMovedTo,
      });
    },
  );
}
