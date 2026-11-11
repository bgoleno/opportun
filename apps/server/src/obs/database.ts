// The database boundary (design.md 14.2, 14.4, 14.11; https://github.com/bgoleno/opportun/issues/343).
// db/client.ts calls these at its execution choke points: `execute` and `onConnection` on
// SQLite, the patched `queryWithCache` on Postgres. Each statement records
// db.client.operation.duration with the statement's verb and its first table, never its text,
// and no span (a discovery run makes thousands of queries: 14.2).
//
// Cost (14.11): with collection off, one check. With it on, the verb and table are read once per
// distinct statement text and kept, so a repeated statement costs a map lookup. The store's own
// writes run suppressed and are not measured (14.6).
import { checkValue } from './gate';
import { ATTRIBUTE_TYPES, DB_OPERATIONS, OTHER } from './catalog';
import {
  isCollecting,
  isSuppressed,
  obs,
  type PreparedRecord,
  prepareRecord,
  recordPrepared,
} from './index';
import { errorType } from './outbound';

export type DbSystem = 'sqlite' | 'postgresql';

export interface StatementShape {
  /** The first keyword (db.operation.name), or OTHER. */
  operation: string;
  /** The first table after FROM, INTO, UPDATE or TABLE (db.collection.name), OTHER for a name
   *  the schema does not have, absent when the statement names none. */
  table?: string;
}

// Read on first use, never at load (the catalog may still be initialising: obs/outbound.ts).
let operations: ReadonlySet<string> | undefined;
const FIRST_WORD = /^\s*([A-Za-z]+)/;
// One identifier after the keyword, optionally quoted: no nested quantifier.
const FIRST_TABLE = /\b(?:FROM|INTO|UPDATE|TABLE)\s+["`]?([A-Za-z_][A-Za-z0-9_]*)/i;
const SHAPES_MAX = 1_000; // design 14.4: a cache of 1,000 entries
// SQL functions whose arguments use FROM without naming a table: `extract(epoch from col)` and
// `substring(s from 2 for 3)`. FIRST_TABLE read that FROM as one (#371).
const FROM_FUNCTION = /\b(?:extract|substring)\s*\(/gi;

/**
 * The text with each extract(...) and substring(...) call's arguments removed, up to its
 * matching parenthesis (they can nest: `extract(epoch from now())`). A scan, not a pattern, so a
 * nested call cannot make it backtrack; the texts are the code's own statements.
 */
function withoutFromFunctions(text: string): string {
  let out = '';
  let at = 0;
  for (const m of text.matchAll(FROM_FUNCTION)) {
    const open = m.index + m[0].length - 1;
    if (open < at) continue; // inside a call already removed
    let depth = 0;
    let close = text.length;
    for (let i = open; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c === 40)
        depth += 1; // (
      else if (c === 41 && --depth === 0) {
        close = i; // )
        break;
      }
    }
    out += `${text.slice(at, open)}()`;
    at = close + 1;
  }
  return at === 0 ? text : out + text.slice(at);
}
const shapes = new Map<string, StatementShape>();

/** A statement's verb and first table. Pure, and cached by text (bounded). */
export function statementShape(text: string): StatementShape {
  const known = shapes.get(text);
  if (known !== undefined) return known;
  const verb = FIRST_WORD.exec(text)?.[1]?.toUpperCase() ?? '';
  const operation = (operations ??= new Set<string>(DB_OPERATIONS)).has(verb) ? verb : OTHER;
  const name = FIRST_TABLE.exec(withoutFromFunctions(text))?.[1];
  const tableType = ATTRIBUTE_TYPES.get('db.collection.name');
  const table =
    name === undefined
      ? undefined
      : tableType !== undefined && checkValue(tableType, name) !== undefined
        ? name
        : OTHER;
  const shape: StatementShape = table === undefined ? { operation } : { operation, table };
  // Statement texts are the code's own, so they are few; the bound is for safety only.
  if (shapes.size < SHAPES_MAX) shapes.set(text, shape);
  return shape;
}

function attributesOf(system: DbSystem, text: string): Record<string, unknown> {
  const { operation, table } = statementShape(text);
  return {
    'db.system.name': system,
    'db.operation.name': operation,
    ...(table === undefined ? {} : { 'db.collection.name': table }),
  };
}

/**
 * A successful statement's record, prepared once per text and system: a repeated statement
 * skips the gate and the series key (14.11: under 2 microseconds after the first sight of its
 * text). Bounded like the shapes, per system; past the bound, statements are recorded the
 * ordinary way.
 */
const prepared = new Map<DbSystem, Map<string, PreparedRecord>>();

function record(system: DbSystem, text: string, started: number, err?: unknown): void {
  const seconds = (performance.now() - started) / 1000;
  if (err !== undefined) {
    // Rare, and its error.type varies: recorded the ordinary way.
    obs.record('db.client.operation.duration', seconds, {
      ...attributesOf(system, text),
      'error.type': errorType(err),
    });
    return;
  }
  // A map per system, keyed by the text itself: no key string to build per statement (#371).
  let bySystem = prepared.get(system);
  if (bySystem === undefined) {
    bySystem = new Map();
    prepared.set(system, bySystem);
  }
  let p = bySystem.get(text);
  if (p === undefined) {
    p = prepareRecord('db.client.operation.duration', attributesOf(system, text));
    if (bySystem.size < SHAPES_MAX) bySystem.set(text, p);
  }
  recordPrepared(p, seconds);
}

/** Runs a synchronous statement (SQLite) and records it. */
export function observeStatement<T>(system: DbSystem, text: string, run: () => T): T {
  if (!isCollecting() || isSuppressed()) return run();
  const started = performance.now();
  let result: T;
  try {
    result = run();
  } catch (err) {
    record(system, text, started, err);
    throw err;
  }
  record(system, text, started);
  return result;
}

/**
 * Runs an asynchronous statement (Postgres) and records it when it settles. `run` is called
 * synchronously, so the statement starts in the caller's step as it did before.
 */
export function observeStatementAsync<T>(
  system: DbSystem,
  text: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!isCollecting() || isSuppressed()) return run();
  const started = performance.now();
  return run().then(
    (value) => {
      record(system, text, started);
      return value;
    },
    (err: unknown) => {
      record(system, text, started, err);
      throw err;
    },
  );
}
