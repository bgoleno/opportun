// Activities, next steps and the merged timeline (FR-O3, O4).
import {
  ACTIVITY_KINDS,
  ActivitySchema,
  COMM_CHANNELS,
  COMM_CLASSIFICATIONS,
  NextStepSchema,
  OPPORTUNITY_STAGES,
  ParticipantSchema,
  REFERRAL_STATUSES,
  TimestampSchema,
} from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ACTIVITY_SORTS,
  createActivity,
  createNextStep,
  createReferral,
  deleteActivity,
  deleteNextStep,
  getActivity,
  listActivities,
  listNextSteps,
  listOpportunityReferrals,
  NEXT_STEP_SORTS,
  opportunityTimeline,
  updateActivity,
  updateNextStep,
} from '../repos/activities';
import { HttpUrl, IdParams, listQuery, optionalText, pageOf } from './common';

const timelineBase = {
  id: z.string(),
  opportunityId: z.string(),
  opportunityTitle: z.string(),
  occurredAt: z.number().int(),
};
/** One entry of the merged timeline; `kind` says which source it came from. */
export const TimelineItemSchema = z.discriminatedUnion('kind', [
  z.object({
    ...timelineBase,
    kind: z.literal('activity'),
    activityKind: z.enum(ACTIVITY_KINDS),
    title: z.string(),
    bodyMd: z.string().nullable(),
    participants: z.array(ParticipantSchema),
    externalUrl: z.string().nullable(),
  }),
  z.object({
    ...timelineBase,
    kind: z.literal('stage'),
    fromStage: z.enum(OPPORTUNITY_STAGES).nullable(),
    toStage: z.enum(OPPORTUNITY_STAGES),
    note: z.string().nullable(),
  }),
  z.object({
    ...timelineBase,
    kind: z.literal('communication'),
    channel: z.enum(COMM_CHANNELS),
    from: z.string(),
    subject: z.string().nullable(),
    snippet: z.string().nullable(),
    classification: z.enum(COMM_CLASSIFICATIONS).nullable(),
  }),
]);

const activityFields = {
  kind: z.enum(ACTIVITY_KINDS),
  title: z.string().trim().min(1).max(300),
  bodyMd: optionalText(100_000),
  occurredAt: TimestampSchema,
  participants: z.array(z.string().trim().min(1).max(200)).max(50),
  externalUrl: HttpUrl.nullish(),
};
const ActivityCreate = z.object({
  ...activityFields,
  occurredAt: TimestampSchema.optional(),
  participants: activityFields.participants.default([]),
});
const ActivityPatch = z
  .object({
    ...activityFields,
    /** Referral activities only: rewrites the status line at the top of the body (FR-C4). */
    referralStatus: z.enum(REFERRAL_STATUSES),
  })
  .partial();

const ReferralCreate = z.object({
  contactId: z.string().min(1).max(64),
  note: optionalText(10_000),
});
const ReferralItem = z.object({
  activityId: z.string(),
  contactId: z.string(),
  name: z.string(),
  status: z.enum(REFERRAL_STATUSES).nullable(),
  note: z.string().nullable(),
  occurredAt: z.number().int(),
});

const stepFields = {
  action: z.string().trim().min(1).max(500),
  dueAt: TimestampSchema.nullish(),
  owner: optionalText(100),
};
const NextStepCreate = z.object(stepFields);
const NextStepPatch = z
  .object({
    ...stepFields,
    /** true sets doneAt to now, false clears it. */
    done: z.boolean(),
    doneAt: TimestampSchema.nullable(),
  })
  .partial()
  .refine((p) => p.done === undefined || p.doneAt === undefined, {
    message: 'send done or doneAt, not both',
    path: ['done'],
  });

const PageQuery = listQuery([]).omit({ sort: true });

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  // --- activities ----------------------------------------------------------

  api.get(
    '/opportunities/:id/activities',
    {
      schema: {
        params: IdParams,
        querystring: listQuery([...ACTIVITY_SORTS.keys()]),
        response: { 200: pageOf(ActivitySchema) },
      },
    },
    async (req) => listActivities(db, app.requireUser(req), req.params.id, req.query),
  );

  api.post(
    '/opportunities/:id/activities',
    { schema: { params: IdParams, body: ActivityCreate, response: { 201: ActivitySchema } } },
    async (req, reply) => {
      const { occurredAt, ...rest } = req.body;
      const row = await createActivity(db, app.requireUser(req), req.params.id, {
        ...rest,
        occurredAt: occurredAt ?? Date.now(),
      });
      return reply.code(201).send(row);
    },
  );

  api.get(
    '/activities/:id',
    { schema: { params: IdParams, response: { 200: ActivitySchema } } },
    async (req) => getActivity(db, app.requireUser(req), req.params.id),
  );

  api.patch(
    '/activities/:id',
    { schema: { params: IdParams, body: ActivityPatch, response: { 200: ActivitySchema } } },
    async (req) => updateActivity(db, app.requireUser(req), req.params.id, req.body),
  );

  api.delete(
    '/activities/:id',
    { schema: { params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await deleteActivity(db, app.requireUser(req), req.params.id);
      return reply.code(204).send(null);
    },
  );

  // --- referral asks (FR-C4) ----------------------------------------------

  api.post(
    '/opportunities/:id/referrals',
    { schema: { params: IdParams, body: ReferralCreate, response: { 201: ActivitySchema } } },
    async (req, reply) =>
      reply.code(201).send(await createReferral(db, app.requireUser(req), req.params.id, req.body)),
  );

  api.get(
    '/opportunities/:id/referrals',
    { schema: { params: IdParams, response: { 200: pageOf(ReferralItem) } } },
    async (req) => listOpportunityReferrals(db, app.requireUser(req), req.params.id),
  );

  // --- next steps ----------------------------------------------------------

  api.get(
    '/opportunities/:id/next-steps',
    {
      schema: {
        params: IdParams,
        querystring: listQuery([...NEXT_STEP_SORTS.keys()]),
        response: { 200: pageOf(NextStepSchema) },
      },
    },
    async (req) => listNextSteps(db, app.requireUser(req), req.params.id, req.query),
  );

  api.post(
    '/opportunities/:id/next-steps',
    { schema: { params: IdParams, body: NextStepCreate, response: { 201: NextStepSchema } } },
    async (req, reply) =>
      reply.code(201).send(await createNextStep(db, app.requireUser(req), req.params.id, req.body)),
  );

  api.patch(
    '/next-steps/:id',
    { schema: { params: IdParams, body: NextStepPatch, response: { 200: NextStepSchema } } },
    async (req) => {
      const { done, ...rest } = req.body;
      const patch = done === undefined ? rest : { ...rest, doneAt: done ? Date.now() : null };
      return updateNextStep(db, app.requireUser(req), req.params.id, patch);
    },
  );

  api.delete(
    '/next-steps/:id',
    { schema: { params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await deleteNextStep(db, app.requireUser(req), req.params.id);
      return reply.code(204).send(null);
    },
  );

  // --- timeline ------------------------------------------------------------

  api.get(
    '/opportunities/:id/timeline',
    {
      schema: {
        params: IdParams,
        querystring: PageQuery,
        response: { 200: pageOf(TimelineItemSchema) },
      },
    },
    async (req) => opportunityTimeline(db, app.requireUser(req), req.params.id, req.query),
  );
}
