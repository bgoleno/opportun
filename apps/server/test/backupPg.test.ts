// Backups on Postgres (FR-I4, iteration 4 Task 12): the same job, schedule, retention and
// manifest as SQLite, with a pg_dump custom-format snapshot (opportun-YYYYMMDD-HHmm.dump).
//
// Always: how pg_dump is invoked (the connection travels in libpq environment variables,
// never in argv) and how both snapshot kinds are named, listed and pruned.
// Postgres leg only: a real dump restored into a fresh database by the documented steps
// (docs/install.md section 6), then migrated (a no-op), compared table by table, and read
// back through the app, vault secret included. That one test needs pg_dump and pg_restore
// 16 on PATH; it checks for them itself and fails with an actionable message naming the
// missing tool, rather than a bare spawn error, when they are not there (issue #180).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readRrConfig, writeRrConfig } from '../src/adapters/reactiveResume';
import { PostgresConfig } from '../src/config';
import {
  closeDatabase,
  connectDatabase,
  libpqEnvFor,
  migrateLockedPg,
  pgClientEnv,
} from '../src/db/client';
import * as pgSchema from '../src/db/schema.pg';
import { TABLE_EXPORTS } from '../src/db/schema.shared';
import {
  BACKUP_RETENTION,
  listBackups,
  pgDumpInvocation,
  pruneBackups,
  runBackup,
  snapshotName,
  verifySnapshot,
} from '../src/jobs/backup';
import { bindVaultKey } from '../src/lib/secretBox';
import { createStorage } from '../src/lib/storage';
import { search } from '../src/repos/search';
import { useApi } from './api';
import { testDialect } from './db';
import { testApp } from './helpers';
import { registerTwoUsers } from './isolation';
import { createScratchDatabase } from './pgScratch';

describe('pg_dump invocation', () => {
  it('passes the connection in libpq variables, never on the command line', () => {
    const env = libpqEnvFor(
      'postgres://opp%40user:s3cr%3At@db.internal:6543/opportun?application_name=x',
      'require',
    );
    expect(env).toEqual({
      PGHOST: 'db.internal',
      PGPORT: '6543',
      PGUSER: 'opp@user',
      PGPASSWORD: 's3cr:t',
      PGDATABASE: 'opportun',
      PGSSLMODE: 'require',
      PGAPPNAME: 'opportun-backup',
      PGCONNECT_TIMEOUT: '10',
    });
    const run = pgDumpInvocation(env, '/data/backups/.tmp-1.dump', { PATH: '/usr/bin' });
    expect(run.command).toBe('pg_dump');
    expect(run.args).toEqual([
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--file=/data/backups/.tmp-1.dump',
    ]);
    expect(run.args.join(' ')).not.toMatch(/s3cr|opp@user|db\.internal|opportun\b/);
    // Only PATH and the libpq variables: no master key, DATABASE_URL or other app secret.
    expect(run.env).toEqual({ PATH: '/usr/bin', ...env });
  });

  it('maps socket hosts, IPv6, defaults and the TLS modes', () => {
    expect(libpqEnvFor('postgres://u@/opportun?host=/var/run/postgresql', 'disable')).toMatchObject(
      { PGHOST: '/var/run/postgresql', PGUSER: 'u', PGDATABASE: 'opportun', PGSSLMODE: 'disable' },
    );
    const v6 = libpqEnvFor('postgresql://u:p@[::1]/d', 'disable');
    expect(v6.PGHOST).toBe('::1');
    expect(v6.PGPORT).toBeUndefined();
    // verify-full: libpq checks the chain and host; the system trust store unless a CA is named.
    expect(libpqEnvFor('postgres://u:p@h/d', 'verify-full', {})).toMatchObject({
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: 'system',
    });
    expect(
      libpqEnvFor('postgres://u:p@h/d', 'verify-full', { NODE_EXTRA_CA_CERTS: '/ca.pem' }),
    ).toMatchObject({ PGSSLROOTCERT: '/ca.pem' });
    expect(libpqEnvFor('postgres://u:p@h/d?sslrootcert=/x.pem', 'verify-full', {})).toMatchObject({
      PGSSLROOTCERT: '/x.pem',
    });
  });
});

/**
 * Issue #180: the live Postgres leg below needs `pg_dump` and `pg_restore` on `PATH`, a
 * precondition this file's own header already stated but never checked. Without this, a
 * machine missing the client tools gets a `pg_dump` ENOENT buried inside the test body,
 * which reads as "backups are broken" rather than "a tool is missing" -- exactly the kind of
 * degradation design principle 6 rules out. CI always has `postgresql-client-16` (ci.yml), so
 * this never fires there; it only ever fires for a developer missing the documented
 * precondition, and tells them so instead of making them guess.
 */
function requirePgClientTool(
  tool: 'pg_dump' | 'pg_restore',
  env: Record<string, string | undefined> = process.env,
): void {
  const probe = spawnSync(tool, ['--version'], { env });
  if (probe.error !== undefined) {
    throw new Error(
      `${tool} is required on PATH to run this test, and is not installed (or not on PATH): ` +
        `${probe.error.message}. This is a missing precondition, not a backup regression -- ` +
        'install the Postgres 16 client tools (the Debian/Ubuntu package is ' +
        'postgresql-client-16; see docs/install.md\'s "Backup on Postgres" section and ' +
        'CONTRIBUTING.md\'s "Running the server tests on Postgres" section) and re-run.',
    );
  }
}

describe('the pg_dump/pg_restore precondition check (#180)', () => {
  it('fails with a message naming the missing tool, not a bare spawn error', () => {
    // A literal env object, not a mutation of the real process.env.PATH (issue #292): vitest's
    // threads pool shares process.env with every test file scheduled onto the same worker.
    expect(() => requirePgClientTool('pg_dump', { PATH: '/nonexistent' })).toThrow(
      /pg_dump is required on PATH.*postgresql-client-16/s,
    );
  });
});

describe('snapshot names on both engines', () => {
  it('names a Postgres snapshot .dump and lists and prunes both kinds together', async () => {
    const now = Date.UTC(2026, 9, 15, 3, 0);
    expect(snapshotName(now)).toBe('opportun-20261015-0300.db');
    expect(snapshotName(now, 'dump')).toBe('opportun-20261015-0300.dump');
    const dir = await mkdtemp(join(tmpdir(), 'opportun-backupnames-'));
    try {
      const storage = createStorage(dir, dir);
      await mkdir(join(dir, 'backups'));
      const names: string[] = [];
      for (let i = 0; i < BACKUP_RETENTION + 2; i++) {
        const name = snapshotName(now + i * 60_000, i % 2 === 0 ? 'db' : 'dump');
        names.push(name);
        await writeFile(join(dir, 'backups', name), 'x');
        await writeFile(
          join(dir, 'backups', name.replace(/\.(db|dump)$/, '.attachments.json')),
          '{}',
        );
        const t = new Date(now + i * 60_000);
        await utimes(join(dir, 'backups', name), t, t);
      }
      expect((await listBackups(storage)).map((b) => b.name)).toEqual([...names].reverse());
      expect(await pruneBackups(storage)).toEqual([names[1], names[0]]);
      const left = (await listBackups(storage)).map((b) => b.name);
      expect(left).toHaveLength(BACKUP_RETENTION);
      expect(left.some((n) => n.endsWith('.dump'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const boot = useApi();

const keyed: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(keyed.splice(0).map((app) => app.close()));
});

async function useApiWithKey(masterKey: Buffer) {
  const { app, dataDir } = await testApp({ masterKey });
  keyed.push(app);
  const { a, b } = await registerTwoUsers(app);
  return { app, dataDir, a, b };
}

/** The URL the app's pool uses (test databases only). */
function urlOfApp(app: FastifyInstance): string {
  const env = pgClientEnv(app.db);
  if (env === undefined) throw new Error('not a Postgres app');
  const url = new URL('postgres://localhost/');
  url.hostname = env.PGHOST ?? 'localhost';
  if (env.PGPORT !== undefined) url.port = env.PGPORT;
  url.username = encodeURIComponent(env.PGUSER ?? '');
  url.password = encodeURIComponent(env.PGPASSWORD ?? '');
  url.pathname = `/${env.PGDATABASE ?? ''}`;
  return url.toString();
}

/** Runs a client tool with the connection in its environment; rejects with its stderr. */
function runTool(command: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`)),
    );
  });
}

/** Rows of every schema table and of search_index, ordered, as JSON per table. */
async function snapshotRows(pool: pg.Pool): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of TABLE_EXPORTS) {
    const table = getTableConfig(pgSchema[name] as PgTable).name;
    const rows = await pool.query(`SELECT * FROM "${table}" ORDER BY 1`);
    out[table] = JSON.stringify(rows.rows);
  }
  const index = await pool.query(
    'SELECT entity_kind, entity_id, user_id, text, tsv::text AS tsv FROM search_index ORDER BY 1, 2, 3',
  );
  out.search_index = JSON.stringify(index.rows);
  return out;
}

describe.runIf(testDialect === 'postgres')('backups on Postgres', () => {
  // Scoped to just this test (issue #180): the other test in this describe forces
  // PATH=/nonexistent itself to simulate pg_dump being unreachable, so it already behaves the
  // same with or without the real tools installed and must not be gated on them.
  describe('a real pg_dump/pg_restore round trip', () => {
    beforeAll(() => {
      requirePgClientTool('pg_dump');
      requirePgClientTool('pg_restore');
    });

    it('writes a pg_dump snapshot that restores, by the documented steps, into a fresh database', async () => {
      const masterKey = randomBytes(32);
      const { app, a, dataDir } = await useApiWithKey(masterKey);
      const ctx = { userId: a.userId, isAdmin: false };
      const opp = await a.request({
        method: 'POST',
        url: '/api/v1/opportunities',
        payload: {
          companyName: 'Acme',
          title: 'Staff Engineer',
          descriptionMd: 'Café observability',
          sourceKind: 'manual',
        },
      });
      expect(opp.statusCode).toBe(201);
      await writeRrConfig(app.db, ctx, 'https://rr.example.org', 'vault-key-123');

      const now = Date.UTC(2026, 9, 15, 3, 0);
      const result = await runBackup(app.db, app.storage, now);
      expect(result.file).toBe('opportun-20261015-0300.dump');
      expect(result.bytes).toBeGreaterThan(0);
      // pg_restore --list confirms the archive is well-formed (issue #170); it does not read
      // the row data pg_dump wrote, unlike SQLite's integrity_check (backup.test.ts).
      expect(result.verified).toEqual({ ok: true, checkedAt: now, detail: null });
      const dump = join(dataDir, 'backups', result.file);
      expect((await readFile(dump)).subarray(0, 5).toString()).toBe('PGDMP');
      const manifest = JSON.parse(
        await readFile(join(dataDir, 'backups', 'opportun-20261015-0300.attachments.json'), 'utf8'),
      );
      expect(manifest.snapshot).toBe(result.file);

      // The documented restore: a fresh C-collated database, pg_restore in one transaction.
      const target = await createScratchDatabase();
      const sourcePool = new pg.Pool({ connectionString: urlOfApp(app) });
      const restoredPool = new pg.Pool({ connectionString: target.url });
      try {
        // pg_restore needs --dbname (PGDATABASE alone is not used); a bare name carries no secret.
        const targetEnv = libpqEnvFor(target.url, 'disable');
        await runTool(
          'pg_restore',
          [
            '--no-owner',
            '--no-privileges',
            '--single-transaction',
            '--exit-on-error',
            `--dbname=${targetEnv.PGDATABASE ?? ''}`,
            dump,
          ],
          targetEnv,
        );
        const before = await restoredPool.query(
          'SELECT count(*)::int AS n FROM "__drizzle_migrations"',
        );
        await migrateLockedPg(restoredPool);
        const after = await restoredPool.query(
          'SELECT count(*)::int AS n FROM "__drizzle_migrations"',
        );
        expect(after.rows[0].n).toBe(before.rows[0].n);
        expect(await snapshotRows(restoredPool)).toEqual(await snapshotRows(sourcePool));

        // The app on the restored database: search works and the vault secret decrypts.
        const restored = await connectDatabase({
          dataDir,
          db: new PostgresConfig(target.url, 2, 'disable'),
        });
        try {
          bindVaultKey(restored.db, masterKey);
          expect(await readRrConfig(restored.db, ctx)).toEqual({
            baseUrl: 'https://rr.example.org',
            apiKey: 'vault-key-123',
          });
          const hits = await search(restored.db, ctx, 'cafe', { limit: 10, offset: 0 });
          expect(hits.items.map((h) => h.entityId)).toEqual([opp.json().id]);
        } finally {
          await closeDatabase(restored);
        }
      } finally {
        await sourcePool.end();
        await restoredPool.end();
        await target.drop();
      }
    });
  });

  it('fails the job with pg_dump stderr, and leaves no partial snapshot, when the dump fails', async () => {
    const { app, dataDir } = await boot();
    // A literal env object for this one call, not a mutation of the real process.env.PATH
    // (issue #292): vitest's threads pool shares process.env with every test file scheduled
    // onto the same worker. verify is passed explicitly (its own real default) only because
    // pgDumpEnv is the parameter after it.
    await expect(
      runBackup(app.db, app.storage, Date.UTC(2026, 9, 16, 3, 0), verifySnapshot, {
        PATH: '/nonexistent',
      }),
    ).rejects.toThrow(/pg_dump/);
    expect(await listBackups(app.storage)).toEqual([]);
    expect((await readdir(join(dataDir, 'backups'))).filter((f) => f.startsWith('.tmp'))).toEqual(
      [],
    );
  });
});
