// Live database integrity check (issue #170): a healthy run writes its result where the
// backups surface already reads it, and a failed one surfaces as a job failure, same as any
// other job (routes/jobs.ts).
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { settings } from '../src/db/schema';
import {
  DB_INTEGRITY_CHECK_CRON,
  DB_INTEGRITY_CHECK_CRON_POSTGRES,
  DB_INTEGRITY_CHECK_KIND,
  readLiveCheck,
  runDbIntegrityCheck,
} from '../src/jobs/dbIntegrityCheck';
import { enqueue } from '../src/jobs/runner';
import { useApi } from './api';
import { sqliteOnly, testDialect } from './db';

const boot = useApi();

/** The gate this guards against (issue #241): a dialect conditional that decides WHETHER a
 *  job is scheduled at all, unlike the legitimate ones elsewhere that only pick HOW to do
 *  something. app.ts's seedSchedule call for this job was SQLite-only while the Postgres
 *  branch of the check was a static no-op, correctly unscheduled; #262 gave that branch real
 *  work and the gate was never revisited, so the job silently never ran on Postgres at all.
 *  Nothing else would have caught that: readLiveCheck only reads what this job writes. */
async function scheduledCron(db: Db): Promise<string | undefined> {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, `schedule:${DB_INTEGRITY_CHECK_KIND}`))
    .get();
  return (row?.value as { cron?: string } | undefined)?.cron;
}

it('seeds the live-check schedule on boot, on both dialects, each with its own cadence (issue #241)', async () => {
  const { app } = await boot();
  const cron = await scheduledCron(app.db);
  expect(cron).toBe(
    testDialect === 'postgres' ? DB_INTEGRITY_CHECK_CRON_POSTGRES : DB_INTEGRITY_CHECK_CRON,
  );
});

describe.runIf(sqliteOnly)('db.integrity_check job', () => {
  it('checks the live database clean, and the result is readable where the backups surface looks', async () => {
    const { app } = await boot();
    const now = Date.UTC(2026, 9, 21, 2, 30);
    const result = await runDbIntegrityCheck(app.db, app.storage, now);
    expect(result).toEqual({ ok: true, checkedAt: now, detail: null });
    expect(await readLiveCheck(app.storage)).toEqual(result);
  });

  it('readLiveCheck is null before the first scheduled run', async () => {
    const { app } = await boot();
    expect(await readLiveCheck(app.storage)).toBeNull();
  });

  it('runs end to end as a job and records a clean result', async () => {
    const { app } = await boot();
    await enqueue(app.db, DB_INTEGRITY_CHECK_KIND, {});
    await app.jobs.drain();
    const live = await readLiveCheck(app.storage);
    expect(live?.ok).toBe(true);
  });
});

// Issue #241: Postgres gets no page scan (settled, see dbIntegrityCheck.ts's own comment), but
// a free, page-content-free signal instead -- whether the backend has restarted since the last
// check, which is what the #198 drill's corruption-triggered crash looks like from here.
describe.runIf(testDialect === 'postgres')(
  'db.integrity_check job on Postgres (issue #241)',
  () => {
    it('reports ok on the first check ever: nothing to diff against yet', async () => {
      const { app } = await boot();
      const now = Date.UTC(2026, 9, 21, 2, 30);
      const result = await runDbIntegrityCheck(app.db, app.storage, now);
      expect(result).toEqual({ ok: true, checkedAt: now, detail: null });
      expect(await readLiveCheck(app.storage)).toEqual(result);
    });

    it('reports ok when the backend has not restarted between two checks', async () => {
      const { app } = await boot();
      const first = await runDbIntegrityCheck(app.db, app.storage, Date.UTC(2026, 9, 21, 2, 30));
      expect(first.ok).toBe(true);
      const second = await runDbIntegrityCheck(app.db, app.storage, Date.UTC(2026, 9, 21, 2, 31));
      expect(second).toEqual({ ok: true, checkedAt: Date.UTC(2026, 9, 21, 2, 31), detail: null });
    });

    it('reports a failure, naming both timestamps, when the postmaster start time changes between checks', async () => {
      const { app } = await boot();
      await runDbIntegrityCheck(app.db, app.storage, Date.UTC(2026, 9, 21, 2, 30));
      // No real crash needed to prove the diff logic: the sidecar this job reads from is just a
      // file (storage.writeText), so writing an earlier recorded start time directly reproduces
      // "the backend's actual start time has moved on since the last check" exactly as a real
      // restart would leave it.
      await app.storage.writeText(
        'backups/.postmaster-start.json',
        JSON.stringify({ startedAtMs: Date.UTC(2020, 0, 1) }),
      );
      const result = await runDbIntegrityCheck(app.db, app.storage, Date.UTC(2026, 9, 21, 2, 31));
      expect(result.ok).toBe(false);
      expect(result.checkedAt).toBe(Date.UTC(2026, 9, 21, 2, 31));
      expect(result.detail).toContain(new Date(Date.UTC(2020, 0, 1)).toISOString());
      expect(result.detail).toMatch(/restarted/);
      expect(result.detail).toMatch(/Settings -> Jobs/);
      expect(await readLiveCheck(app.storage)).toEqual(result);
    });

    it('runs end to end as a job and records a clean result', async () => {
      const { app } = await boot();
      await enqueue(app.db, DB_INTEGRITY_CHECK_KIND, {});
      await app.jobs.drain();
      const live = await readLiveCheck(app.storage);
      expect(live?.ok).toBe(true);
    });
  },
);
