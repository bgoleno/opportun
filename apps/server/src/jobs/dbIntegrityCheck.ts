// Live database integrity check (issue #170), SQLite only. The owner's live instance
// corrupted silently -- the server kept answering healthz 200, because SQLite only reads the
// pages a query actually touches, and corruption surfaced only when a restart crash-looped on
// "database disk image is malformed". Checking only at startup would have the same blind spot
// between checks; this runs daily, scheduled 30 minutes before the nightly backup
// (DB_INTEGRITY_CHECK_CRON vs. BACKUP_CRON in backup.ts) so a bad result puts a date on when
// corruption started, which the incident otherwise left no way to answer.
//
// Runs PRAGMA integrity_check through the app's own connection rather than opening a second
// one to the same file. #165 confirms a second connection is legitimate under WAL (the
// documented resetPassword CLI pattern already does this safely, alongside the running
// server) -- but #165 also found the live corruption on a Docker Desktop bind mount, which is
// exactly the filesystem substrate WAL's cross-process locking has a documented history of
// not reliably supporting, and the owner has not chosen whether to move off it (#165's
// options are still open). Adding a second connection now, specifically to probe the thing
// just found unreliable, is the wrong moment to lean on it further. Going through the
// existing connection costs a brief stall instead: integrity_check holds the database for its
// full scan, serialized behind the same write gate every other query already waits on
// (db/gate.ts). Expected duration scales with database size; on the owner's instance (tens of
// thousands of rows, well under a GB) this is sub-second to a few seconds, not the minutes a
// much larger database might take -- noted here so a future slow run reads as "database grew"
// rather than "the job hung".
//
// Postgres (issue #241) gets a different, much cheaper check instead of a page scan: the #198
// drill found that touching a corrupted page on Postgres crashes the backend outright (the
// postmaster kills every connection and reinitializes), including when the backup job's own
// pg_dump touches it -- so the backup failing with a dropped connection is itself the
// corruption signal, if only something recorded it. pg_postmaster_start_time() is pure
// metadata (never reads a table page, so it does not reopen the settled "no scheduled scan"
// decision above) and changes whenever that crash-and-reinitialize cycle runs, verified
// directly against five deliberate restarts during the investigation. A changed value since
// the last check is reported as a failure here, the same shape a bad PRAGMA integrity_check
// result already is, so /healthz, the Backups page and restore's refresh-on-success (#205) all
// pick it up with no further change. It cannot tell a corruption-caused crash apart from an
// entirely ordinary restart (an upgrade, a host reboot): the detail message says so plainly and
// points at Settings -> Jobs, where a backup failure with the matching "server closed the
// connection unexpectedly" text is the other half of actually telling those apart.
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { pgClientEnv, rawAll, rawGet, type Db } from '../db/client';
import { BACKUP_DIR } from './backup';
import { requireService, type JobHandler } from './registry';
import type { Storage } from '../lib/storage';

export const DB_INTEGRITY_CHECK_KIND = 'db.integrity_check';
/** SQLite only (app.ts): 30 minutes ahead of BACKUP_CRON (backup.ts), so a bad result is known
 *  before that night's backup runs, not discovered after. A full PRAGMA integrity_check scan
 *  is not something to run more often than that: it holds the database for the scan, serialized
 *  behind the write gate every other query already waits on (see this file's own top comment). */
export const DB_INTEGRITY_CHECK_CRON = '30 2 * * *';
/** Postgres only (app.ts; issue #241): checkPostgresRestart below is a different kind of check
 *  from the SQLite scan above, and a once-a-day cadence is the wrong choice for it, carried
 *  over from the SQLite constant by mistake when #262 made this branch do real work instead of
 *  a static no-op. The SQLite check asks "is the database damaged right now", a question that
 *  stays answerable whenever you ask it. This one asks "did the backend restart since I last
 *  checked", a question about a window: a restart at 02:35 would sit unnoticed for nearly 24
 *  hours at the SQLite cadence. The check itself is a single metadata query (no page read, no
 *  write-gate contention, effectively free), so there is no cost argument for spacing it out
 *  the way the scan above needs; every 15 minutes bounds the detection lag to a quarter hour
 *  instead of most of a day, at that same negligible cost.
 *
 *  Below runner.ts's MIN_USER_CRON_INTERVAL_MS (at most one run an hour) on purpose, not by
 *  oversight: that floor guards a cron a user can actually type into Settings (discovery
 *  sources, atsDetect.ts's CronSchema), and nothing in this codebase exposes schedule:<name>
 *  for this kind through any such route today (seedSchedule only ever seeds it at boot,
 *  checked directly: the only two setSchedule call sites are runner.ts itself and
 *  repos/discovery.ts's per-source schedules). If that ever changes, an editable schedule for
 *  this kind should keep this value reachable as a floor of its own, system-seeded and
 *  explicitly exempt, rather than silently inheriting the hour-long one meant for a person
 *  typing a cron by hand. */
export const DB_INTEGRITY_CHECK_CRON_POSTGRES = '*/15 * * * *';
/** Alongside the backup snapshots' own sidecars (backup.ts), not a new top-level concern: the
 *  live check is the other half of "can this instance's data be trusted". Exported for
 *  restore.ts (issue #205): a successful restore replaces the live database, so a failed
 *  result recorded here before the restore is no longer a true statement about it, and
 *  nothing else would re-read it until the next scheduled run, up to a day later. */
export const LIVE_CHECK_FILE = `${BACKUP_DIR}/.live-check.json`;
/** The Postgres postmaster's own start time at the last check, so the next one can tell
 *  whether it restarted since (issue #241). Kept apart from LIVE_CHECK_FILE itself: that file's
 *  shape is the result an admin reads, not the raw value this job diffs against. */
const POSTMASTER_START_FILE = `${BACKUP_DIR}/.postmaster-start.json`;
const DETAIL_LIMIT = 2000;

export interface LiveCheckResult {
  ok: boolean;
  checkedAt: number;
  detail: string | null;
}

interface PostmasterStart {
  startedAtMs: number;
}

/** The live database's most recent scheduled integrity check, or null if none has ever run
 *  (a fresh install, or the first check since boot). */
export async function readLiveCheck(storage: Storage): Promise<LiveCheckResult | null> {
  try {
    return JSON.parse(await storage.readText(LIVE_CHECK_FILE)) as LiveCheckResult;
  } catch {
    return null;
  }
}

async function readPostmasterStart(storage: Storage): Promise<PostmasterStart | null> {
  try {
    return JSON.parse(await storage.readText(POSTMASTER_START_FILE)) as PostmasterStart;
  } catch {
    return null;
  }
}

/** Epoch milliseconds, read as bigint so node-postgres's installed type parser (db/client.ts)
 *  hands it back as a JS number directly, the same as every other timestamp in this app. */
async function currentPostmasterStart(db: Db): Promise<number> {
  const row = await rawGet<{ startedAtMs: number }>(
    db,
    sql`select (extract(epoch from pg_postmaster_start_time()) * 1000)::bigint as "startedAtMs"`,
  );
  if (row === undefined) throw new Error('pg_postmaster_start_time() returned no row');
  return row.startedAtMs;
}

// Issue #205/#241: not reading pages on Postgres is a deliberate decision, not an oversight
// left unimplemented. #165 is specific to a single-file SQLite database on a bind mount, so a
// direct port of "scan everything, daily" has no equivalent target here -- and the #198 drill
// found that the direct equivalent (reading every page) is exactly what crashes a Postgres
// backend on a corrupted one, so doing that on a schedule would mean causing this same crash
// on a schedule instead of on demand: worse, not better. See docs/install.md's engine
// comparison for the full trade this reflects. The check below asks a narrower, page-free
// question instead -- "did the backend restart since the last check" -- cheap precisely
// because it never reads a page.
async function checkPostgresRestart(
  db: Db,
  storage: Storage,
  now: number,
): Promise<LiveCheckResult> {
  const startedAtMs = await currentPostmasterStart(db);
  const previous = await readPostmasterStart(storage);
  await storage.ensureDir(BACKUP_DIR);
  await storage.writeText(
    POSTMASTER_START_FILE,
    JSON.stringify({ startedAtMs } satisfies PostmasterStart),
  );
  if (previous === null || previous.startedAtMs === startedAtMs) {
    return { ok: true, checkedAt: now, detail: null };
  }
  return {
    ok: false,
    checkedAt: now,
    detail:
      `the Postgres backend restarted at ${new Date(startedAtMs).toISOString()}, since this ` +
      `check last ran at ${new Date(previous.startedAtMs).toISOString()}. This can be an ` +
      'ordinary restart (an upgrade, a host reboot) or a crash, including the corrupted-page ' +
      'crash described in docs/install.md; check Settings -> Jobs for a backup attempt that ' +
      'failed with "server closed the connection unexpectedly" around the same time to tell ' +
      'those apart.',
  };
}

async function checkSqliteIntegrity(db: Db, now: number): Promise<LiveCheckResult> {
  try {
    const rows = await rawAll<{ integrity_check: string }>(db, sql`PRAGMA integrity_check`);
    const ok = rows.length === 1 && rows[0]?.integrity_check === 'ok';
    return ok
      ? { ok: true, checkedAt: now, detail: null }
      : {
          ok: false,
          checkedAt: now,
          detail: rows
            .map((r) => r.integrity_check)
            .join('; ')
            .slice(0, DETAIL_LIMIT),
        };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, checkedAt: now, detail: message.slice(0, DETAIL_LIMIT) };
  }
}

export async function runDbIntegrityCheck(
  db: Db,
  storage: Storage,
  now: number = Date.now(),
): Promise<LiveCheckResult> {
  const result =
    pgClientEnv(db) !== undefined
      ? await checkPostgresRestart(db, storage, now)
      : await checkSqliteIntegrity(db, now);
  await storage.ensureDir(BACKUP_DIR);
  await storage.writeText(LIVE_CHECK_FILE, JSON.stringify(result));
  return result;
}

export const dbIntegrityCheckJob: JobHandler<Record<string, never>> = {
  kind: DB_INTEGRITY_CHECK_KIND,
  payloadSchema: z.object({}).strict() as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    const result = await runDbIntegrityCheck(db, requireService(ctx, 'storage'));
    await ctx.setResult(result);
    // Surfaced the same way any other job failure is (routes/jobs.ts): a bad live database is
    // reported, not acted on here (issue #170's own scope boundary).
    if (!result.ok)
      throw new Error(`live database integrity check failed: ${result.detail ?? 'unknown'}`);
  },
};
