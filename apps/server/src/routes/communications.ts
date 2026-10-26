// Communications API (FR-M2, M4, M8): inbox views, the user's reclassification (which feeds
// prompt refinement), proposed stage changes, which apply only when the user accepts them, and
// the purge of what is already stored. Every route is scoped to the signed-in user.
//
// There is no route that serves a message body. There is no body to serve: Plan 3 Task 1 stopped
// keeping them, and what a client gets is the snippet plus the identifiers its deep link needs.
import {
  BODY_SOURCES,
  COMM_CHANNELS,
  COMM_CLASSIFICATIONS,
  OPPORTUNITY_STAGES,
  OUTREACH_KINDS,
} from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { JOB_STATUSES, REJECTION_REASONS } from '../db/schema.shared';
import { rejectCommunication } from '../repos/reject';
import { requireUser } from '../repos/base';
import {
  acceptProposal,
  bulkTriage,
  dismissProposal,
  getCommunicationView,
  INBOX_VIEWS,
  listCommunications,
  reclassify,
} from '../repos/communications';
import { IdParams, MAX_LIMIT, pageOf } from './common';
import { BACKUP_RETENTION } from '../jobs/backup';
import {
  drainBlockingClassifyJobs,
  previewPurge,
  purgeDiscoveryContent,
  purgeMailBodies,
} from '../jobs/purge';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';

/** What the user types to mean it. */
export const PURGE_CONFIRMATION = 'PURGE';

export const CommunicationViewSchema = z.object({
  id: z.string(),
  channel: z.enum(COMM_CHANNELS),
  threadKey: z.string().nullable(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string().nullable(),
  snippet: z.string().nullable(),
  sentAt: z.number().int(),
  classification: z.enum(COMM_CLASSIFICATIONS).nullable(),
  outreachKind: z.enum(OUTREACH_KINDS).nullable(),
  mismatchReason: z.string().nullable(),
  confidence: z.number().nullable(),
  // Issue #149: what the classifier actually read; null for a message never classified, or
  // classified before this column existed. Also stripped by the serializer if left out here.
  bodySource: z.enum(BODY_SOURCES).nullable(),
  opportunityId: z.string().nullable(),
  opportunityTitle: z.string().nullable(),
  companyName: z.string().nullable(),
  opportunityStage: z.enum(OPPORTUNITY_STAGES).nullable(),
  needsReview: z.boolean(),
  proposedTransition: z.enum(OPPORTUNITY_STAGES).nullable(),
  createdAt: z.number().int(),
  // The serializer strips anything not declared here, so these have to be present or the
  // blocked view cannot say which rule decided, and mailLink builds a link to /undefined.
  externalId: z.string(),
  triageDecision: z.string().nullable(),
  triageRule: z.string().nullable(),
});

const ListQuery = z.object({
  view: z.enum(INBOX_VIEWS).default('all'),
  opportunityId: z.string().min(1).max(64).optional(),
  // Triage controls (#inbox-sort-filter-bulk): source, sender, keyword, and date order. All
  // optional; absent means the previous behaviour (every source, newest first).
  channel: z.enum(COMM_CHANNELS).optional(),
  sender: z.string().min(1).max(200).optional(),
  q: z.string().min(1).max(200).optional(),
  order: z.enum(['newest', 'oldest']).default('newest'),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Bulk triage (#inbox-sort-filter-bulk): one action applied to a selection. The id list is
 * capped at MAX_LIMIT so a single request cannot be unbounded; ids that are not the caller's
 * are skipped by the per-message scoping, never touched.
 */
const BulkBody = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_LIMIT),
  // Reject only. Bulk reclassify is intentionally not exposed: its link-target 404 cannot be
  // told apart from a not-yours 404 at the bulk layer, so it would miscount. See bulkTriage.
  action: z.object({
    kind: z.literal('reject'),
    reason: z.enum(REJECTION_REASONS),
    note: z.string().max(1000).nullish(),
  }),
});

const ReclassifyBody = z
  .object({
    classification: z.enum(COMM_CLASSIFICATIONS).optional(),
    outreachKind: z.enum(OUTREACH_KINDS).nullable().optional(),
    opportunityId: z.string().min(1).max(64).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

const AcceptBody = z.object({ reopen: z.boolean().optional() }).nullish();

/** The largest body returned inline; longer ones are cut (the stored copy stays whole). */

const RejectBody = z.object({
  reason: z.enum(REJECTION_REASONS),
  note: z.string().max(1000).nullish(),
  /** Opts this one note in to prompt refinement; off by default. */
  shareNote: z.boolean().optional(),
  neverIngest: z.enum(['address', 'domain']).optional(),
});

const RejectResponseSchema = z.object({
  /** Null when neverIngest was not asked for; true only once a deny rule is confirmed active. */
  blocked: z.boolean().nullable(),
  blockFailureReason: z.enum(['unparseable_sender']).optional(),
});

export async function communicationRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get(
    '/communications',
    { schema: { querystring: ListQuery, response: { 200: pageOf(CommunicationViewSchema) } } },
    async (req) => await listCommunications(db, requireUser(req), req.query),
  );

  // Bulk triage (#inbox-sort-filter-bulk): reject a selection in one call.
  api.post(
    '/communications/bulk',
    {
      schema: {
        body: BulkBody,
        response: {
          200: z.object({ succeeded: z.number().int(), skipped: z.number().int() }),
        },
      },
    },
    async (req) => await bulkTriage(db, requireUser(req), req.body),
  );

  api.get(
    '/communications/:id',
    { schema: { params: IdParams, response: { 200: CommunicationViewSchema } } },
    async (req) => await getCommunicationView(db, requireUser(req), req.params.id),
  );

  api.post(
    '/communications/:id/classify',
    {
      schema: {
        params: IdParams,
        body: ReclassifyBody,
        response: { 200: CommunicationViewSchema },
      },
    },
    async (req) => await reclassify(db, requireUser(req), req.params.id, req.body),
  );

  // Reject as out of scope (spec D4). Not the updated view: the point is that there is no
  // longer a message here to show. The body is just the one thing the caller cannot infer
  // from "it succeeded": whether a block the user asked for is actually in force now (#145).
  api.post(
    '/communications/:id/reject',
    { schema: { params: IdParams, body: RejectBody, response: { 200: RejectResponseSchema } } },
    async (req) => await rejectCommunication(db, requireUser(req), req.params.id, req.body),
  );

  api.post(
    '/communications/:id/accept-transition',
    {
      schema: {
        params: IdParams,
        body: AcceptBody,
        response: {
          200: z.object({
            communication: CommunicationViewSchema,
            opportunityId: z.string(),
            stage: z.enum(OPPORTUNITY_STAGES),
          }),
        },
      },
    },
    async (req) => {
      const { communication, opportunity } = await acceptProposal(
        db,
        requireUser(req),
        req.params.id,
        { reopen: req.body?.reopen },
      );
      return { communication, opportunityId: opportunity.id, stage: opportunity.stage };
    },
  );

  api.delete(
    '/communications/:id/proposed-transition',
    { schema: { params: IdParams, response: { 200: CommunicationViewSchema } } },
    async (req) => await dismissProposal(db, requireUser(req), req.params.id),
  );

  // The purge (spec D5). Two routes, both the user's own: a preview that reads, and a run that
  // is irreversible from inside Opportun, which is why it asks for the word typed out and writes
  // what it did to the audit log.
  api.get(
    '/communications/purge-preview',
    {
      schema: {
        response: {
          200: z.object({
            discoveryResults: z.number().int(),
            mailBodies: z.number().int(),
            bodiesInUse: z.number().int(),
            /** Nightly snapshots keep what was purged for this many days (decision D-7). */
            backupRetentionDays: z.number().int(),
          }),
        },
      },
    },
    async (req) => ({
      ...(await previewPurge(db, requireUser(req))),
      backupRetentionDays: BACKUP_RETENTION,
    }),
  );

  api.post(
    '/communications/purge',
    {
      schema: {
        body: z.object({
          what: z.enum(['discovery', 'mail_bodies', 'both']),
          /** The word PURGE, typed by the user. A destructive action asks to be meant. */
          confirm: z.string(),
          /**
           * Issue #66: an unfinished classify job holds a body back from this same purge call
           * indefinitely. Opting in dead-letters those jobs first, so the purge that follows
           * finds nothing left to skip. It is not a verdict on whether those messages should
           * have been classified; it only stops waiting on jobs that may never finish.
           */
          drainBlocked: z.boolean().default(false),
        }),
        response: {
          200: z.object({
            discoveryResults: z.number().int(),
            mailBodies: z.object({
              cleared: z.number().int(),
              deleted: z.number().int(),
              shared: z.number().int(),
              skipped: z.number().int(),
            }),
            jobsDrained: z.number().int(),
            /**
             * Jobs the drain found blocking this purge but could not cancel (a job already
             * running), so a row that is still blocked says so explicitly rather than reading
             * the same as one that was never blocked at all.
             */
            jobsStillBlocked: z.array(z.object({ id: z.string(), status: z.enum(JOB_STATUSES) })),
          }),
        },
      },
    },
    async (req) => {
      const ctx = requireUser(req);
      if (req.body.confirm !== PURGE_CONFIRMATION) {
        throw new HttpError(400, 'not_confirmed', `Type ${PURGE_CONFIRMATION} to confirm`);
      }
      const what = req.body.what;
      const purgesMail = what !== 'discovery';
      const drain =
        purgesMail && req.body.drainBlocked
          ? await drainBlockingClassifyJobs(db, ctx)
          : { cancelled: 0, stillBlocked: [] };
      const discoveryResults = what === 'mail_bodies' ? 0 : await purgeDiscoveryContent(db, ctx);
      const mailBodies = purgesMail
        ? await purgeMailBodies(db, ctx, app.storage)
        : { cleared: 0, deleted: 0, shared: 0, skipped: 0 };
      // Counts only: what was purged is exactly what must not be written down again.
      await audit(db, 'mail.purged', {
        userId: ctx.userId,
        ip: req.ip,
        detail: {
          what,
          discoveryResults,
          jobsDrained: drain.cancelled,
          jobsStillBlocked: drain.stillBlocked.length,
          ...mailBodies,
        },
      });
      return {
        discoveryResults,
        mailBodies,
        jobsDrained: drain.cancelled,
        jobsStillBlocked: drain.stillBlocked,
      };
    },
  );
}
