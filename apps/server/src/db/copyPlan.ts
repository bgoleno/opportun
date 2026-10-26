// The pure half of the SQLite-to-Postgres copy tool (iteration 4 Task 14; the tool is
// lib/copyToPostgres.ts, its command line cli/copyToPostgres.ts). Engine-free and tested on
// its own (test/copyPlan.test.ts):
//
// - tableSpecs/copyOrder: every schema table with its column kinds, primary key and foreign
//   keys, read from the Drizzle schema (never hand-listed), in an FK-safe order: every parent
//   table before its children, self-references (prompts.parent_id, resumes.parent_resume_id)
//   handled per row by parentsFirst.
// - fromSqlite/fromPg: one value as the source holds it (better-sqlite3 with safe integers)
//   and as Postgres returns it (node-postgres with db/client's parsers: int8 as number, jsonb
//   as text), each turned into a canonical cell string. Cells compare DECODED values, so the
//   documented jsonb differences (key order, spacing, numeric spelling, duplicate keys) do
//   not count as drift, while a JSON string "123" against the number 123, or SQL NULL against
//   JSON null, does. fromSqlite also yields the parameter to insert, after removing NUL
//   characters and lone surrogates through lib/safeText's cleanText (Postgres rejects both),
//   counted per column, never silently.
// - TableDigest: a SHA-256 over a table's canonical rows in primary-key order (sorted here,
//   by code unit, so neither engine's collation is involved), computed identically for the
//   source rows and for the rows read back from Postgres.
// - sealedEnvelopes: vault ciphertexts (secretBox) embedded in text and JSON values, for the
//   decryptability check.
//
// Error messages name the table, column and primary key of a row, never a value: rows hold
// password hashes, tokens and ciphertexts.
import { createHash } from 'node:crypto';
import { getTableConfig as pgTableConfig } from 'drizzle-orm/pg-core';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { cleanText } from '../lib/safeText';
import * as pgTables from './schema.pg';
import { TABLE_EXPORTS } from './schema.shared';
import * as sqliteTables from './schema.sqlite';

/** How a column's values are stored: SQLite type on the left, Postgres on the right. */
export type ColumnKind =
  | 'text' // text / text
  | 'json' // text (mode json) / jsonb
  | 'int' // integer / bigint (mode number)
  | 'real' // real / double precision
  | 'bool'; // integer (mode boolean) / boolean

export interface ColumnSpec {
  name: string;
  kind: ColumnKind;
}

export interface TableSpec {
  /** SQL table name (identical on both engines). */
  name: string;
  columns: ColumnSpec[];
  /** Primary key column names, in key order. */
  pk: string[];
  /** Other tables this one references (copied first). */
  parents: string[];
  /** Columns referencing this table's own rows (ordered per row by parentsFirst). */
  selfRefs: { column: string; references: string }[];
}

const SQLITE_KINDS: Record<string, ColumnKind> = {
  SQLiteText: 'text',
  SQLiteTextJson: 'json',
  SQLiteInteger: 'int',
  SQLiteReal: 'real',
  SQLiteBoolean: 'bool',
};

const PG_KINDS: Record<string, ColumnKind> = {
  PgText: 'text',
  PgJsonb: 'json',
  PgBigInt53: 'int',
  PgDoublePrecision: 'real',
  PgBoolean: 'bool',
};

/** A row the tool cannot copy faithfully (bad type, invalid JSON, a cycle): it aborts. */
export class CopyDataError extends Error {
  override name = 'CopyDataError';
}

/** Every schema table (TABLE_EXPORTS order), checked against its Postgres twin. */
export function tableSpecs(): TableSpec[] {
  return TABLE_EXPORTS.map((exportName) => {
    const config = getTableConfig(sqliteTables[exportName] as SQLiteTable);
    const twin = pgTableConfig(pgTables[exportName]);
    const columns = config.columns.map((c) => {
      const kind = SQLITE_KINDS[c.columnType];
      if (kind === undefined) {
        throw new Error(`copy plan: ${config.name}.${c.name} has unsupported type ${c.columnType}`);
      }
      const pgColumn = twin.columns.find((p) => p.name === c.name);
      if (pgColumn === undefined || PG_KINDS[pgColumn.columnType] !== kind) {
        throw new Error(`copy plan: ${config.name}.${c.name} has no matching Postgres column`);
      }
      return { name: c.name, kind };
    });
    if (twin.name !== config.name || twin.columns.length !== columns.length) {
      throw new Error(`copy plan: ${config.name} differs from its Postgres twin`);
    }
    const composite = config.primaryKeys[0];
    const pk =
      composite !== undefined
        ? composite.columns.map((c) => c.name)
        : config.columns.filter((c) => c.primary).map((c) => c.name);
    if (pk.length === 0) throw new Error(`copy plan: ${config.name} has no primary key`);
    const parents = new Set<string>();
    const selfRefs: TableSpec['selfRefs'] = [];
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      const target = getTableConfig(ref.foreignTable).name;
      if (target === config.name) {
        ref.columns.forEach((col, i) => {
          selfRefs.push({ column: col.name, references: ref.foreignColumns[i]?.name ?? 'id' });
        });
      } else {
        parents.add(target);
      }
    }
    return { name: config.name, columns, pk, parents: [...parents], selfRefs };
  });
}

/** `specs` with every table after the tables it references (ties keep the given order). */
export function copyOrder(specs: TableSpec[]): TableSpec[] {
  const placed = new Set<string>();
  const known = new Set(specs.map((s) => s.name));
  const out: TableSpec[] = [];
  let pending = [...specs];
  while (pending.length > 0) {
    const next = pending.find((s) => s.parents.every((p) => placed.has(p) || !known.has(p)));
    if (next === undefined) {
      throw new Error(
        `copy plan: table dependency cycle among ${pending.map((s) => s.name).join(', ')}`,
      );
    }
    out.push(next);
    placed.add(next.name);
    pending = pending.filter((s) => s !== next);
  }
  return out;
}

/**
 * Rows of a self-referencing table, each after the rows it references (a row referencing
 * itself is fine: Postgres checks the key at the end of the statement). A reference to a row
 * not in `rows` is left to the database's foreign key check. Throws on a reference cycle.
 */
export function parentsFirst<T>(
  rows: T[],
  idOf: (row: T) => string,
  parentsOf: ((row: T) => string | null)[],
): T[] {
  if (parentsOf.length === 0) return rows;
  const byId = new Map(rows.map((r) => [idOf(r), r]));
  const waiting = new Map<string, number>();
  const children = new Map<string, T[]>();
  for (const row of rows) {
    const id = idOf(row);
    const parents = new Set(
      parentsOf
        .map((p) => p(row))
        .filter((p): p is string => p !== null && p !== id && byId.has(p)),
    );
    waiting.set(id, parents.size);
    for (const p of parents) children.set(p, [...(children.get(p) ?? []), row]);
  }
  const out: T[] = [];
  const queue = rows.filter((r) => waiting.get(idOf(r)) === 0);
  for (let i = 0; i < queue.length; i += 1) {
    const row = queue[i] as T;
    out.push(row);
    for (const child of children.get(idOf(row)) ?? []) {
      const left = (waiting.get(idOf(child)) ?? 0) - 1;
      waiting.set(idOf(child), left);
      if (left === 0) queue.push(child);
    }
  }
  if (out.length !== rows.length) {
    const stuck = rows.filter((r) => (waiting.get(idOf(r)) ?? 0) > 0).map(idOf);
    throw new CopyDataError(`self-reference cycle among rows ${stuck.slice(0, 5).join(', ')}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Values

/** Where a value sits, for error messages (never the value itself). */
export interface ValueSite {
  table: string;
  column: string;
  /** The row's primary key, as its canonical key. */
  rowKey: string;
}

/** Values changed by cleanText in one column (logged and reported by the tool). */
export interface SanitizeCounter {
  count: number;
}

/** A source value: its canonical cell and the parameter written to Postgres. */
export interface SourceValue {
  cell: string;
  param: string | number | boolean | null;
  /**
   * JSON re-encoded from the parsed value because cleanText changed it: numbers beyond
   * double precision in it are rounded, so the row is reported as re-encoded.
   */
  reencoded?: true;
}

function fail(site: ValueSite, why: string): never {
  throw new CopyDataError(`${site.table}.${site.column} of row ${site.rowKey}: ${why}`);
}

function typeName(raw: unknown): string {
  if (typeof raw === 'bigint') return 'integer';
  if (typeof raw === 'number') return 'real';
  if (raw instanceof Uint8Array) return 'blob';
  return typeof raw;
}

/** JSON with object keys sorted at every depth (numbers and strings as JSON.stringify). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

const textCell = (s: string) => `T${JSON.stringify(s)}`;
const numberCell = (prefix: 'I' | 'R', n: number) => `${prefix}${String(n)}`;
const jsonCell = (value: unknown) => `J${canonicalJson(value)}`;

/** `value` with cleanText applied to every string and key; `changed` counts the edits. */
function cleanJson(value: unknown, changed: { n: number }): unknown {
  if (typeof value === 'string') {
    const clean = cleanText(value);
    if (clean !== value) changed.n += 1;
    return clean;
  }
  if (Array.isArray(value)) return value.map((v) => cleanJson(v, changed));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = cleanText(k);
      if (key !== k) changed.n += 1;
      out[key] = cleanJson(v, changed);
    }
    return out;
  }
  return value;
}

function toSafeNumber(raw: bigint, site: ValueSite): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) fail(site, 'integer outside the safe integer range');
  return n;
}

/**
 * One SQLite value (read with safe integers: every INTEGER arrives as a bigint) as its cell
 * and the parameter to insert. Refuses anything Postgres would store as something else: a
 * value of the wrong storage class (SQLite's typing is per value), an integer beyond 2^53, a
 * boolean other than 0/1, text that is not valid JSON in a JSON column.
 */
export function fromSqlite(
  kind: ColumnKind,
  raw: unknown,
  site: ValueSite,
  sanitized: SanitizeCounter,
): SourceValue {
  if (raw === null || raw === undefined) return { cell: 'N', param: null };
  switch (kind) {
    case 'text': {
      if (typeof raw !== 'string') fail(site, `expected text, found ${typeName(raw)}`);
      const clean = cleanText(raw);
      if (clean !== raw) sanitized.count += 1;
      return { cell: textCell(clean), param: clean };
    }
    case 'json': {
      if (typeof raw !== 'string') fail(site, `expected JSON text, found ${typeName(raw)}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fail(site, 'invalid JSON');
      }
      const changed = { n: 0 };
      const clean = cleanJson(parsed, changed);
      if (changed.n > 0) {
        sanitized.count += 1;
        return { cell: jsonCell(clean), param: JSON.stringify(clean), reencoded: true };
      }
      // The source text itself: jsonb keeps numbers exactly as written (a re-encoding would
      // round beyond 2^53) and the text 'null' becomes jsonb null, not SQL NULL.
      return { cell: jsonCell(parsed), param: raw };
    }
    case 'int': {
      if (typeof raw !== 'bigint') fail(site, `expected an integer, found ${typeName(raw)}`);
      const n = toSafeNumber(raw, site);
      return { cell: numberCell('I', n), param: n };
    }
    case 'real': {
      const n = typeof raw === 'bigint' ? toSafeNumber(raw, site) : raw;
      if (typeof n !== 'number') fail(site, `expected a number, found ${typeName(raw)}`);
      return { cell: numberCell('R', n), param: n };
    }
    case 'bool': {
      if (raw !== 0n && raw !== 1n) fail(site, 'boolean column holds a value other than 0 or 1');
      return { cell: raw === 1n ? 'B1' : 'B0', param: raw === 1n };
    }
  }
}

/** One value as node-postgres returns it (db/client's parsers), as its cell. */
export function fromPg(kind: ColumnKind, raw: unknown): string {
  if (raw === null || raw === undefined) return 'N';
  switch (kind) {
    case 'text':
      return textCell(String(raw));
    case 'json':
      return jsonCell(typeof raw === 'string' ? JSON.parse(raw) : raw);
    case 'int':
      return numberCell('I', Number(raw));
    case 'real':
      return numberCell('R', Number(raw));
    case 'bool':
      return raw === true ? 'B1' : 'B0';
  }
}

/** The canonical key of a row: its primary key cells. */
export function rowKey(spec: TableSpec, cells: Map<string, string>): string {
  return JSON.stringify(spec.pk.map((c) => cells.get(c) ?? 'N'));
}

/** The canonical line of a row: every cell in column order. */
export function rowLine(spec: TableSpec, cells: Map<string, string>): string {
  return JSON.stringify(spec.columns.map((c) => cells.get(c.name) ?? 'N'));
}

export interface TableChecksum {
  rows: number;
  /** SHA-256 hex over the canonical rows in primary-key order. */
  checksum: string;
}

/** The checksum of one table's rows, added in any order. */
export class TableDigest {
  readonly #lines = new Map<string, string>();

  constructor(readonly table: string) {}

  add(key: string, line: string): void {
    if (this.#lines.has(key)) {
      throw new CopyDataError(`${this.table}: duplicate primary key ${key}`);
    }
    this.#lines.set(key, line);
  }

  finish(): TableChecksum {
    const hash = createHash('sha256');
    const keys = [...this.#lines.keys()].sort();
    for (const key of keys) hash.update(`${this.#lines.get(key) ?? ''}\n`);
    return { rows: keys.length, checksum: hash.digest('hex') };
  }
}

// ---------------------------------------------------------------------------
// Vault envelopes

export interface SealedEnvelope {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

/**
 * A value that names a `ciphertext` key (so it was meant to be a sealed envelope) but is not
 * one, either because it is not valid JSON or because the parsed JSON does not match the
 * envelope shape (#148). There is no other legitimate use of that field name to carve out:
 * `ciphertext` appears nowhere else in this codebase except secretBox's own envelope, the
 * `secrets` table, and the two places (here and the redaction lists) that know about it. The
 * vault check this feeds exists to prove the copy; a value it cannot even parse is exactly
 * the thing it must refuse on rather than quietly treat as "not an envelope".
 */
export class MalformedEnvelope extends Error {
  override name = 'MalformedEnvelope';
}

function asEnvelope(value: unknown): SealedEnvelope | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  return typeof v.ciphertext === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.tag === 'string' &&
    typeof v.keyVersion === 'number'
    ? { ciphertext: v.ciphertext, iv: v.iv, tag: v.tag, keyVersion: v.keyVersion }
    : undefined;
}

function parseEnvelope(text: string): SealedEnvelope | undefined {
  if (!text.startsWith('{') || !text.includes('"ciphertext"')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new MalformedEnvelope(
      `names a ciphertext key but is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const sealed = asEnvelope(parsed);
  if (sealed === undefined) {
    throw new MalformedEnvelope(
      'names a ciphertext key but is not a sealed envelope (wrong shape)',
    );
  }
  return sealed;
}

/**
 * Every secretBox envelope in a decoded value: a text value holding one as JSON
 * (users.totp_secret), or one inside a JSON value, as an object or as a JSON string
 * (settings' sealedSecret). Paths are JSONPath-like ('$', '$.key', '$.list[0]').
 */
export function sealedEnvelopes(
  value: unknown,
  path = '$',
): { path: string; sealed: SealedEnvelope }[] {
  if (typeof value === 'string') {
    const sealed = parseEnvelope(value);
    return sealed === undefined ? [] : [{ path, sealed }];
  }
  const direct = asEnvelope(value);
  if (direct !== undefined) return [{ path, sealed: direct }];
  if (Array.isArray(value)) return value.flatMap((v, i) => sealedEnvelopes(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => sealedEnvelopes(v, `${path}.${k}`));
  }
  return [];
}
