// A Postgres connection that ends (a restart, a failover, a session limit) fails what was using it,
// and never stops the server (https://github.com/bgoleno/opportun/issues/963). A connection is cut as
// Postgres cuts one, with pg_terminate_backend, at each point of its life. SQLite has none.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PostgresConfig } from '../src/config';
import {
  connectDatabase,
  MIGRATION_LOCK_KEY,
  openPgSession,
  pgPoolConfig,
  rawGet,
  withTransaction,
  type Db,
  type Exec,
} from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import { jobs } from '../src/db/schema';
import { enqueue } from '../src/lib/jobQueue';
import { racePoint } from '../src/lib/racePoints';
import { registerJob, unregisterJob } from '../src/jobs/registry';
import {
  recoverStaleJobs,
  runDueJobs,
  startRunner,
  type RowRetry,
  type Runner,
} from '../src/jobs/runner';
import { DemoResetGate, HOLD_LIMIT_MS } from '../src/lib/demoResetGate';
import { useApi } from './api';
import { testDialect } from './db';
import { captureLogs } from './helpers';
import type { TestClient } from './isolation';
import { createTestDatabase } from './pgHarness';
import { pauseAt } from './race';

const ENDED = 'postgres connection ended';

it('every pool the server makes is watched (#963)', async () => {
  const src = fileURLToPath(new URL('../src', import.meta.url));
  let pools = 0;
  for (const f of (await readdir(src, { recursive: true })).filter((n) => n.endsWith('.ts'))) {
    const text = (await readFile(join(src, f), 'utf8')).replace(/\s+/g, '');
    if (!text.includes("from'pg'")) continue;
    const made = text.match(/new(pg\.)?(Pool|Client)\(/g)?.length ?? 0;
    const watched = text.match(/watchConnections\((opts\.pool\?\?)?newpg\.Pool\(/g)?.length ?? 0;
    expect([f, watched]).toEqual([f, made]);
    pools += made;
  }
  expect(pools).toBe(3);
});

describe.runIf(testDialect === 'postgres')('a Postgres connection that ends (#963)', () => {
  let logs = captureLogs();
  const boot = useApi(() => ({ logStream: logs }));
  const open: pg.Client[] = [];
  /** What would have stopped the server: an error nobody listened for. */
  const crashes: unknown[] = [];
  const crashed = (err: unknown) => crashes.push(err);

  beforeEach(() => {
    logs = captureLogs();
    crashes.length = 0;
    process.on('uncaughtException', crashed);
  });
  afterEach(async () => {
    process.off('uncaughtException', crashed);
    await Promise.all(open.splice(0).map((c) => c.end().catch(() => undefined)));
  });

  const start = () => boot({ logLevel: 'error' });
  async function outside(url: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url });
    client.on('error', () => undefined);
    await client.connect();
    open.push(client);
    return client;
  }
  const urlOf = (app: FastifyInstance) => (app.config.db as PostgresConfig).url;

  /** Ends the app's connections that match, and returns how many. */
  async function cut(by: pg.Client, where = 'true'): Promise<number> {
    const res = await by.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND application_name LIKE 'opportun%' AND (${where})`,
    );
    return res.rowCount ?? 0;
  }
  const until = async (done: () => Promise<boolean> | boolean): Promise<void> => {
    for (let i = 0; i < 200; i += 1) {
      if (await done()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('never came');
  };
  /** Waits until one of the app's connections is waiting for a lock. */
  const blocked = (by: pg.Client) =>
    until(async () => {
      const res = await by.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND application_name LIKE 'opportun%'`,
      );
      return (res.rowCount ?? 0) > 0;
    });
  const endings = () => logs.lines.filter((l) => l.includes(ENDED));
  const failures = () => logs.lines.filter((l) => l.includes('unhandled error'));
  /** Lets every event of the cut connections arrive. */
  const settle = () => new Promise((r) => setTimeout(r, 200));

  async function opportunity(a: TestClient): Promise<string> {
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { companyName: 'Initech', title: 'Platform Engineer', sourceKind: 'manual' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }
  const read = (a: TestClient, id: string) =>
    a.request({ method: 'GET', url: `/api/v1/opportunities/${id}` });

  it('while idle: nothing fails, and each is logged once', async () => {
    const { app, a } = await start();
    const id = await opportunity(a);
    const by = await outside(urlOf(app));
    const n = await cut(by);
    expect(n).toBeGreaterThan(0);
    await until(() => endings().length >= n);
    await settle();
    expect(endings()).toHaveLength(n);
    expect((await read(a, id)).statusCode).toBe(200);
    expect(crashes).toEqual([]);
  });

  it('during a statement on its own: that fails, and the next is served', async () => {
    const { app, a } = await start();
    const id = await opportunity(a);
    const by = await outside(urlOf(app));
    await by.query('BEGIN');
    await by.query('LOCK TABLE opportunities IN ACCESS EXCLUSIVE MODE');
    const pending = read(a, id);
    await blocked(by);
    expect(await cut(by, "wait_event_type = 'Lock'")).toBe(1);
    const res = await pending;
    expect(res.statusCode).toBe(500);
    await by.query('ROLLBACK');
    await settle();
    // pool.query() has it: the statement rejects and the connection is dropped, so the request's own
    // error is what is logged, once.
    expect([...endings(), ...failures()]).toHaveLength(1);
    expect((await read(a, id)).statusCode).toBe(200);
    expect(crashes).toEqual([]);
  });

  const rename = (a: TestClient, id: string) =>
    a.request({ method: 'PATCH', url: `/api/v1/opportunities/${id}`, payload: { title: 'Other' } });

  it('during a statement of a transaction: that fails whole, and the next is served', async () => {
    const { app, a } = await start();
    const id = await opportunity(a);
    const by = await outside(urlOf(app));
    await by.query('BEGIN');
    // Reads go on: the transaction's UPDATE is what waits.
    await by.query('LOCK TABLE opportunities IN SHARE MODE');
    const pending = rename(a, id);
    await blocked(by);
    expect(await cut(by, "wait_event_type = 'Lock'")).toBe(1);
    const res = await pending;
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'internal' } });
    await by.query('ROLLBACK');
    await settle();
    expect(endings()).toHaveLength(1);
    expect(failures()).toHaveLength(1);
    expect((await read(a, id)).json()).toMatchObject({ title: 'Platform Engineer' });
    expect((await rename(a, id)).statusCode).toBe(200);
    expect(crashes).toEqual([]);
  });

  it('between two statements of a transaction: the same', async () => {
    const { app, a } = await start();
    const id = await opportunity(a);
    const by = await outside(urlOf(app));
    onSlowTransaction(() => undefined); // parked on purpose
    const parked = pauseAt('opportunities.update.locked');
    const pending = rename(a, id);
    await parked.reached;
    expect(await cut(by, "state = 'idle in transaction'")).toBe(1);
    await until(() => endings().length > 0 || crashes.length > 0);
    await settle();
    parked.release();
    const res = await pending;
    expect(res.statusCode).toBe(500);
    expect(endings()).toHaveLength(1);
    expect(failures()).toHaveLength(1);
    expect((await read(a, id)).json()).toMatchObject({ title: 'Platform Engineer' });
    expect((await rename(a, id)).statusCode).toBe(200);
    expect(crashes).toEqual([]);
  });

  it('no connection is lost from the pool', async () => {
    const { app, a } = await start();
    const id = await opportunity(a);
    const by = await outside(urlOf(app));
    onSlowTransaction(() => undefined);
    const { poolMax } = app.config.db as PostgresConfig;
    for (let i = 0; i < poolMax + 2; i += 1) {
      const parked = pauseAt('opportunities.update.locked');
      const pending = rename(a, id);
      await parked.reached;
      expect(await cut(by, "state = 'idle in transaction'")).toBe(1);
      await settle();
      parked.release();
      expect((await pending).statusCode).toBe(500);
    }
    expect((await rename(a, id)).statusCode).toBe(200);
    expect(crashes).toEqual([]);
  }, 60_000);

  it('a job it fails runs again', async () => {
    const { app, a } = await start();
    const kind = 'test.connection_ends';
    let runs = 0;
    registerJob({
      kind,
      payloadSchema: z.object({}),
      maxAttempts: 3,
      async run(db) {
        runs += 1;
        await withTransaction(db, async (tx) => {
          await rawGet(tx, sql`SELECT 1`);
          await racePoint('test.job');
          await rawGet(tx, sql`SELECT 1`);
        });
      },
    });
    try {
      const jobId = await enqueue(app.db, kind, {}, { userId: a.userId });
      const row = async () => (await app.db.select().from(jobs).all()).find((j) => j.id === jobId)!;
      const by = await outside(urlOf(app));
      onSlowTransaction(() => undefined);
      const parked = pauseAt('test.job');
      const pending = runDueJobs(app.db, {});
      await parked.reached;
      expect(await cut(by, "state = 'idle in transaction'")).toBe(1);
      await settle();
      parked.release();
      await pending;
      expect(await row()).toMatchObject({ status: 'pending', attempts: 1 });
      await runDueJobs(app.db, { now: () => Date.now() + 60 * 60 * 1000 });
      expect(await row()).toMatchObject({ status: 'done' });
      expect(runs).toBe(2);
      expect(crashes).toEqual([]);
    } finally {
      unregisterJob(kind);
    }
  });

  // The other pools' connections: a migration's, and the bulk tools' own.
  it('while a migration waits: opening the database fails, and nothing else', async () => {
    const test = await createTestDatabase();
    try {
      const by = await outside(test.config.url);
      await by.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      const { app } = await start();
      const opening = connectDatabase({ dataDir: app.config.dataDir, db: test.config });
      const failed = expect(opening).rejects.toThrow();
      await blocked(by);
      expect(await cut(by, "wait_event_type = 'Lock'")).toBe(1);
      await failed;
      await settle();
      expect(crashes).toEqual([]);
    } finally {
      await Promise.all(open.splice(0).map((c) => c.end()));
      await test.drop();
    }
  });

  it('a bulk tool’s own connection, between two statements: the next one fails', async () => {
    const { app } = await start();
    const session = await openPgSession(app.config.db as PostgresConfig);
    try {
      const by = await outside(urlOf(app));
      await session.query('BEGIN');
      expect(
        await cut(by, "application_name = 'opportun-copy' AND state = 'idle in transaction'"),
      ).toBe(1);
      await settle();
      await expect(session.query('SELECT 1')).rejects.toThrow();
      expect(crashes).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('a transaction that is not cut is untouched, and nothing is logged', async () => {
    const { app } = await start();
    expect(
      await withTransaction(app.db, (tx) => rawGet<{ v: number }>(tx, sql`SELECT 1 AS v`)),
    ).toEqual({ v: 1 });
    expect(endings()).toEqual([]);
  });

  // sec and em on #963: a connection that has ended by the time a transaction begins is never given
  // back to the pool. Drizzle runs BEGIN outside its try.
  describe('a transaction’s connection goes back to the pool', () => {
    /** The app's database on a small pool of its own, and what its connections meet when taken. */
    async function small(max: number) {
      const { app, a } = await start();
      const by = await outside(urlOf(app));
      const pool = new pg.Pool({ ...pgPoolConfig(app.config.db as PostgresConfig), max });
      const handle = await connectDatabase(app.config, { pool });
      const taken: { as: (client: pg.PoolClient) => Promise<void> } = { as: async () => undefined };
      const connect = pool.connect.bind(pool) as (cb?: unknown) => Promise<pg.PoolClient>;
      pool.connect = (async (cb?: unknown) => {
        if (cb !== undefined) return connect(cb); // pool.query()'s own
        const client = await connect();
        await taken.as(client);
        return client;
      }) as never;
      open.push({ end: () => pool.end() } as never);
      return { a, by, pool, db: handle.db, taken };
    }
    const one = (db: Exec) => rawGet<{ v: number }>(db, sql`SELECT 1 AS v`);
    const transaction = (db: Db) => withTransaction(db, (tx) => one(tx));

    /** The pool's connections all given back or gone, none waited for, and no more than `max`. */
    const whole = (pool: pg.Pool, max: number) => {
      expect([pool.idleCount, pool.waitingCount]).toEqual([pool.totalCount, 0]);
      expect(pool.totalCount).toBeLessThanOrEqual(max);
    };
    /** poolMax and one more transactions, one after another and at once, and a lone statement. */
    async function serves(pool: pg.Pool, db: Db, max: number): Promise<void> {
      const all = Array.from({ length: max + 1 }, () => ({ v: 1 }));
      for (const v of all) expect(await transaction(db)).toEqual(v);
      expect(await Promise.all(all.map(() => transaction(db)))).toEqual(all);
      expect(await one(db)).toEqual({ v: 1 });
      whole(pool, max);
    }
    /** Passes `client`'s statements on, except the ones `fails` names. */
    function failing(client: pg.PoolClient, fails: (text: string) => boolean, why: string) {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      const patched = ((...args: unknown[]) =>
        fails((args[0] as { text?: string }).text ?? '')
          ? Promise.reject(new Error(why))
          : query(...args)) as never;
      client.query = patched;
      return () => client.query === patched;
    }
    const max = 2;

    it('when it has ended before BEGIN: the pool serves poolMax and one more after', async () => {
      const { by, pool, db, taken } = await small(max);
      taken.as = async (client) => {
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        await by.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
        await settle();
      };
      for (let i = 0; i < max + 1; i += 1) {
        await expect(transaction(db)).rejects.toThrow();
        whole(pool, max);
      }
      taken.as = async () => undefined;
      await serves(pool, db, max);
      expect(crashes).toEqual([]);
    }, 60_000);

    it('when BEGIN fails on a live one: it is not used again', async () => {
      const { pool, db, taken } = await small(max);
      const failed = new Set<pg.PoolClient>();
      const untouched: (() => boolean)[] = [];
      taken.as = async (client) => {
        failed.add(client);
        untouched.push(failing(client, (text) => text.startsWith('begin'), 'BEGIN failed'));
      };
      for (let i = 0; i < max + 1; i += 1) {
        await expect(transaction(db)).rejects.toThrow('BEGIN failed');
        whole(pool, max);
      }
      expect(failed.size).toBe(max + 1);
      expect(untouched.map((same) => same())).toEqual([true, true, true]);
      let reused = 0;
      taken.as = async (client) => {
        if (failed.has(client)) reused += 1;
      };
      await serves(pool, db, max);
      expect(reused).toBe(0);
    });

    it('when ROLLBACK fails on a live one: it is not used again, with its transaction open', async () => {
      const { pool, db, taken } = await small(max);
      const failed = new Set<pg.PoolClient>();
      const untouched: (() => boolean)[] = [];
      taken.as = async (client) => {
        failed.add(client);
        untouched.push(failing(client, (text) => text === 'rollback', 'ROLLBACK failed'));
      };
      for (let i = 0; i < max + 1; i += 1) {
        await expect(
          withTransaction(db, async (tx) => {
            await one(tx);
            throw new Error('undo');
          }),
        ).rejects.toThrow('ROLLBACK failed');
        whole(pool, max);
      }
      expect(failed.size).toBe(max + 1);
      expect(untouched.map((same) => same())).toEqual([true, true, true]);
      let reused = 0;
      taken.as = async (client) => {
        if (failed.has(client)) reused += 1;
      };
      await serves(pool, db, max);
      expect(reused).toBe(0);
    });

    it('when COMMIT fails on a live one: it is not used again', async () => {
      const { pool, db, taken } = await small(max);
      const failed = new Set<pg.PoolClient>();
      taken.as = async (client) => {
        failed.add(client);
        failing(client, (text) => text === 'commit', 'COMMIT failed');
      };
      for (let i = 0; i < max + 1; i += 1) {
        await expect(transaction(db)).rejects.toThrow('COMMIT failed');
        whole(pool, max);
      }
      expect(failed.size).toBe(max + 1);
      taken.as = async () => undefined;
      await serves(pool, db, max);
    });

    it('an ordinary one, committed or rolled back, goes back and is used again', async () => {
      const { pool, db, taken } = await small(1);
      const clients: pg.PoolClient[] = [];
      const queries: unknown[] = [];
      taken.as = async (client) => {
        clients.push(client);
        queries.push(client.query);
      };
      expect(await transaction(db)).toEqual({ v: 1 });
      await expect(
        withTransaction(db, async (tx) => {
          await one(tx);
          throw new Error('undo');
        }),
      ).rejects.toThrow('undo');
      await expect(withTransaction(db, (tx) => rawGet(tx, sql`SELECT 1 / 0 AS v`))).rejects.toThrow(
        'division by zero',
      );
      // A body that goes on after a failed statement: Postgres answers its COMMIT with a ROLLBACK,
      // which is no error.
      await withTransaction(db, (tx) => rawGet(tx, sql`SELECT 1 / 0 AS v`).catch(() => undefined));
      expect(await transaction(db)).toEqual({ v: 1 });
      expect(clients).toHaveLength(5);
      expect(new Set(clients).size).toBe(1);
      // What watches a transaction's statements is off the connection when it goes back.
      expect(new Set([...queries, clients[0]!.query]).size).toBe(1);
      expect([pool.totalCount, pool.idleCount, pool.waitingCount]).toEqual([1, 1, 0]);
    });

    it('one on the database inside another is still refused', async () => {
      const { db } = await small(2);
      await expect(withTransaction(db, () => transaction(db))).rejects.toThrow(/pass its tx/);
    });
  });

  // tl and em on #963: in a restart Postgres is still away when the job it caught ends, so the write
  // that says so fails too, and the row stayed `running`, its dedupe key held, until the next start.
  describe('a job caught while Postgres is away', () => {
    const KIND = 'test.postgres_away';
    const NOT_WRITTEN = "a job's row could not be written; trying again";

    /** Postgres gone and back, as the app sees it: `by` stays connected throughout. */
    async function postgres(app: FastifyInstance, by: pg.Client) {
      const name = new URL(urlOf(app)).pathname.slice(1);
      // From another database: Postgres does not let one be closed from within.
      const server = await outside(process.env.TEST_DATABASE_URL!);
      const accept = (yes: boolean) =>
        server.query(`ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS ${String(yes)}`);
      return {
        back: () => accept(true),
        async leaves(): Promise<void> {
          await accept(false);
          await cut(by);
          await settle();
        },
      };
    }
    const QUICK: RowRetry = { firstMs: 50, maxMs: 200, limitMs: 60_000 };
    const LONG: RowRetry = { firstMs: 60_000, maxMs: 60_000, limitMs: 600_000 };

    interface Job {
      maxAttempts?: number;
      body?: (db: Db) => Promise<void>;
      /** An instance job, which a demo server's gate holds. */
      instance?: boolean;
      gate?: (pg: { leaves(): Promise<void> }) => DemoResetGate;
      rowRetry?: RowRetry;
    }
    /** One job queued, and what starts a runner on it. */
    async function queued(job: Job) {
      const { app, a } = await boot({ logLevel: 'warn' });
      const by = await outside(urlOf(app));
      const away = await postgres(app, by);
      onSlowTransaction(() => undefined); // parked on purpose
      const seen = { runs: 0, dead: 0, errors: [] as unknown[], ahead: 0 };
      registerJob({
        kind: KIND,
        payloadSchema: z.object({}),
        maxAttempts: job.maxAttempts ?? 3,
        async run(db) {
          seen.runs += 1;
          await racePoint('test.job');
          await job.body?.(db);
        },
        async onDead() {
          seen.dead += 1;
        },
      });
      const id = await enqueue(app.db, KIND, {}, job.instance ? {} : { userId: a.userId });
      let runner: Runner | undefined;
      const go = (db: Db = app.db): Runner =>
        (runner = startRunner(db, {
          intervalMs: 20,
          workers: 1,
          workerId: 'test-worker',
          random: () => 0,
          now: () => Date.now() + seen.ahead,
          rowRetry: job.rowRetry ?? QUICK,
          services: {
            log: app.log,
            ...(job.gate === undefined ? {} : { demoResetGate: job.gate(away) }),
          },
          onError: (err) => seen.errors.push(err),
        }));
      const row = async (of = id) => {
        const res = await by.query<{ status: string; attempts: number; locked_by: string | null }>(
          'SELECT status, attempts, locked_by FROM jobs WHERE id = $1',
          [of],
        );
        return res.rows[0]!;
      };
      const whole = async () =>
        (await by.query<Record<string, unknown>>('SELECT * FROM jobs WHERE id = $1', [id]))
          .rows[0]!;
      const said = () => logs.lines.filter((l) => l.includes(NOT_WRITTEN));
      const ends = async (): Promise<void> => {
        await away.back();
        await runner?.stop();
        unregisterJob(KIND);
      };
      /** Another job, done: the worker has gone on from the first. */
      const another = async (): Promise<void> => {
        const next = await enqueue(app.db, KIND, {}, {});
        await until(async () => (await row(next)).status === 'done');
      };
      return { app, by, away, id, seen, go, row, whole, said, ends, another };
    }
    /** The job parked in its handler, Postgres gone, the handler let go. */
    async function caught(job: Job) {
      const t = await queued(job);
      const parked = pauseAt('test.job');
      const runner = t.go();
      await parked.reached;
      await t.away.leaves();
      parked.release();
      /** It has failed to write its row, more than once. */
      const waiting = async (): Promise<void> => {
        await until(() => t.said().length > 0 || t.seen.errors.length > 0);
        await new Promise((r) => setTimeout(r, 400));
      };
      return { ...t, runner, waiting };
    }
    const inTransaction = (db: Db) =>
      withTransaction(db, async (tx) => {
        await rawGet(tx, sql`SELECT 1`);
      });

    it('one that failed goes back to pending once Postgres is back, and runs again', async () => {
      const t = await caught({ body: inTransaction });
      try {
        await t.waiting();
        expect(await t.row()).toMatchObject({ status: 'running', attempts: 1 });
        await t.away.back();
        await until(async () => (await t.row()).status === 'pending');
        expect(await t.row()).toEqual({ status: 'pending', attempts: 1, locked_by: null });
        t.seen.ahead = 60 * 60 * 1000;
        await until(async () => (await t.row()).status === 'done');
        expect([t.seen.runs, t.seen.dead, t.said().length]).toEqual([2, 0, 1]);
        expect(crashes).toEqual([]);
      } finally {
        await t.ends();
      }
    }, 60_000);

    it('one that succeeded is done once Postgres is back, and is not run twice', async () => {
      const t = await caught({});
      try {
        await t.waiting();
        expect(await t.row()).toMatchObject({ status: 'running', attempts: 1 });
        await t.away.back();
        await until(async () => (await t.row()).status === 'done');
        t.seen.ahead = 60 * 60 * 1000;
        await settle();
        expect(await t.row()).toEqual({ status: 'done', attempts: 1, locked_by: null });
        expect([t.seen.runs, t.seen.dead, t.said().length]).toEqual([1, 0, 1]);
      } finally {
        await t.ends();
      }
    }, 60_000);

    it('one at its last attempt is dead once Postgres is back, and settled once', async () => {
      const t = await caught({ body: inTransaction, maxAttempts: 1 });
      try {
        await t.waiting();
        expect([(await t.row()).status, t.seen.dead]).toEqual(['running', 0]);
        await t.away.back();
        await until(async () => (await t.row()).status === 'dead' && t.seen.dead > 0);
        await settle();
        expect([t.seen.runs, t.seen.dead, t.said().length]).toEqual([1, 1, 1]);
      } finally {
        await t.ends();
      }
    }, 60_000);

    it('a stop does not wait for it, and the next start recovers the row', async () => {
      const t = await caught({ body: inTransaction, rowRetry: LONG });
      try {
        await t.waiting();
        const began = performance.now();
        await t.runner.stop();
        expect(performance.now() - began).toBeLessThan(5000);
        expect(t.said()).toHaveLength(1);
        expect(t.seen.errors.length).toBeGreaterThan(0);
        expect(await t.row()).toMatchObject({ status: 'running', attempts: 1 });
        await t.away.back();
        expect(await recoverStaleJobs(t.app.db)).toBe(1);
        expect(await t.row()).toEqual({ status: 'pending', attempts: 1, locked_by: null });
        expect(t.seen.runs).toBe(1);
      } finally {
        await t.ends();
      }
    }, 60_000);

    it('past its limit the worker goes on to the next job', async () => {
      const t = await caught({
        body: inTransaction,
        rowRetry: { firstMs: 50, maxMs: 50, limitMs: 500 },
      });
      try {
        await until(() => t.said().length > 0);
        // Given up, the worker claims again, and that fails too while Postgres is away.
        await until(() => t.seen.errors.length > 1);
        await t.away.back();
        await t.another();
        expect(await t.row()).toMatchObject({ status: 'running', attempts: 1 });
      } finally {
        await t.ends();
      }
    }, 60_000);

    // tl: past its hold the demo reset may have reseeded the account, and what a dead job's handler
    // writes would land in it.
    it('one under the demo reset’s hold is given up when the hold ends', async () => {
      const t = await caught({
        body: inTransaction,
        maxAttempts: 1,
        instance: true,
        gate: () => new DemoResetGate({ stopMarginMs: HOLD_LIMIT_MS - 5000 }),
        rowRetry: { ...LONG, firstMs: 10_000 },
      });
      try {
        await until(() => t.said().length > 0);
        expect(t.seen.errors).toEqual([]);
        // Until the hold's end: well before the next try.
        await until(() => t.seen.errors.length > 0);
        await until(() => t.seen.errors.length > 1);
        await t.away.back();
        await t.another();
        expect(await t.row()).toMatchObject({ status: 'running', attempts: 1 });
        expect(t.seen.dead).toBe(0);
      } finally {
        await t.ends();
      }
    }, 60_000);

    /** A demo server's gate, taken, and Postgres gone before the check that follows. */
    const checkFails: Job = {
      instance: true,
      gate: (pg) => {
        const gate = new DemoResetGate();
        const shared = gate.shared.bind(gate);
        gate.shared = async (opts) => {
          gate.shared = shared;
          const hold = await shared(opts);
          await pg.leaves();
          return hold;
        };
        return gate;
      },
    };

    it('one whose check before its handler failed goes back, its attempt not counted', async () => {
      const t = await queued(checkFails);
      try {
        t.go();
        await until(() => t.said().length > 0);
        expect([await t.row(), t.seen.runs]).toMatchObject([{ status: 'running', attempts: 1 }, 0]);
        await t.away.back();
        await until(async () => (await t.row()).status === 'pending');
        expect(await t.row()).toEqual({ status: 'pending', attempts: 0, locked_by: null });
        t.seen.ahead = 60 * 60 * 1000;
        await until(async () => (await t.row()).status === 'done');
        expect([t.seen.runs, (await t.row()).attempts]).toEqual([1, 1]);
      } finally {
        await t.ends();
      }
    }, 60_000);

    // What ends before a handler runs: the write alone fails, by a trigger, as there is no moment
    // between the claim and it to cut the connection in.
    it.each([
      [
        'of a kind with no handler',
        (by: pg.Client, id: string) =>
          by.query("UPDATE jobs SET kind = 'test.nobody' WHERE id = $1", [id]),
      ],
      [
        'whose payload is not valid',
        (by: pg.Client, id: string) =>
          by.query("UPDATE jobs SET payload = '[]' WHERE id = $1", [id]),
      ],
    ])(
      'one %s is dead once it can be written',
      async (_name, spoil) => {
        const t = await queued({});
        try {
          await spoil(t.by, t.id);
          await t.by.query(`CREATE FUNCTION refuse() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'refused'; END $$`);
          await t.by.query(`CREATE TRIGGER refuse BEFORE UPDATE ON jobs FOR EACH ROW
          WHEN (NEW.status = 'dead') EXECUTE FUNCTION refuse()`);
          t.go();
          await until(() => t.said().length > 0 || t.seen.errors.length > 0);
          expect((await t.row()).status).toBe('running');
          await t.by.query('DROP TRIGGER refuse ON jobs');
          await until(async () => (await t.row()).status === 'dead');
          expect([t.seen.runs, t.said().length, t.seen.errors]).toEqual([0, 1, []]);
        } finally {
          await t.ends();
        }
      },
      60_000,
    );

    // A try may have been written and its answer lost, so the row is another run's by the next one:
    // a job put back to pending while it runs would run twice at once.
    it('a row claimed again after a write whose answer was lost is left alone', async () => {
      let ran = 0;
      const t = await queued({
        body: async () => {
          ran += 1;
          if (ran === 1) throw new Error('failed');
        },
      });
      const pool = new pg.Pool({ ...pgPoolConfig(t.app.config.db as PostgresConfig), max: 2 });
      open.push({ end: () => pool.end() } as never);
      const { db } = await connectDatabase(t.app.config, { pool });
      const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
      let claimedAgain: Record<string, unknown> | undefined;
      let tries = 0;
      pool.query = (async (...args: unknown[]) => {
        const result = await query(...args);
        const text = (args[0] as { text?: string }).text ?? '';
        if (!/^update "jobs" set .*"last_error"/.test(text)) return result;
        tries += 1;
        if (tries > 1) return result;
        expect(await t.row()).toMatchObject({ status: 'pending', attempts: 1 }); // written
        await t.by.query(
          `UPDATE jobs SET status = 'running', attempts = 2, locked_by = 'test-worker',
             locked_at = $2 WHERE id = $1`,
          [t.id, Date.now() + 60_000],
        );
        claimedAgain = await t.whole();
        throw new Error('answer lost');
      }) as never;
      try {
        t.go(db);
        await until(() => tries > 1 || t.seen.errors.length > 0);
        await t.another();
        expect(await t.whole()).toEqual(claimedAgain);
        expect([t.said().length, t.seen.runs]).toEqual([1, 2]);
      } finally {
        await t.ends();
      }
    }, 60_000);

    /** The job fails, and Postgres answers the write of its row with `code`. */
    async function answered(code: string) {
      const t = await queued({ body: () => Promise.reject(new Error('failed')) });
      await t.by.query(`CREATE FUNCTION refuse() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'refused' USING ERRCODE = '${code}'; END $$`);
      await t.by.query(`CREATE TRIGGER refuse BEFORE UPDATE ON jobs FOR EACH ROW
        WHEN (NEW.status = 'pending') EXECUTE FUNCTION refuse()`);
      t.go();
      return t;
    }

    // Starting up, the old primary made read-only, too many connections, shutting down.
    it.each(['57P03', '25006', '53300', '57P01'])(
      'a write Postgres answers with %s is tried again',
      async (code) => {
        const t = await answered(code);
        try {
          await until(() => t.said().length > 0 || t.seen.errors.length > 0);
          await t.by.query('DROP TRIGGER refuse ON jobs');
          await until(async () => (await t.row()).status === 'pending');
          expect(t.seen.errors).toEqual([]);
        } finally {
          await t.ends();
        }
      },
      60_000,
    );

    // sec and tl: about the statement itself, so no try of it would go better.
    it.each(['22021', '23514', '42501'])(
      'a write Postgres answers with %s fails at once',
      async (code) => {
        const t = await answered(code);
        try {
          await until(() => t.said().length > 0 || t.seen.errors.length > 0);
          await settle();
          expect([t.said().length, t.seen.errors.length]).toEqual([0, 1]);
          expect((await t.row()).status).toBe('running');
        } finally {
          await t.ends();
        }
      },
      60_000,
    );

    it.each([
      ['its status', "status = 'pending', run_at = run_at + 86400000"],
      ['its worker', "locked_by = 'another'"],
      ['when it was claimed', 'locked_at = locked_at + 1'],
      ['its attempt', 'attempts = attempts + 1'],
    ])(
      'a row no longer this claim’s, by %s alone, is left alone',
      async (_by, change) => {
        const t = await caught({ body: inTransaction });
        try {
          await t.waiting();
          await t.by.query(`UPDATE jobs SET ${change} WHERE id = $1`, [t.id]);
          const before = await t.whole();
          await t.away.back();
          await t.another();
          expect(await t.whole()).toEqual(before);
          expect(t.seen.errors).toEqual([]);
        } finally {
          await t.ends();
        }
      },
      60_000,
    );

    // The same in the writes of an end, and of one put back.
    it.each<[string, Job]>([
      ['done', {}],
      ['dead', { body: inTransaction, maxAttempts: 1 }],
    ])(
      'a row no longer this claim’s is not made %s',
      async (_to, job) => {
        const t = await caught(job);
        try {
          await t.waiting();
          await t.by.query('UPDATE jobs SET attempts = attempts + 1 WHERE id = $1', [t.id]);
          const before = await t.whole();
          await t.away.back();
          await t.another();
          expect(await t.whole()).toEqual(before);
          expect([t.seen.errors, t.seen.dead]).toEqual([[], job.maxAttempts === 1 ? 1 : 0]);
        } finally {
          await t.ends();
        }
      },
      60_000,
    );

    it('a row no longer this claim’s is not put back', async () => {
      const t = await queued(checkFails);
      try {
        t.go();
        await until(() => t.said().length > 0);
        await t.by.query('UPDATE jobs SET attempts = attempts + 1 WHERE id = $1', [t.id]);
        const before = await t.whole();
        await t.away.back();
        await t.another();
        expect(await t.whole()).toEqual(before);
      } finally {
        await t.ends();
      }
    }, 60_000);
  });

  // The whole of it, in a process that an uncaught error would end.
  it('the server goes on serving', async () => {
    const test = await createTestDatabase();
    const dir = await mkdtemp(join(tmpdir(), 'opportun-pg-ends-'));
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./fixtures/pgServerChild.ts', import.meta.url)),
        dir,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PG_SERVER_CHILD_URL: test.config.url },
      },
    );
    let out = '';
    let err = '';
    let exit: number | null | undefined;
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
    child.on('exit', (code) => (exit = code));
    try {
      for (let i = 0; i < 400 && !out.includes('listening'); i += 1) {
        expect(exit, err).toBeUndefined();
        await new Promise((r) => setTimeout(r, 100));
      }
      const at = /listening (\S+)/.exec(out)?.[1];
      expect(at, err).toBeDefined();
      const by = await outside(test.config.url);
      // Registering takes this lock in its transaction, and waits for it there.
      await by.query("SELECT pg_advisory_lock(hashtext('registration'))");
      const register = () =>
        fetch(`${at}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'jane@example.com',
            displayName: 'Jane Example',
            password: 'correct horse battery',
          }),
        });
      const pending = register();
      pending.catch(() => undefined);
      await blocked(by);
      expect(await cut(by, "wait_event_type = 'Lock'")).toBe(1);
      expect((await pending).status).toBe(500);
      await settle();
      expect((await fetch(`${at}/healthz`)).status).toBe(200);
      await by.query('SELECT pg_advisory_unlock_all()');
      expect((await register()).status).toBe(201);
      expect(exit).toBeUndefined();
      expect(out + err).not.toContain('uncaught exception');
      expect((out + err).split(ENDED)).toHaveLength(2);
    } finally {
      child.kill('SIGTERM');
      await until(() => exit !== undefined || child.signalCode !== null).catch(() =>
        child.kill('SIGKILL'),
      );
      await Promise.all(open.splice(0).map((c) => c.end().catch(() => undefined)));
      await test.drop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
