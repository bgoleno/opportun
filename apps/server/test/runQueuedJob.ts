// Runs one job a test queued, and only that one (https://github.com/bgoleno/opportun/issues/615).
//
// `runNextJob` claims the oldest due job, whatever queued it. On the real clock, anything else that
// is due wins: the harness seeds about twenty schedules at boot (app.ts), each run materializes their
// next occurrences, and one comes due whenever the wall clock crosses its cron (#607's Postgres leg
// failed so at 02:07 UTC). A test that queues a job and calls runNextJob once then ran something else
// and found nothing.
//
// Every other pending job is held aside for the one claim (run_at moved to the far future) and put
// back exactly as it was. The harness starts no polling runner (helpers.ts), so nothing else claims
// in between. Throws if the job was not the one that ran: not due yet, already taken, or unknown.
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { jobs } from '../src/db/schema';
import { readSchedules, runNextJob, SCHEDULE_PREFIX, type RunOptions } from '../src/jobs/runner';

/** A run_at no job comes due at: far enough ahead of any clock a test pins. */
const HELD = Date.UTC(9999, 0, 1);

export async function runQueuedJob(
  app: FastifyInstance,
  id: string,
  opts: RunOptions = { services: app.jobs.services },
): Promise<void> {
  const before = await app.db
    .select({ attempts: jobs.attempts, status: jobs.status })
    .from(jobs)
    .where(eq(jobs.id, id))
    .get();
  if (before === undefined) throw new Error(`runQueuedJob: no job ${id}`);
  if (before.status !== 'pending') throw new Error(`runQueuedJob: job ${id} is ${before.status}`);
  const others = await app.db
    .select({ id: jobs.id, runAt: jobs.runAt })
    .from(jobs)
    .where(and(eq(jobs.status, 'pending'), ne(jobs.id, id)))
    .all();
  if (others.length > 0) {
    await app.db
      .update(jobs)
      .set({ runAt: HELD })
      .where(
        inArray(
          jobs.id,
          others.map((o) => o.id),
        ),
      )
      .run();
  }
  try {
    await runNextJob(app.db, opts);
  } finally {
    // Back as they were, one run_at at a time; a held job is still pending (nothing else claims).
    const byRunAt = new Map<number, string[]>();
    for (const o of others) byRunAt.set(o.runAt, [...(byRunAt.get(o.runAt) ?? []), o.id]);
    for (const [runAt, ids] of byRunAt) {
      await app.db
        .update(jobs)
        .set({ runAt })
        .where(and(inArray(jobs.id, ids), eq(jobs.runAt, HELD)))
        .run();
    }
  }
  const after = await app.db
    .select({ attempts: jobs.attempts })
    .from(jobs)
    .where(eq(jobs.id, id))
    .get();
  if (after === undefined || after.attempts <= before.attempts) {
    throw new Error(`runQueuedJob: job ${id} did not run (not due yet?)`);
  }
}

/**
 * For a test that claims with runNextJob itself, two at once or with a run still in flight, where
 * runQueuedJob's hold and restore would cross: parks the pending occurrences of the instance
 * schedules app.ts seeds at boot (schedule rows with no user), so none can come due on the real
 * clock and be claimed in place of the test's own job (#615). A schedule the test queues itself (a
 * source's, with its user) is left alone. Not restored: the test's app is its own.
 */
export async function holdInstanceSchedules(app: FastifyInstance): Promise<void> {
  const keys = (await readSchedules(app.db))
    .filter((s) => s.userId === null)
    .map((s) => `${SCHEDULE_PREFIX}${s.kind}`);
  if (keys.length === 0) return;
  await app.db
    .update(jobs)
    .set({ runAt: HELD })
    .where(and(eq(jobs.status, 'pending'), inArray(jobs.dedupeKey, keys)))
    .run();
}
