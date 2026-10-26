// Dialect-neutral database access for tests (iteration 4 Task 4). Tests read and poke rows
// through these helpers, never through a raw driver connection, so the same assertions run
// on SQLite and on Postgres (the Task 13 matrix leg, test/pgHarness.ts). Suites that
// test the SQLite engine itself (boot, migrations, backup, the write gate) open
// better-sqlite3 directly and are marked SQLite-only with `sqliteOnly`.
import { getTableName, sql, type SQL } from 'drizzle-orm';
import { rawAll, rawGet, rawRun, type Db, type DbTable } from '../src/db/client';

/** The dialect this run's databases use (TEST_DB_DIALECT; SQLite by default). */
export const testDialect: 'sqlite' | 'postgres' =
  process.env.TEST_DB_DIALECT === 'postgres' ? 'postgres' : 'sqlite';

/** True on SQLite runs: `describe.runIf(sqliteOnly)` for engine-specific suites. */
export const sqliteOnly = testDialect === 'sqlite';

/** An app (or a DbHandle): anything carrying the database. */
export interface HasDb {
  db: Db;
}

/**
 * Raw SQL with `?` placeholders bound in order (never interpolated), or a drizzle `sql`
 * template. Placeholders are compiled per dialect by drizzle.
 */
function toSql(query: SQL | string, params: readonly unknown[]): SQL {
  if (typeof query !== 'string') {
    if (params.length > 0) throw new Error('pass parameters inside the sql`` template');
    return query;
  }
  const parts = query.split('?');
  if (parts.length - 1 !== params.length) {
    throw new Error(`expected ${parts.length - 1} parameters, got ${params.length}: ${query}`);
  }
  const [head = '', ...rest] = parts;
  const chunks: SQL[] = [sql.raw(head)];
  rest.forEach((part, i) => chunks.push(sql`${params.at(i)}`, sql.raw(part)));
  return sql.join(chunks, sql.raw(''));
}

/** Every row of a query, as objects keyed by column alias. */
export async function queryAll<T = Record<string, unknown>>(
  app: HasDb,
  query: SQL | string,
  ...params: unknown[]
): Promise<T[]> {
  return await rawAll<T>(app.db, toSql(query, params));
}

/** The first row of a query, or undefined. */
export async function queryOne<T = Record<string, unknown>>(
  app: HasDb,
  query: SQL | string,
  ...params: unknown[]
): Promise<T | undefined> {
  return await rawGet<T>(app.db, toSql(query, params));
}

/** Runs a statement (DDL or a write) for a fixture; resolves with the rows it changed. */
export async function exec(app: HasDb, query: SQL | string, ...params: unknown[]): Promise<number> {
  return (await rawRun(app.db, toSql(query, params))).changes;
}

/** COUNT(*) of a table (by schema object or name), optionally under a raw WHERE clause. */
export async function countRows(
  app: HasDb,
  table: DbTable | string,
  where?: string,
  ...params: unknown[]
): Promise<number> {
  const name = typeof table === 'string' ? table : getTableName(table);
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`not a table name: ${name}`);
  const clause = where === undefined ? '' : ` WHERE ${where}`;
  const row = await queryOne<{ n: number | string }>(
    app,
    `SELECT count(*) AS n FROM ${name}${clause}`,
    ...params,
  );
  return Number(row?.n ?? 0);
}

/** Every table in the database (optionally only those with a column named `column`). */
export async function listTables(app: HasDb, column?: string): Promise<string[]> {
  const rows =
    testDialect === 'postgres'
      ? await queryAll<{ name: string }>(
          app,
          `SELECT t.table_name AS name FROM information_schema.tables t
            WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
              AND (CAST(? AS text) IS NULL OR EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                      AND c.column_name = ?))
            ORDER BY t.table_name`,
          column ?? null,
          column ?? null,
        )
      : await queryAll<{ name: string }>(
          app,
          `SELECT m.name AS name FROM sqlite_master m
            WHERE m.type = 'table'
              AND (CAST(? AS text) IS NULL OR EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = ?))
            ORDER BY m.name`,
          column ?? null,
          column ?? null,
        );
  return rows.map((r) => r.name);
}

/**
 * A raw boolean column as a JS boolean: SQLite returns 0/1, Postgres true/false. Raw test SQL
 * filters with bare columns (`WHERE is_active`, `NOT is_admin`), never `= 1`.
 */
export function bool(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new Error(`not a boolean column value: ${JSON.stringify(value)}`);
}

let failingSeq = 0;

export interface FailingWriteOptions {
  /** The statement that fails (default INSERT). */
  on?: 'INSERT' | 'UPDATE' | 'DELETE';
  /** A condition over NEW (insert, update) or OLD (delete), valid on both engines. */
  when?: string;
  /** The error message raised (default 'injected'). */
  message?: string;
}

/**
 * Makes writes to `table` fail (matching `when`, if given) until the returned undo runs: a
 * fault injected below the code under test. SQLite: a BEFORE trigger raising ABORT.
 * Postgres: a BEFORE ... FOR EACH ROW trigger whose function raises an exception.
 */
export async function withFailingWrite(
  app: HasDb,
  table: string,
  opts: FailingWriteOptions = {},
): Promise<() => Promise<void>> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`not a table name: ${table}`);
  const on = opts.on ?? 'INSERT';
  const message = opts.message ?? 'injected';
  if (!/^[a-z ]+$/.test(message)) throw new Error(`not a plain message: ${message}`);
  const name = `test_failing_write_${++failingSeq}`;
  if (testDialect === 'postgres') {
    await exec(
      app,
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql
         AS $$ BEGIN RAISE EXCEPTION '${message}'; END $$`,
    );
    await exec(
      app,
      `CREATE TRIGGER ${name} BEFORE ${on} ON ${table} FOR EACH ROW
         ${opts.when === undefined ? '' : `WHEN (${opts.when})`} EXECUTE FUNCTION ${name}()`,
    );
    return async () => {
      await exec(app, `DROP TRIGGER ${name} ON ${table}`);
      await exec(app, `DROP FUNCTION ${name}()`);
    };
  }
  await exec(
    app,
    `CREATE TRIGGER ${name} BEFORE ${on} ON ${table}${opts.when === undefined ? '' : ` WHEN ${opts.when}`}
     BEGIN SELECT RAISE(ABORT, '${message}'); END`,
  );
  return async () => {
    await exec(app, `DROP TRIGGER ${name}`);
  };
}

/** withFailingWrite for inserts (`when` is a condition over NEW). */
export async function withFailingInsert(
  app: HasDb,
  table: string,
  when?: string,
): Promise<() => Promise<void>> {
  return withFailingWrite(app, table, when === undefined ? {} : { when });
}
