// A dedicated account on a demo server (https://github.com/bgoleno/opportun/issues/563; docs/install.md,
// the demo section):
//
//   node --import tsx src/cli/createDemoAccount.ts <email> <display name>
//
// For one person the operator invites on their own (a journalist, say): an ordinary account, never
// an admin, that the shared demo admin has no power over and that the nightly reset leaves alone.
// It creates the account and its mark (lib/demoDedicated.ts) in one transaction, and prints the
// account's password to stdout, once. Nothing else: the password never goes to a log, a file, the
// audit trail or stderr. Registration is never opened, not even for the insert.
//
// Refuses (touching nothing) off a demo server, on a demo not yet seeded, and for an email already
// in use. Run it against the same DATA_DIR (and, on Postgres, the same DB_DIALECT and DATABASE_URL)
// and the same OPPORTUN_PEPPER as the server (in Docker: docker compose exec).
// First, before anything that loads the AI SDK: see unsetEmptyAiBaseUrls.ts for why.
import '../unsetEmptyAiBaseUrls';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { loadDbConfig, loadSqliteDir } from '../config';
import { closeDatabase, connectDatabase, withTransaction, type Db } from '../db/client';
import { settings, users } from '../db/schema';
import { audit } from '../lib/audit';
import { writeDedicatedMark } from '../lib/demoDedicated';
import { temporaryPassword } from '../lib/passwordReset';
import { hashPassword, NO_PEPPERS, pepperSet, type PepperSet } from '../lib/passwords';
import { insertUserRow } from '../lib/registration';
import { DEMO_MARKER_KEY } from './seedDemo';
import type { CliIo } from './resetPassword';

/** The same one-pepper set resetPassword.ts builds: the server's current OPPORTUN_PEPPER. */
function toPepperSet(pepper: string): PepperSet {
  return pepper === '' ? NO_PEPPERS : pepperSet(1, { 1: pepper });
}

// The registration route's own rules for both (routes/auth.ts RegisterBody).
const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const DisplayName = z.string().trim().min(1).max(100);

export interface CreateDemoAccountArgs {
  db: Db;
  /** The server's environment: OPPORTUN_DEMO must be 1. */
  env: NodeJS.ProcessEnv;
  email: string | undefined;
  displayName: string | undefined;
  io?: CliIo;
  /** OPPORTUN_PEPPER of the server this database belongs to ('' when none). */
  pepper?: string;
}

const USAGE = 'Usage: node --import tsx src/cli/createDemoAccount.ts <email> <display name>';

class Refused extends Error {}

const processIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/** Creates and marks a dedicated demo account. Resolves with the process exit code. */
export async function main({
  db,
  env,
  email,
  displayName,
  io = processIo,
  pepper = '',
}: CreateDemoAccountArgs): Promise<number> {
  const parsedEmail = Email.safeParse(email ?? '');
  const parsedName = DisplayName.safeParse(displayName ?? '');
  if (!parsedEmail.success || !parsedName.success) {
    io.stderr(USAGE);
    return 2;
  }
  if (env.OPPORTUN_DEMO !== '1') {
    io.stderr('OPPORTUN_DEMO is not set to 1: a dedicated demo account is for a demo server only.');
    return 1;
  }
  const password = temporaryPassword();
  const passwordHash = await hashPassword(password, toPepperSet(pepper));
  const now = Date.now();
  let userId: string;
  try {
    userId = await withTransaction(
      db,
      async (tx) => {
        // Seeded first: the seed makes demo-admin the admin, and a database with no demo marker
        // is not one the demo reset would ever run on.
        const marker = await tx
          .select({ key: settings.key })
          .from(settings)
          .where(eq(settings.key, DEMO_MARKER_KEY))
          .get();
        if (marker === undefined) {
          throw new Refused('This demo has not been seeded yet: run the demo seed first.');
        }
        const taken = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, parsedEmail.data))
          .get();
        if (taken !== undefined) throw new Refused(`An account already uses ${parsedEmail.data}.`);
        const row = await insertUserRow(tx, {
          email: parsedEmail.data,
          passwordHash,
          displayName: parsedName.data,
          isAdmin: false,
          now,
        });
        await writeDedicatedMark(tx, row.id, now);
        return row.id;
      },
      // registerUser's scope: no first registration runs beside this insert.
      { scope: 'registration' },
    );
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    io.stderr(`${err.message} Nothing changed.`);
    return 1;
  }
  await audit(db, 'demo.dedicated_account_created', { userId });
  io.stderr(
    `Created the dedicated demo account ${parsedEmail.data}. Its password is on stdout, shown ` +
      'this once: give it to its owner, who can change it in Settings.',
  );
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
    // The server's database, resolved the same way as resetPassword.ts does (issue #179).
    const sqliteDir = loadSqliteDir(process.env, dataDir);
    const handle = await connectDatabase({ dataDir, sqliteDir, db: loadDbConfig(process.env) });
    try {
      return await main({
        db: handle.db,
        env: process.env,
        email: process.argv[2],
        displayName: process.argv[3],
        // The same pepper the server hashes with, or the password would not verify.
        pepper: process.env.OPPORTUN_PEPPER ?? '',
      });
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
