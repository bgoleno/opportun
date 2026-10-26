// Generates the Postgres migration baseline (ADR-4, iteration 4 Task 8). Run ONCE:
//
//   node --import tsx scripts/pgBaseline.ts
//
// 1. drizzle-kit generates drizzle-pg/0000_baseline.sql (DDL) from src/db/schema.pg.ts;
// 2. a fresh SQLite database migrated to the current head supplies every row the SQLite
//    migrations seed (the system prompts), appended to the baseline as INSERTs;
// 3. the journal entry's `when` is set to the SQLite head's, so both engines' bookkeeping
//    tables record the same head.
//
// The result is committed and never regenerated: test/migrationParity.test.ts pins its hash
// and checks its seed rows against a SQLite database migrated to the same head. Later schema
// changes ship as lockstep pairs (drizzle-pg.config.ts).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import { openDatabase, type Sqlite } from '../src/db/client';
import * as pg from '../src/db/schema.pg';
import { TABLE_EXPORTS } from '../src/db/schema.shared';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
export const PG_MIGRATIONS_DIR = join(SERVER_DIR, 'drizzle-pg');
const SQLITE_JOURNAL = join(SERVER_DIR, 'drizzle', 'meta', '_journal.json');
const PG_JOURNAL = join(PG_MIGRATIONS_DIR, 'meta', '_journal.json');
export const BASELINE_FILE = join(PG_MIGRATIONS_DIR, '0000_baseline.sql');

/** Marks where the generated DDL ends and the seed rows begin in the baseline. */
export const SEED_MARKER =
  '-- Seed rows: every row the SQLite migrations seed, at the baseline head.';

const BREAK = '\n--> statement-breakpoint\n';

function quote(text: string): string {
  if (text.includes('\u0000')) throw new Error('Postgres text cannot hold NUL characters');
  return `'${text.replaceAll("'", "''")}'`;
}

/** A SQLite value as a Postgres literal of the twin column's type. */
export function pgLiteral(column: PgColumn, value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  switch (column.columnType) {
    case 'PgText':
      return quote(String(value));
    case 'PgJsonb':
      JSON.parse(String(value)); // strict: an invalid JSON seed aborts generation
      return `${quote(String(value))}::jsonb`;
    case 'PgBoolean':
      if (value === 0 || value === 1) return value === 1 ? 'TRUE' : 'FALSE';
      throw new Error(`${column.name}: boolean must be 0 or 1, got ${String(value)}`);
    case 'PgBigInt53':
      if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
      throw new Error(`${column.name}: not a safe integer: ${String(value)}`);
    case 'PgDoublePrecision':
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      throw new Error(`${column.name}: not a finite number: ${String(value)}`);
    default:
      throw new Error(`${column.name}: no literal encoding for ${column.columnType}`);
  }
}

/**
 * INSERT statements for every row in every schema table of a SQLite database, tables in
 * schema order (parents first) and, within a table, rows without a self-reference first.
 */
export function seedStatements(sqlite: Sqlite): string[] {
  const out: string[] = [];
  for (const name of TABLE_EXPORTS) {
    const cfg = getTableConfig(pg[name] as PgTable);
    // A table added by a migration after the baseline does not exist in a database migrated
    // to the baseline head, and by definition seeds no rows there. Without this, adding any
    // new table to the schema breaks the baseline seed comparison.
    const exists = sqlite
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(cfg.name);
    if (exists === undefined) continue;
    const cols = cfg.columns;
    const selfRefCandidate = cfg.foreignKeys
      .map((fk) => fk.reference())
      .find((ref) => getTableConfig(ref.foreignTable).name === cfg.name)?.columns[0]?.name;
    // A self-reference added by a migration after this database's head is not a column here
    // yet (the same reasoning as the table-existence check above, one level down): there is
    // nothing in it to order by, and querying it by name would fail outright rather than
    // return nothing, since ORDER BY is validated against the table's actual schema.
    const selfRefExists =
      selfRefCandidate !== undefined &&
      (sqlite.pragma(`table_info("${cfg.name}")`) as { name: string }[]).some(
        (c) => c.name === selfRefCandidate,
      );
    const selfRef = selfRefExists ? selfRefCandidate : undefined;
    const order = [selfRef === undefined ? undefined : `"${selfRef}" IS NOT NULL`, 'rowid']
      .filter((x) => x !== undefined)
      .join(', ');
    const rows = sqlite.prepare(`SELECT * FROM "${cfg.name}" ORDER BY ${order}`).all() as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      const names = cols.map((c) => `"${c.name}"`).join(', ');
      const values = cols.map((c) => pgLiteral(c, row[c.name])).join(', ');
      out.push(`INSERT INTO "${cfg.name}" (${names}) VALUES (${values});`);
    }
  }
  return out;
}

interface Journal {
  entries: { idx: number; when: number; tag: string }[];
}

export function readJournal(path: string): Journal {
  return JSON.parse(readFileSync(path, 'utf8')) as Journal;
}

function main(): void {
  if (existsSync(PG_JOURNAL)) {
    throw new Error(
      'drizzle-pg already has a journal: the baseline is generated once and never regenerated',
    );
  }
  execFileSync(
    join(SERVER_DIR, 'node_modules', '.bin', 'drizzle-kit'),
    ['generate', '--config', 'drizzle-pg.config.ts', '--name', 'baseline'],
    { cwd: SERVER_DIR, stdio: 'inherit' },
  );
  const dir = mkdtempSync(join(tmpdir(), 'opportun-pgbaseline-'));
  try {
    const handle = openDatabase(dir);
    const seeds = seedStatements(handle.sqlite);
    handle.sqlite.close();
    const ddl = readFileSync(BASELINE_FILE, 'utf8').trimEnd();
    writeFileSync(BASELINE_FILE, `${ddl}${BREAK}${SEED_MARKER}\n${seeds.join(BREAK)}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const head = readJournal(SQLITE_JOURNAL).entries.at(-1);
  if (head === undefined) throw new Error('the SQLite journal is empty');
  const journal = readJournal(PG_JOURNAL);
  const [baseline] = journal.entries;
  if (journal.entries.length !== 1 || baseline === undefined) {
    throw new Error('expected exactly the baseline entry in the new Postgres journal');
  }
  baseline.when = head.when;
  writeFileSync(PG_JOURNAL, `${JSON.stringify(journal, null, 2)}\n`);
  process.stdout.write(`baseline at SQLite head ${head.tag} (when ${head.when})\n`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
