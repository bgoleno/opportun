// Scratch Postgres databases for the live Postgres tests (iteration 4 Wave 2). They run only
// when TEST_DATABASE_URL points at a Postgres 16 server the tests may create databases on
// (Task 13's CI service); without it they are skipped and the recorded fake (test/fakePg.ts)
// carries the Postgres branch. Kept beside Task 13's harness (test/pgHarness.ts, which clones
// a MIGRATED template): the migrator and parity tests need an EMPTY database.
import { randomBytes } from 'node:crypto';
import pg from 'pg';

/** The admin URL for live Postgres tests, or undefined (skip them). */
export const livePgUrl: string | undefined =
  process.env.TEST_DATABASE_URL === undefined || process.env.TEST_DATABASE_URL === ''
    ? undefined
    : process.env.TEST_DATABASE_URL;

/** A fresh, empty, C-collated database; `drop` removes it (forcing out open connections). */
export async function createScratchDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  if (livePgUrl === undefined) throw new Error('TEST_DATABASE_URL is not set');
  const admin = livePgUrl;
  const name = `opportun_w2_${randomBytes(6).toString('hex')}`;
  const run = async (statement: string) => {
    const client = new pg.Client({ connectionString: admin });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  };
  await run(
    `CREATE DATABASE "${name}" TEMPLATE template0 LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C' ENCODING 'UTF8'`,
  );
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return { url: url.toString(), drop: () => run(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) };
}

/** Runs `fn` against a fresh, empty, C-collated database, dropped afterwards. */
export async function withScratchDatabase<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const scratch = await createScratchDatabase();
  try {
    return await fn(scratch.url);
  } finally {
    await scratch.drop();
  }
}
