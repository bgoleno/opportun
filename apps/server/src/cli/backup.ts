// One-command backup (docs/install.md section 6; issue #142, the mirror of restore.ts), for
// running by hand right before an upgrade rather than improvising a plain `cp` of a live
// database (issue #165: that is exactly what went wrong -- a cp of a live SQLite file is not a
// consistent snapshot, and the result was corrupt). This does not reimplement the snapshot: it
// calls the same runBackup (jobs/backup.ts) the nightly job and the Settings "Back up now"
// button call, VACUUM INTO on SQLite / pg_dump on Postgres, the mechanism that produced a
// clean, restorable snapshot tonight when the manual copy did not.
//
//   node --import tsx src/cli/backup.ts
//
// Exit codes: 0 written (prints the file name, its size and where it landed), 1 the backup
// itself failed (pg_dump's error, or a database error from VACUUM INTO).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDbConfig, loadSqliteDir } from '../config';
import { closeDatabase, connectDatabase, type Db } from '../db/client';
import { runBackup, type BackupResult } from '../jobs/backup';
import { createStorage, type Storage } from '../lib/storage';

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const processIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

export interface BackupArgs {
  db: Db;
  storage: Storage;
  io?: CliIo;
  now?: number;
}

/** Runs a backup now. Resolves with the process exit code. */
export async function main({ db, storage, io = processIo, now }: BackupArgs): Promise<number> {
  let result: BackupResult;
  try {
    result = await runBackup(db, storage, now);
  } catch (err) {
    io.stderr(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  // issue #205: "it did not complain" and "it told me this is good" are different levels of
  // confidence at 04:00, and verifySnapshot already ran (runBackup throws instead of reaching
  // here if it failed) -- say so, rather than leaving the operator to infer it from the
  // absence of an error. Dialect-aware because the guarantee itself differs: pg_restore
  // --list reads the archive's table of contents, not its row data (jobs/backup.ts's own
  // VerifyResult doc comment), a real gap from SQLite's full PRAGMA integrity_check that the
  // #198 drill confirmed matters (see docs/install.md's engine comparison).
  io.stdout(
    result.file.endsWith('.dump')
      ? `Wrote backups/${result.file} (${result.bytes} bytes). Verified: the archive's table of contents reads back cleanly (pg_restore --list; row data is not read, see docs/install.md).`
      : `Wrote backups/${result.file} (${result.bytes} bytes). Verified: passed a full integrity check.`,
  );
  if (result.pruned.length > 0) {
    io.stdout(`Pruned ${result.pruned.length} older snapshot(s): ${result.pruned.join(', ')}.`);
  }
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const dataDir = resolve(
    process.env.DATA_DIR === undefined || process.env.DATA_DIR === ''
      ? './data'
      : process.env.DATA_DIR,
  );
  const run = async (): Promise<number> => {
    const sqliteDir = loadSqliteDir(process.env, dataDir);
    const handle = await connectDatabase({ dataDir, sqliteDir, db: loadDbConfig(process.env) });
    const storage = createStorage(dataDir, sqliteDir);
    try {
      return await main({ db: handle.db, storage });
    } finally {
      await closeDatabase(handle);
    }
  };
  run().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
