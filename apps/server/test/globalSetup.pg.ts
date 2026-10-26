// Run-wide setup for the Postgres leg of the test matrix (iteration 4 Task 13; see
// pgHarness.ts). A no-op on SQLite runs. On Postgres: refuses a half-configured environment,
// creates this run's template database (C collation, libc provider, as docs/install.md
// requires), migrates it to head with the production migrator, and drops it at teardown.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { adminQuery, adminUrl, urlFor } from './pgHarness';

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  if (process.env.TEST_DB_DIALECT !== 'postgres') {
    project.provide('pgTemplate', '');
    return;
  }
  // db/schema.ts picks its tables from DB_DIALECT at load time; a Postgres run on the SQLite
  // tables would fail in confusing ways, so say what is missing up front.
  if (process.env.DB_DIALECT !== 'postgres') {
    throw new Error('TEST_DB_DIALECT=postgres also needs DB_DIALECT=postgres');
  }
  const admin = adminUrl();
  const { migrateLockedPg } = await import('../src/db/client');
  const template = `opportun_tpl_${randomBytes(4).toString('hex')}`;
  await adminQuery(
    `CREATE DATABASE "${template}" TEMPLATE template0 LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C' ENCODING 'UTF8'`,
    admin,
  );
  const pool = new pg.Pool({ connectionString: urlFor(template, admin), max: 1 });
  try {
    await migrateLockedPg(pool);
  } catch (err) {
    await pool.end();
    await adminQuery(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`, admin);
    throw new Error(`migrating the template database ${template}: ${String(err)}`, { cause: err });
  }
  // No connection may stay open on a template while it is cloned.
  await pool.end();
  console.log(`postgres test template: ${template} (${new URL(admin).host})`);
  project.provide('pgTemplate', template);
  return async () => {
    if (process.env.PG_KEEP_DATABASES === '1') return;
    await adminQuery(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`, admin);
  };
}
