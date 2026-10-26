// Opportunities and lifecycle transitions (FR-O1, O2, O5, O9 partial).
import {
  CLOSED_REASONS,
  DISMISS_REASONS,
  OPPORTUNITY_STAGES,
  OpportunitySchema,
  SOURCE_KINDS,
} from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createOpportunity,
  deleteOpportunity,
  dismissPossibleDuplicate,
  getOpportunity,
  listOpportunities,
  OPPORTUNITY_SORTS,
  reorderOpportunities,
  transitionOpportunity,
  updateOpportunity,
} from '../repos/opportunities';
import { search, SEARCH_KINDS } from '../repos/search';
import { HttpUrl, IdParams, listQuery, optionalText, pageOf } from './common';

export const OpportunityView = OpportunitySchema.extend({
  companyName: z.string(),
  /** Null until a homepage is confidently resolved (issue #239); never a guess. */
  companyDomain: z.string().nullable(),
  /** Ids of opportunities this one is flagged as a possible duplicate with, from either
   *  direction (#9). Empty when there is nothing to badge. */
  possibleDuplicates: z.array(z.string().min(1).max(64)),
  /** True when the description is the user's own writing (issue #255), derived from the
   *  internal descriptionFingerprint rather than exposing the hash itself. */
  descriptionIsUserWritten: z.boolean(),
  /** True when a 'capture' activity exists on this opportunity's timeline (issue #264), so the
   *  client knows whether re-deriving a description from it is possible at all. */
  hasCapturedPage: z.boolean(),
});

const Title = z.string().trim().min(1).max(300);
const Priority = z.number().int().min(1).max(3);

const editableFields = {
  companyName: z.string().trim().min(1).max(200),
  title: Title,
  descriptionMd: optionalText(100_000),
  postingUrl: HttpUrl.nullish(),
  location: optionalText(200),
  remote: z.boolean().nullish(),
  compNote: optionalText(1000),
  roleTargetId: z.string().min(1).max(64).nullish(),
};

const CreateBody = z.object({
  ...editableFields,
  sourceKind: z.enum(SOURCE_KINDS),
  priority: Priority.optional(),
});
/** Issue #240: a drag reorder PATCHes this directly; a stage change (POST /stage) always
 *  overwrites it server-side, so it is never accepted there. */
const SortOrder = z.number().int().min(-1_000_000).max(1_000_000);
const PatchBody = z
  .object({
    ...editableFields,
    priority: Priority,
    stageDetail: optionalText(200),
    sortOrder: SortOrder,
  })
  .partial()
  .strict();
/**
 * Cap for a single reorder request (#240 follow-up). A trivial single-column write with no
 * company lookup, dedupe scan, history row or search index touch -- unlike bulk-accept's
 * MAX_BULK_SIZE, which is tuned for an operation that does all four -- so this is bounded by
 * what one column could plausibly hold rather than by measured per-item cost. Kept well above
 * any single user's pipeline today specifically so a whole column always fits in the one
 * transaction this endpoint exists to provide; chunking it client-side would reintroduce the
 * exact atomicity gap this is the fix for.
 */
const REORDER_MAX_SIZE = 2000;
const ReorderBody = z
  .object({
    changes: z
      .array(z.object({ id: z.string().min(1).max(64), sortOrder: SortOrder }).strict())
      .min(1)
      .max(REORDER_MAX_SIZE),
  })
  .strict();

const CreateQuery = z.object({
  force: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
const DismissDuplicateBody = z.object({ otherId: z.string().min(1).max(64) }).strict();
const StageBody = z.object({
  to: z.enum(OPPORTUNITY_STAGES),
  closedReason: z.enum(CLOSED_REASONS).optional(),
  dismissedReason: z.enum(DISMISS_REASONS).optional(),
  note: z.string().trim().min(1).max(2000).optional(),
  reopen: z.boolean().optional(),
});
const StageList = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()))
  .pipe(z.array(z.enum(OPPORTUNITY_STAGES)).min(1));
const ListQuery = listQuery([...OPPORTUNITY_SORTS.keys()]).extend({
  stage: StageList.optional(),
  companyId: z.string().min(1).max(64).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

const SearchQuery = listQuery([])
  .omit({ sort: true })
  .extend({ q: z.string().trim().min(1).max(500) });
const SearchHit = z.object({
  entityKind: z.enum(SEARCH_KINDS),
  entityId: z.string(),
  /** Highlights are wrapped in \u0002 ... \u0003 (SNIPPET_START / SNIPPET_END). */
  snippet: z.string(),
  opportunityId: z.string().nullable(),
});

export async function opportunityRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get(
    '/opportunities',
    { schema: { querystring: ListQuery, response: { 200: pageOf(OpportunityView) } } },
    async (req) => listOpportunities(db, app.requireUser(req), req.query),
  );

  api.post(
    '/opportunities',
    { schema: { querystring: CreateQuery, body: CreateBody, response: { 201: OpportunityView } } },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      const opp = await createOpportunity(db, ctx, req.body, { force: req.query.force });
      return reply.code(201).send(opp);
    },
  );

  api.get(
    '/opportunities/:id',
    { schema: { params: IdParams, response: { 200: OpportunityView } } },
    async (req) => getOpportunity(db, app.requireUser(req), req.params.id),
  );

  api.patch(
    '/opportunities/:id',
    { schema: { params: IdParams, body: PatchBody, response: { 200: OpportunityView } } },
    async (req) => updateOpportunity(db, app.requireUser(req), req.params.id, req.body),
  );

  // A whole column's manual-order renumbering (issue #240 follow-up), in one transaction
  // rather than one PATCH per card: see reorderOpportunities for why that matters at scale.
  api.post(
    '/opportunities/reorder',
    { schema: { body: ReorderBody, response: { 204: z.null() } } },
    async (req, reply) => {
      await reorderOpportunities(db, app.requireUser(req), req.body.changes);
      return reply.code(204).send(null);
    },
  );

  api.delete(
    '/opportunities/:id',
    { schema: { params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await deleteOpportunity(db, app.requireUser(req), req.params.id);
      return reply.code(204).send(null);
    },
  );

  api.post(
    '/opportunities/:id/stage',
    { schema: { params: IdParams, body: StageBody, response: { 200: OpportunityView } } },
    async (req) => transitionOpportunity(db, app.requireUser(req), req.params.id, req.body),
  );

  // "Not a duplicate" (#9): clears a possible-duplicate flag between :id and otherId, in
  // whichever direction it is stored, so the judgement persists past a page reload.
  api.post(
    '/opportunities/:id/dismiss-duplicate',
    {
      schema: {
        params: IdParams,
        body: DismissDuplicateBody,
        response: { 200: OpportunityView },
      },
    },
    async (req) =>
      dismissPossibleDuplicate(db, app.requireUser(req), req.params.id, req.body.otherId),
  );

  // Full-text search across opportunities, activities and communications (FR-O9).
  api.get(
    '/search',
    { schema: { querystring: SearchQuery, response: { 200: pageOf(SearchHit) } } },
    async (req) => {
      const { q, limit, offset } = req.query;
      return search(app.db, app.requireUser(req), q, { limit, offset });
    },
  );
}
