// The database seam (db/client.ts), on the dialect this run uses: SQLite by default, Postgres
// when Task 13's matrix sets DB_DIALECT=postgres, TEST_DB_DIALECT=postgres and
// TEST_DATABASE_URL (each test then gets a scratch database). The Postgres client's protocol
// is also pinned without a server in test/dbClientPg.test.ts.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresConfig, type DbConfig } from '../src/config';
import {
  closeDatabase,
  connectDatabase,
  isUniqueViolation,
  pingDatabase,
  rawAll,
  rawGet,
  withTransaction,
  type DbHandle,
} from '../src/db/client';
import { settings, users } from '../src/db/schema';
import { decodeJson } from '../src/db/dialect';
import { onSlowTransaction, SLOW_TRANSACTION_MS, type SlowTransaction } from '../src/db/gate';
import { testDialect } from './db';
import { createScratchDatabase } from './pgScratch';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(): Promise<DbHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'opportun-dbclient-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let db: DbConfig = { dialect: 'sqlite' };
  if (testDialect === 'postgres') {
    const scratch = await createScratchDatabase();
    cleanups.push(scratch.drop);
    db = new PostgresConfig(scratch.url, 4, 'disable');
  }
  const handle = await connectDatabase({ dataDir: dir, db });
  let closed = false;
  cleanups.push(async () => {
    if (!closed) await closeDatabase(handle);
  });
  return Object.assign(handle, {
    close: async () => {
      closed = true;
      await closeDatabase(handle);
    },
  });
}

const user = (id: string, createdAt = 0) => ({
  id,
  email: 'same@example.com',
  passwordHash: 'x',
  displayName: 'U',
  createdAt,
  updatedAt: createdAt,
});

describe(`db client seam (${testDialect})`, () => {
  it('pings an open connection and refuses after close', async () => {
    const h = await open();
    expect(await pingDatabase(h)).toBe(true);
    await (h as DbHandle & { close: () => Promise<void> }).close();
    await expect(pingDatabase(h)).rejects.toThrow();
  });

  it('recognizes the driver unique violation and nothing else', async () => {
    const { db } = await open();
    await db.insert(users).values(user('u1')).run();
    let caught: unknown;
    try {
      await db.insert(users).values(user('u2')).run();
    } catch (err) {
      caught = err;
    }
    expect(isUniqueViolation(caught)).toBe(true);
    // Also when still wrapped by drizzle (e.g. a driver error surfacing through another path).
    expect(isUniqueViolation(new DrizzleQueryError('insert', [], caught as Error))).toBe(true);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(
      isUniqueViolation(Object.assign(new Error('fk'), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })),
    ).toBe(false);
    expect(isUniqueViolation(Object.assign(new Error('fk'), { code: '23503' }))).toBe(false);
    expect(isUniqueViolation('SQLITE_CONSTRAINT_UNIQUE')).toBe(false);
  });

  it('surfaces driver errors unwrapped, so no SQL or bound parameter reaches a log line', async () => {
    const { db } = await open();
    await db
      .insert(users)
      .values({ ...user('u1'), passwordHash: 'secret-hash-value' })
      .run();
    const err = await db
      .insert(users)
      .values({ ...user('u2'), passwordHash: 'secret-hash-value' })
      .run()
      .then(
        () => undefined,
        (e: unknown) => e as Error & { code?: string },
      );
    expect(err).not.toBeInstanceOf(DrizzleQueryError);
    expect(err?.code).toBe(testDialect === 'sqlite' ? 'SQLITE_CONSTRAINT_UNIQUE' : '23505');
    expect(err?.message).not.toContain('secret-hash-value');
  });

  it('epoch-ms timestamps and counts arrive as numbers', async () => {
    const { db } = await open();
    const ms = 1792195200017;
    await db.insert(users).values(user('u1', ms)).run();
    const row = await db.select({ createdAt: users.createdAt }).from(users).get();
    expect(row?.createdAt).toBe(ms);
    const count = await rawGet<{ n: unknown }>(db, sql`SELECT count(*) AS n FROM users`);
    expect(count?.n).toBe(1);
  });

  it('JSON values round-trip exactly, strings that look like JSON included', async () => {
    const { db } = await open();
    const values: unknown[] = ['123', 'true', '"quoted"', '[1,2]', 123, true, ['a'], { a: '1' }];
    for (const [i, value] of values.entries()) {
      await db
        .insert(settings)
        .values({ key: `k${i}`, value, updatedAt: 0 })
        .run();
    }
    const rows = await db.select().from(settings).all();
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    expect(values.map((_, i) => byKey.get(`k${i}`))).toEqual(values);
    const raw = await rawAll<{ key: string; value: unknown }>(
      db,
      sql`SELECT key, value FROM settings ORDER BY key`,
    );
    const rawByKey = new Map(raw.map((r) => [r.key, decodeJson(r.value)]));
    expect(values.map((_, i) => rawByKey.get(`k${i}`))).toEqual(values);
  });

  it.runIf(testDialect === 'postgres')(
    'a scope serializes transactions holding it, and only those',
    async () => {
      const { db } = await open();
      const order: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const body = (name: string, wait?: Promise<void>) => async () => {
        order.push(`${name}:in`);
        if (wait !== undefined) await wait;
        order.push(`${name}:out`);
      };
      const a = withTransaction(db, body('a', held), { scope: 'user:same' });
      // Let a take its lock before the others start.
      while (!order.includes('a:in')) await new Promise((r) => setTimeout(r, 5));
      const b = withTransaction(db, body('b'), { scope: 'user:same' });
      await withTransaction(db, body('c'), { scope: 'user:other' });
      expect(order).toEqual(['a:in', 'c:in', 'c:out']);
      release();
      await Promise.all([a, b]);
      expect(order).toEqual(['a:in', 'c:in', 'c:out', 'a:out', 'b:in', 'b:out']);
    },
  );
});

describe.runIf(testDialect === 'postgres')('transaction timing guard on Postgres', () => {
  it('flags a body that waits outside the database, not one that waits for a connection', async () => {
    const { db } = await open(); // pool of 4
    const reports: SlowTransaction[] = [];
    onSlowTransaction((s) => reports.push(s));
    // Four bodies busy in the database (pg_sleep) hold every pooled connection; the fifth
    // waits ~400 ms for one before its BEGIN. Neither kind of wait is the body's own.
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withTransaction(db, async (tx) => {
          await rawAll(tx, sql`SELECT pg_sleep(0.4)`);
        }),
      ),
    );
    expect(reports.filter((r) => r.awaitedOutside)).toEqual([]);
    // A body awaiting a timer is flagged.
    await withTransaction(db, async () => {
      await new Promise((r) => setTimeout(r, SLOW_TRANSACTION_MS + 100));
    });
    expect(reports.filter((r) => r.awaitedOutside)).toHaveLength(1);
  });
});
