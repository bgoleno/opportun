// List conventions shared by every collection endpoint: {items, total}, limit/offset
// paging and a whitelisted sort key ("field" ascending, "-field" descending).
import { count, type SQL } from 'drizzle-orm';
import type { DbColumn, DbTable } from '../db/client';
import { ascNullsFirst, descNullsLast, ilike } from '../db/dialect';
import type { Exec } from './base';

export interface ListOpts {
  limit: number;
  offset: number;
  /** A key from the resource's sort whitelist, optionally prefixed with '-' (descending). */
  sort?: string | undefined;
}

/** A column, or an expression such as a CASE that orders stages by lifecycle position. */
export type SortExpr = DbColumn | SQL;

export interface Page<T> {
  items: T[];
  total: number;
}

/**
 * ORDER BY terms for a sort key. The key was validated against `columns` at the route
 * (listQuery), so an unknown key here is a programming error. `tie` (the id) keeps paging
 * stable when the sort column has duplicates. NULLs sort first ascending and last descending
 * on both engines (SQLite's order; several sort keys are nullable, e.g. ai_score, lastRunAt).
 */
export function orderBy(
  sort: string | undefined,
  fallback: string,
  columns: ReadonlyMap<string, SortExpr>,
  tie: DbColumn,
): SQL[] {
  const key = sort ?? fallback;
  const descending = key.startsWith('-');
  const column = columns.get(descending ? key.slice(1) : key);
  if (column === undefined) throw new Error(`unknown sort key: ${key}`);
  return descending
    ? [descNullsLast(column), descNullsLast(tie)]
    : [ascNullsFirst(column), ascNullsFirst(tie)];
}

/** A sort whitelist: API sort key to column. */
export function sortColumns(columns: Record<string, SortExpr>): ReadonlyMap<string, SortExpr> {
  return new Map(Object.entries(columns));
}

/** COUNT(*) over `table` under `where`. */
export async function countWhere(
  exec: Exec,
  table: DbTable,
  where: SQL | undefined,
): Promise<number> {
  return (await exec.select({ n: count() }).from(table).where(where).get())?.n ?? 0;
}

/**
 * Case-insensitive (ASCII) substring match where %, _ and \ in `needle` are literal: LIKE on
 * SQLite, ILIKE on Postgres (db/dialect.ts).
 */
export function likeContains(column: DbColumn | SQL, needle: string): SQL {
  return ilike(column, needle);
}
