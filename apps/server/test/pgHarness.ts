// The Postgres leg of the test matrix (iteration 4 Task 13). With TEST_DB_DIALECT=postgres,
// DB_DIALECT=postgres and TEST_DATABASE_URL set, globalSetup.pg.ts migrates one template
// database to head per run, and every app or handle a test opens gets its own database
// cloned from it (CREATE DATABASE ... TEMPLATE: a file copy, no migrations), dropped when
// the app closes. Clones are named after the test file that made them, so a failure, a
// server log line (log_line_prefix carries %d) and a database kept for inspection
// (PG_KEEP_DATABASES=1) all point back at the file.
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import pg from 'pg';
import { expect, inject } from 'vitest';
import { PostgresConfig } from '../src/config';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The run's template database (globalSetup.pg.ts); '' on SQLite runs. */
    pgTemplate: string;
  }
}

/** Pool size for each test app's database (the CI server allows 300 connections). */
const TEST_POOL_MAX = 4;

/** The server URL the Postgres leg creates its databases on. */
export function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error('TEST_DB_DIALECT=postgres needs TEST_DATABASE_URL (a Postgres 16 server)');
  }
  return url;
}

/** `url` with its database name replaced. */
export function urlFor(database: string, base: string = adminUrl()): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Runs one statement on the admin connection (CREATE/DROP DATABASE cannot run in a pool tx). */
export async function adminQuery(statement: string, url: string = adminUrl()): Promise<void> {
  const client = new pg.Client({ connectionString: url, application_name: 'opportun-tests' });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/** A database name fragment for the current test file: lowercase, [a-z0-9_]. */
function fileSlug(): string {
  const path = expect.getState().testPath ?? 'unknown';
  return basename(path)
    .replace(/\.test\.ts$/, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .slice(0, 32);
}

/** Every clone this worker made for the running test, for the failure report (setup.ts). */
export const databasesOfCurrentTest: string[] = [];

let seq = 0;

export interface TestDatabase {
  name: string;
  config: PostgresConfig;
  drop: () => Promise<void>;
}

/** A fresh database at the migrated head, cloned from the run's template. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const template = inject('pgTemplate');
  if (template === '') throw new Error('no template database: is globalSetup.pg.ts configured?');
  seq += 1;
  // <= 63 bytes: opportun_t_ (11) + slug (<= 32) + _ + seq + _ + 6 hex.
  const name = `opportun_t_${fileSlug()}_${seq}_${randomBytes(3).toString('hex')}`;
  try {
    await adminQuery(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  } catch (err) {
    throw new Error(`creating test database ${name} from ${template}: ${String(err)}`, {
      cause: err,
    });
  }
  databasesOfCurrentTest.push(name);
  let dropped = false;
  return {
    name,
    config: new PostgresConfig(urlFor(name), TEST_POOL_MAX, 'disable'),
    drop: async () => {
      if (dropped || process.env.PG_KEEP_DATABASES === '1') return;
      dropped = true;
      await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}
