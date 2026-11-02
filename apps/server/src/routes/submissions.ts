// Application submission routes (assisted apply M1a, https://github.com/bgoleno/opportun/issues/114;
// design Part A section 6.1). Session routes only: a device token cannot reach them.
//
// Rules every route here keeps, for this milestone and the ones after it:
// - Opportun never transmits an application. Nothing here contacts an employer or an ATS.
// - One opportunity per request. Every route names exactly one id in its path and there is no
//   route that lists or acts on submissions across opportunities (both enforced by
//   test/submissionRouteShape.test.ts, which reads the registered paths). A body names no
//   opportunity or submission: the only id it may carry is the chosen resume's, and an id array
//   or any other key is refused by the strict schemas (test/submissions.test.ts).
// - The whole feature is behind OPPORTUN_SUBMISSIONS=1 and never on the demo: otherwise every
//   route answers 404 feature_unavailable from its own first hook. The app-wide session and
//   CSRF hooks run before it, as for every route; nothing of a submission is read before it.
// - A body with an unknown key, or a value of the wrong shape (an id array included), is 422.
import { SubmissionAnswersSchema, SubmissionFieldsSchema, SubmissionSchema } from '@opportun/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MAX_DAILY_REVIEW_CAP, submissionsEnabled } from '../config';
import { HttpError } from '../lib/errors';
import { rateLimit } from '../lib/rateLimit';
import type { ValidationIssue } from '../plugins/security';
import {
  cancelSubmission,
  createSubmissionDraft,
  getSnapshotForDownload,
  getSubmission,
  listSubmissionsForOpportunity,
  updateSubmissionDraft,
} from '../repos/submissions';
import {
  attestSubmission,
  recordSubmissionOutcome,
  SUBMISSION_OUTCOMES,
} from '../repos/submissionOutcome';
import {
  handoffSubmission,
  reviewSubmission,
  reviewUsage,
  setUserReviewCap,
} from '../repos/submissionReview';
import { contentDisposition } from './attachments';
import { DEFAULT_LIMIT, IdParams, MAX_LIMIT, pageOf } from './common';

const CreateBody = z
  .object({
    /** Client-generated per attempt; a repeat with the same key returns the same draft. */
    idempotencyKey: z.uuid(),
    resumeId: z.string().min(1).max(64),
  })
  .strict();

const PatchBody = z
  .object({
    resumeId: z.string().min(1).max(64),
    fields: SubmissionFieldsSchema,
    answers: SubmissionAnswersSchema,
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, {
    message: 'send at least one of resumeId, fields, answers',
  });

/**
 * A cancel carries nothing. Fastify hands an empty request body through as null, not {} (the
 * same note as routes/opportunityPosting.ts's rederive), so absent and null both pass.
 */
const EmptyBody = z.object({}).strict().nullish();

/**
 * The review: the digest of the state the screen showed (GET /submissions/:id's reviewDigest),
 * and the user's explicit acknowledgment that Opportun will not submit it (design 6.1).
 */
const ReviewBody = z
  .object({
    reviewDigest: z.string().regex(/^[0-9a-f]{64}$/),
    acknowledged: z.literal(true),
    /**
     * Required when the user already applied to this requisition (422 reapply_reason_required
     * otherwise); user-authored, kept with the attempt (owner decision 6, #118).
     */
    reapplyReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * "I submitted it" (M2a, #118). `moveToApplied` has no default: the screen sends the tick the
 * user left (pre-ticked, owner decision 3), so the stage never changes on an omitted field.
 */
const AttestBody = z
  .object({
    moveToApplied: z.boolean(),
    submittedAt: z.number().int().positive().optional(),
  })
  .strict();

/** What the user reports after the handoff; the note is theirs, like a timeline note. */
const OutcomeBody = z
  .object({
    outcome: z.enum(SUBMISSION_OUTCOMES),
    note: z.string().trim().max(1_000).optional(),
  })
  .strict();

const HandoffResponse = z.object({
  /** The employer's posting, for the browser to open. The server never fetches it. */
  destinationUrl: z.string(),
  /** When the handoff lapses if no outcome is recorded: a fixed time. */
  expiresAt: z.number().int(),
});

/**
 * In-process burst limit per user on review and handoff (design 3.4 item 5 (i)), on top of the
 * database-counted daily cap. Generous for a person, too tight for a script.
 */
const BURST = { limit: 10, windowMs: 60 * 1000 } as const;

/** The user's own daily review cap; null goes back to the instance's (#130). */
const ReviewCapBody = z
  .object({ dailyReviewCap: z.number().int().min(1).max(MAX_DAILY_REVIEW_CAP).nullable() })
  .strict();

const ReviewUsageSchema = z.object({
  used: z.number().int(),
  cap: z.number().int(),
  instanceCap: z.number().int(),
  userCap: z.number().int().nullable(),
  nextFreeAt: z.number().int().nullable(),
});

const PageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

/**
 * The app answers schema validation with 400 elsewhere (plugins/security.ts). These routes
 * attach the validation error instead and answer 422, as #114 criterion 3 asks, with the same
 * body a 400 carries: `{ error: { code: 'validation', issues } }`, every issue with its path.
 * Returns true when it answered; the handler then returns at once.
 */
function answeredInvalid(req: FastifyRequest, reply: FastifyReply): boolean {
  const err = req.validationError;
  if (err === undefined || err === null) return false;
  const context = (err as { validationContext?: string }).validationContext;
  const validation =
    (err as { validation?: { instancePath?: string; keyword?: string; message?: string }[] })
      .validation ?? [];
  const issues: ValidationIssue[] = validation.map((v) => ({
    path: [
      ...(context === undefined ? [] : [context]),
      ...(v.instancePath ?? '').split('/').filter((s) => s.length > 0),
    ],
    code: v.keyword ?? 'invalid',
    message: v.message ?? 'Invalid input',
  }));
  void reply.code(422).send({ error: { code: 'validation', issues } });
  return true;
}

export async function submissionRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  // Off, or on the demo: no route here exists as far as a caller can tell (design 7.8).
  app.addHook('onRequest', async () => {
    if (!submissionsEnabled(app.config)) {
      throw new HttpError(404, 'feature_unavailable');
    }
  });

  api.post(
    '/opportunities/:id/submissions',
    {
      attachValidation: true,
      schema: {
        params: IdParams,
        body: CreateBody,
        response: { 200: SubmissionSchema, 201: SubmissionSchema },
      },
    },
    async (req, reply) => {
      if (answeredInvalid(req, reply)) return reply;
      const { submission, replayed } = await createSubmissionDraft(
        db,
        app.requireUser(req),
        req.params.id,
        req.body,
      );
      if (replayed) void reply.header('idempotent-replayed', 'true');
      return reply.code(replayed ? 200 : 201).send(submission);
    },
  );

  api.get(
    '/opportunities/:id/submissions',
    {
      attachValidation: true,
      schema: {
        params: IdParams,
        querystring: PageQuery,
        response: { 200: pageOf(SubmissionSchema) },
      },
    },
    async (req, reply) => {
      if (answeredInvalid(req, reply)) return reply;
      return listSubmissionsForOpportunity(db, app.requireUser(req), req.params.id, req.query);
    },
  );

  api.get(
    '/submissions/:id',
    { attachValidation: true, schema: { params: IdParams, response: { 200: SubmissionSchema } } },
    async (req, reply) => {
      if (answeredInvalid(req, reply)) return reply;
      return getSubmission(db, app.requireUser(req), req.params.id);
    },
  );

  api.patch(
    '/submissions/:id',
    {
      attachValidation: true,
      schema: { params: IdParams, body: PatchBody, response: { 200: SubmissionSchema } },
    },
    async (req, reply) => {
      if (answeredInvalid(req, reply)) return reply;
      return updateSubmissionDraft(db, app.requireUser(req), req.params.id, req.body);
    },
  );

  // The caller's own daily review usage and cap (#130): a per-user setting, so under /settings
  // like the others, and not a submission route (test/submissionRouteShape.test.ts keeps those
  // to one id each). Registered here so the flag hook above covers them too.
  api.get(
    '/settings/applications',
    { schema: { response: { 200: ReviewUsageSchema } } },
    async (req) => reviewUsage(db, app.requireUser(req), app.config),
  );

  api.put(
    '/settings/applications',
    {
      attachValidation: true,
      schema: { body: ReviewCapBody, response: { 200: ReviewUsageSchema } },
    },
    async (req, reply) => {
      if (answeredInvalid(req, reply)) return reply;
      return setUserReviewCap(db, app.requireUser(req), app.config, req.body.dailyReviewCap);
    },
  );

  const reviewBurst = rateLimit({
    ...BURST,
    keyFn: (req) => `submission-review|${app.requireUser(req).userId}`,
  });
  const handoffBurst = rateLimit({
    ...BURST,
    keyFn: (req) => `submission-handoff|${app.requireUser(req).userId}`,
  });

  // Session and CSRF only, like every route here: a device token cannot review or hand off.
  api.post(
    '/submissions/:id/review',
    {
      attachValidation: true,
      preHandler: reviewBurst,
      schema: { params: IdParams, body: ReviewBody, response: { 200: SubmissionSchema } },
    },
    async (req, reply) => {
      if (answeredInvalid(req, reply)) return reply;
      return reviewSubmission(db, app.requireUser(req), app.config, req.params.id, req.body);
    },
  );

  api.post(
    '/submissions/:id/handoff',
    {
      attachValidation: true,
      preHandler: handoffBurst,
      schema: { params: IdParams, body: EmptyBody, response: { 200: HandoffResponse } },
    },
    async (req, reply) => {
      if (answeredInvalid(req, reply)) return reply;
      return handoffSubmission(db, app.requireUser(req), req.params.id);
    },
  );

  api.post(
    '/submissions/:id/cancel',
    {
      attachValidation: true,
      schema: { params: IdParams, body: EmptyBody, response: { 200: SubmissionSchema } },
    },
    async (req, reply) => {
      if (answeredInvalid(req, reply)) return reply;
      return cancelSubmission(db, app.requireUser(req), req.params.id);
    },
  );

  api.post(
    '/submissions/:id/attest',
    {
      attachValidation: true,
      schema: { params: IdParams, body: AttestBody, response: { 200: SubmissionSchema } },
    },
    async (req, reply) => {
      if (answeredInvalid(req, reply)) return reply;
      return attestSubmission(db, app.requireUser(req), req.params.id, req.body);
    },
  );

  api.post(
    '/submissions/:id/outcome',
    {
      attachValidation: true,
      schema: { params: IdParams, body: OutcomeBody, response: { 200: SubmissionSchema } },
    },
    async (req, reply) => {
      if (answeredInvalid(req, reply)) return reply;
      return recordSubmissionOutcome(db, app.requireUser(req), req.params.id, req.body);
    },
  );

  // The snapshot file (#115 criterion 5): the owner's own attempt only, streamed the way an
  // attachment download is (routes/attachments.ts). Always a PDF: the job stores nothing else
  // (exportFile refuses bytes that are not one), and the header says so rather than echoing the
  // stored mime. nosniff and the other security headers come from plugins/security.ts.
  api.get('/submissions/:id/snapshot', { schema: { params: IdParams } }, async (req, reply) => {
    const file = await getSnapshotForDownload(db, app.requireUser(req), req.params.id);
    const stream = await app.storage.openAttachment(file.storedPath);
    return reply
      .header('content-type', 'application/pdf')
      .header('content-length', file.bytes)
      .header('content-disposition', contentDisposition(file.filename))
      .header('cache-control', 'private, no-store')
      .send(stream);
  });
}
