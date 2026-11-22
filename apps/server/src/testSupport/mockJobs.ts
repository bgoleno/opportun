// A run-now for the scheduled jobs an end-to-end spec would otherwise wait a day for
// (https://github.com/bgoleno/opportun/issues/747). The AI duplicate check is a daily sweep at
// 07:15 with no run-now in the product, so apps/web/e2e had no way to reach it. This queues one
// run of an allowed kind, due now, for the server's own runner to claim: the same handler, the
// same claim and the same result as the scheduled run, with only the clock skipped. Registered
// with the AI mock (index.ts), so like every mock it is never on in production, and it answers
// loopback callers only, as the AI mock does.
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { jobs } from '../db/schema';
import { OPPORTUNITY_DEDUPE_AI_KIND } from '../jobs/opportunityDedupeAi';
import { enqueue } from '../jobs/runner';

export const MOCK_JOBS_PATH = '/__mock/jobs';

/** The kinds a spec may run now: scheduled sweeps whose next run is too far off to wait for. */
export const MOCK_RUNNABLE_KINDS: readonly string[] = [OPPORTUNITY_DEDUPE_AI_KIND];

/**
 * A second guard only (sec on #754): behind a proxy on the same host every caller looks local.
 * The guard that matters is that the AI mock, and this hook with it, is never on in production
 * (testSupportFromEnv refuses every mock under NODE_ENV=production).
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const KindParams = z.object({ kind: z.string().max(100) });
const IdParams = z.object({ id: z.string().max(100) });

export async function mockJobRoutes(app: FastifyInstance): Promise<void> {
  const loopbackOnly = (remote: string | undefined): boolean => LOOPBACK.has(remote ?? '');

  /** Queues one run of `kind`, due now; answers its job id. */
  app.post(`${MOCK_JOBS_PATH}/:kind/run`, async (req, reply) => {
    if (!loopbackOnly(req.socket.remoteAddress)) {
      return reply.code(403).send({ error: { code: 'loopback_only' } });
    }
    const { kind } = KindParams.parse(req.params);
    if (!MOCK_RUNNABLE_KINDS.includes(kind)) {
      return reply.code(404).send({ error: { code: 'not_runnable' } });
    }
    const jobId = await enqueue(app.db, kind, {});
    return reply.send({ jobId });
  });

  /** A queued run's status and result, for the spec to wait on. */
  app.get(`${MOCK_JOBS_PATH}/:id`, async (req, reply) => {
    if (!loopbackOnly(req.socket.remoteAddress)) {
      return reply.code(403).send({ error: { code: 'loopback_only' } });
    }
    const { id } = IdParams.parse(req.params);
    const row = await app.db
      .select({ kind: jobs.kind, status: jobs.status, result: jobs.result })
      .from(jobs)
      .where(eq(jobs.id, id))
      .get();
    if (row === undefined || !MOCK_RUNNABLE_KINDS.includes(row.kind)) {
      return reply.code(404).send({ error: { code: 'not_found' } });
    }
    return reply.send({ status: row.status, result: row.result ?? null });
  });
}
