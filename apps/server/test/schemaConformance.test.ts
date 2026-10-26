// The Postgres schema twin conforms to the SQLite schema (iteration 4 Task 7).
//
// Dialect erasure: repos type against the SQLite tables while db/schema hands them the
// twin matching DB_DIALECT at runtime. That is sound only if every table's row types are
// identical across the twins (checked at compile time below: `pnpm typecheck` fails on any
// drift) and the twins name the same tables, columns, defaults, keys and indexes (checked at
// runtime). The type mapping is pinned here column by column, so a new column cannot pick a
// Postgres type silently.
import { type InferInsertModel, type InferSelectModel, type SQL, type Table } from 'drizzle-orm';
import {
  bigint,
  getTableConfig as pgTableConfig,
  PgDialect,
  pgTable,
  text as pgText,
  type PgColumn,
} from 'drizzle-orm/pg-core';
import {
  getTableConfig as sqliteTableConfig,
  SQLiteSyncDialect,
  type SQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as schema from '../src/db/schema';
import * as pg from '../src/db/schema.pg';
import { TABLE_EXPORTS, type TableExport } from '../src/db/schema.shared';
import * as lite from '../src/db/schema.sqlite';

type Lite = typeof lite;
type Pg = typeof pg;
type Models<S, K extends keyof S> = {
  [P in K]: S[P] extends Table
    ? { select: InferSelectModel<S[P]>; insert: InferInsertModel<S[P]> }
    : never;
};

/**
 * The type mapping (plan Task 7 rules; decisions recorded in schema.pg.ts):
 * text -> text, json-mode text -> jsonb, boolean-mode integer -> boolean, real -> double
 * precision, and every integer -> bigint in number mode (SQLite INTEGER is 64-bit; the twin
 * keeps its range, not only for epoch-ms timestamps).
 */
const TYPE_MAP: Record<string, string> = {
  SQLiteText: 'PgText',
  SQLiteTextJson: 'PgJsonb',
  SQLiteBoolean: 'PgBoolean',
  SQLiteInteger: 'PgBigInt53',
  SQLiteReal: 'PgDoublePrecision',
};

const liteDialect = new SQLiteSyncDialect();
const pgDialect = new PgDialect();

function whereText(where: SQL | undefined, dialect: 'sqlite' | 'postgres'): string | undefined {
  if (where === undefined) return undefined;
  return (dialect === 'sqlite' ? liteDialect : pgDialect).sqlToQuery(where).sql;
}

type AnyColumn = SQLiteColumn | PgColumn;

function describeColumn(c: AnyColumn) {
  return {
    name: c.name,
    notNull: c.notNull,
    hasDefault: c.hasDefault,
    default: c.default as unknown,
    primary: c.primary,
    isUnique: c.isUnique,
    uniqueName: c.uniqueName,
    enumValues: c.enumValues,
  };
}

function describeTable(name: TableExport, dialect: 'sqlite' | 'postgres') {
  const cfg =
    dialect === 'sqlite'
      ? sqliteTableConfig(lite[name])
      : pgTableConfig(pg[name] as Parameters<typeof pgTableConfig>[0]);
  const columns = cfg.columns as AnyColumn[];
  return {
    table: cfg.name,
    columns: columns.map(describeColumn),
    primaryKeys: cfg.primaryKeys.map((pk) => pk.columns.map((c) => c.name)),
    foreignKeys: cfg.foreignKeys
      .map((fk) => {
        const ref = fk.reference();
        return {
          name: fk.getName(),
          columns: ref.columns.map((c) => c.name),
          foreignColumns: ref.foreignColumns.map((c) => c.name),
          // Unset means NO ACTION on both engines; pg-core spells the default out.
          onDelete: fk.onDelete ?? 'no action',
          onUpdate: fk.onUpdate ?? 'no action',
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    indexes: cfg.indexes
      .map((ix) => ({
        name: ix.config.name ?? '(unnamed)',
        unique: ix.config.unique,
        columns: ix.config.columns.map((c) => (c as AnyColumn).name),
        where: whereText(ix.config.where, dialect),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

describe('schema twin conformance', () => {
  it('row types are identical for every table (compile time; see pnpm typecheck)', () => {
    expectTypeOf<Models<Pg, TableExport>>().toEqualTypeOf<Models<Lite, TableExport>>();
    // ...and the mapped type is not vacuous (a non-table would map to never on both sides).
    expectTypeOf<Models<Pg, TableExport>['users']['select']['totpRecovery']>().toEqualTypeOf<
      string[] | null
    >();
    expectTypeOf<Models<Pg, TableExport>['jobs']['insert']['runAt']>().toEqualTypeOf<number>();
    // The check bites: a twin whose column type or nullability drifts does not compile.
    const drifted = pgTable('users', {
      id: pgText('id').primaryKey(),
      n: bigint('n', { mode: 'bigint' }),
    });
    const same = pgTable('users', {
      id: pgText('id').primaryKey(),
      n: bigint('n', { mode: 'number' }),
    });
    type Row = { id: string; n: number | null };
    expectTypeOf<InferSelectModel<typeof same>>().toEqualTypeOf<Row>();
    // @ts-expect-error bigint mode 'bigint' selects as bigint, not number
    expectTypeOf<InferSelectModel<typeof drifted>>().toEqualTypeOf<Row>();
    expect([drifted.n.columnType, same.n.columnType]).toEqual(['PgBigInt64', 'PgBigInt53']);
  });

  it('both twins export exactly the 31 shared tables', () => {
    expect(TABLE_EXPORTS).toHaveLength(31);
    for (const name of TABLE_EXPORTS) {
      expect(lite[name], name).toBeDefined();
      expect(pg[name], name).toBeDefined();
    }
  });

  it('maps every column type by the rules', () => {
    const unmapped: string[] = [];
    for (const name of TABLE_EXPORTS) {
      const liteCols = sqliteTableConfig(lite[name]).columns;
      const pgCols = pgTableConfig(pg[name] as Parameters<typeof pgTableConfig>[0]).columns;
      for (const c of liteCols) {
        const twin = pgCols.find((p) => p.name === c.name);
        if (twin?.columnType !== TYPE_MAP[c.columnType]) {
          unmapped.push(`${name}.${c.name}: ${c.columnType} -> ${twin?.columnType ?? 'missing'}`);
        }
      }
    }
    expect(unmapped).toEqual([]);
  });

  it.each(TABLE_EXPORTS)(
    '%s: same table, columns, defaults, keys and indexes on both dialects',
    (name) => {
      expect(describeTable(name, 'postgres')).toEqual(describeTable(name, 'sqlite'));
    },
  );

  it('db/schema picks the twin matching the dialect', () => {
    // This run is SQLite unless DB_DIALECT says otherwise (the Task 13 matrix sets it).
    const expected = schema.SCHEMA_DIALECT === 'postgres' ? pg : lite;
    for (const name of TABLE_EXPORTS) expect(schema[name], name).toBe(expected[name]);
    for (const name of TABLE_EXPORTS) {
      expect(schema.tablesFor('sqlite')[name]).toBe(lite[name]);
      expect(schema.tablesFor('postgres')[name]).toBe(pg[name]);
    }
  });

  describe('under DB_DIALECT=postgres (fresh module graph)', () => {
    afterEach(() => {
      // This describe runs under vitest.config.ts's `forks` project (issue #298):
      // process.env here is genuinely per-process, not shared with a sibling test file.
      // eslint-disable-next-line no-restricted-syntax -- forks-isolated, see the comment above
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it('db/schema exports the Postgres tables', async () => {
      // eslint-disable-next-line no-restricted-syntax -- forks-isolated, see afterEach above
      vi.stubEnv('DB_DIALECT', 'postgres');
      vi.resetModules();
      const fresh = await import('../src/db/schema');
      const freshPg = await import('../src/db/schema.pg');
      expect(fresh.SCHEMA_DIALECT).toBe('postgres');
      for (const name of TABLE_EXPORTS) expect(fresh[name], name).toBe(freshPg[name]);
    });

    it('the SQLite opener refuses Postgres tables', async () => {
      // eslint-disable-next-line no-restricted-syntax -- see the afterEach above.
      vi.stubEnv('DB_DIALECT', 'postgres');
      vi.resetModules();
      const { openDatabase } = await import('../src/db/client');
      expect(() => openDatabase('/nonexistent-never-created')).toThrow(
        /DB_DIALECT=postgres: refusing to open the SQLite database/,
      );
    });
  });
});
