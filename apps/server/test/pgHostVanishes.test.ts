// A database host that vanishes without closing its connections holds neither a statement nor the
// server's stop (https://github.com/bgoleno/opportun/issues/981). The host is a proxy that stops
// passing anything on (test/pgProxy.ts). SQLite has none.
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PostgresConfig } from '../src/config';
import {
  closeDatabase,
  connectDatabase,
  isLockTimeout,
  isLockWaitEnded,
  isStatementError,
  MIGRATION_LOCK_KEY,
  openPgSession,
  pgPoolConfig,
  rawGet,
  withTransaction,
  type Exec,
} from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import { registerJob, unregisterJob } from '../src/jobs/registry';
import { startRunner } from '../src/jobs/runner';
import { enqueue } from '../src/lib/jobQueue';
import { useApi } from './api';
import { testDialect } from './db';
import { captureLogs } from './helpers';
import { createTestDatabase } from './pgHarness';
import { pgProxy } from './pgProxy';

const ENDED = 'postgres connection ended';
/** What the code adds to statement_timeout, and what the tests put in its place. */
const GRACE_MS = 30_000;
const TEST_GRACE_MS = 900;
/** statement_timeout of the tests' connections, and so how long one may be silent. */
const LIMIT_MS = 600;
const BOUND_MS = LIMIT_MS + TEST_GRACE_MS;
/** A loaded machine's slack; less than a second wait of the bound. */
const SLACK_MS = BOUND_MS - 100;
/** The migration's statement_timeout. */
const MIGRATION_LIMIT_MS = 120_000;

/** A connection's parts that the tests look at. */
const streamOf = (client: unknown) =>
  (client as { connection: { stream: net.Socket } }).connection.stream;

describe.runIf(testDialect === 'postgres')('a Postgres host that vanishes (#981)', () => {
  const cleanups: (() => Promise<unknown> | void)[] = [];
  /** The bounds the code asked of its sockets, as it asked them. */
  const asked: number[] = [];
  let shorten: (ms: number) => number;
  let logs = captureLogs();
  const boot = useApi(() => ({ logStream: logs }));

  beforeEach(() => {
    logs = captureLogs();
    asked.length = 0;
    shorten = (ms) => ms - GRACE_MS + TEST_GRACE_MS;
    onSlowTransaction(() => undefined); // parked on purpose
    const real = net.Socket.prototype.setTimeout;
    vi.spyOn(net.Socket.prototype, 'setTimeout').mockImplementation(function (
      this: net.Socket,
      ms: number,
      callback?: () => void,
    ) {
      if (ms < GRACE_MS) return real.call(this, ms, callback);
      asked.push(ms);
      return real.call(this, shorten(ms), callback);
    });
  });
  afterEach(async () => {
    for (const clean of cleanups.splice(0).reverse()) await clean();
    vi.restoreAllMocks();
  });

  async function host(urlSuffix = `?statement_timeout=${LIMIT_MS}`, direct = false) {
    const test = await createTestDatabase();
    cleanups.push(() => test.drop());
    const proxy = await pgProxy(test.config.url);
    cleanups.push(() => proxy.close());
    const by = new pg.Client({ connectionString: test.config.url });
    by.on('error', () => undefined);
    await by.connect();
    cleanups.push(() => by.end());
    const url = direct ? test.config.url : proxy.through(test.config.url);
    const cfg = new PostgresConfig(`${url}${urlSuffix}`, 3, 'disable');
    const dataDir = await mkdtemp(join(tmpdir(), 'opportun-test-'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    return { proxy, by, cfg, dataDir };
  }
  async function database(urlSuffix?: string, direct?: boolean) {
    const h = await host(urlSuffix, direct);
    const pool = new pg.Pool(pgPoolConfig(h.cfg));
    const sockets: net.Socket[] = [];
    pool.on('connect', (c) => sockets.push(streamOf(c)));
    const ends: Error[] = [];
    const handle = await connectDatabase(
      { dataDir: h.dataDir, db: h.cfg },
      { pool, onConnectionEnd: (err) => ends.push(err) },
    );
    let closed: Promise<void> | undefined;
    const close = () => (closed ??= closeDatabase(handle));
    cleanups.push(async () => {
      await h.proxy.close();
      await close();
    });
    return { ...h, db: handle.db, pool, sockets, ends, close };
  }
  /** What `work` came to, and how long it took. */
  async function timed(work: Promise<unknown>) {
    const from = performance.now();
    const err = await work.then(
      () => undefined,
      (e: unknown) => e,
    );
    return { err, ms: performance.now() - from };
  }
  function expectCutAtTheBound({ err, ms }: { err: unknown; ms: number }): void {
    expect(err).toBeInstanceOf(Error);
    expect(ms).toBeGreaterThan(BOUND_MS - 100);
    expect(ms).toBeLessThan(BOUND_MS + SLACK_MS);
  }
  const one = (db: Exec) => rawGet<{ v: number }>(db, sql`SELECT 1 AS v`);
  const sleep = (exec: Exec, ms: number) => rawGet(exec, sql`SELECT pg_sleep(${ms / 1000})`);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** From the loop's check phase: its timers run next, before what has come is read. */
  async function standStill(): Promise<void> {
    await new Promise((r) => setImmediate(r));
    const until = performance.now() + BOUND_MS + 500;
    while (performance.now() < until);
  }

  describe('what is waiting ends', () => {
    it('a statement on its own', async () => {
      const t = await database();
      t.proxy.vanish();
      const cut = await timed(one(t.db));
      expectCutAtTheBound(cut);
      // Not taken for a wait that Postgres ended, or a statement it refused: those were not written.
      expect([isLockTimeout(cut.err), isLockWaitEnded(cut.err), isStatementError(cut.err)]).toEqual(
        [false, false, false],
      );
      expect(t.pool.totalCount).toBe(0);
    });

    it('a statement of a transaction, and no second wait for its rollback', async () => {
      const t = await database();
      const cut = await timed(
        withTransaction(t.db, async (tx) => {
          await one(tx);
          t.proxy.vanish();
          await one(tx);
        }),
      );
      expectCutAtTheBound(cut);
      expect(t.pool.totalCount).toBe(0);
    });

    it('the database’s close, with a statement waiting', async () => {
      const t = await database();
      t.proxy.vanish();
      const waiting = timed(one(t.db));
      await wait(100); // it is in flight
      const { err, ms } = await timed(t.close());
      expect(err).toBeUndefined();
      expect(ms).toBeLessThan(BOUND_MS + SLACK_MS);
      expectCutAtTheBound(await waiting);
    });

    it('a connection nothing waits for, once it is closed', async () => {
      const t = await database();
      await one(t.db);
      t.proxy.vanish();
      const { ms } = await timed(t.close());
      expect(ms).toBeLessThan(500); // pg-pool does not wait for it
      expect(t.sockets.some((s) => !s.destroyed)).toBe(true);
      await wait(BOUND_MS + 500);
      expect(t.sockets.filter((s) => !s.destroyed)).toEqual([]);
    });

    it('one each in the whole pool; and the pool serves again once the host is back', async () => {
      const t = await database();
      await Promise.all([1, 2, 3].map(() => sleep(t.db, 100)));
      expect(t.pool.totalCount).toBe(3);
      t.proxy.vanish();
      const all = [1, 2, 3].map(() => timed(one(t.db)));
      const next = one(t.db); // waits for a connection
      await wait(BOUND_MS / 2);
      t.proxy.back();
      for (const cut of await Promise.all(all)) expectCutAtTheBound(cut);
      expect(await next).toEqual({ v: 1 });
      expect(await Promise.all([1, 2, 3, 4].map(() => one(t.db)))).toEqual(Array(4).fill({ v: 1 }));
    });

    it('a statement of a bulk tool’s own connection', async () => {
      const { cfg, proxy } = await host();
      const session = await openPgSession(cfg);
      cleanups.push(() => session.close());
      await session.query('BEGIN');
      proxy.vanish();
      expectCutAtTheBound(await timed(session.query('SELECT 1')));
    });

    it('a migration’s, at its own bound', async () => {
      const { cfg, dataDir, by, proxy } = await host();
      await by.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      shorten = (ms) => (ms === MIGRATION_LIMIT_MS + GRACE_MS ? BOUND_MS : 30);
      const opening = timed(connectDatabase({ dataDir, db: cfg }));
      await vi.waitFor(() => expect(asked).toContain(MIGRATION_LIMIT_MS + GRACE_MS));
      proxy.vanish();
      const { err, ms } = await opening;
      expect(err).toBeInstanceOf(Error);
      expect(ms).toBeLessThan(BOUND_MS + SLACK_MS);
    });

    it('a request answers, the next is served once the host is back, and one line says it', async () => {
      const { proxy, cfg } = await host();
      const { app, a } = await boot({ db: cfg, logLevel: 'error' });
      const me = () => a.request({ method: 'GET', url: '/api/v1/opportunities' });
      expect((await me()).statusCode).toBe(200);
      proxy.vanish();
      const from = performance.now();
      expect((await me()).statusCode).toBe(500);
      expect(performance.now() - from).toBeLessThan(BOUND_MS + SLACK_MS);
      proxy.back();
      expect((await me()).statusCode).toBe(200);
      const said = logs.lines.filter((l) => l.includes(ENDED));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('ConnectionSilent');
      expect(said[0]).not.toMatch(/127\.0\.0\.1|select|sessions/i);
      expect(app.server).toBeDefined();
    });

    it('the server stops, with a request waiting', async () => {
      const { proxy, cfg } = await host();
      const { app, a } = await boot({ db: cfg, logLevel: 'error' });
      // The last thing a stop waits for: testApp's close goes on to drop a database of its own.
      const end = pg.Pool.prototype.end as () => Promise<void>;
      let stopped: number | undefined;
      vi.spyOn(pg.Pool.prototype, 'end').mockImplementation(async function (this: pg.Pool) {
        await end.call(this);
        stopped = performance.now();
      });
      proxy.vanish();
      const waiting = a.request({ method: 'GET', url: '/api/v1/opportunities' });
      await wait(100);
      const from = performance.now();
      await app.close();
      expect(stopped).toBeDefined();
      expect(stopped! - from).toBeLessThan(BOUND_MS + SLACK_MS);
      expect((await waiting).statusCode).toBe(500);
    });
  });

  describe('a write whose outcome is not known is not made twice', () => {
    it('a COMMIT that reached the server: the caller hears an error, and it is there once', async () => {
      const t = await database();
      await t.by.query('CREATE TABLE made (n int)');
      let bodies = 0;
      const cut = await timed(
        withTransaction(t.db, async (tx) => {
          bodies += 1;
          await rawGet(tx, sql`INSERT INTO made VALUES (1) RETURNING n`);
          t.proxy.holdAnswers();
        }),
      );
      expectCutAtTheBound(cut);
      expect(isLockWaitEnded(cut.err)).toBe(false);
      expect(bodies).toBe(1);
      expect((await t.by.query('SELECT n FROM made')).rows).toEqual([{ n: 1 }]);
    });

    it('a job’s end: tried again, and the guarded try changes nothing', async () => {
      const t = await database();
      const KIND = 'test.host_vanishes';
      let runs = 0;
      registerJob({
        kind: KIND,
        payloadSchema: z.object({}),
        maxAttempts: 3,
        run: async () => {
          runs += 1;
          t.proxy.holdAnswers();
        },
      });
      const id = await enqueue(t.db, KIND, {}, {});
      const errors: unknown[] = [];
      const warned: string[] = [];
      const log = { warn: (...args: unknown[]) => void warned.push(String(args.at(-1))) };
      const runner = startRunner(t.db, {
        intervalMs: 20,
        workers: 1,
        workerId: 'test-worker',
        random: () => 0,
        rowRetry: { firstMs: 50, maxMs: 200, limitMs: 60_000 },
        services: { log: log as never },
        onError: (err) => errors.push(err),
      });
      cleanups.push(async () => {
        await runner.stop();
        unregisterJob(KIND);
      });
      const row = async () =>
        (await t.by.query<Record<string, unknown>>('SELECT * FROM jobs WHERE id = $1', [id]))
          .rows[0]!;
      await vi.waitFor(async () => expect((await row()).status).toBe('done'), 5_000);
      const written = await row(); // the first try, whose answer never comes
      await vi.waitFor(() => expect(warned).toHaveLength(1), BOUND_MS + SLACK_MS);
      const next = await enqueue(t.db, KIND, {}, {});
      await vi.waitFor(
        async () =>
          expect(
            (await t.by.query('SELECT status FROM jobs WHERE id = $1', [next])).rows[0],
          ).toEqual({ status: 'done' }),
        10_000,
      );
      expect(await row()).toEqual(written);
      expect([runs, warned.length >= 1]).toEqual([2, true]);
    });
  });

  describe('what is only long is not cut', () => {
    it('a statement the server ends itself: its own answer comes first', async () => {
      const t = await database();
      const { err, ms } = await timed(sleep(t.db, 10_000));
      expect(isLockWaitEnded(err)).toBe(true); // 57014
      expect(ms).toBeLessThan(BOUND_MS);
      expect(t.ends).toEqual([]);
    });

    it('statements issued at once on one connection, longer together than the bound', async () => {
      const t = await database();
      await withTransaction(t.db, async (tx) => {
        await Promise.all([1, 2, 3, 4, 5].map(() => sleep(tx, LIMIT_MS - 200)));
      });
      expect(t.ends).toEqual([]);
    });

    it('a transaction with nothing in flight for longer than the bound', async () => {
      const t = await database();
      await withTransaction(t.db, async (tx) => {
        await one(tx);
        await wait(BOUND_MS + 500);
        expect(await one(tx)).toEqual({ v: 1 });
      });
      expect(t.ends).toEqual([]);
    });

    // Not through the proxy, which is in this process and stands still with it.
    it('a process that stood still for longer than the bound, its answer there already', async () => {
      const t = await database(undefined, true);
      const asleep = sleep(t.db, 200);
      await wait(50);
      await standStill();
      await asleep;
      expect(t.ends).toEqual([]);
    });

    it('the same, with more of the answer still to come than one turn reads', async () => {
      shorten = () => BOUND_MS;
      const t = await database('?statement_timeout=60000', true);
      const client = await t.pool.connect();
      try {
        const rows = client.query(
          "SELECT repeat('x', 10000) AS x FROM generate_series(1, 5000) AS n",
        );
        await wait(20);
        await standStill();
        expect((await rows).rowCount).toBe(5000);
      } finally {
        client.release();
      }
      expect(t.ends).toEqual([]);
    }, 60_000);

    it('a connection idle for longer than the bound has the whole of it again', async () => {
      const t = await database();
      const client = await t.pool.connect();
      try {
        await wait(BOUND_MS + 500);
        await client.query(`SELECT pg_sleep(${(LIMIT_MS - 200) / 1000})`);
        await wait(BOUND_MS + 500);
        t.proxy.vanish();
        expectCutAtTheBound(await timed(client.query('SELECT 1')));
      } finally {
        client.release(true);
      }
    });

    it('a statement still being sent to a slow host', async () => {
      shorten = () => BOUND_MS;
      const t = await database('?statement_timeout=60000');
      // More than the sockets between hold, for longer than the bound.
      const big = 'x'.repeat(64 * 1024 * 1024);
      t.proxy.slow(4);
      const client = await t.pool.connect();
      try {
        const { ms } = await timed(client.query(`SELECT length('${big}') AS n`));
        expect(ms).toBeGreaterThan(BOUND_MS);
      } finally {
        client.release();
      }
      expect(t.ends).toEqual([]);
    }, 60_000);

    it('a migration that waits for longer than the ordinary bound; after it, the ordinary one', async () => {
      const { cfg, dataDir, by } = await host();
      await by.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      const pool = new pg.Pool(pgPoolConfig(cfg));
      const sockets: net.Socket[] = [];
      pool.on('connect', (c) => sockets.push(streamOf(c)));
      const opening = connectDatabase({ dataDir, db: cfg }, { pool });
      await wait(BOUND_MS + 1_000);
      await by.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      const handle = await opening;
      cleanups.push(() => closeDatabase(handle));
      const ordinary = LIMIT_MS + GRACE_MS;
      expect(asked).toEqual([ordinary, MIGRATION_LIMIT_MS + GRACE_MS, ordinary]);
      expect(sockets.map((s) => s.timeout)).toEqual([BOUND_MS]);
    });
  });

  // What the connection was really given: pg lets the URL's value win over the code's.
  it.each([
    ['', 60_000],
    ['?statement_timeout=120000', 150_000],
    ['?statement_timeout=0', 0],
    ['?statement_timeout=2min', 0], // a unit: Postgres reads it, this does not
  ])('the bound of a connection whose URL ends %j', async (suffix, bound) => {
    const t = await database(suffix);
    shorten = (ms) => ms;
    const client = await t.pool.connect();
    cleanups.push(() => client.release(true));
    const all = asked.filter((ms) => ms !== MIGRATION_LIMIT_MS + GRACE_MS || ms === bound);
    expect([...new Set(all)]).toEqual(bound === 0 ? [] : [bound]);
    expect(streamOf(client).timeout ?? 0).toBe(bound === 0 ? 0 : bound - GRACE_MS + TEST_GRACE_MS);
  });

  it('without a limit on the server there is none here', async () => {
    const t = await database('?statement_timeout=0');
    await sleep(t.db, BOUND_MS + 500);
    t.proxy.vanish();
    const waiting = timed(one(t.db));
    expect(await Promise.race([waiting, wait(BOUND_MS + 1_000)])).toBeUndefined();
  });
});
