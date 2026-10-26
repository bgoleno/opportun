// One-command restore (issue #142; docs/install.md section 6; the mirror of cli/backup.ts and
// of install.md's own manual procedure, with the four guarantees lib/restore.ts documents):
//
//   node --import tsx src/cli/restore.ts <snapshot-name>
//
// snapshot-name is a file already under backups/, e.g. opportun-20261021-0300.db (SQLite) or
// opportun-20261021-0300.dump (Postgres). Exit codes: 0 restored, 1 failed partway (the message
// says what was preserved and where), 2 refused or bad usage (nothing was written).
//
// Deliberately does not open the database the way the server does (connectDatabase): that would
// migrate a database this command has not yet decided is trustworthy, and, on Postgres, would
// itself be a connection that requirement 1's "is anything using this" check would then see and
// refuse against. Instead it works directly against the configured DATA_DIR, SQLITE_DIR and,
// for Postgres, DATABASE_URL, exactly as lib/restore.ts itself does.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDbConfig, loadSqliteDir, type DbConfig } from '../config';
import {
  formatRestoreReport,
  restorePostgres,
  restoreSqlite,
  RestoreFailed,
  RestoreRefused,
} from '../lib/restore';
import { createStorage, type Storage } from '../lib/storage';

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const processIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

const USAGE = [
  'Usage: node --import tsx src/cli/restore.ts <snapshot-name>',
  '  snapshot-name is a file already under backups/, e.g. opportun-20261021-0300.db (SQLite)',
  '  or opportun-20261021-0300.dump (Postgres). Run against the same DATA_DIR, SQLITE_DIR',
  '  (and, on Postgres, the same DB_DIALECT and DATABASE_URL) as the server; stop it first.',
].join('\n');

export interface RestoreArgs {
  snapshot: string | undefined;
  storage: Storage;
  db: DbConfig;
  io?: CliIo;
  now?: () => number;
}

/** Runs the restore; resolves with the process exit code. */
export async function main({
  snapshot,
  storage,
  db,
  io = processIo,
  now,
}: RestoreArgs): Promise<number> {
  if (snapshot === undefined || snapshot === '') {
    io.stderr(USAGE);
    return 2;
  }
  try {
    const report =
      db.dialect === 'sqlite'
        ? await restoreSqlite({ storage, snapshot, now })
        : await restorePostgres({ storage, snapshot, target: db, now });
    io.stdout(formatRestoreReport(report));
    return 0;
  } catch (err) {
    if (err instanceof RestoreRefused) {
      io.stderr(`Refused: ${err.message}`);
      return 2;
    }
    if (err instanceof RestoreFailed) {
      io.stderr(`Failed while ${err.stage}: ${err.message}`);
      return 1;
    }
    io.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const dataDir = resolve(
    process.env.DATA_DIR === undefined || process.env.DATA_DIR === ''
      ? './data'
      : process.env.DATA_DIR,
  );
  const db = loadDbConfig(process.env);
  const storage = createStorage(dataDir, loadSqliteDir(process.env, dataDir));
  main({ snapshot: process.argv[2], storage, db }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
