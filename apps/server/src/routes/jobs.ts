// Job status API (design section 8). The admin sees every job and may revive dead ones; a
// user sees only jobs run on their behalf (imports). Payloads and results are never listed:
// an import payload carries the user's data.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { JOB_STATUSES } from '../db/schema';
import { audit } from '../lib/audit';
import { SHARED_DEMO_IDS } from '../lib/demoAccounts';
import { isSharedDemoAdmin, withinSharedDemo } from '../lib/demoSharedAdmin';
import { forbidden, HttpError, notFound } from '../lib/errors';
import { reviveDeadJob, type JobRow } from '../jobs/runner';
import { requireAdmin, requireUser } from '../repos/base';
import { jobExists, jobOwner, listJobs, type JobListScope } from '../repos/jobs';
import { IdParams } from './common';

export const JobView = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.enum(JOB_STATUSES),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  runAt: z.number().int(),
  lastError: z.string().nullable(),
  userId: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

function toJobView(j: JobRow): z.infer<typeof JobView> {
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    runAt: j.runAt,
    lastError: j.lastError,
    userId: j.userId,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

const ListQuery = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get(
    '/jobs',
    {
      schema: { querystring: ListQuery, response: { 200: z.object({ items: z.array(JobView) }) } },
    },
    async (req) => {
      const ctx = requireUser(req);
      // An admin sees every job; the shared demo admin the pinned accounts' and the instance's
      // own, never a dedicated account's (#563); anyone else their own.
      const scope: JobListScope = !ctx.isAdmin
        ? { kind: 'user', userId: ctx.userId }
        : isSharedDemoAdmin(app.config, ctx)
          ? { kind: 'users_and_instance', userIds: SHARED_DEMO_IDS }
          : { kind: 'all' };
      const rows = await listJobs(db, scope, {
        status: req.query.status,
        limit: req.query.limit,
      });
      return { items: rows.map(toJobView) };
    },
  );

  api.post(
    '/jobs/:id/retry',
    { schema: { params: IdParams, response: { 200: JobView } } },
    async (req) => {
      const ctx = requireAdmin(req);
      if (isSharedDemoAdmin(app.config, ctx)) {
        const job = await jobOwner(db, req.params.id);
        // Not a pinned account's or the instance's: refused, the same whether it exists or not.
        if (job === undefined || !withinSharedDemo(job.userId)) throw forbidden();
      }
      const revived = await reviveDeadJob(db, req.params.id);
      if (revived === undefined) {
        if (!(await jobExists(db, req.params.id))) throw notFound();
        throw new HttpError(409, 'not_dead');
      }
      await audit(db, 'job.retry', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { jobId: revived.id, kind: revived.kind },
      });
      return toJobView(revived);
    },
  );
}
