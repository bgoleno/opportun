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
import { submissionsEnabled } from '../config';
import { HttpError } from '../lib/errors';
import type { ValidationIssue } from '../plugins/security';
import {
  cancelSubmission,
  createSubmissionDraft,
  getSubmission,
  listSubmissionsForOpportunity,
  updateSubmissionDraft,
} from '../repos/submissions';
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
}
