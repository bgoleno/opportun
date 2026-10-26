// Lockstep parity of the two migration chains (ADR-4, iteration 4 Task 8).
//
// drizzle/ (SQLite) and drizzle-pg/ (Postgres, from 0000_baseline at the SQLite head of
// iteration 4) must describe the same schema at every head. Offline (every run):
//   - the journals pair up: each SQLite migration after the baseline has a Postgres twin
//     with the same name and the same `when`, and the other way round;
//   - the baseline file is pinned (it is generated once and never regenerated);
//   - the baseline's seed rows equal what the SQLite chain seeds at the baseline head;
//   - the schema the SQLite chain builds equals the newest Postgres snapshot's (tables,
//     columns, nullability, defaults, primary keys, FKs, index names, uniqueness, partial
//     predicates).
// Live (TEST_DATABASE_URL set, Task 13's matrix): the Postgres chain applied to a scratch
// database builds that same schema, and its seeded rows match SQLite's.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  migrateLocked,
  migrateLockedPg,
  MIGRATIONS_DIR,
  MIGRATIONS_PG_DIR,
  openDatabase,
  type Sqlite,
} from '../src/db/client';
import Database from 'better-sqlite3';
import { BASELINE_FILE, readJournal, SEED_MARKER, seedStatements } from '../scripts/pgBaseline';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as pgSchema from '../src/db/schema.pg';
import { TABLE_EXPORTS } from '../src/db/schema.shared';
import { pgLiveModel, pgSnapshotModel, sqliteModel } from './schemaModel';
import { livePgUrl, withScratchDatabase } from './pgScratch';
import { sqliteOnly } from './db';

/** sha256 of drizzle-pg/0000_baseline.sql as committed. Never update it: add a migration. */
const BASELINE_SHA256 = 'aa690f4e8aa4dbe4f55a54d1560eebbeca3c7044ff6607a3aa3800e614531717';

/**
 * Postgres-only migrations allowed to have no SQLite twin, each with its reason, keyed by the
 * exact journal tag and `when` (`<tag>@<when>`), so a later one-sided migration that happens
 * to reuse a name cannot ride an existing entry.
 */
const PG_ONLY: Record<string, string> = {
  '0001_search@1792275584719':
    'Task 11: the tsvector search_index (SQLite keeps its FTS5 table from 0001_fts); not modeled by drizzle on either engine',
};
/** SQLite-only migrations after the baseline, each with its reason (`<tag>@<when>`). */
const SQLITE_ONLY: Record<string, string> = {};

const sqliteJournal = readJournal(join(MIGRATIONS_DIR, 'meta', '_journal.json'));
const pgJournal = readJournal(join(MIGRATIONS_PG_DIR, 'meta', '_journal.json'));
const baseline = pgJournal.entries[0];

/** A migration's name without its number: the pairing key with the `when`. */
const nameOf = (tag: string) => tag.replace(/^\d+_/, '');

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A SQLite database migrated up to and including the journal entry with `when` <= `upTo`. */
async function sqliteAt(upTo: number): Promise<Sqlite> {
  const dir = await mkdtemp(join(tmpdir(), 'opportun-parity-'));
  dirs.push(dir);
  const folder = join(dir, 'drizzle');
  await mkdir(join(folder, 'meta'), { recursive: true });
  const entries = sqliteJournal.entries.filter((e) => e.when <= upTo);
  for (const e of entries)
    await copyFile(join(MIGRATIONS_DIR, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
  await writeFile(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...sqliteJournal, entries }),
  );
  const sqlite = new Database(join(dir, 'opportun.db'));
  sqlite.pragma('foreign_keys = ON');
  migrateLocked(sqlite, folder);
  return sqlite;
}

type Entry = { tag: string; when: number };

/**
 * Migrations without a twin on the other chain (pairs share name and `when`) and not on
 * that side's allowlist (exact `<tag>@<when>`), as `sqlite:<tag>@<when>` / `pg:<tag>@<when>`.
 */
function unpaired(
  lite: Entry[],
  pg: Entry[],
  pgOnly: Record<string, string>,
  sqliteOnly: Record<string, string>,
): string[] {
  const pair = (e: Entry) => `${nameOf(e.tag)}@${e.when}`;
  const exact = (e: Entry) => `${e.tag}@${e.when}`;
  const litePairs = new Set(lite.map(pair));
  const pgPairs = new Set(pg.map(pair));
  return [
    ...pg
      .filter((e) => !litePairs.has(pair(e)) && pgOnly[exact(e)] === undefined)
      .map((e) => `pg:${exact(e)}`),
    ...lite
      .filter((e) => !pgPairs.has(pair(e)) && sqliteOnly[exact(e)] === undefined)
      .map((e) => `sqlite:${exact(e)}`),
  ];
}

describe('migration chains in lockstep', () => {
  it('an allowlist entry covers exactly one migration, by tag and `when`', () => {
    const allow = { '0001_search@100': 'reason' };
    expect(unpaired([], [{ tag: '0001_search', when: 100 }], allow, {})).toEqual([]);
    // A later one-sided migration reusing the name, or the same tag at another `when`.
    expect(unpaired([], [{ tag: '0007_search', when: 200 }], allow, {})).toEqual([
      'pg:0007_search@200',
    ]);
    expect(unpaired([], [{ tag: '0001_search', when: 101 }], allow, {})).toEqual([
      'pg:0001_search@101',
    ]);
    // A pair needs no entry; a lone SQLite migration does.
    const both = [{ tag: '0020_x', when: 300 }];
    expect(
      unpaired([{ tag: '0020_x', when: 300 }], [{ tag: '0002_x', when: 300 }], {}, {}),
    ).toEqual([]);
    expect(unpaired(both, [], {}, {})).toEqual(['sqlite:0020_x@300']);
  });

  it('the Postgres chain starts with the baseline at a SQLite head', () => {
    expect(baseline?.tag).toBe('0000_baseline');
    expect(sqliteJournal.entries.map((e) => e.when)).toContain(baseline?.when);
  });

  it('pairs every migration after the baseline by name and journal `when`', () => {
    const after = (e: { when: number }) => e.when > (baseline?.when ?? Infinity);
    expect(
      unpaired(
        sqliteJournal.entries.filter(after),
        pgJournal.entries.slice(1),
        PG_ONLY,
        SQLITE_ONLY,
      ),
    ).toEqual([]);
    // Same order on both sides, strictly increasing (the migrators apply by `when`).
    const whens = pgJournal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(whens).size).toBe(whens.length);
  });

  it('every Postgres journal entry has its SQL file and snapshot', async () => {
    const files = await readdir(MIGRATIONS_PG_DIR);
    const snapshots = await readdir(join(MIGRATIONS_PG_DIR, 'meta'));
    for (const e of pgJournal.entries) {
      expect(files).toContain(`${e.tag}.sql`);
      expect(snapshots).toContain(`${e.tag.slice(0, 4)}_snapshot.json`);
    }
  });

  it('pins the baseline (generated once, never regenerated)', async () => {
    const text = await readFile(BASELINE_FILE);
    expect(createHash('sha256').update(text).digest('hex')).toBe(BASELINE_SHA256);
  });

  it.runIf(sqliteOnly)('seeds the rows the SQLite chain seeds at the baseline head', async () => {
    const sqlite = await sqliteAt(baseline?.when ?? 0);
    try {
      const text = await readFile(BASELINE_FILE, 'utf8');
      const seeds = text
        .slice(text.indexOf(SEED_MARKER) + SEED_MARKER.length)
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      expect(seeds.length).toBeGreaterThan(0);
      expect(seeds).toEqual(seedStatements(sqlite));
    } finally {
      sqlite.close();
    }
  });

  it.runIf(sqliteOnly)('the SQLite head schema equals the newest Postgres snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opportun-parity-'));
    dirs.push(dir);
    const handle = openDatabase(dir);
    try {
      const newest = pgJournal.entries.at(-1);
      const snapshot = JSON.parse(
        await readFile(
          join(MIGRATIONS_PG_DIR, 'meta', `${newest?.tag.slice(0, 4)}_snapshot.json`),
          'utf8',
        ),
      ) as Parameters<typeof pgSnapshotModel>[0];
      const lite = sqliteModel(handle.sqlite);
      const pg = pgSnapshotModel(snapshot);
      expect(Object.keys(pg).sort()).toEqual(Object.keys(lite).sort());
      for (const table of Object.keys(lite)) expect(pg[table], table).toEqual(lite[table]);
    } finally {
      await closeDatabase(handle);
    }
  });
});

/** Every schema table's rows, ordered by primary key, values decoded by the twin's column type. */
async function canonicalRows(
  read: (table: string, orderBy: string) => Promise<Record<string, unknown>[]>,
): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const name of TABLE_EXPORTS) {
    const cfg = getTableConfig(pgSchema[name] as PgTable);
    const pk = [
      ...cfg.columns.filter((c) => c.primary).map((c) => c.name),
      ...cfg.primaryKeys.flatMap((k) => k.columns.map((c) => c.name)),
    ];
    const rows = await read(cfg.name, pk.map((c) => `"${c}"`).join(', '));
    out[cfg.name] = rows.map((row) =>
      Object.fromEntries(
        cfg.columns.map((c) => {
          const v = row[c.name];
          if (v === null || v === undefined) return [c.name, null];
          switch (c.columnType) {
            case 'PgBoolean':
              return [c.name, v === true || v === 1];
            case 'PgBigInt53':
            case 'PgDoublePrecision':
              return [c.name, Number(v)];
            case 'PgJsonb':
              return [c.name, typeof v === 'string' ? (JSON.parse(v) as unknown) : v];
            default:
              return [c.name, v];
          }
        }),
      ),
    );
  }
  return out;
}

describe.runIf(livePgUrl !== undefined)('migration chains in lockstep (live Postgres)', () => {
  it('the Postgres chain builds the SQLite head schema and seeds the same rows', async () => {
    await withScratchDatabase(async (url) => {
      const pool = new pg.Pool({ connectionString: url });
      // The SQLite chain on a raw connection: openDatabase refuses to open SQLite on the
      // Postgres leg (DB_DIALECT=postgres), where this test is required.
      const sqlite = await sqliteAt(Infinity);
      try {
        await migrateLockedPg(pool);
        const lite = sqliteModel(sqlite);
        const live = await pgLiveModel(pool);
        expect(Object.keys(live).sort()).toEqual(Object.keys(lite).sort());
        for (const table of Object.keys(lite)) expect(live[table], table).toEqual(lite[table]);
        const liteRows = await canonicalRows(
          async (t, order) =>
            sqlite.prepare(`SELECT * FROM "${t}" ORDER BY ${order}`).all() as Record<
              string,
              unknown
            >[],
        );
        const pgRows = await canonicalRows(
          async (t, order) => (await pool.query(`SELECT * FROM "${t}" ORDER BY ${order}`)).rows,
        );
        expect(pgRows).toEqual(liteRows);
      } finally {
        sqlite.close();
        await pool.end();
      }
    });
  });
});
