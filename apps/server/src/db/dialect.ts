// Dialect SQL helpers (ADR-4, iteration 4 Task 10). The few SQL fragments whose spelling or
// meaning differs between SQLite and Postgres live here, each pinned to SQLite's behavior so
// a repo query returns the same rows on both engines:
//
// - LIKE is ASCII case-insensitive on SQLite and case-sensitive on Postgres: ilike().
// - JSON: json_extract/json_each/json_object vs ->>/jsonb_array_elements/jsonb_build_object;
//   both drivers hand raw JSON back as text (db/client.ts disables node-postgres's own json
//   parsing so a stored JSON string is parsed exactly once): decodeJson().
// - Dates: strftime vs to_char: utcDay().
// - max() over a boolean does not exist on Postgres: maxBoolAsInt().
// - NULLs sort first ascending on SQLite and last on Postgres: ascNullsFirst/descNullsLast
//   spell SQLite's order out (valid on both; SQLite since 3.30), for every ORDER BY over a
//   nullable column. Collation (names and titles) is the database's: Postgres must be created
//   with LC_COLLATE=C (checked at boot in db/client.ts), which also keeps lower() and ILIKE
//   ASCII-only like SQLite's.
// - count(*), sum() and min() come back as int8/numeric strings from node-postgres by default:
//   db/client.ts installs number parsers; countAll() also maps explicitly.
// - The job claim needs FOR UPDATE SKIP LOCKED on Postgres: claimNextJob().
// - A case-sensitive prefix match that an index can still range-scan needs different operators
//   per engine: Postgres's plain LIKE is already case-sensitive, so `col LIKE 'x%'` range-scans
//   a btree index normally. SQLite's LIKE optimizer will NOT turn `col LIKE 'x%'` into a range
//   scan unless the pattern has no ASCII letters or `PRAGMA case_sensitive_like` is ON (neither
//   true here: ilike() above depends on the *default* case-insensitive LIKE elsewhere in this
//   file), so SQLite uses GLOB instead, whose matching is case-sensitive by default and whose
//   own optimizer does range-scan a leading non-wildcard prefix: likePrefix().
//
// The helpers for the running process are bound to DB_DIALECT (db/schema.ts SCHEMA_DIALECT);
// dialectSql(d) builds either set, for tests.
import { Column, is, sql, type SQL } from 'drizzle-orm';
import { rawAll, type Exec } from './client';
import type { DbDialect } from './dialectName';
import { SCHEMA_DIALECT } from './schema';

/** A column, or any SQL expression. */
type Expr = SQL | SQL.Aliased | { getSQL(): SQL };

const JSON_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Keys are inlined into the SQL (Postgres ->> needs a literal), so only plain names pass. */
function jsonKey(key: string): string {
  if (!JSON_KEY.test(key)) throw new Error(`not a plain JSON key: ${JSON.stringify(key)}`);
  return key;
}

/** A json/jsonb column of the Postgres twin (ILIKE has no jsonb operand). */
function isJsonColumn(column: Expr): boolean {
  return is(column, Column) && (column.columnType === 'PgJsonb' || column.columnType === 'PgJson');
}

/** `%needle%` with %, _ and \ in the needle escaped (ESCAPE '\'). */
function containsPattern(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** `prefix%` with %, _ and \ in the prefix escaped (ESCAPE '\'), for Postgres's plain LIKE. */
function likePrefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** `prefix*` with GLOB's own wildcards ([, ], *, ?) in the prefix bracket-escaped: GLOB has no
 *  ESCAPE clause, so a literal metacharacter is matched instead by naming it inside a
 *  single-character class. */
function globPrefixPattern(prefix: string): string {
  return `${prefix.replace(/[[\]*?]/g, (c) => `[${c}]`)}*`;
}

export interface DialectSql {
  readonly dialect: DbDialect;
  /**
   * ASCII case-insensitive substring match; %, _ and \ in `needle` are literal. A JSON column
   * is matched on its text form (Postgres: cast to text, see jsonContains).
   */
  ilike(column: Expr, needle: string): SQL;
  /**
   * Case-sensitive prefix match (`prefix` plus anything), as a predicate an index can still
   * range-scan (see the file header). Only correct when both the column and `prefix` are
   * already in the same case, same as how dedupeKey/dedupeGroupKey are always lowercased.
   */
  likePrefix(column: Expr, prefix: string): SQL;
  /**
   * ilike over a JSON value's text form. SQLite stores JSON.stringify text; Postgres renders
   * jsonb with a space after each comma and colon, so a needle spanning two array elements
   * can match differently. Searches within one value (an email in contacts.emails) agree.
   */
  jsonContains(column: Expr, needle: string): SQL;
  /**
   * A top-level key of a JSON column, as text (NULL when absent or JSON null). Strings and
   * numbers read the same on both engines ('42' for 42); booleans differ ('1' on SQLite,
   * 'true' on Postgres) and are not looked up this way.
   */
  jsonText(column: Expr, key: string): SQL<string | null>;
  /** True when a JSON array column holds an object whose `key` equals `value` (a string). */
  jsonArrayHasObjectWith(column: Expr, key: string, value: string): SQL<boolean>;
  /** A JSON object from key/expression pairs; decode the result with decodeJson. */
  jsonObject(pairs: readonly (readonly [string, SQL])[]): SQL;
  /** A JSON column embedded as JSON (not as a string) inside jsonObject. */
  jsonValue(column: Expr): SQL;
  /** A raw JSON value as either driver returns it (text), parsed exactly once. */
  decodeJson(value: unknown): unknown;
  /** The UTC calendar day (YYYY-MM-DD) of an epoch-ms column. No bound parameters. */
  utcDay(columnMs: Expr): SQL<string>;
  /** 1 when any row's boolean is true, else 0 (also for no rows). */
  maxBoolAsInt(column: Expr): SQL<number>;
}

function sqliteSql(): DialectSql {
  return {
    dialect: 'sqlite',
    ilike: (column, needle) => sql`${column} LIKE ${containsPattern(needle)} ESCAPE '\\'`,
    likePrefix: (column, prefix) => sql`${column} GLOB ${globPrefixPattern(prefix)}`,
    // SQLite JSON columns are text already.
    jsonContains: (column, needle) => sql`${column} LIKE ${containsPattern(needle)} ESCAPE '\\'`,
    // CAST: json_extract returns a JSON number as a number; text keeps it comparable with
    // Postgres ->>, which always returns text.
    jsonText: (column, key) =>
      sql<string | null>`CAST(json_extract(${column}, ${sql.raw(`'$.${jsonKey(key)}'`)}) AS TEXT)`,
    jsonArrayHasObjectWith: (column, key, value) =>
      sql<boolean>`EXISTS (SELECT 1 FROM json_each(${column}) AS p WHERE p.type = 'object' AND json_extract(p.value, ${sql.raw(`'$.${jsonKey(key)}'`)}) = ${value})`,
    jsonObject: (pairs) =>
      sql`json_object(${sql.join(
        pairs.map(([k, v]) => sql`${sql.raw(`'${jsonKey(k)}'`)}, ${v}`),
        sql`, `,
      )})`,
    jsonValue: (column) => sql`json(${column})`,
    decodeJson: (value) => (typeof value === 'string' ? (JSON.parse(value) as unknown) : value),
    utcDay: (columnMs) => sql<string>`strftime('%Y-%m-%d', ${columnMs} / 1000, 'unixepoch')`,
    maxBoolAsInt: (column) => sql<number>`coalesce(max(${column}), 0)`,
  };
}

function postgresSql(): DialectSql {
  return {
    dialect: 'postgres',
    ilike: (column, needle) =>
      isJsonColumn(column)
        ? sql`(${column})::text ILIKE ${containsPattern(needle)} ESCAPE '\\'`
        : sql`${column} ILIKE ${containsPattern(needle)} ESCAPE '\\'`,
    // Plain LIKE is already case-sensitive on Postgres, so this is an ordinary indexable
    // prefix predicate; no GLOB equivalent needed here.
    likePrefix: (column, prefix) => sql`${column} LIKE ${likePrefixPattern(prefix)} ESCAPE '\\'`,
    jsonContains: (column, needle) =>
      sql`(${column})::text ILIKE ${containsPattern(needle)} ESCAPE '\\'`,
    jsonText: (column, key) => sql<string | null>`(${column} ->> ${sql.raw(`'${jsonKey(key)}'`)})`,
    jsonArrayHasObjectWith: (column, key, value) =>
      sql<boolean>`EXISTS (SELECT 1 FROM jsonb_array_elements(${column}) AS p(value) WHERE jsonb_typeof(p.value) = 'object' AND p.value ->> ${sql.raw(`'${jsonKey(key)}'`)} = ${value})`,
    jsonObject: (pairs) =>
      sql`jsonb_build_object(${sql.join(
        pairs.map(([k, v]) => sql`${sql.raw(`'${jsonKey(k)}'`)}, ${v}`),
        sql`, `,
      )})`,
    jsonValue: (column) => sql`${column}`,
    // db/client.ts keeps json/jsonb in text form (no node-postgres parse), as on SQLite.
    decodeJson: (value) => (typeof value === 'string' ? (JSON.parse(value) as unknown) : value),
    utcDay: (columnMs) =>
      sql<string>`to_char(to_timestamp(${columnMs} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
    maxBoolAsInt: (column) => sql<number>`coalesce(max((${column})::int), 0)`,
  };
}

/** The helper set for a dialect (tests build both). */
export function dialectSql(dialect: DbDialect): DialectSql {
  return dialect === 'postgres' ? postgresSql() : sqliteSql();
}

/** The helpers for this process's dialect. */
export const dialectHelpers: DialectSql = dialectSql(SCHEMA_DIALECT);

export const ilike = dialectHelpers.ilike;
export const likePrefix = dialectHelpers.likePrefix;
export const jsonContains = dialectHelpers.jsonContains;
export const jsonText = dialectHelpers.jsonText;
export const jsonArrayHasObjectWith = dialectHelpers.jsonArrayHasObjectWith;
export const jsonObject = dialectHelpers.jsonObject;
export const jsonValue = dialectHelpers.jsonValue;
export const decodeJson = dialectHelpers.decodeJson;
export const utcDay = dialectHelpers.utcDay;
export const maxBoolAsInt = dialectHelpers.maxBoolAsInt;

/** Ascending with NULLs first (SQLite's order), the same SQL on both engines. */
export function ascNullsFirst(expr: Expr): SQL {
  return sql`${expr} ASC NULLS FIRST`;
}

/** Descending with NULLs last (SQLite's order), the same SQL on both engines. */
export function descNullsLast(expr: Expr): SQL {
  return sql`${expr} DESC NULLS LAST`;
}

/** count(*) read as a number on both engines (Postgres count is int8). */
export function countAll(): SQL<number> {
  return sql<number>`count(*)`.mapWith(Number);
}

// ---------------------------------------------------------------------------
// The job claim

/** A job the claim moved to running, payload decoded (undefined when unreadable). */
export interface ClaimedJob {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  userId: string | null;
}

interface ClaimedRow {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  user_id: string | null;
}

/**
 * Claims the oldest due pending job for `workerId` in one statement: UPDATE ... RETURNING
 * whose subquery picks the row. SQLite runs it under the write gate, so no two workers pick
 * the same row. Postgres (READ COMMITTED, a pool) adds FOR UPDATE SKIP LOCKED to the
 * subquery: a second worker skips the row the first one locked instead of claiming it too
 * (or waiting and then updating a row that is no longer pending).
 */
export function claimJobSql(
  workerId: string,
  now: number,
  dialect: DbDialect,
  excludeKinds: readonly string[] = [],
): SQL {
  const lock = dialect === 'postgres' ? sql` FOR UPDATE SKIP LOCKED` : sql``;
  // Kinds already at their concurrency limit are skipped in the claim itself, so a worker
  // never takes a job it would have to put back.
  const skip =
    excludeKinds.length === 0
      ? sql``
      : sql` AND kind NOT IN (${sql.join(
          excludeKinds.map((k) => sql`${k}`),
          sql`, `,
        )})`;
  return sql`
    UPDATE jobs
       SET status = 'running', locked_by = ${workerId}, locked_at = ${now},
           attempts = attempts + 1, updated_at = ${now}
     WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND run_at <= ${now}${skip}
                  ORDER BY run_at, created_at LIMIT 1${lock})
    RETURNING id, kind, payload, attempts, max_attempts, user_id`;
}

/** Runs the claim (claimJobSql) and decodes the claimed row. */
export async function claimNextJob(
  exec: Exec,
  workerId: string,
  now: number,
  helpers: DialectSql = dialectHelpers,
  excludeKinds: readonly string[] = [],
): Promise<ClaimedJob | undefined> {
  const rows = await rawAll<ClaimedRow>(
    exec,
    claimJobSql(workerId, now, helpers.dialect, excludeKinds),
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  let payload: unknown;
  try {
    payload = helpers.decodeJson(row.payload);
  } catch {
    payload = undefined;
  }
  return {
    id: row.id,
    kind: row.kind,
    payload,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    userId: row.user_id,
  };
}
