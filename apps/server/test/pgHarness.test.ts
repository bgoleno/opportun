// The test harness itself (test/helpers.ts testApp, test/pgHarness.ts): an app that fails to
// start must not leak its database copy or pool (review fix 6).
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { testDialect } from './db';
import { captureLogs, testApp } from './helpers';
import { adminUrl, databasesOfCurrentTest } from './pgHarness';

describe('testApp', () => {
  it('closes an app whose setup throws, dropping its Postgres database copy', async () => {
    await expect(
      testApp(
        {},
        {
          setup: () => {
            throw new Error('setup failed on purpose');
          },
        },
      ),
    ).rejects.toThrow('setup failed on purpose');
    if (testDialect !== 'postgres') return;
    const name = databasesOfCurrentTest.at(-1);
    expect(name).toMatch(/^opportun_t_pgharness_/);
    const client = new pg.Client({ connectionString: adminUrl() });
    await client.connect();
    try {
      const left = await client.query('SELECT datname FROM pg_database WHERE datname = $1', [name]);
      // PG_KEEP_DATABASES=1 keeps it on purpose (inspection after a failure).
      expect(left.rows).toHaveLength(process.env.PG_KEEP_DATABASES === '1' ? 1 : 0);
    } finally {
      await client.end();
    }
  });

  it('closes the pool before dropping the database copy, terminating no live backend', async () => {
    const logs = captureLogs();
    const { app } = await testApp({ logLevel: 'error' }, { logStream: logs });

    await app.close();

    if (testDialect !== 'postgres') return;
    // DROP DATABASE ... WITH (FORCE) terminates whatever is still connected. A pool
    // connection killed that way reaches the app as an idle-connection error, and a
    // connection checked out mid-query rejects with nobody left to catch it, which is how
    // this reached CI: an uncaught 57P01 and a close that hung for the hook's full 30s.
    expect(logs.text()).not.toContain('postgres idle connection error');
  });
});
