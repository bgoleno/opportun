// Nightly backups (FR-I4). SQLite: VACUUM INTO writes a consistent snapshot of the live
// database to a temp file under backups/, which is then moved into place as
// opportun-YYYYMMDD-HHmm.db (UTC) by an atomic, no-clobber link (lib/storage.ts), so a
// reader never sees a half-written snapshot AND a second snapshot in the same minute
// (a manual "back up now" alongside the nightly run, or two manual runs) never silently
// replaces the first: it claims the next free -2, -3, ... suffix instead (issue #3).
// Postgres (iteration 4 Task 12): the same, with pg_dump's custom format (one consistent
// snapshot transaction) written to the temp file and moved into place as
// opportun-YYYYMMDD-HHmm.dump; pg_dump is spawned with the connection in libpq environment
// variables, never in argv. Next to each snapshot goes a manifest of the attachment files
// it refers to (attachments are content-addressed and never modified, so they are not
// copied). The 14 newest snapshots of either kind are kept, by modification time, which a
// collision suffix does not affect (listBackups never sorts by the filename string).
// Restore steps for both engines: docs/install.md section 6.
//
// Every snapshot is verified immediately after it is written (issue #170): the owner's live
// instance corrupted silently, and its own pre-upgrade backup, taken minutes earlier, was also
// corrupt, sitting in backups/ looking exactly like a good one. A backup nobody has ever
// opened is a hope, not a backup. The result goes in a sidecar next to the snapshot
// (opportun-...-verify.json), read by listBackups, so it shows in the same surface as size
// and time; a failed verification also fails the job, surfacing it the same way any other job
// failure does (apps/server/src/routes/jobs.ts), but the snapshot and its failed verification
// are kept, not deleted, since a corrupt file that cannot be told apart from a good one is
// exactly the problem being fixed here.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { pgClientEnv, rawRun, type Db, type LibpqEnv } from '../db/client';
import { attachments } from '../db/schema';
import { FileExistsError, type Storage } from '../lib/storage';
import { requireService, type JobHandler } from './registry';

export const BACKUP_JOB_KIND = 'backup';
export const BACKUP_CRON = '0 3 * * *';
export const BACKUP_RETENTION = 14;
export const BACKUP_DIR = 'backups';
/** Dedupe key for on-demand backups (scheduled ones use schedule:backup). */
export const MANUAL_BACKUP_DEDUPE_KEY = 'backup:manual';
/**
 * Same-minute collisions tried before giving up (pathological: retention keeps only 14
 * snapshots total, so this is a safety bound, never expected to bind in practice).
 */
const MAX_COLLISION_ATTEMPTS = 1000;

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

export interface BackupResult {
  file: string;
  bytes: number;
  pruned: string[];
  verified: VerifyResult;
}

export interface BackupFile {
  name: string;
  bytes: number;
  createdAt: number;
  /** null: no verification sidecar exists, e.g. a snapshot taken before #170 shipped. */
  verified: VerifyResult | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** opportun-YYYYMMDD-HHmm.db (or .dump on Postgres) for a UTC instant. */
export function snapshotName(now: number, kind: SnapshotKind = 'db'): string {
  const d = new Date(now);
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  return `opportun-${date}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}.${kind}`;
}

const manifestName = (snapshot: string): string =>
  snapshot.replace(/\.(db|dump)$/, '.attachments.json');
const verifyName = (snapshot: string): string => snapshot.replace(/\.(db|dump)$/, '.verify.json');

/** `base` on the first attempt (n = 0); base with a `-2`, `-3`, ... suffix on each retry. */
function suffixed(base: string, kind: SnapshotKind, n: number): string {
  if (n === 0) return base;
  const ext = `.${kind}`;
  return `${base.slice(0, -ext.length)}-${n + 1}${ext}`;
}

/** How long a pg_dump may run before it is killed and the backup fails. */
const PG_DUMP_TIMEOUT_MS = 30 * 60_000;
/** Bytes of pg_dump's stderr kept for the job's error. */
const STDERR_LIMIT = 4096;

/**
 * The pg_dump command for a snapshot: custom format (compressed, restorable selectively by
 * pg_restore), no ownership or grants (the restore target's role owns everything). The child
 * gets PATH and the libpq variables only: no master key, DATABASE_URL or other app secret.
 */
export function pgDumpInvocation(
  connection: LibpqEnv,
  outFile: string,
  baseEnv: Record<string, string | undefined> = { PATH: process.env.PATH },
): { command: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  if (baseEnv.PATH !== undefined) env.PATH = baseEnv.PATH;
  return {
    command: 'pg_dump',
    args: ['--format=custom', '--no-owner', '--no-privileges', `--file=${outFile}`],
    env: { ...env, ...connection },
  };
}

/** Runs pg_dump to `outFile`; rejects with its exit status and (bounded) stderr. `baseEnv` is
 *  overridable for tests only (issue #292's own fix, mirroring runBackup's `verify` override
 *  below): the #180 precondition test needs pg_dump unreachable without mutating the real
 *  process.env.PATH, which vitest's threads pool shares with every test file running in the
 *  same worker. Every real call uses pgDumpInvocation's own default. */
function runPgDump(
  connection: LibpqEnv,
  outFile: string,
  baseEnv?: Record<string, string | undefined>,
): Promise<void> {
  const { command, args, env } = pgDumpInvocation(connection, outFile, baseEnv);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), PG_DUMP_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`pg_dump could not start: ${err.message}`, { cause: err }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const why = signal === null ? `exited with status ${code}` : `was killed (${signal})`;
        reject(new Error(`pg_dump ${why}: ${stderr.slice(0, STDERR_LIMIT).trim()}`));
      }
    });
  });
}

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

/** A snapshot's own verification result, or null if it was never written (a snapshot from
 *  before issue #170, or one whose sidecar write itself failed). */
async function readVerification(storage: Storage, file: string): Promise<VerifyResult | null> {
  try {
    return JSON.parse(await storage.readText(`${BACKUP_DIR}/${verifyName(file)}`)) as VerifyResult;
  } catch {
    return null;
  }
}

/** Snapshots on disk, newest first (by modification time), each with its own verification
 *  result alongside size and time (issue #170): existing and restorable are different claims. */
export async function listBackups(storage: Storage): Promise<BackupFile[]> {
  const files = await storage.listFiles(BACKUP_DIR);
  const snapshots = files
    .filter((f) => isSnapshotName(f.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return Promise.all(
    snapshots.map(async (f) => ({
      name: f.name,
      bytes: f.bytes,
      createdAt: Math.round(f.mtimeMs),
      verified: await readVerification(storage, f.name),
    })),
  );
}

/** Deletes snapshots (and their manifests) beyond the newest `keep`. */
export async function pruneBackups(storage: Storage, keep = BACKUP_RETENTION): Promise<string[]> {
  const stale = (await listBackups(storage)).slice(keep).map((f) => f.name);
  for (const name of stale) {
    await storage.removeFile(`${BACKUP_DIR}/${name}`);
    await storage.removeFile(`${BACKUP_DIR}/${manifestName(name)}`);
  }
  return stale;
}

// One backup at a time per process: a second call waits for the first to finish.
let queue: Promise<unknown> = Promise.resolve();

async function snapshot(
  db: Db,
  storage: Storage,
  now: number,
  verify: typeof verifySnapshot,
  pgDumpEnv?: Record<string, string | undefined>,
): Promise<BackupResult> {
  await storage.ensureDir(BACKUP_DIR);
  const pg = pgClientEnv(db);
  const kind: SnapshotKind = pg === undefined ? 'db' : 'dump';
  const base = snapshotName(now, kind);
  const tmpRel = `${BACKUP_DIR}/.tmp-${randomBytes(8).toString('hex')}.${kind}`;
  // VACUUM INTO and pg_dump take a filesystem path, so it is resolved (and confined) by storage.
  const tmpAbs = storage.resolveInsideRoot(tmpRel);
  let file = base;
  try {
    if (pg === undefined) await rawRun(db, sql`VACUUM INTO ${tmpAbs}`);
    else await runPgDump(pg, tmpAbs, pgDumpEnv);
    // moveFile never clobbers (lib/storage.ts, atomic). On a same-minute collision, claim the
    // next free suffix instead of either losing the earlier snapshot or failing the caller.
    for (let n = 0; ; n++) {
      file = suffixed(base, kind, n);
      try {
        await storage.moveFile(tmpRel, `${BACKUP_DIR}/${file}`);
        break;
      } catch (err) {
        if (!(err instanceof FileExistsError) || n >= MAX_COLLISION_ATTEMPTS) throw err;
      }
    }
  } finally {
    await storage.removeFile(tmpRel);
  }
  const manifest = await db
    .selectDistinct({
      storedPath: attachments.storedPath,
      sha256: attachments.sha256,
      bytes: attachments.bytes,
    })
    .from(attachments)
    .orderBy(attachments.storedPath)
    .all();
  await storage.writeText(
    `${BACKUP_DIR}/${manifestName(file)}`,
    JSON.stringify({ snapshot: file, attachments: manifest }, null, 2),
  );
  const pruned = await pruneBackups(storage);
  const written = (await listBackups(storage)).find((f) => f.name === file);
  const verified = await verify(storage, file, kind, now);
  await storage.writeText(`${BACKUP_DIR}/${verifyName(file)}`, JSON.stringify(verified));
  if (!verified.ok) {
    // The file and its failed verification both stay (not deleted): a corrupt snapshot that
    // vanished on its own would be exactly as invisible as the one this issue was filed over.
    // Throwing surfaces this run as a failed job (routes/jobs.ts), the same as any other.
    throw new Error(`backup verification failed for ${file}: ${verified.detail ?? 'unknown'}`);
  }
  return { file, bytes: written?.bytes ?? 0, pruned, verified };
}

/** Writes a snapshot, its attachments manifest, then prunes to the newest 14. */
/** `verify` is overridable for tests only (issue #170's own failure path needs a way to force
 *  a bad result without actually corrupting a file on disk); every real call uses the
 *  default. `pgDumpEnv` is the same kind of override (issue #292): the #180 precondition test
 *  needs pg_dump unreachable without mutating the real process.env.PATH. Neither parameter
 *  changes what a real call (which supplies neither) does: pgDumpInvocation's own default,
 *  `{ PATH: process.env.PATH }`, is unchanged and still the only thing a real backup ever
 *  sees. */
export function runBackup(
  db: Db,
  storage: Storage,
  now: number = Date.now(),
  verify: typeof verifySnapshot = verifySnapshot,
  pgDumpEnv?: Record<string, string | undefined>,
): Promise<BackupResult> {
  const run = queue.then(() => snapshot(db, storage, now, verify, pgDumpEnv));
  queue = run.catch(() => undefined);
  return run;
}

export const backupJob: JobHandler<Record<string, never>> = {
  kind: BACKUP_JOB_KIND,
  payloadSchema: z.object({}).strict() as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    const result = await runBackup(db, requireService(ctx, 'storage'));
    await ctx.setResult(result);
  },
};
