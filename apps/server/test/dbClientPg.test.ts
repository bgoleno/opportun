// The Postgres branch of the database seam (iteration 4 Task 9), against the recorded fake
// (test/fakePg.ts): no Postgres server is available to Wave 2. These tests pin the client's
// protocol: which statements run, on which pooled connection, in which order, and how the
// results reach the repos (the terminal shim, raw helpers, counts, int8 as number, unwrapped
// driver errors). Postgres semantics themselves are proven by Task 13's matrix, which runs
// test/dbClient.test.ts and the whole suite against postgres:16.
import { and, DrizzleQueryError, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakePgPool, OID, pgError, type FakeQuery, type FakeResult } from './fakePg';

type Client = typeof import('../src/db/client');
type Schema = typeof import('../src/db/schema');
type Config = typeof import('../src/config');

let client: Client;
let schema: Schema;
let config: Config;

beforeAll(async () => {
  // A fresh module graph whose tables are the Postgres twin (db/schema reads DB_DIALECT).
  // This file runs under vitest.config.ts's `forks` project (issue #298): process.env here
  // is genuinely per-process, not shared with any sibling test file the way threads are.
  // eslint-disable-next-line no-restricted-syntax -- forks-isolated, see the comment above
  vi.stubEnv('DB_DIALECT', 'postgres');
  vi.resetModules();
  client = await import('../src/db/client');
  schema = await import('../src/db/schema');
  config = await import('../src/config');
});

afterAll(() => {
  // eslint-disable-next-line no-restricted-syntax -- forks-isolated, see beforeAll above
  vi.unstubAllEnvs();
  vi.resetModules();
});

const HEAD = 1792195200017;

/** Answers the boot-time statements: migrations up to date, a C-collated database. */
function bootResponder(collate = 'C', provider = 'c') {
  return (q: FakeQuery): FakeResult | undefined => {
    if (/^SELECT created_at FROM "__drizzle_migrations"/.test(q.text)) {
      return { rows: [{ created_at: HEAD }] };
    }
    if (/FROM pg_database/.test(q.text)) {
      return { rows: [{ datcollate: collate, datctype: collate, datlocprovider: provider }] };
    }
    return undefined;
  };
}

async function open(
  respond: (q: FakeQuery) => FakeResult | Error | undefined = () => undefined,
  collate = 'C',
  provider = 'c',
) {
  const boot = bootResponder(collate, provider);
  const pool = new FakePgPool((q) => respond(q) ?? boot(q));
  const db = new config.PostgresConfig('postgres://opportun:pw@localhost/opportun', 5, 'disable');
  const handle = await client.connectDatabase(
    { dataDir: '/unused', db },
    { pool: pool as unknown as pg.Pool },
  );
  // Boot statements and the migration connection are not what the tests look at.
  pool.log.length = 0;
  pool.clients.length = 0;
  return { pool, handle, db: handle.db };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const userRow = (id: string) => ({
  id,
  email: `${id}@example.com`,
  passwordHash: 'x',
  displayName: 'U',
  createdAt: 1,
  updatedAt: 1,
});

describe('connectDatabase (postgres)', () => {
  it('migrates on a pooled connection and checks the collation', async () => {
    const { handle } = await open();
    expect(handle.dialect).toBe('postgres');
    expect(handle.dialect === 'postgres' && handle.warnings).toEqual([]);
  });

  it('warns when the database is not C-collated', async () => {
    const { handle } = await open(undefined, 'en_US.UTF-8');
    expect(handle.dialect === 'postgres' && handle.warnings.join('\n')).toMatch(
      /collation is en_US\.UTF-8, not C/,
    );
  });

  it('warns when the database collates with ICU, even with datcollate C', async () => {
    const { handle } = await open(undefined, 'C', 'i');
    expect(handle.dialect === 'postgres' && handle.warnings.join('\n')).toMatch(
      /locale provider is icu, not libc/,
    );
  });

  it('accepts only libc C/POSIX for both collate and ctype', () => {
    const ok = { datcollate: 'C', datctype: 'C', datlocprovider: 'c' };
    expect(client.collationProblem(ok)).toBeUndefined();
    expect(
      client.collationProblem({ ...ok, datcollate: 'POSIX', datctype: 'POSIX' }),
    ).toBeUndefined();
    expect(client.collationProblem({ ...ok, datlocprovider: 'i' })).toMatch(/icu/);
    expect(client.collationProblem({ ...ok, datlocprovider: 'b' })).toMatch(/builtin/);
    expect(client.collationProblem({ ...ok, datctype: 'en_US.UTF-8' })).toMatch(/en_US/);
    expect(client.collationProblem(undefined)).toMatch(/unknown/);
  });

  it('refuses a dialect that differs from the schema the process loaded', async () => {
    await expect(
      client.connectDatabase({ dataDir: '/unused', db: { dialect: 'sqlite' } }),
    ).rejects.toThrow(/DB_DIALECT=postgres: refusing to open the SQLite database/);
  });

  it('builds the pool settings from the config', () => {
    const cfg = (ssl: 'disable' | 'require' | 'verify-full') =>
      client.pgPoolConfig(new config.PostgresConfig('postgres://u:p@h/x', 7, ssl));
    expect(cfg('disable')).toMatchObject({
      connectionString: 'postgres://u:p@h/x',
      max: 7,
      ssl: false,
      statement_timeout: 30_000,
      application_name: 'opportun',
    });
    expect(cfg('require').ssl).toEqual({ rejectUnauthorized: false });
    expect(cfg('verify-full').ssl).toEqual({ rejectUnauthorized: true });
  });

  it('reads int8 and numeric as numbers, refusing int8 beyond 2^53', async () => {
    await open();
    expect(pg.types.getTypeParser(20)('1792195200017')).toBe(1792195200017);
    expect(pg.types.getTypeParser(1700)('12.5')).toBe(12.5);
    expect(() => pg.types.getTypeParser(20)('9007199254740993')).toThrow(/safe integer/);
  });
});

describe('terminal shim and raw helpers', () => {
  it('select .get()/.all() map rows like the SQLite driver', async () => {
    const { db } = await open((q) =>
      /^select "id", "email" from "users"/.test(q.text)
        ? {
            rows: [
              ['u1', 'a@x'],
              ['u2', 'b@x'],
            ],
          }
        : undefined,
    );
    const { users } = schema;
    const one = await db.select({ id: users.id, email: users.email }).from(users).get();
    expect(one).toEqual({ id: 'u1', email: 'a@x' });
    const all = await db.select({ id: users.id, email: users.email }).from(users).all();
    expect(all).toHaveLength(2);
  });

  it('bigint columns and counts arrive in text form and decode to numbers', async () => {
    const { db } = await open((q) => {
      if (/^select "created_at" from "users"/.test(q.text)) {
        return { rows: [['1792195200017']], fields: [{ name: 'created_at', oid: OID.INT8 }] };
      }
      if (/^SELECT count\(\*\) AS n/.test(q.text)) {
        return { rows: [{ n: '3' }], fields: [{ name: 'n', oid: OID.INT8 }] };
      }
      return undefined;
    });
    const { users } = schema;
    expect(await db.select({ createdAt: users.createdAt }).from(users).get()).toEqual({
      createdAt: 1792195200017,
    });
    expect(await client.rawGet(db, sql`SELECT count(*) AS n FROM users`)).toEqual({ n: 3 });
  });

  it('jsonb is decoded exactly once: string values that look like JSON stay strings', async () => {
    // What a column holds -> its jsonb text form as the server sends it.
    const values: unknown[] = [
      '123',
      'true',
      '"quoted"',
      '[1,2]',
      123,
      true,
      ['a'],
      { a: '1' },
      null,
    ];
    const { db } = await open((q) => {
      if (/^select "value" from "settings"/.test(q.text)) {
        return {
          rows: values.map((v) => [JSON.stringify(v)]),
          fields: [{ name: 'value', oid: OID.JSONB }],
        };
      }
      if (/^SELECT value FROM settings/.test(q.text)) {
        return {
          rows: values.map((v) => ({ value: JSON.stringify(v) })),
          fields: [{ name: 'value', oid: OID.JSONB }],
        };
      }
      return undefined;
    });
    const { settings } = schema;
    const builder = await db.select({ value: settings.value }).from(settings).all();
    expect(builder.map((r) => r.value)).toEqual(values);
    const { decodeJson } = await import('../src/db/dialect');
    const raw = await client.rawAll<{ value: unknown }>(db, sql`SELECT value FROM settings`);
    expect(raw.map((r) => decodeJson(r.value))).toEqual(values);
  });

  it('a miss is undefined, a write reports its row count through runCount', async () => {
    const { db, pool } = await open((q) => {
      if (/^select/.test(q.text)) return { rows: [] };
      if (/^update "users"/.test(q.text)) return { rows: [], rowCount: 3 };
      return undefined;
    });
    const { users } = schema;
    expect(await db.select({ id: users.id }).from(users).get()).toBeUndefined();
    const n = await client.runCount(db.update(users).set({ displayName: 'Z' }));
    expect(n).toBe(3);
    const update = pool.log.find((q) => q.text.startsWith('update'));
    expect(update?.params).toEqual(['Z']);
  });

  it('.returning().get() and insert .run()', async () => {
    const { db } = await open((q) => {
      if (/^insert into "users".*returning "id"/s.test(q.text)) return { rows: [['u9']] };
      if (/^insert into "users"/.test(q.text)) return { rows: [], rowCount: 1 };
      return undefined;
    });
    const { users } = schema;
    expect(await db.insert(users).values(userRow('u9')).returning({ id: users.id }).get()).toEqual({
      id: 'u9',
    });
    expect(await db.insert(users).values(userRow('u8')).run()).toEqual({ changes: 1 });
  });

  it('raw helpers return objects and the changed-row count', async () => {
    const { db, pool } = await open((q) => {
      if (/^SELECT key FROM settings WHERE key = \$1/.test(q.text)) {
        return { rows: [{ key: 'a' }, { key: 'b' }] };
      }
      if (/^DELETE FROM settings/.test(q.text)) return { rows: [], rowCount: 2 };
      return undefined;
    });
    expect(await client.rawAll(db, sql`SELECT key FROM settings WHERE key = ${'a'}`)).toEqual([
      { key: 'a' },
      { key: 'b' },
    ]);
    expect(await client.rawGet(db, sql`SELECT key FROM settings WHERE key = ${'a'}`)).toEqual({
      key: 'a',
    });
    expect(await client.rawRun(db, sql`DELETE FROM settings`)).toEqual({ changes: 2 });
    // Bound, never interpolated.
    expect(pool.log[0]?.params).toEqual(['a']);
  });

  it('binds a JSON compare-and-set through the jsonb encoder', async () => {
    const { db, pool } = await open(() => ({ rows: [] }));
    const { users } = schema;
    const previous = ['h1', 'h2'];
    await db
      .update(users)
      .set({ totpRecovery: ['h2'] })
      .where(and(eq(users.id, 'u1'), eq(users.totpRecovery, previous)))
      .returning({ id: users.id })
      .get();
    const q = pool.log[0];
    expect(q?.text).toMatch(/"totp_recovery" = \$\d/);
    // The stored and compared values are JSON text, which Postgres casts to jsonb: equality is
    // then jsonb equality (schema.pg.ts header).
    expect(q?.params).toContain(JSON.stringify(previous));
    expect(q?.params).toContain(JSON.stringify(['h2']));
  });
});

describe('transactions', () => {
  it('run on one checked-out connection, read committed, and release it', async () => {
    const { db, pool } = await open();
    const { settings } = schema;
    const result = await client.withTransaction(db, async (tx) => {
      await tx.insert(settings).values({ key: 'k', value: 1, updatedAt: 1 }).run();
      await client.rawRun(tx, sql`DELETE FROM settings WHERE key = ${'x'}`);
      return 'done';
    });
    expect(result).toBe('done');
    const [tx] = pool.clients;
    expect(pool.textsOf(tx?.id ?? -1).map((t) => t.split(' ').slice(0, 3).join(' '))).toEqual([
      'begin isolation level',
      'insert into "settings"',
      'DELETE FROM settings',
      'commit',
    ]);
    expect(pool.log.filter((q) => q.client === 0)).toEqual([]);
    expect(tx?.released).toBe(true);
  });

  it('roll back when the body throws, surfacing the error', async () => {
    const { db, pool } = await open();
    await expect(
      client.withTransaction(db, async () => {
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');
    expect(pool.textsOf(pool.clients[0]?.id ?? -1).at(-1)).toBe('rollback');
    expect(pool.clients[0]?.released).toBe(true);
    expect(pool.leaks).toEqual([]);
  });

  it('a scope takes pg_advisory_xact_lock(hashtext(scope)) first, on the transaction', async () => {
    const { db, pool } = await open();
    await client.withTransaction(
      db,
      async (tx) => {
        await client.rawGet(tx, sql`SELECT 1`);
      },
      { scope: 'user:u1' },
    );
    const texts = pool.textsOf(pool.clients[0]?.id ?? -1);
    expect(texts[1]).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
    expect(pool.log.find((q) => /advisory/.test(q.text))?.params).toEqual(['user:u1']);
  });

  it('the same scope serializes two transactions; different scopes do not', async () => {
    const { db } = await open();
    const order: string[] = [];
    const run = (name: string, scope: string, hold?: Promise<void>) =>
      client.withTransaction(
        db,
        async (tx) => {
          order.push(`${name}:in`);
          await client.rawGet(tx, sql`SELECT 1`);
          if (hold !== undefined) await hold;
          order.push(`${name}:out`);
        },
        { scope },
      );
    const gate = deferred();
    const a = run('a', 'user:same', gate.promise);
    const b = run('b', 'user:same');
    const c = run('c', 'user:other');
    await c;
    // c ran to completion while a held its lock; b is still waiting for a.
    expect(order).toEqual(['a:in', 'c:in', 'c:out']);
    gate.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:in', 'c:in', 'c:out', 'a:out', 'b:in', 'b:out']);
  });

  it('lockScope holds inside a savepoint until the outer transaction ends', async () => {
    const { db, pool } = await open();
    await client.withTransaction(db, async (tx) => {
      await client.withTransaction(tx, async (inner) => {
        await client.lockScope(inner, 'user:nested');
      });
      await client.rawGet(tx, sql`SELECT 2`);
    });
    const texts = pool.textsOf(pool.clients[0]?.id ?? -1);
    expect(texts).toEqual([
      'begin isolation level read committed',
      'savepoint sp1',
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'release savepoint sp1',
      'SELECT 2',
      'commit',
    ]);
  });

  it('rolling back to a savepoint keeps the outer transaction and the locks taken before it', async () => {
    const { db, pool } = await open();
    const order: string[] = [];
    const gate = deferred();
    const innerFailed = deferred();
    const a = client.withTransaction(
      db,
      async (tx) => {
        await expect(
          client.withTransaction(tx, async (inner) => {
            await client.lockScope(inner, 'user:inner');
            throw new Error('inner failed');
          }),
        ).rejects.toThrow('inner failed');
        innerFailed.resolve();
        await gate.promise;
        await client.rawGet(tx, sql`SELECT 'still open'`);
      },
      { scope: 'user:outer' },
    );
    await innerFailed.promise;
    const aClient = pool.clients[0]?.id ?? -1;
    // The lock taken inside the rolled-back savepoint is gone: another transaction takes it.
    await client.withTransaction(db, async (tx) => {
      await client.lockScope(tx, 'user:inner');
      order.push('inner-free');
    });
    // The lock taken before the savepoint is still held by the open outer transaction.
    const b = client.withTransaction(db, async () => void order.push('outer-acquired'), {
      scope: 'user:outer',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['inner-free']);
    gate.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['inner-free', 'outer-acquired']);
    expect(pool.textsOf(aClient)).toEqual([
      'begin isolation level read committed',
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'savepoint sp1',
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'rollback to savepoint sp1',
      "SELECT 'still open'",
      'commit',
    ]);
  });

  it('lockScope refuses the root handle', async () => {
    const { db } = await open();
    await expect(client.lockScope(db, 'user:x')).rejects.toThrow(/outside a transaction/);
  });

  it('refuses the root handle inside the caller’s own transaction', async () => {
    const { db } = await open();
    const { settings } = schema;
    await expect(
      client.withTransaction(db, async () => {
        await client.withTransaction(db, async () => undefined);
      }),
    ).rejects.toThrow(/inside a transaction on the same database: pass its tx/);
    await expect(
      client.withTransaction(db, async () => {
        await db.select().from(settings).get();
      }),
    ).rejects.toThrow(/db\.select inside a transaction on the same database/);
    // eslint-disable-next-line no-restricted-syntax -- asserting the runtime refusal
    expect(() => (db as unknown as { transaction: () => void }).transaction()).toThrow(
      /bypasses the write gate: use withTransaction/,
    );
  });

  it('concurrent transactions run on separate connections', async () => {
    const { db, pool } = await open();
    const gate = deferred();
    const a = client.withTransaction(db, async (tx) => {
      await client.rawGet(tx, sql`SELECT 'a'`);
      await gate.promise;
    });
    await client.withTransaction(db, async (tx) => {
      await client.rawGet(tx, sql`SELECT 'b'`);
    });
    gate.resolve();
    await a;
    expect(pool.clients).toHaveLength(2);
    expect(pool.textsOf(pool.clients[0]?.id ?? -1)).toContain("SELECT 'a'");
    expect(pool.textsOf(pool.clients[1]?.id ?? -1)).toContain("SELECT 'b'");
  });
});

describe('errors, ping and close', () => {
  it('surfaces the driver error unwrapped, so no bound parameter reaches a log line', async () => {
    const { db } = await open((q) =>
      /^insert into "users"/.test(q.text)
        ? pgError('23505', 'duplicate key value violates unique constraint "users_email_unique"')
        : undefined,
    );
    const { users } = schema;
    const err = await db
      .insert(users)
      .values({ ...userRow('u1'), passwordHash: 'secret-hash-value' })
      .run()
      .then(
        () => undefined,
        (e: unknown) => e as Error & { code?: string },
      );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DrizzleQueryError);
    expect(err?.code).toBe('23505');
    expect(err?.message).not.toContain('secret-hash-value');
    expect(client.isUniqueViolation(err)).toBe(true);
    expect(client.isUniqueViolation(new DrizzleQueryError('insert', [], err as Error))).toBe(true);
    expect(client.isUniqueViolation(pgError('23503', 'fk'))).toBe(false);
  });

  it('strips row values from Postgres errors: detail, where, internal query, data-error input', async () => {
    const secret = 'secret-person@example.com';
    const { db } = await open((q) => {
      if (/^insert into "users"/.test(q.text)) {
        return pgError(
          '23505',
          'duplicate key value violates unique constraint "users_email_unique"',
          {
            detail: `Key (email)=(${secret}) already exists.`,
            where: `SQL statement "INSERT ... VALUES ('${secret}')"`,
            internalQuery: `SELECT '${secret}'`,
            constraint: 'users_email_unique',
            table: 'users',
          },
        );
      }
      if (/^UPDATE/.test(q.text)) {
        return pgError('22P02', `invalid input syntax for type bigint: "${secret}"`);
      }
      return undefined;
    });
    const { users } = schema;
    const unique = await db
      .insert(users)
      .values(userRow('u1'))
      .run()
      .then(
        () => undefined,
        (e: unknown) => e as Error & Record<string, unknown>,
      );
    expect(unique?.code).toBe('23505');
    expect(unique?.constraint).toBe('users_email_unique');
    expect(unique?.table).toBe('users');
    expect(client.isUniqueViolation(unique)).toBe(true);
    const badInput = await client.rawRun(db, sql`UPDATE users SET created_at = ${secret}`).then(
      () => undefined,
      (e: unknown) => e as Error & Record<string, unknown>,
    );
    expect(badInput?.code).toBe('22P02');
    expect(badInput?.message).toBe('invalid input syntax for type bigint: [value withheld]');
    for (const err of [unique, badInput]) {
      expect(err).toBeInstanceOf(Error);
      expect(err?.detail).toBeUndefined();
      expect(err?.where).toBeUndefined();
      expect(err?.internalQuery).toBeUndefined();
      // Every form a log line or jobs.last_error could take.
      const { inspect } = await import('node:util');
      for (const text of [JSON.stringify(err), inspect(err), String(err?.stack), String(err)]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('unwraps raw-helper errors too', async () => {
    const { db } = await open((q) =>
      /^UPDATE/.test(q.text) ? pgError('40001', 'could not serialize') : undefined,
    );
    const err = await client.rawRun(db, sql`UPDATE users SET password_hash = ${'secret-2'}`).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeInstanceOf(DrizzleQueryError);
    expect(err?.message).not.toContain('secret-2');
  });

  it('pings with SELECT 1 and closes the pool', async () => {
    const { handle, pool } = await open((q) =>
      /^SELECT 1 AS ok/.test(q.text) ? { rows: [{ ok: 1 }] } : undefined,
    );
    expect(await client.pingDatabase(handle)).toBe(true);
    await client.closeDatabase(handle);
    expect(pool.ended).toBe(true);
    await expect(client.pingDatabase(handle)).rejects.toThrow();
  });
});
