// Copies a SQLite deployment's database into a new, empty Postgres database and verifies the
// copy (iteration 4 Task 14; lib/copyToPostgres.ts; the cutover runbook is docs/install.md):
//
//   DB_DIALECT=postgres DATABASE_URL=postgres://... OPPORTUN_MASTER_KEY_FILE=... \
//     node --import tsx src/cli/copyToPostgres.ts --from <DATA_DIR> [--dry-run]
//
// The target comes from the same variables the server reads (DATABASE_URL or
// DATABASE_URL_FILE, DB_SSL), never from the command line, where every local user could read
// its password with ps. The master key (OPPORTUN_MASTER_KEY or _FILE) is needed to prove that
// every vault secret still decrypts after the copy. The server must be stopped.
//
// Exit codes: 0 copied and verified (or a clean dry run), 1 verification failed or an error
// (the copy was rolled back unless the report says otherwise), 2 refused or bad usage
// (nothing was written).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDbConfig, loadMasterKey, loadSqliteDir } from '../config';
import {
  copyToPostgres,
  CopyFailed,
  CopyRefused,
  formatReport,
  type CopyOptions,
  type CopyReport,
} from '../lib/copyToPostgres';

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const USAGE = [
  'Usage: DB_DIALECT=postgres DATABASE_URL=... OPPORTUN_MASTER_KEY_FILE=... \\',
  '  node --import tsx src/cli/copyToPostgres.ts --from <SQLITE_DIR> [--dry-run] [--batch <rows>] [--attachment-sample <n>] [--allow-undecryptable]',
  '',
  "  --from               the SQLite deployment's SQLITE_DIR, where opportun.db lives",
  '                        (default: $SQLITE_DIR, else $DATA_DIR, else ./data). Attachments',
  '                        are read from $DATA_DIR regardless (issue #179 may have moved only',
  '                        the database).',
  '  --dry-run            check the source and the target and print the plan; write nothing',
  '  --batch              rows per INSERT (default 500)',
  '  --attachment-sample  attachment files to verify by hash (default 500; 0 = all)',
  '  --allow-undecryptable  copy even if some vault values do not decrypt with this key (warned per value)',
].join('\n');

export interface CliArgs {
  from: string | undefined;
  dryRun: boolean;
  batchRows: number | undefined;
  attachmentSample: number | undefined;
  allowUndecryptable: boolean;
}

/** Parses the arguments; throws a usage message on anything unknown. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    from: undefined,
    dryRun: false,
    batchRows: undefined,
    attachmentSample: undefined,
    allowUndecryptable: false,
  };
  const count = (flag: string, raw: string | undefined, min: number): number => {
    if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < min) {
      throw new Error(`${flag} needs an integer of at least ${min}`);
    }
    return Number(raw);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--allow-undecryptable') args.allowUndecryptable = true;
    else if (arg === '--from') args.from = argv[(i += 1)];
    else if (arg === '--batch') args.batchRows = count('--batch', argv[(i += 1)], 1);
    else if (arg === '--attachment-sample') {
      args.attachmentSample = count('--attachment-sample', argv[(i += 1)], 0);
    } else throw new Error(`unknown argument: ${String(arg)}`);
  }
  if (args.from === '') throw new Error('--from needs a directory');
  return args;
}

/** What to do after a successful copy (printed once, at the end). */
export const CUTOVER_CHECKLIST = [
  'Cutover checklist (docs/install.md, "Moving to Postgres"):',
  '  1. The server must have stayed stopped for the whole copy, and stays stopped until step 3: the copy is a snapshot, so anything written to SQLite during or after it is not in Postgres (a warning above says so if the tool noticed the source change). Do not start it on SQLite again.',
  '  2. Set DB_DIALECT=postgres and DATABASE_URL (or DATABASE_URL_FILE) for the server; keep DATA_DIR and the master key: attachments/ and master.key stay on the filesystem.',
  '  3. Start the server and check GET /healthz, sign in, run a search, open an attachment.',
  '  4. Keep the SQLite file (DATA_DIR/opportun.db) untouched: it is the rollback. Rollback = stop, unset DB_DIALECT, start; writes made on Postgres after the cutover do not flow back.',
].join('\n');

export interface MainOptions {
  argv: string[];
  env: NodeJS.ProcessEnv;
  io?: CliIo;
  /** Tests: passed through to the copy (e.g. a beforeVerify hook). */
  copy?: Partial<CopyOptions>;
  /** Receives the report (tests). */
  onReport?: (report: CopyReport) => void;
}

const processIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/** Runs the copy; resolves with the process exit code. */
export async function main({
  argv,
  env,
  io = processIo,
  copy,
  onReport,
}: MainOptions): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  let target;
  let masterKey: Buffer;
  try {
    const db = loadDbConfig(env);
    if (db.dialect !== 'postgres')
      throw new Error('set DB_DIALECT=postgres and DATABASE_URL to the target database');
    target = db;
    masterKey = loadMasterKey(env);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const dataDir = resolve(
    env.DATA_DIR === undefined || env.DATA_DIR === '' ? './data' : env.DATA_DIR,
  );
  const sqliteDir = args.from !== undefined ? resolve(args.from) : loadSqliteDir(env, dataDir);
  io.stdout(
    `${args.dryRun ? 'Dry run: ' : ''}copying ${sqliteDir}/opportun.db to Postgres (${target.toString()})`,
  );
  let report: CopyReport;
  try {
    report = await copyToPostgres({
      dataDir,
      sqliteDir,
      target,
      masterKey,
      dryRun: args.dryRun,
      allowUndecryptable: args.allowUndecryptable,
      ...(args.batchRows === undefined ? {} : { batchRows: args.batchRows }),
      ...(args.attachmentSample === undefined ? {} : { attachmentSample: args.attachmentSample }),
      log: (line) => io.stdout(line),
      ...copy,
    });
  } catch (err) {
    if (err instanceof CopyRefused) {
      io.stderr(
        err.afterMigrate
          ? `Refused after migrating the empty target (it now holds only the schema and its seeded rows; nothing was copied): ${err.message}.`
          : `Refused before any changes: ${err.message}. Nothing was written.`,
      );
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    const state = err instanceof CopyFailed ? err.target : 'unknown';
    if (state === 'untouched') {
      io.stderr(`Copy failed before any changes: ${message}. Nothing was written.`);
    } else if (state === 'migrated') {
      io.stderr(
        `Copy failed and was rolled back: the target holds only its migrations. Cause: ${message}`,
      );
    } else {
      io.stderr(
        `Copy failed. COMMIT outcome unknown: verify the target before trusting either side. Cause: ${message}`,
      );
    }
    return 1;
  }
  onReport?.(report);
  io.stdout('');
  io.stdout(formatReport(report));
  for (const w of report.warnings) if (w.startsWith('WARNING:')) io.stderr(w);
  if (!report.ok) {
    io.stderr('');
    io.stderr(`Copy NOT verified: ${report.failures.join('; ')}`);
    io.stderr(
      report.outcome === 'rolled-back'
        ? 'The copy was rolled back: the target holds only its migrations.'
        : 'COMMIT outcome unknown: verify the target before trusting either side (the SQLite file is untouched).',
    );
    return 1;
  }
  io.stdout('');
  if (report.dryRun) {
    io.stdout('Dry run complete: nothing was written. Run again without --dry-run to copy.');
  } else {
    io.stdout('Copied and verified.');
    io.stdout('');
    io.stdout(CUTOVER_CHECKLIST);
  }
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main({ argv: process.argv.slice(2), env: process.env }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
