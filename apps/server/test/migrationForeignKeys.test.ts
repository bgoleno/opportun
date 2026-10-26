// Issue #156: drizzle-kit 0.31.11 can drop ON DELETE/ON UPDATE from a generated
// `ALTER TABLE ... ADD COLUMN ... REFERENCES` statement on SQLite. The snapshot's own
// foreign-key model records the clause correctly; only the emitted SQL text for that one
// statement shape is wrong, so a `CREATE TABLE`-time foreign key is unaffected. A documented
// warning to check this by hand is exactly the kind of unenforced precondition issue #180
// showed gets violated anyway.
//
// This checks the thing that actually matters: not what any one migration's text claims, but
// what the fully-migrated, real SQLite database actually enforces, against what
// schema.sqlite.ts itself declares for every table in TABLE_EXPORTS. A future table or column
// is covered automatically, generated migration or hand-written, with nothing here to update.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Sqlite } from '../src/db/client';
import { TABLE_EXPORTS } from '../src/db/schema.shared';
import * as sqliteTables from '../src/db/schema.sqlite';
import { sqliteOnly } from './db';

interface FkClauses {
  onDelete: string;
  onUpdate: string;
}

/** `${table}.${column}->${foreignTable}`: unique per foreign key in this schema. */
function fkKey(table: string, column: string, foreignTable: string): string {
  return `${table}.${column}->${foreignTable}`;
}

/** Every foreign key schema.sqlite.ts declares, keyed by fkKey, as Drizzle itself models it. */
function expectedForeignKeys(): Map<string, FkClauses> {
  const expected = new Map<string, FkClauses>();
  for (const exportName of TABLE_EXPORTS) {
    // eslint-disable-next-line security/detect-object-injection -- exportName is from TABLE_EXPORTS, not external input
    const table = sqliteTables[exportName] as SQLiteTable;
    const { name, foreignKeys } = getTableConfig(table);
    for (const fk of foreignKeys) {
      const ref = fk.reference();
      const column = ref.columns[0]!.name;
      const foreignTable = getTableConfig(ref.foreignColumns[0]!.table).name;
      expected.set(fkKey(name, column, foreignTable), {
        onDelete: (fk.onDelete ?? 'no action').toLowerCase(),
        onUpdate: (fk.onUpdate ?? 'no action').toLowerCase(),
      });
    }
  }
  return expected;
}

/** Every foreign key a real, fully-migrated SQLite database actually enforces. */
function appliedForeignKeys(sqlite: Sqlite): Map<string, FkClauses> {
  const applied = new Map<string, FkClauses>();
  const tableNames = (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  for (const tableName of tableNames) {
    const fks = sqlite
      .prepare(
        'SELECT "from" AS col, "table" AS foreignTable, on_delete AS onDelete, on_update AS onUpdate ' +
          'FROM pragma_foreign_key_list(?)',
      )
      .all(tableName) as {
      col: string;
      foreignTable: string;
      onDelete: string;
      onUpdate: string;
    }[];
    for (const fk of fks) {
      applied.set(fkKey(tableName, fk.col, fk.foreignTable), {
        onDelete: fk.onDelete.toLowerCase(),
        onUpdate: fk.onUpdate.toLowerCase(),
      });
    }
  }
  return applied;
}

describe.runIf(sqliteOnly)('migration foreign keys match the schema (issue #156)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('every ON DELETE/ON UPDATE the full migration chain applies matches schema.sqlite.ts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'opportun-fk-test-'));
    dirs.push(dataDir);
    const { sqlite } = openDatabase(dataDir);
    try {
      expect(appliedForeignKeys(sqlite)).toEqual(expectedForeignKeys());
    } finally {
      sqlite.close();
    }
  });
});
