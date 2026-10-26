// Job status API (design section 8). The admin sees every job and may revive dead ones; a
// user sees only jobs run on their behalf (imports). Payloads and results are never listed:
// an import payload carries the user's data.
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { JOB_STATUSES, jobs } from '../db/schema';
import { audit } from '../lib/audit';
import { forbidden, HttpError, notFound } from '../lib/errors';
import { reviveDeadJob, type JobRow } from '../jobs/runner';
import { requireUser } from '../repos/base';
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
      const where = and(
        ctx.isAdmin ? undefined : eq(jobs.userId, ctx.userId),
        req.query.status === undefined ? undefined : eq(jobs.status, req.query.status),
      ) as SQL | undefined;
      const rows = await db
        .select()
        .from(jobs)
        .where(where)
        .orderBy(desc(jobs.updatedAt), desc(jobs.id))
        .limit(req.query.limit)
        .all();
      return { items: rows.map(toJobView) };
    },
  );

  api.post(
    '/jobs/:id/retry',
    { schema: { params: IdParams, response: { 200: JobView } } },
    async (req) => {
      const ctx = requireUser(req);
      if (!ctx.isAdmin) throw forbidden();
      const revived = await reviveDeadJob(db, req.params.id);
      if (revived === undefined) {
        const exists = await db
          .select({ id: jobs.id })
          .from(jobs)
          .where(eq(jobs.id, req.params.id))
          .get();
        if (exists === undefined) throw notFound();
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
