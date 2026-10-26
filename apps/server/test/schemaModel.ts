// A dialect-neutral model of a migrated database's schema, for the lockstep parity checks
// (iteration 4 Task 8, test/migrationParity.test.ts). Three sources normalize into it:
//
// - a live SQLite database (sqlite_master + pragmas): what the SQLite chain really builds;
// - a drizzle-kit Postgres snapshot (drizzle-pg/meta/NNNN_snapshot.json): what the Postgres
//   chain's DDL was generated from, checked without a server;
// - a live Postgres database (information_schema + pg_catalog), once one is available.
//
// Column types compare by SQLite storage class (Postgres bigint and boolean are INTEGER,
// double precision is REAL, text and jsonb are TEXT); the finer mapping (boolean vs integer,
// jsonb vs text) is pinned at the Drizzle level by test/schemaConformance.test.ts.
import type { Pool } from 'pg';
import type { Sqlite } from '../src/db/client';

export type Storage = 'text' | 'integer' | 'real';

export interface ColumnModel {
  storage: Storage;
  notNull: boolean;
  default: string | number | undefined;
}

export interface IndexModel {
  unique: boolean;
  columns: string[];
  where: string | undefined;
}

export interface TableModel {
  columns: Record<string, ColumnModel>;
  primaryKey: string[];
  /** Unique constraints are modeled as unique indexes (both engines back them with one). */
  indexes: Record<string, IndexModel>;
  /** "cols -> table(cols) on delete X on update Y", sorted (SQLite FKs have no names). */
  foreignKeys: string[];
}

export type SchemaModel = Record<string, TableModel>;

/** Tables outside the Drizzle schema: bookkeeping, and SQLite's FTS5 index (Task 11). */
export function isSchemaTable(name: string): boolean {
  return (
    !name.startsWith('sqlite_') && !name.startsWith('__drizzle') && !name.startsWith('search_index')
  );
}

const PG_STORAGE: Record<string, Storage> = {
  text: 'text',
  jsonb: 'text',
  bigint: 'integer',
  boolean: 'integer',
  'double precision': 'real',
};

function storageOfPg(type: string): Storage {
  const s = PG_STORAGE[type];
  if (s === undefined) throw new Error(`unmapped Postgres column type: ${type}`);
  return s;
}

function storageOfSqlite(type: string): Storage {
  const t = type.toLowerCase();
  if (t === 'text' || t === 'integer' || t === 'real') return t;
  throw new Error(`unmapped SQLite column type: ${type}`);
}

/**
 * A column default as a value: quotes removed, casts dropped, booleans as 0/1 (SQLite stores
 * them so; Postgres `false` and SQLite `false` or `0` all become 0).
 */
export function normalizeDefault(raw: unknown): string | number | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  let v = String(raw).trim();
  v = v.replace(/::[a-z ]+$/i, '');
  const quoted = /^'(.*)'$/s.exec(v);
  if (quoted !== null) return (quoted[1] ?? '').replaceAll("''", "'");
  if (/^true$/i.test(v)) return 1;
  if (/^false$/i.test(v)) return 0;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** A partial-index predicate, spelled the same whichever engine printed it. */
export function normalizePredicate(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined || raw.trim() === '') return undefined;
  let v = raw
    .replace(/[`"]/g, '')
    .replace(/::[a-z]+(\[\])?/gi, '')
    .replace(/\b[a-z_][a-z0-9_]*\.([a-z_][a-z0-9_]*)\b/gi, '$1');
  // Postgres prints `x IN ('a', 'b')` back as `x = ANY (ARRAY['a', 'b'])`.
  v = v.replace(/=\s*ANY\s*\(\s*ARRAY\[([^\]]*)\]\s*\)/gi, 'IN ($1)');
  v = v
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ');
  return v.trim().toLowerCase();
}

function fkKey(
  columns: string[],
  table: string,
  foreignColumns: string[],
  onDelete: string,
  onUpdate: string,
): string {
  return `${columns.join(',')} -> ${table}(${foreignColumns.join(',')}) on delete ${onDelete.toLowerCase()} on update ${onUpdate.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// SQLite

export function sqliteModel(sqlite: Sqlite): SchemaModel {
  const model: SchemaModel = {};
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  for (const { name } of tables) {
    if (!isSchemaTable(name)) continue;
    const cols = sqlite.prepare('SELECT * FROM pragma_table_info(?)').all(name) as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[];
    const table: TableModel = { columns: {}, primaryKey: [], indexes: {}, foreignKeys: [] };
    for (const c of cols) {
      table.columns[c.name] = {
        storage: storageOfSqlite(c.type),
        // SQLite does not imply NOT NULL for a text primary key; both chains declare it.
        notNull: c.notnull === 1,
        default: normalizeDefault(c.dflt_value),
      };
    }
    table.primaryKey = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    const indexes = sqlite.prepare('SELECT * FROM pragma_index_list(?)').all(name) as {
      name: string;
      unique: number;
      origin: string;
    }[];
    for (const ix of indexes) {
      if (ix.origin === 'pk') continue;
      const columns = (
        sqlite.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(ix.name) as {
          name: string;
        }[]
      ).map((c) => c.name);
      const ddl = (
        sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get(ix.name) as { sql: string | null } | undefined
      )?.sql;
      const where =
        ddl === null || ddl === undefined ? undefined : /\sWHERE\s(.*)$/is.exec(ddl)?.[1];
      table.indexes[ix.name] = {
        unique: ix.unique === 1,
        columns,
        where: normalizePredicate(where),
      };
    }
    const fks = sqlite.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(name) as {
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
    }[];
    const byId = new Map<number, typeof fks>();
    for (const fk of fks) byId.set(fk.id, [...(byId.get(fk.id) ?? []), fk]);
    table.foreignKeys = [...byId.values()]
      .map((parts) => {
        const sorted = parts.sort((a, b) => a.seq - b.seq);
        const first = sorted[0];
        if (first === undefined) throw new Error('empty foreign key');
        return fkKey(
          sorted.map((p) => p.from),
          first.table,
          sorted.map((p) => p.to),
          first.on_delete,
          first.on_update,
        );
      })
      .sort();
    model[name] = table;
  }
  return model;
}

// ---------------------------------------------------------------------------
// drizzle-kit Postgres snapshot (version 7)

interface SnapshotTable {
  name: string;
  columns: Record<
    string,
    { name: string; type: string; primaryKey: boolean; notNull: boolean; default?: unknown }
  >;
  indexes: Record<
    string,
    {
      name: string;
      columns: { expression: string; isExpression: boolean }[];
      isUnique: boolean;
      where?: string;
    }
  >;
  foreignKeys: Record<
    string,
    {
      tableTo: string;
      columnsFrom: string[];
      columnsTo: string[];
      onDelete?: string;
      onUpdate?: string;
    }
  >;
  compositePrimaryKeys: Record<string, { columns: string[] }>;
  uniqueConstraints: Record<string, { name: string; columns: string[] }>;
}

export function pgSnapshotModel(snapshot: { tables: Record<string, SnapshotTable> }): SchemaModel {
  const model: SchemaModel = {};
  for (const t of Object.values(snapshot.tables)) {
    const table: TableModel = { columns: {}, primaryKey: [], indexes: {}, foreignKeys: [] };
    for (const c of Object.values(t.columns)) {
      table.columns[c.name] = {
        storage: storageOfPg(c.type),
        notNull: c.notNull || c.primaryKey,
        default: normalizeDefault(c.default),
      };
      if (c.primaryKey) table.primaryKey.push(c.name);
    }
    for (const pk of Object.values(t.compositePrimaryKeys)) table.primaryKey.push(...pk.columns);
    for (const ix of Object.values(t.indexes)) {
      if (ix.columns.some((c) => c.isExpression)) throw new Error(`expression index ${ix.name}`);
      table.indexes[ix.name] = {
        unique: ix.isUnique,
        columns: ix.columns.map((c) => c.expression),
        where: normalizePredicate(ix.where),
      };
    }
    for (const u of Object.values(t.uniqueConstraints)) {
      table.indexes[u.name] = { unique: true, columns: u.columns, where: undefined };
    }
    table.foreignKeys = Object.values(t.foreignKeys)
      .map((fk) =>
        fkKey(
          fk.columnsFrom,
          fk.tableTo,
          fk.columnsTo,
          fk.onDelete ?? 'no action',
          fk.onUpdate ?? 'no action',
        ),
      )
      .sort();
    model[t.name] = table;
  }
  return model;
}

// ---------------------------------------------------------------------------
// Live Postgres (public schema). Not yet exercised against a server in Wave 2: the first
// run (Task 13's matrix) may need its normalizers adjusted, never the parity it asserts.

const FK_ACTIONS: Record<string, string> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

export async function pgLiveModel(pool: Pool): Promise<SchemaModel> {
  const model: SchemaModel = {};
  const cols = await pool.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: 'YES' | 'NO';
    column_default: string | null;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
  );
  for (const c of cols.rows) {
    if (!isSchemaTable(c.table_name)) continue;
    const table = (model[c.table_name] ??= {
      columns: {},
      primaryKey: [],
      indexes: {},
      foreignKeys: [],
    });
    table.columns[c.column_name] = {
      storage: storageOfPg(c.data_type),
      notNull: c.is_nullable === 'NO',
      default: normalizeDefault(c.column_default),
    };
  }
  const indexes = await pool.query<{
    table_name: string;
    index_name: string;
    is_unique: boolean;
    is_primary: boolean;
    predicate: string | null;
    columns: string[];
  }>(
    `SELECT t.relname AS table_name, i.relname AS index_name, ix.indisunique AS is_unique,
            ix.indisprimary AS is_primary, pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
            ARRAY(SELECT a.attname::text
                    FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
                   ORDER BY k.ord) AS columns
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'`,
  );
  for (const ix of indexes.rows) {
    const table = model[ix.table_name];
    if (table === undefined) continue;
    if (ix.is_primary) {
      table.primaryKey = ix.columns;
      continue;
    }
    table.indexes[ix.index_name] = {
      unique: ix.is_unique,
      columns: ix.columns,
      where: normalizePredicate(ix.predicate),
    };
  }
  const fks = await pool.query<{
    table_name: string;
    foreign_table: string;
    columns: string[];
    foreign_columns: string[];
    on_delete: string;
    on_update: string;
  }>(
    `SELECT t.relname AS table_name, f.relname AS foreign_table,
            ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                   ORDER BY k.ord) AS columns,
            ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                   ORDER BY k.ord) AS foreign_columns,
            c.confdeltype AS on_delete, c.confupdtype AS on_update
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_class f ON f.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'`,
  );
  for (const fk of fks.rows) {
    const table = model[fk.table_name];
    if (table === undefined) continue;
    table.foreignKeys.push(
      fkKey(
        fk.columns,
        fk.foreign_table,
        fk.foreign_columns,
        FK_ACTIONS[fk.on_delete] ?? fk.on_delete,
        FK_ACTIONS[fk.on_update] ?? fk.on_update,
      ),
    );
  }
  for (const table of Object.values(model)) table.foreignKeys.sort();
  return model;
}
