// restorePostgres (issue #142): the Postgres leg of restore.test.ts. Argument and snapshot-name
// checks that need no live server run always; everything that needs a real pg_dump/pg_restore/
// createdb and a live Postgres server (postgresInUse, verifyPgDump, the restore itself) runs
// only when one is available via TEST_DATABASE_URL, the same gate test/pgScratch.ts's own live
// tests use (independent of the TEST_DB_DIALECT matrix leg: restorePostgres never goes through
// drizzle's schema, so it needs no SCHEMA_DIALECT=postgres build).
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresConfig } from '../src/config';
import { libpqEnvFor } from '../src/db/client';
import { formatRestoreReport, RestoreRefused, restorePostgres } from '../src/lib/restore';
import { createStorage, type Storage } from '../src/lib/storage';
import { createScratchDatabase, livePgUrl } from './pgScratch';

let base: string;
let dataDir: string;
let storage: Storage;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'opportun-restorepg-')));
  dataDir = join(base, 'data');
  storage = createStorage(dataDir, dataDir);
  await mkdir(join(dataDir, 'backups'), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const DUMMY_TARGET = new PostgresConfig('postgres://u:p@localhost/does-not-matter', 2, 'disable');

describe('restorePostgres (argument checks, no live server needed)', () => {
  it('refuses a name this app’s own backup job did not produce, before touching any database', async () => {
    await writeFile(join(dataDir, 'backups', 'manual-pre-upgrade-20261021-0655.dump'), 'x');
    await expect(
      restorePostgres({
        storage,
        snapshot: 'manual-pre-upgrade-20261021-0655.dump',
        target: DUMMY_TARGET,
      }),
    ).rejects.toThrow(RestoreRefused);
  });

  it('refuses a SQLite-shaped name (.db) on the Postgres path', async () => {
    await writeFile(join(dataDir, 'backups', 'opportun-20261021-0300.db'), 'x');
    await expect(
      restorePostgres({ storage, snapshot: 'opportun-20261021-0300.db', target: DUMMY_TARGET }),
    ).rejects.toThrow(RestoreRefused);
  });

  it('refuses a snapshot that does not exist', async () => {
    await expect(
      restorePostgres({ storage, snapshot: 'opportun-20261021-0300.dump', target: DUMMY_TARGET }),
    ).rejects.toThrow(RestoreRefused);
  });
});

/** A real pg_dump of `url`'s database, written to backups/<name> as a valid custom-format file. */
function dumpTo(url: string, name: string, destDir: string): Promise<void> {
  const env = libpqEnvFor(url, 'disable');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        `--file=${join(destDir, 'backups', name)}`,
      ],
      { env: { ...env, PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`pg_dump exited ${code}: ${stderr}`)),
    );
  });
}

describe.runIf(livePgUrl !== undefined)('restorePostgres (live Postgres)', () => {
  const restoredDbs: string[] = [];

  afterEach(async () => {
    const admin = new pg.Client({ connectionString: livePgUrl });
    await admin.connect();
    try {
      for (const name of restoredDbs.splice(0)) {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    } finally {
      await admin.end();
    }
  });

  it('restores a real pg_dump into a fresh database, preserving the existing one by construction', async () => {
    const scratch = await createScratchDatabase();
    try {
      const target = new PostgresConfig(scratch.url, 2, 'disable');
      const client = new pg.Client({ connectionString: scratch.url });
      await client.connect();
      try {
        await client.query('CREATE TABLE t (x integer)');
        await client.query('INSERT INTO t VALUES (1), (2)');
      } finally {
        await client.end();
      }
      const SNAPSHOT = 'opportun-20261021-0300.dump';
      await dumpTo(scratch.url, SNAPSHOT, dataDir);

      const report = await restorePostgres({ storage, snapshot: SNAPSHOT, target });
      restoredDbs.push(report.restoredTo);

      expect(report.dialect).toBe('postgres');
      expect(report.restoredTo).toMatch(/^opportun_restored_/);
      expect(report.preserved).toContain('never touched');

      const admin = new pg.Client({ connectionString: livePgUrl as string });
      await admin.connect();
      let restoredUrl: string;
      try {
        const row = (
          await admin.query<{ datname: string }>(
            'SELECT datname FROM pg_database WHERE datname = $1',
            [report.restoredTo],
          )
        ).rows[0];
        expect(row).toBeDefined();
        const u = new URL(scratch.url);
        u.pathname = `/${report.restoredTo}`;
        restoredUrl = u.toString();
      } finally {
        await admin.end();
      }
      const restoredClient = new pg.Client({ connectionString: restoredUrl });
      await restoredClient.connect();
      try {
        const rows = (await restoredClient.query('SELECT x FROM t ORDER BY x')).rows;
        expect(rows).toEqual([{ x: 1 }, { x: 2 }]);
      } finally {
        await restoredClient.end();
      }

      // The source database itself was never touched by the restore (preserved by construction).
      const sourceClient = new pg.Client({ connectionString: scratch.url });
      await sourceClient.connect();
      try {
        const rows = (await sourceClient.query('SELECT x FROM t ORDER BY x')).rows;
        expect(rows).toEqual([{ x: 1 }, { x: 2 }]);
      } finally {
        await sourceClient.end();
      }
    } finally {
      await scratch.drop();
    }
  });

  it('refuses while another connection is open against the target database (requirement 1)', async () => {
    const scratch = await createScratchDatabase();
    try {
      const target = new PostgresConfig(scratch.url, 2, 'disable');
      const SNAPSHOT = 'opportun-20261021-0301.dump';
      await dumpTo(scratch.url, SNAPSHOT, dataDir);

      const holder = new pg.Client({ connectionString: scratch.url });
      await holder.connect();
      try {
        await expect(restorePostgres({ storage, snapshot: SNAPSHOT, target })).rejects.toThrow(
          RestoreRefused,
        );
      } finally {
        await holder.end();
      }
      // Once nothing else holds it open, the same restore succeeds.
      const report = await restorePostgres({ storage, snapshot: SNAPSHOT, target });
      restoredDbs.push(report.restoredTo);
    } finally {
      await scratch.drop();
    }
  });

  it('refuses a corrupt dump rather than trust a plausible-looking file (requirement 2)', async () => {
    const scratch = await createScratchDatabase();
    try {
      const target = new PostgresConfig(scratch.url, 2, 'disable');
      const SNAPSHOT = 'opportun-20261021-0302.dump';
      await dumpTo(scratch.url, SNAPSHOT, dataDir);
      const path = join(dataDir, 'backups', SNAPSHOT);
      const bytes = await readFile(path);
      await writeFile(path, bytes.subarray(0, Math.floor(bytes.length / 2)));

      await expect(restorePostgres({ storage, snapshot: SNAPSHOT, target })).rejects.toThrow(
        RestoreRefused,
      );
    } finally {
      await scratch.drop();
    }
  });

  it('reports exactly what was restored and from when (requirement 4)', async () => {
    const scratch = await createScratchDatabase();
    try {
      const target = new PostgresConfig(scratch.url, 2, 'disable');
      const SNAPSHOT = 'opportun-20261021-0303.dump';
      await dumpTo(scratch.url, SNAPSHOT, dataDir);
      const report = await restorePostgres({ storage, snapshot: SNAPSHOT, target });
      restoredDbs.push(report.restoredTo);
      expect(report.snapshot).toBe(SNAPSHOT);
      expect(report.snapshotCompletedAt).toBeGreaterThan(0);
      expect(report.verified.ok).toBe(true);
      const text = formatRestoreReport(report);
      expect(text).toContain(SNAPSHOT);
      expect(text).toContain(report.restoredTo);
      expect(text).toMatch(/restored from/i);
      // issue #205: the honest, weaker guarantee named explicitly, not left to be inferred.
      expect(text).toMatch(/table of contents/i);
    } finally {
      await scratch.drop();
    }
  });
});
