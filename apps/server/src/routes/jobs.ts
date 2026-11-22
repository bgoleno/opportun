// Job status API (design section 8). The admin sees every job and may revive dead ones; a
// user sees only jobs run on their behalf (imports). Payloads and results are never listed:
// an import payload carries the user's data.
import { and, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/client';
import { JOB_STATUSES, jobs } from '../db/schema';
import { audit } from '../lib/audit';
import { SHARED_DEMO_IDS } from '../lib/demoAccounts';
import { isSharedDemoAdmin, withinSharedDemo } from '../lib/demoSharedAdmin';
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

function toJobView(
  j: Pick<
    JobRow,
    | 'id'
    | 'kind'
    | 'status'
    | 'attempts'
    | 'maxAttempts'
    | 'runAt'
    | 'lastError'
    | 'userId'
    | 'createdAt'
    | 'updatedAt'
  >,
): z.infer<typeof JobView> {
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

/**
 * The jobs list, newest change first (#592). Settings > Jobs polls it every 5 s for 200 rows: only
 * the columns the screen shows (never a payload or a result, which can be large), in the order of
 * jobs_updated_at_idx, so its cost does not grow with the done jobs kept in retention.
 */
export function jobsListQuery(db: Db, where: SQL | undefined, limit: number) {
  return db
    .select({
      id: jobs.id,
      kind: jobs.kind,
      status: jobs.status,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      runAt: jobs.runAt,
      lastError: jobs.lastError,
      userId: jobs.userId,
      createdAt: jobs.createdAt,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .where(where)
    .orderBy(desc(jobs.updatedAt), desc(jobs.id))
    .limit(limit);
}

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
      const owner = !ctx.isAdmin
        ? eq(jobs.userId, ctx.userId)
        : isSharedDemoAdmin(app.config, ctx)
          ? or(isNull(jobs.userId), inArray(jobs.userId, [...SHARED_DEMO_IDS]))
          : undefined;
      const where = and(
        owner,
        req.query.status === undefined ? undefined : eq(jobs.status, req.query.status),
      ) as SQL | undefined;
      const rows = await jobsListQuery(db, where, req.query.limit).all();
      return { items: rows.map(toJobView) };
    },
  );

  api.post(
    '/jobs/:id/retry',
    { schema: { params: IdParams, response: { 200: JobView } } },
    async (req) => {
      const ctx = requireUser(req);
      if (!ctx.isAdmin) throw forbidden();
      if (isSharedDemoAdmin(app.config, ctx)) {
        const job = await db
          .select({ userId: jobs.userId })
          .from(jobs)
          .where(eq(jobs.id, req.params.id))
          .get();
        // Not a pinned account's or the instance's: refused, the same whether it exists or not.
        if (job === undefined || !withinSharedDemo(job.userId)) throw forbidden();
      }
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
