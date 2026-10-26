// Operator recovery for a lost password (docs/install.md section 6):
//
//   node --import tsx src/cli/resetPassword.ts <email>
//
// Generates a strong temporary password, stores only its Argon2id hash, ends every session the
// user has, turns off TOTP 2FA (the recovery of last resort for a lost phone with no recovery
// codes: the user re-enrolls after signing in), and prints the temporary password to stdout. Nothing else: the password never goes
// to a log, a file, the audit trail or stderr. Exits nonzero (touching nothing) when the email
// is unknown. Run it against the same DATA_DIR (and, on Postgres, the same DB_DIALECT and
// DATABASE_URL) as the server (in Docker: docker compose exec).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadDbConfig, loadSqliteDir } from '../config';
import { closeDatabase, connectDatabase, type Db } from '../db/client';
import { users } from '../db/schema';
import { audit } from '../lib/audit';
import { resetUserPassword } from '../lib/passwordReset';
import { NO_PEPPERS, pepperSet, type PepperSet } from '../lib/passwords';

export { temporaryPassword } from '../lib/passwordReset';

/**
 * The CLI is handed one pepper string, which is the current one, so it builds the single-entry
 * set that version 1 names. A deployment mid-rotation runs the reset with its CURRENT pepper
 * and OPPORTUN_PEPPER_VERSION; the resulting hash is stamped and verifies normally.
 */
function toPepperSet(pepper: string, version = 1): PepperSet {
  return pepper === '' ? NO_PEPPERS : pepperSet(version, { [version]: pepper });
}

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface ResetPasswordArgs {
  db: Db;
  email: string | undefined;
  io?: CliIo;
  /** OPPORTUN_PEPPER of the server this database belongs to ('' when none). */
  pepper?: string;
}

const USAGE = 'Usage: node --import tsx src/cli/resetPassword.ts <email>';

const processIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/** Resets the password for `email`. Resolves with the process exit code. */
export async function main({
  db,
  email,
  io = processIo,
  pepper = '',
}: ResetPasswordArgs): Promise<number> {
  const normalized = email?.trim().toLowerCase() ?? '';
  if (normalized === '') {
    io.stderr(USAGE);
    return 2;
  }
  const user = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalized))
    .get();
  if (user === undefined) {
    io.stderr(`No user with email ${normalized}; nothing changed.`);
    return 1;
  }
  const password = await resetUserPassword(db, user.id, toPepperSet(pepper));
  await audit(db, 'auth.password_reset_cli', { userId: user.id });
  io.stdout(password);
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
    // The server's database: DATA_DIR/SQLITE_DIR for SQLite, DB_DIALECT/DATABASE_URL for
    // Postgres. SQLITE_DIR must resolve the same way here as it does for the server
    // (config.ts's loadConfig), or the CLI and server open different files on a
    // split-volume install (issue #179).
    const sqliteDir = loadSqliteDir(process.env, dataDir);
    const handle = await connectDatabase({ dataDir, sqliteDir, db: loadDbConfig(process.env) });
    const { db } = handle;
    try {
      // The same pepper the server hashes with, or the temporary password would not verify.
      return await main({ db, email: process.argv[2], pepper: process.env.OPPORTUN_PEPPER ?? '' });
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
