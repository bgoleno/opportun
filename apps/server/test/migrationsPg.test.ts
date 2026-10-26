// The Postgres migrator (iteration 4 Task 8): migrateLockedPg takes a session advisory lock
// around read-decide-apply in one transaction, keeps drizzle's bookkeeping shape, and refuses
// a database migrated by a newer release, like migrateLocked on SQLite.
//
// Recorded fake (always): the statements, their connection and their order. Live
// (TEST_DATABASE_URL, Task 13's matrix): the same properties against postgres:16.
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { MIGRATION_LOCK_KEY, MIGRATIONS_PG_DIR, migrateLockedPg } from '../src/db/client';
import { FakePgPool, pgError } from './fakePg';
import { livePgUrl, withScratchDatabase } from './pgScratch';

const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_PG_DIR });
const head = Math.max(...migrations.map((m) => m.folderMillis));
/** Every migration's `when`, in order: what a fresh database records. */
const allWhens = migrations.map((m) => m.folderMillis);
const baselineStatements = migrations[0]?.sql.filter((s) => s.trim() !== '') ?? [];

/** A fake server holding drizzle's bookkeeping table, committed per transaction. */
function migratingPool(opts: { lastApplied?: number; failOn?: RegExp } = {}) {
  const committed: number[] = opts.lastApplied === undefined ? [] : [opts.lastApplied];
  const pending = new Map<number, number[]>();
  const pool = new FakePgPool((q) => {
    const text = q.text.trim();
    if (opts.failOn?.test(text)) return pgError('42601', 'syntax error at or near "boom"');
    if (/^SELECT created_at FROM "__drizzle_migrations"/i.test(text)) {
      // bigint arrives as a string from a driver without the int8 parser: the migrator
      // must not depend on it.
      return {
        rows: committed.length === 0 ? [] : [{ created_at: String(Math.max(...committed)) }],
      };
    }
    if (/^INSERT INTO "__drizzle_migrations"/i.test(text)) {
      pending.set(q.client, [...(pending.get(q.client) ?? []), Number(q.params[1])]);
    }
    if (/^COMMIT/i.test(text)) {
      committed.push(...(pending.get(q.client) ?? []));
      pending.delete(q.client);
    }
    if (/^ROLLBACK/i.test(text)) pending.delete(q.client);
    return undefined;
  });
  return { pool, committed, asPool: pool as unknown as pg.Pool };
}

describe('migrateLockedPg (recorded fake)', () => {
  it('applies the baseline once, under a session lock, in one transaction', async () => {
    const { pool, committed, asPool } = migratingPool();
    await migrateLockedPg(asPool);
    expect(committed).toEqual(allWhens);
    const texts = pool.textsOf(1);
    const at = (re: RegExp) => texts.findIndex((t) => re.test(t));
    const lock = at(/^SELECT pg_advisory_lock\(\$1\)/);
    const begin = at(/^BEGIN/);
    const read = at(/^SELECT created_at FROM "__drizzle_migrations"/);
    const firstDdl = texts.indexOf(baselineStatements[0] ?? '');
    const record = at(/^INSERT INTO "__drizzle_migrations"/);
    const commit = at(/^COMMIT/);
    const unlock = at(/^SELECT pg_advisory_unlock\(\$1\)/);
    expect(at(/^SET statement_timeout = 120000$/)).toBe(0);
    expect([lock, begin, read, firstDdl, record, commit, unlock].every((i) => i >= 0)).toBe(true);
    expect(lock).toBeLessThan(begin);
    expect(begin).toBeLessThan(read);
    expect(read).toBeLessThan(firstDdl);
    expect(firstDdl).toBeLessThan(record);
    expect(record).toBeLessThan(commit);
    expect(commit).toBeLessThan(unlock);
    expect(texts.at(-1)).toBe('RESET statement_timeout');
    // Every baseline statement ran, in order, on the locked connection; nothing on others.
    expect(texts.filter((t) => baselineStatements.includes(t))).toEqual(baselineStatements);
    expect(pool.log.every((q) => q.client === 1)).toBe(true);
    const lockQuery = pool.log.find((q) => /pg_advisory_lock/.test(q.text));
    expect(lockQuery?.params).toEqual([MIGRATION_LOCK_KEY]);
    const recordQuery = pool.log.find((q) => /^INSERT INTO "__drizzle_migrations"/.test(q.text));
    expect(recordQuery?.params).toEqual([migrations[0]?.hash, migrations[0]?.folderMillis]);
    expect(pool.clients[0]?.released).toBe(true);
    expect(pool.leaks).toEqual([]);
  });

  it('the lock key cannot collide with a hashtext() scope lock', () => {
    // hashtext() is int4: scope locks (lockScope) live in [-2^31, 2^31).
    expect(BigInt(MIGRATION_LOCK_KEY) > 2n ** 31n).toBe(true);
    expect(BigInt(MIGRATION_LOCK_KEY) < 2n ** 63n).toBe(true);
  });

  it('two concurrent boots apply the baseline once', async () => {
    const { pool, committed, asPool } = migratingPool();
    await Promise.all([migrateLockedPg(asPool), migrateLockedPg(asPool)]);
    expect(committed).toEqual(allWhens);
    const firstDdl = baselineStatements[0];
    expect(pool.log.filter((q) => q.text === firstDdl)).toHaveLength(1);
    expect(pool.clients.every((c) => c.released && !c.inTransaction)).toBe(true);
  });

  it('an up-to-date database applies nothing', async () => {
    const { pool, committed, asPool } = migratingPool({ lastApplied: head });
    await migrateLockedPg(asPool);
    expect(committed).toEqual([head]);
    expect(pool.log.some((q) => q.text === baselineStatements[0])).toBe(false);
  });

  it('refuses a database migrated by a newer release, leaving it untouched', async () => {
    const { pool, committed, asPool } = migratingPool({ lastApplied: head + 1 });
    await expect(migrateLockedPg(asPool)).rejects.toThrow(/newer release of Opportun/);
    expect(committed).toEqual([head + 1]);
    const texts = pool.textsOf(1);
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
    expect(texts.some((t) => /pg_advisory_unlock/.test(t))).toBe(true);
    expect(pool.clients[0]?.released).toBe(true);
  });

  it('a migration that throws leaves no bookkeeping row and surfaces the driver error', async () => {
    const failing = (baselineStatements[3] ?? '').trim();
    const { pool, committed, asPool } = migratingPool({
      failOn: new RegExp(`^${failing.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    });
    const err = await migrateLockedPg(asPool).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    expect(err?.code).toBe('42601');
    expect(committed).toEqual([]);
    const texts = pool.textsOf(1);
    expect(texts).toContain('ROLLBACK');
    expect(texts.some((t) => /^INSERT INTO "__drizzle_migrations"/.test(t))).toBe(false);
    expect(texts.some((t) => /pg_advisory_unlock/.test(t))).toBe(true);
    expect(pool.clients[0]?.released).toBe(true);
  });

  it('migrates from the folder it is given (the next pair lands the same way)', async () => {
    const folder = join(MIGRATIONS_PG_DIR);
    const { committed, asPool } = migratingPool();
    await migrateLockedPg(asPool, folder);
    expect(committed).toEqual(allWhens);
  });
});

describe.runIf(livePgUrl !== undefined)('migrateLockedPg (live Postgres)', () => {
  it('two concurrent boots against one empty database apply the baseline once', async () => {
    await withScratchDatabase(async (url) => {
      const pools = [
        new pg.Pool({ connectionString: url }),
        new pg.Pool({ connectionString: url }),
      ];
      try {
        await Promise.all(pools.map((p) => migrateLockedPg(p)));
        const rows = await pools[0]!.query('SELECT hash, created_at FROM "__drizzle_migrations"');
        expect(rows.rows).toHaveLength(migrations.length);
        expect(Number(rows.rows[0].created_at)).toBe(migrations[0]?.folderMillis);
        const prompts = await pools[0]!.query('SELECT count(*) AS n FROM prompts');
        expect(Number(prompts.rows[0].n)).toBeGreaterThan(0);
      } finally {
        await Promise.all(pools.map((p) => p.end()));
      }
    });
  });

  it('refuses a database with a migration beyond the newest known', async () => {
    await withScratchDatabase(async (url) => {
      const pool = new pg.Pool({ connectionString: url });
      try {
        await migrateLockedPg(pool);
        await pool.query('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)', [
          'future',
          head + 1,
        ]);
        await expect(migrateLockedPg(pool)).rejects.toThrow(/newer release/);
      } finally {
        await pool.end();
      }
    });
  });

  it('a migration that throws leaves no bookkeeping row', async () => {
    await withScratchDatabase(async (url) => {
      const pool = new pg.Pool({ connectionString: url });
      try {
        const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const dir = await mkdtemp(join(tmpdir(), 'opportun-badpg-'));
        await mkdir(join(dir, 'meta'));
        await writeFile(
          join(dir, '0000_bad.sql'),
          'CREATE TABLE ok_table (id int);\n--> statement-breakpoint\nTHIS IS NOT SQL;',
        );
        await writeFile(
          join(dir, 'meta', '_journal.json'),
          JSON.stringify({
            version: '7',
            dialect: 'postgresql',
            entries: [{ idx: 0, version: '7', when: 1, tag: '0000_bad', breakpoints: true }],
          }),
        );
        await expect(migrateLockedPg(pool, dir)).rejects.toThrow();
        const rows = await pool.query(
          `SELECT to_regclass('public.__drizzle_migrations') AS bookkeeping, to_regclass('public.ok_table') AS ok`,
        );
        // The whole read-decide-apply transaction rolled back, bookkeeping table included.
        expect(rows.rows[0]).toEqual({ bookkeeping: null, ok: null });
      } finally {
        await pool.end();
      }
    });
  });
});
