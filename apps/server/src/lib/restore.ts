// Restore (issue #142): the inverse of jobs/backup.ts, and the one-command half of FR-I4 that
// was missing. docs/install.md section 6 documents this today as a manual filesystem procedure
// (stop the server, move the live database aside, copy the snapshot into place, start, let
// migrations catch up); every step is a chance to destroy the thing being recovered. This
// module does the same steps, in the same order, with four guarantees that step is not
// expected to supply on its own:
//
//   1. Refuses to run while the server (or anything else) is using the target database,
//      rather than trusting the operator to have stopped it first.
//   2. Verifies the chosen snapshot before trusting it. A file that looks right (plausible
//      name, plausible size) is not the same claim as a file that opens cleanly and passes an
//      integrity check (issue #165: the owner's own pre-upgrade backup was both, and corrupt).
//      Issue #170 landed the same check (verifySnapshot, jobs/backup.ts) run right after every
//      snapshot is written; this calls that function again, fresh, immediately before trusting
//      it, rather than trusting a cached result or inventing a second check that could someday
//      disagree with it. Fresh matters here specifically: a snapshot that passed its check at
//      backup time is not the same claim as one that still passes it now, and an older snapshot
//      written before #170 shipped has no cached result to fall back on at all.
//   3. Preserves whatever it is about to overwrite, in an obvious place, before overwriting it.
//   4. Reports exactly what was restored and from when, in those words, not left to be
//      inferred from a filename or a row count.
//
// Deliberately out of scope: attachments/ and master.key. Both live outside the database, are
// untouched by a database restore, and were untouched by the incident this was built from;
// deciding what (if anything) ties their recovery to a database restore is a separate question.
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import pg from 'pg';
import type { PostgresConfig } from '../config';
import { libpqEnvFor, pgPoolConfig, type LibpqEnv } from '../db/client';
import { isSnapshotName, verifySnapshot, type VerifyResult } from '../jobs/backup';
import { LIVE_CHECK_FILE } from '../jobs/dbIntegrityCheck';
import { DATABASE_FILE_NAMES, type Storage } from './storage';

/** Refused before anything was touched: nothing was written. */
export class RestoreRefused extends Error {
  override name = 'RestoreRefused';
}

/** Failed partway. `stage` says how far it got, so the operator knows what state things are in. */
export class RestoreFailed extends Error {
  override name = 'RestoreFailed';
  constructor(
    message: string,
    readonly stage: 'preserving' | 'restoring',
  ) {
    super(message);
  }
}

export interface RestoreReport {
  dialect: 'sqlite' | 'postgres';
  /** The snapshot file name that was restored. */
  snapshot: string;
  /** When that snapshot finished writing (its own mtime: jobs/backup.ts never leaves a
   *  partial file at this name, so this is the moment the backup completed, not started). */
  snapshotCompletedAt: number;
  /** Where whatever was about to be overwritten was moved, or null when there was nothing. */
  preserved: string | null;
  /** SQLite: the live file path restored into. Postgres: the fresh database's name. */
  restoredTo: string;
  /** The snapshot's own verification result (requirement 2): always ok here, since a failing
   *  one throws RestoreRefused before this report exists. Carried through so the report can
   *  say so explicitly (issue #205) rather than leave it to be inferred from the absence of
   *  an error. */
  verified: VerifyResult;
}

const BUSY_TIMEOUT_MS = 200;

/**
 * True if another connection currently holds dbFile open (issue #142 requirement 1). Opens a
 * throwaway connection and tries to take SQLite's own EXCLUSIVE lock, which requires every
 * other connection, reader or writer, WAL or not, to have released the file first: if the
 * server (or anything else) still has it open, this fails with SQLITE_BUSY inside
 * busy_timeout; if nothing does, it succeeds and is immediately released. Verified empirically
 * against both a live holder and one killed with SIGKILL (locks are OS-level, released on
 * process exit regardless of how the process ended, so a crashed server is not mistaken for a
 * running one).
 */
function sqliteInUse(dbFile: string): boolean {
  let probe: Database.Database;
  try {
    probe = new Database(dbFile);
  } catch {
    // Does not exist, or cannot be opened at all: nothing to be "in use".
    return false;
  }
  try {
    probe.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    probe.pragma('journal_mode = WAL');
    probe.exec('PRAGMA locking_mode = EXCLUSIVE');
    probe.exec('BEGIN IMMEDIATE');
    probe.prepare('SELECT count(*) FROM sqlite_master').get();
    probe.exec('COMMIT');
    return false;
  } catch {
    return true;
  } finally {
    probe.close();
  }
}

function isoStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

export interface SqliteRestoreOptions {
  storage: Storage;
  /** A name under backups/, e.g. opportun-20261021-0300.db. */
  snapshot: string;
  now?: () => number;
}

export async function restoreSqlite(opts: SqliteRestoreOptions): Promise<RestoreReport> {
  const { storage } = opts;
  const now = opts.now ?? Date.now;
  if (!isSnapshotName(opts.snapshot) || !opts.snapshot.endsWith('.db')) {
    throw new RestoreRefused(
      `"${opts.snapshot}" is not a name this app's own backup job writes (opportun-<date>-<time>.db); refusing to trust a file from anywhere else.`,
    );
  }
  const snapshotRelPath = `backups/${opts.snapshot}`;
  const backupFiles = await storage.listFiles('backups');
  const entry = backupFiles.find((f) => f.name === opts.snapshot);
  if (entry === undefined) {
    throw new RestoreRefused(`backups/${opts.snapshot} does not exist.`);
  }
  const liveAbsPath = storage.liveDatabasePath('opportun.db');

  // Preserve FIRST, before the in-use check below, and by a true byte copy rather than the
  // move this ends with: merely opening a live SQLite file to check whether anything else
  // holds it can itself trigger SQLite's own WAL recovery -- a write -- if the file was left
  // with un-checkpointed WAL data (issue #165's own shape: a crash, found later). Copying
  // first means what gets preserved is whatever was actually on disk, untouched by anything
  // this command does afterward, not a post-recovery version of it.
  const preserveDir = `pre-restore-${isoStamp(now())}`;
  let preserved: string | null = null;
  try {
    let copiedAny = false;
    for (const name of DATABASE_FILE_NAMES) {
      if (await storage.copyDatabaseFile(name, preserveDir)) copiedAny = true;
    }
    if (copiedAny) preserved = storage.resolveInsideRoot(preserveDir);
  } catch (err) {
    throw new RestoreFailed(
      `could not preserve the existing database before restoring: ${err instanceof Error ? err.message : String(err)}`,
      'preserving',
    );
  }

  if (sqliteInUse(liveAbsPath)) {
    throw new RestoreRefused(
      `${liveAbsPath} is in use by another connection (the server may still be running). Stop it first; nothing was overwritten (a copy was made at ${preserved ?? '(nothing existed to copy)'}, harmlessly).`,
    );
  }

  const verified = await verifySnapshot(storage, opts.snapshot, 'db', now());
  if (!verified.ok) {
    throw new RestoreRefused(
      `${opts.snapshot} failed its integrity check (${verified.detail ?? 'unknown'}); refusing to restore a snapshot known to be bad. Try an older one.`,
    );
  }

  try {
    for (const name of DATABASE_FILE_NAMES) await storage.removeDatabaseFile(name);
    await storage.restoreDatabaseFile(snapshotRelPath);
  } catch (err) {
    throw new RestoreFailed(
      `could not write the restored database: ${err instanceof Error ? err.message : String(err)}${preserved !== null ? ` (the previous database is intact at ${preserved})` : ''}`,
      'restoring',
    );
  }

  // Issue #205: the live file just written is byte-identical to the snapshot `verified`
  // above already confirmed clean, so that result is still true of it -- but whatever the
  // scheduled check (jobs/dbIntegrityCheck.ts) last found about the PREVIOUS live database is
  // not: it was about a database this restore just replaced. Left alone, that stale failure
  // sits in the same file the scheduled check itself writes, read by both /healthz and
  // /api/v1/backups, until the next scheduled run overwrites it (up to a day later),
  // reporting a database that was just fixed as still broken. Refresh it to match reality now
  // rather than wait for the clock. Best-effort: a failure to write this does not undo an
  // otherwise-successful restore, since the restore itself already fully succeeded above.
  try {
    await storage.writeText(
      LIVE_CHECK_FILE,
      JSON.stringify({ ok: true, checkedAt: now(), detail: null }),
    );
  } catch {
    // Nothing to do: the restore already succeeded; the next scheduled check corrects this.
  }

  return {
    dialect: 'sqlite',
    snapshot: opts.snapshot,
    snapshotCompletedAt: Math.round(entry.mtimeMs),
    preserved,
    restoredTo: liveAbsPath,
    verified,
  };
}

// ---------------------------------------------------------------------------
// Postgres

/** How long createdb/pg_restore may run before being killed. */
const PG_RESTORE_TIMEOUT_MS = 30 * 60_000;
const STDERR_LIMIT = 4096;

function run(command: string, args: string[], env: LibpqEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...env, PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), PG_RESTORE_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${command} could not start: ${err.message}`, { cause: err }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const why = signal === null ? `exited with status ${code}` : `was killed (${signal})`;
        reject(new Error(`${command} ${why}: ${stderr.slice(0, STDERR_LIMIT).trim()}`));
      }
    });
  });
}

/** True if any connection other than this check's own is open against cfg's database. */
async function postgresInUse(cfg: PostgresConfig): Promise<boolean> {
  const pool = new pg.Pool({ ...pgPoolConfig(cfg), max: 1, application_name: 'opportun-restore' });
  try {
    const res = await pool.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
    );
    return ((res.rows[0] as { n: number } | undefined)?.n ?? 0) > 0;
  } catch (err) {
    // The target database does not exist yet (first restore ever): nothing can be using it.
    if (err instanceof Error && /database .* does not exist/i.test(err.message)) return false;
    throw err;
  } finally {
    await pool.end();
  }
}

export interface PostgresRestoreOptions {
  storage: Storage;
  snapshot: string;
  /** The server's current connection: both the "is it in use" check and the libpq env the
   *  restore itself runs under target this same server. */
  target: PostgresConfig;
  now?: () => number;
}

export async function restorePostgres(opts: PostgresRestoreOptions): Promise<RestoreReport> {
  const { storage } = opts;
  const now = opts.now ?? Date.now;
  if (!isSnapshotName(opts.snapshot) || !opts.snapshot.endsWith('.dump')) {
    throw new RestoreRefused(
      `"${opts.snapshot}" is not a name this app's own backup job writes (opportun-<date>-<time>.dump); refusing to trust a file from anywhere else.`,
    );
  }
  const snapshotRelPath = `backups/${opts.snapshot}`;
  const backupFiles = await storage.listFiles('backups');
  const entry = backupFiles.find((f) => f.name === opts.snapshot);
  if (entry === undefined) {
    throw new RestoreRefused(`backups/${opts.snapshot} does not exist.`);
  }
  const snapshotAbsPath = storage.resolveInsideRoot(snapshotRelPath);

  if (await postgresInUse(opts.target)) {
    throw new RestoreRefused(
      'the target Postgres database has another open connection (the server may still be running). Stop it first; nothing was touched.',
    );
  }

  const verified = await verifySnapshot(storage, opts.snapshot, 'dump', now());
  if (!verified.ok) {
    throw new RestoreRefused(
      `${opts.snapshot} failed to read as a pg_dump archive (${verified.detail ?? 'unknown'}); refusing to restore a snapshot known to be bad. Try an older one.`,
    );
  }

  const adminEnv = libpqEnvFor(opts.target.url, opts.target.ssl);

  // Restoring into a fresh database, never over the existing one: the existing database is
  // thereby preserved by construction (requirement 3), not by a separate copy step. Overwriting
  // the live database in place is install.md's own documented riskier alternative and is not
  // built here.
  const fresh = `opportun_restored_${isoStamp(now())
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')}`;
  try {
    await run(
      'createdb',
      [
        '--template=template0',
        '--locale-provider=libc',
        '--lc-collate=C',
        '--lc-ctype=C',
        '--encoding=UTF8',
        fresh,
      ],
      adminEnv,
    );
  } catch (err) {
    throw new RestoreFailed(
      `could not create ${fresh}: ${err instanceof Error ? err.message : String(err)}. The existing database was not touched.`,
      'preserving',
    );
  }

  try {
    await run(
      'pg_restore',
      [
        '--no-owner',
        '--no-privileges',
        '--single-transaction',
        '--exit-on-error',
        `--dbname=${fresh}`,
        snapshotAbsPath,
      ],
      adminEnv,
    );
  } catch (err) {
    throw new RestoreFailed(
      `pg_restore into ${fresh} failed: ${err instanceof Error ? err.message : String(err)}. The existing database was not touched; ${fresh} holds a failed, incomplete restore and should be dropped.`,
      'restoring',
    );
  }

  return {
    dialect: 'postgres',
    snapshot: opts.snapshot,
    snapshotCompletedAt: Math.round(entry.mtimeMs),
    preserved: '(the existing database was never touched: restore always targets a fresh one)',
    restoredTo: fresh,
    verified,
  };
}

/** One line stating exactly what was restored and from when (requirement 4). */
export function formatRestoreReport(report: RestoreReport): string {
  const when = new Date(report.snapshotCompletedAt).toISOString();
  return [
    `Restored from ${report.snapshot}, a backup that completed at ${when}.`,
    `Anything written after ${when} is not in this restore.`,
    // issue #205: say so, not just not-complain -- the same gap as cli/backup.ts's message,
    // and the same honest dialect difference (SQLite's row-data check vs. Postgres's
    // table-of-contents-only one).
    report.dialect === 'sqlite'
      ? "Verified: passed a full integrity check. The instance's live-check status has been refreshed to match."
      : "Verified: the archive's table of contents read back cleanly (pg_restore --list; row data is not read).",
    report.dialect === 'sqlite'
      ? `Live database: ${report.restoredTo}.`
      : `New database: ${report.restoredTo}. Point DATABASE_URL at it and restart to use it.`,
    report.preserved !== null
      ? report.dialect === 'sqlite'
        ? `The previous database was preserved at ${report.preserved}.`
        : report.preserved
      : 'There was no existing database to preserve.',
  ].join('\n');
}
