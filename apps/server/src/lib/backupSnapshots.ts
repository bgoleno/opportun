// Backup snapshot files (https://github.com/bgoleno/opportun/issues/788): where they live, which
// names are snapshots, and verifying one, in lib/ so the restore command (lib/restore.ts) uses them
// without importing the backup job (jobs/backup.ts), which writes them.
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { type Storage } from './storage';

export const BACKUP_DIR = 'backups';

/** The base name, with -2, -3, ... appended on an earlier same-minute collision. */
const SNAPSHOT_BASE = /^opportun-(\d{8})-(\d{4})\.(db|dump)$/;
const SNAPSHOT_SUFFIXED = /^opportun-(\d{8})-(\d{4})-\d{1,6}\.(db|dump)$/;
/**
 * True only for a name this job itself could have produced (snapshotName()'s shape, with or
 * without a collision suffix). Exported for restore.ts (issue #142): a restore command must
 * refuse a file an external tool wrote under the same directory, whatever it is named, rather
 * than trust anything that merely sits in backups/ (issue #165: a same-ish-looking file from
 * an unrelated script was corrupt).
 */
export const isSnapshotName = (name: string): boolean =>
  SNAPSHOT_BASE.test(name) || SNAPSHOT_SUFFIXED.test(name);

/** Snapshot file extension: SQLite database file, or pg_dump custom-format archive. */
export type SnapshotKind = 'db' | 'dump';

/**
 * SQLite: PRAGMA integrity_check against the file itself -- a real data check. Postgres:
 * pg_restore --list against the archive, which validates the TOC (the dump is readable and
 * well-formed) but, unlike SQLite's check, never reads the actual row data; that gap is
 * inherent to how pg_dump's custom format is verified short of a full restore.
 */
export interface VerifyResult {
  ok: boolean;
  checkedAt: number;
  detail: string | null;
}

/** Bytes of pg_dump's stderr kept for the job's error. */
export const STDERR_LIMIT = 4096;

/** Bounded length of a verification's own detail text (an integrity_check row, or pg_restore
 *  stderr), kept with the result rather than discarded. */
const DETAIL_LIMIT = 2000;

/**
 * pg_restore --list reads the archive's table of contents only: no database, no credential,
 * confirming the dump is a well-formed archive it can parse. It does not read the row data
 * pg_dump wrote, so this is weaker than SQLite's integrity_check -- stated in VerifyResult's
 * own doc comment, not hidden.
 */
function runPgRestoreList(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pg_restore', ['--list', file], {
      // eslint-disable-next-line no-restricted-properties -- a child process's own environment, passed on, not a setting (#773)
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      reject(new Error(`pg_restore could not start: ${err.message}`, { cause: err }));
    });
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else {
        const why = signal === null ? `exited with status ${code}` : `was killed (${signal})`;
        reject(new Error(`pg_restore --list ${why}: ${stderr.slice(0, STDERR_LIMIT).trim()}`));
      }
    });
  });
}

/** Verifies a just-written snapshot (issue #170). Never throws: a failure is reported in the
 *  result, not raised here, so the caller decides what to do with it. */
export async function verifySnapshot(
  storage: Storage,
  file: string,
  kind: SnapshotKind,
  now: number,
): Promise<VerifyResult> {
  try {
    if (kind === 'db') {
      const abs = storage.resolveInsideRoot(`${BACKUP_DIR}/${file}`);
      const sqlite = new Database(abs, { readonly: true, fileMustExist: true });
      try {
        const result = sqlite.pragma('integrity_check', { simple: true }) as string;
        return result === 'ok'
          ? { ok: true, checkedAt: now, detail: null }
          : { ok: false, checkedAt: now, detail: result.slice(0, DETAIL_LIMIT) };
      } finally {
        sqlite.close();
      }
    }
    await runPgRestoreList(storage.resolveInsideRoot(`${BACKUP_DIR}/${file}`));
    return { ok: true, checkedAt: now, detail: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, checkedAt: now, detail: message.slice(0, DETAIL_LIMIT) };
  }
}

/** Alongside the backup snapshots' own sidecars (backup.ts), not a new top-level concern: the
 *  live check is the other half of "can this instance's data be trusted". Exported for
 *  restore.ts (issue #205): a successful restore replaces the live database, so a failed
 *  result recorded here before the restore is no longer a true statement about it, and
 *  nothing else would re-read it until the next scheduled run, up to a day later. */
export const LIVE_CHECK_FILE = `${BACKUP_DIR}/.live-check.json`;
