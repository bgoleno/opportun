// Backup status (FR-I4): the snapshots on disk, the nightly schedule, and an on-demand
// backup. Snapshots hold every user's data, so this is admin only.
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { jobs } from '../db/schema';
import { BACKUP_JOB_KIND, listBackups, MANUAL_BACKUP_DEDUPE_KEY } from '../jobs/backup';
import { readLiveCheck } from '../jobs/dbIntegrityCheck';
import { enqueue, readSchedules, SCHEDULE_PREFIX } from '../jobs/runner';
import { audit } from '../lib/audit';
import { forbidden } from '../lib/errors';
import { requireUser } from '../repos/base';

/** issue #170: "exists and completed" is not "restorable". null: never checked (a snapshot
 *  from before this shipped, or the most recent boot's first night). */
const VerifyResult = z
  .object({ ok: z.boolean(), checkedAt: z.number().int(), detail: z.string().nullable() })
  .nullable();

const BackupList = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      bytes: z.number().int(),
      createdAt: z.number().int(),
      verified: VerifyResult,
    }),
  ),
  schedule: z.object({ cron: z.string(), enabled: z.boolean() }).nullable(),
  nextRunAt: z.number().int().nullable(),
  /** The live database's own most recent scheduled check (issue #170); null on Postgres,
   *  where this does not apply, or before the first scheduled run. */
  liveCheck: VerifyResult,
  /** The database directory's filesystem, checked once at boot (issue #197); null on
   *  Postgres, or when it is not one WAL's locking is known to be unsafe on. A log line at
   *  boot is read once if ever, so this is here too, next to the other things an admin would
   *  check about whether their data can be trusted. */
  filesystemHazard: z.object({ fsType: z.string(), message: z.string() }).nullable(),
  /** The most recent backup attempt (scheduled or manual), when it exhausted its retries
   *  instead of succeeding (issue #241): before this, a human checking here for "is my data
   *  protected" saw nothing at all, even after every attempt had been failing for days --
   *  the only record lived at Settings -> Jobs, a page with no reason to think to check.
   *  Null when the most recent attempt is not dead, or none has run yet. */
  lastBackupFailure: z
    .object({
      failedAt: z.number().int(),
      attempts: z.number().int(),
      detail: z.string().nullable(),
    })
    .nullable(),
});

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get('/backups', { schema: { response: { 200: BackupList } } }, async (req) => {
    if (!requireUser(req).isAdmin) throw forbidden();
    const schedule =
      (await readSchedules(db)).find((s) => s.kind === BACKUP_JOB_KIND)?.schedule ?? null;
    const next = await db
      .select({ runAt: jobs.runAt })
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, BACKUP_JOB_KIND),
          eq(jobs.dedupeKey, `${SCHEDULE_PREFIX}${BACKUP_JOB_KIND}`),
          eq(jobs.status, 'pending'),
        ),
      )
      .orderBy(asc(jobs.runAt))
      .get();
    const lastJob = await db
      .select({
        status: jobs.status,
        updatedAt: jobs.updatedAt,
        attempts: jobs.attempts,
        lastError: jobs.lastError,
      })
      .from(jobs)
      .where(eq(jobs.kind, BACKUP_JOB_KIND))
      .orderBy(desc(jobs.updatedAt), desc(jobs.id))
      .get();
    return {
      items: await listBackups(app.storage),
      schedule,
      nextRunAt: next?.runAt ?? null,
      liveCheck: await readLiveCheck(app.storage),
      filesystemHazard: app.sqliteFsHazard,
      lastBackupFailure:
        lastJob?.status === 'dead'
          ? { failedAt: lastJob.updatedAt, attempts: lastJob.attempts, detail: lastJob.lastError }
          : null,
    };
  });

  api.post(
    '/backups',
    { schema: { response: { 202: z.object({ jobId: z.string() }) } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      if (!ctx.isAdmin) throw forbidden();
      const jobId = await enqueue(db, BACKUP_JOB_KIND, {}, { dedupeKey: MANUAL_BACKUP_DEDUPE_KEY });
      await audit(db, 'backup.requested', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { jobId },
      });
      return reply.code(202).send({ jobId });
    },
  );
}
