// Dialect SQL helpers (iteration 4 Task 10). Each case runs the helper inside a query and
// checks the output: on SQLite always, on Postgres when TEST_DATABASE_URL is set (Task 13's
// matrix). Without a server, the Postgres SQL of every helper is compiled and pinned here, so
// a change to it is a deliberate, reviewed change. Same inputs, same expected outputs: a case
// that passes on SQLite and fails on Postgres is a bug in the helper, never in the test.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, rawAll, rawRun, type SqliteHandle } from '../src/db/client';
import {
  ascNullsFirst,
  claimJobSql,
  claimNextJob,
  countAll,
  descNullsLast,
  dialectSql,
  type DialectSql,
} from '../src/db/dialect';
import type { DbDialect } from '../src/db/dialectName';
import * as pgTables from '../src/db/schema.pg';
import { livePgUrl, withScratchDatabase } from './pgScratch';
import { sqliteOnly } from './db';

/** A JSON literal as the dialect stores JSON columns (text vs jsonb). */
function json(d: DbDialect, value: unknown): SQL {
  const text = JSON.stringify(value);
  return d === 'postgres' ? sql`${text}::jsonb` : sql`${text}`;
}

interface Case {
  name: string;
  query: (h: DialectSql, d: DbDialect) => SQL;
  /** Rows as returned, after normalizing booleans to true/false and numbers to numbers. */
  expected: Record<string, unknown>[];
}

const MIDNIGHT = Date.UTC(2026, 9, 17); // 2026-10-17T00:00:00Z

const CASES: Case[] = [
  {
    name: 'ilike: case-insensitive substring',
    query: (h) => sql`SELECT ${h.ilike(sql`'Senior Product MANAGER'`, 'manager')} AS hit`,
    expected: [{ hit: true }],
  },
  {
    name: 'ilike: %, _ and \\ in the needle are literal',
    query: (h) =>
      sql`SELECT ${h.ilike(sql`'100% sure'`, '0%')} AS a, ${h.ilike(sql`'1000 sure'`, '0%')} AS b,
                 ${h.ilike(sql`'a_b'`, '_')} AS c, ${h.ilike(sql`'ab'`, '_')} AS d,
                 ${h.ilike(sql`'C:\\dir'`, ':\\d')} AS e`,
    expected: [{ a: true, b: false, c: true, d: false, e: true }],
  },
  {
    name: 'jsonContains: case-insensitive substring of a JSON column',
    query: (h, d) =>
      sql`SELECT ${h.jsonContains(json(d, ['Ann@Example.com', 'b@x.org']), 'ann@example')} AS hit,
                 ${h.jsonContains(json(d, ['b@x.org']), 'ann@')} AS miss`,
    expected: [{ hit: true, miss: false }],
  },
  {
    name: 'jsonText: string and number values both read as text',
    query: (h, d) =>
      sql`SELECT ${h.jsonText(json(d, { id: 'x-1', n: 42 }), 'id')} AS s,
                 ${h.jsonText(json(d, { id: 'x-1', n: 42 }), 'n')} AS n,
                 ${h.jsonText(json(d, { id: 'x-1' }), 'missing')} AS m,
                 ${h.jsonText(json(d, { id: null }), 'id')} AS nul`,
    expected: [{ s: 'x-1', n: '42', m: null, nul: null }],
  },
  {
    name: 'jsonArrayHasObjectWith: matches an object element by key, never a string element',
    query: (h, d) => {
      const list = json(d, ['Alice', { contactId: 'c1', name: 'Bob' }]);
      return sql`SELECT ${h.jsonArrayHasObjectWith(list, 'contactId', 'c1')} AS yes,
                        ${h.jsonArrayHasObjectWith(list, 'contactId', 'c2')} AS no,
                        ${h.jsonArrayHasObjectWith(json(d, ['c1']), 'contactId', 'c1')} AS str`;
    },
    expected: [{ yes: true, no: false, str: false }],
  },
  {
    name: 'jsonObject + decodeJson: a round trip with nested JSON and NULL',
    query: (h, d) =>
      sql`SELECT ${h.jsonObject([
        ['title', sql`'Call'`],
        ['note', sql`NULL`],
        ['n', sql`7`],
        ['participants', h.jsonValue(json(d, ['Ann', { contactId: 'c1', name: 'Bo' }]))],
      ])} AS data`,
    expected: [
      {
        data: {
          title: 'Call',
          note: null,
          n: 7,
          participants: ['Ann', { contactId: 'c1', name: 'Bo' }],
        },
      },
    ],
  },
  {
    name: 'utcDay: buckets epoch ms by UTC day across midnight',
    query: (h) =>
      sql`SELECT ${h.utcDay(sql`${MIDNIGHT - 1}`)} AS before, ${h.utcDay(sql`${MIDNIGHT}`)} AS at,
                 ${h.utcDay(sql`${MIDNIGHT + 86_399_999}`)} AS last`,
    expected: [{ before: '2026-10-16', at: '2026-10-17', last: '2026-10-17' }],
  },
  {
    name: 'maxBoolAsInt: 1 when any row is true, 0 when none or no rows',
    query: (h, d) => {
      const t = d === 'postgres' ? sql`TRUE` : sql`1`;
      const f = d === 'postgres' ? sql`FALSE` : sql`0`;
      return sql`SELECT (SELECT ${h.maxBoolAsInt(sql`b`)} FROM (SELECT ${f} AS b UNION ALL SELECT ${t}) AS x) AS some,
                        (SELECT ${h.maxBoolAsInt(sql`b`)} FROM (SELECT ${f} AS b) AS x) AS none,
                        (SELECT ${h.maxBoolAsInt(sql`b`)} FROM (SELECT ${f} AS b) AS x WHERE 1 = 0) AS empty`;
    },
    expected: [{ some: 1, none: 0, empty: 0 }],
  },
];

/** Rows from either engine, normalized: SQLite 0/1 booleans vs Postgres booleans. */
function normalize(rows: Record<string, unknown>[], expected: Record<string, unknown>[]) {
  return rows.map((row, i) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => {
        const want = expected[i]?.[k];
        if (typeof want === 'boolean' && (v === 0 || v === 1)) return [k, v === 1];
        if (typeof want === 'number' && typeof v === 'string') return [k, Number(v)];
        if (typeof want === 'object' && want !== null && typeof v === 'string') {
          return [k, JSON.parse(v) as unknown];
        }
        return [k, v];
      }),
    ),
  );
}

const ORDER_ROWS = sql`(SELECT NULL AS v, 'n' AS id UNION ALL SELECT 2, 'b' UNION ALL SELECT 1, 'a') AS t`;

// The SQLite engine itself (better-sqlite3 opened directly): SQLite runs only.
describe.runIf(sqliteOnly)('dialect helpers on SQLite', () => {
  let dir: string;
  let handle: SqliteHandle;
  const h = dialectSql('sqlite');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opportun-dialect-'));
    handle = openDatabase(dir);
  });

  afterAll(async () => {
    await closeDatabase(handle);
    await rm(dir, { recursive: true, force: true });
  });

  it.each(CASES)('$name', async (c) => {
    const rows = await rawAll<Record<string, unknown>>(handle.db, c.query(h, 'sqlite'));
    expect(normalize(rows, c.expected)).toEqual(c.expected);
  });

  it('decodeJson reads a JSON column value as the driver returns it', () => {
    expect(h.decodeJson('{"a":[1,"x"]}')).toEqual({ a: [1, 'x'] });
    expect(h.decodeJson('"text"')).toBe('text');
  });

  it('pins NULLs first ascending and last descending', async () => {
    const asc = await rawAll<{ id: string }>(
      handle.db,
      sql`SELECT id FROM ${ORDER_ROWS} ORDER BY ${ascNullsFirst(sql`v`)}`,
    );
    const desc = await rawAll<{ id: string }>(
      handle.db,
      sql`SELECT id FROM ${ORDER_ROWS} ORDER BY ${descNullsLast(sql`v`)}`,
    );
    expect(asc.map((r) => r.id)).toEqual(['n', 'a', 'b']);
    expect(desc.map((r) => r.id)).toEqual(['b', 'a', 'n']);
  });

  it('claimNextJob claims the oldest due job once and decodes its payload', async () => {
    const insert = (id: string, runAt: number, payload: string) =>
      rawRun(
        handle.db,
        sql`INSERT INTO jobs (id, kind, payload, run_at, attempts, max_attempts, status, created_at, updated_at)
            VALUES (${id}, 'k', ${payload}, ${runAt}, 0, 3, 'pending', 0, 0)`,
      );
    await insert('j-late', 20, '{"n":2}');
    await insert('j-early', 10, '{"n":1}');
    await insert('j-bad', 15, 'not json');
    await insert('j-future', 1_000, '{}');
    const first = await claimNextJob(handle.db, 'w1', 100);
    expect(first).toEqual({
      id: 'j-early',
      kind: 'k',
      payload: { n: 1 },
      attempts: 1,
      maxAttempts: 3,
      userId: null,
    });
    expect((await claimNextJob(handle.db, 'w2', 100))?.payload).toBeUndefined(); // j-bad
    expect((await claimNextJob(handle.db, 'w1', 100))?.id).toBe('j-late');
    expect(await claimNextJob(handle.db, 'w1', 100)).toBeUndefined();
    const locked = await rawAll<{ id: string; locked_by: string }>(
      handle.db,
      sql`SELECT id, locked_by FROM jobs WHERE status = 'running' ORDER BY id`,
    );
    expect(locked).toEqual([
      { id: 'j-bad', locked_by: 'w2' },
      { id: 'j-early', locked_by: 'w1' },
      { id: 'j-late', locked_by: 'w1' },
    ]);
  });

  it('countAll reads as a number', async () => {
    const rows = await rawAll<{ n: unknown }>(
      handle.db,
      sql`SELECT ${countAll()} AS n FROM ${ORDER_ROWS}`,
    );
    expect(rows).toEqual([{ n: 3 }]);
  });
});

describe('dialect helpers: Postgres SQL (compiled, no server)', () => {
  const h = dialectSql('postgres');
  const compile = (q: SQL) => new PgDialect().sqlToQuery(q);

  it('ilike uses ILIKE with a literal backslash escape and a bound pattern', () => {
    expect(compile(h.ilike(sql`"name"`, '50%_off'))).toMatchObject({
      sql: `"name" ILIKE $1 ESCAPE '\\'`,
      params: ['%50\\%\\_off%'],
    });
  });

  it('ilike casts a jsonb column to text (no ILIKE on jsonb); jsonContains always does', () => {
    expect(compile(h.ilike(pgTables.contacts.emails, 'ann'))).toMatchObject({
      sql: `("contacts"."emails")::text ILIKE $1 ESCAPE '\\'`,
      params: ['%ann%'],
    });
    expect(compile(h.ilike(pgTables.contacts.name, 'ann')).sql).toBe(
      `"contacts"."name" ILIKE $1 ESCAPE '\\'`,
    );
    expect(compile(h.jsonContains(sql`x`, 'ann')).sql).toBe(`(x)::text ILIKE $1 ESCAPE '\\'`);
  });

  it('jsonText reads ->> with an inline, validated key', () => {
    expect(compile(h.jsonText(sql`"posting"`, 'externalId')).sql).toBe(
      `("posting" ->> 'externalId')`,
    );
    expect(() => h.jsonText(sql`"posting"`, "x'); DROP TABLE users; --")).toThrow(/JSON key/);
  });

  it('jsonArrayHasObjectWith walks jsonb_array_elements', () => {
    expect(compile(h.jsonArrayHasObjectWith(sql`"participants"`, 'contactId', 'c1'))).toMatchObject(
      {
        sql: `EXISTS (SELECT 1 FROM jsonb_array_elements("participants") AS p(value) WHERE jsonb_typeof(p.value) = 'object' AND p.value ->> 'contactId' = $1)`,
        params: ['c1'],
      },
    );
  });

  it('jsonObject builds jsonb_build_object; jsonValue passes jsonb through', () => {
    expect(
      compile(
        h.jsonObject([
          ['a', sql`x`],
          ['b', h.jsonValue(sql`y`)],
        ]),
      ).sql,
    ).toBe(`jsonb_build_object('a', x, 'b', y)`);
    expect(() => h.jsonObject([["it's", sql`x`]])).toThrow(/JSON key/);
  });

  it('decodeJson parses the text form once, like SQLite', () => {
    expect(h.decodeJson('{"a":1}')).toEqual({ a: 1 });
    // A stored JSON string stays a string, even when it looks like JSON itself.
    expect(h.decodeJson('"123"')).toBe('123');
    expect(h.decodeJson('"[1,2]"')).toBe('[1,2]');
  });

  it('utcDay formats in UTC, with no bound parameter (it is grouped by)', () => {
    expect(compile(h.utcDay(sql`"created_at"`))).toMatchObject({
      sql: `to_char(to_timestamp("created_at" / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      params: [],
    });
  });

  it('maxBoolAsInt casts the boolean before max()', () => {
    expect(compile(h.maxBoolAsInt(sql`"fallback_pricing"`)).sql).toBe(
      `coalesce(max(("fallback_pricing")::int), 0)`,
    );
  });

  it('the job claim skips rows another worker has locked', () => {
    const pgClaim = compile(claimJobSql('w1', 5, 'postgres')).sql.replace(/\s+/g, ' ');
    expect(pgClaim).toContain('ORDER BY run_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED)');
    const liteClaim = new PgDialect().sqlToQuery(claimJobSql('w1', 5, 'sqlite')).sql;
    expect(liteClaim).not.toContain('SKIP LOCKED');
  });

  it('ordering and count helpers are the same SQL on both dialects', () => {
    expect(compile(ascNullsFirst(sql`v`)).sql).toBe('v ASC NULLS FIRST');
    expect(compile(descNullsLast(sql`v`)).sql).toBe('v DESC NULLS LAST');
    expect(compile(countAll()).sql).toBe('count(*)');
  });
});

describe.runIf(livePgUrl !== undefined)('dialect helpers on Postgres (live)', () => {
  const h = dialectSql('postgres');
  const compile = (q: SQL) => new PgDialect().sqlToQuery(q);

  it('every case returns the SQLite results', async () => {
    await withScratchDatabase(async (url) => {
      const pool = new pg.Pool({ connectionString: url });
      try {
        for (const c of CASES) {
          const q = compile(c.query(h, 'postgres'));
          const res = await pool.query(q.sql, q.params);
          expect(normalize(res.rows as Record<string, unknown>[], c.expected), c.name).toEqual(
            c.expected,
          );
        }
        const asc = compile(sql`SELECT id FROM ${ORDER_ROWS} ORDER BY ${ascNullsFirst(sql`v`)}`);
        const desc = compile(sql`SELECT id FROM ${ORDER_ROWS} ORDER BY ${descNullsLast(sql`v`)}`);
        expect(
          (await pool.query(asc.sql, asc.params)).rows.map((r: { id: string }) => r.id),
        ).toEqual(['n', 'a', 'b']);
        expect(
          (await pool.query(desc.sql, desc.params)).rows.map((r: { id: string }) => r.id),
        ).toEqual(['b', 'a', 'n']);
      } finally {
        await pool.end();
      }
    });
  });
});
