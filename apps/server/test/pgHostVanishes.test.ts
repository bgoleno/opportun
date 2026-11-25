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
import { PATIENCE_MS } from './patience';
import { createTestDatabase } from './pgHarness';
import { pgProxy } from './pgProxy';

const ENDED = 'postgres connection ended';
/** What the code adds to statement_timeout. */
const GRACE_MS = 30_000;
/** statement_timeout of the tests' connections: never reached, so that the silence is what ends one. */
const LIMIT_MS = 60_000;
/** How long one may be silent in the tests where that is a timer's, once the test is set up. */
const BOUND_MS = 1_500;
/** Longer than any test waits: where the silence is the test's to end, or is not to. */
const FAR_MS = 600_000;
/** The migration's statement_timeout. */
const MIGRATION_LIMIT_MS = 120_000;

/** A connection's parts that the tests look at. */
const streamOf = (client: unknown) =>
  (client as { connection: { stream: net.Socket } }).connection.stream;

describe.runIf(testDialect === 'postgres')('a Postgres host that vanishes (#981)', () => {
  const cleanups: (() => Promise<unknown> | void)[] = [];
  /** The bounds the code asked of its sockets, as it asked them. */
  const asked: number[] = [];
  /** The last one of each socket, and what it has of it now. */
  const bounds = new Map<net.Socket, number>();
  let given: (ms: number) => number;
  /** How often each was silent to its bound: an idle one's are among them. */
  const silences = new Map<net.Socket, number>();
  const real = net.Socket.prototype.setTimeout;
  /** From here on the silence of every connection, those there are too, is bounded by `of`. */
  function arm(of: (ms: number) => number = () => BOUND_MS): void {
    given = of;
    for (const [socket, ms] of bounds) if (!socket.destroyed) real.call(socket, given(ms));
  }
  /** The bound is over: what node does then. */
  const isSilent = (socket: net.Socket) => socket.emit('timeout');
  let logs = captureLogs();
  const boot = useApi(() => ({ logStream: logs }));

  beforeEach(() => {
    logs = captureLogs();
    asked.length = 0;
    bounds.clear();
    silences.clear();
    given = () => FAR_MS;
    onSlowTransaction(() => undefined); // parked on purpose
    vi.spyOn(net.Socket.prototype, 'setTimeout').mockImplementation(function (
      this: net.Socket,
      ms: number,
      callback?: () => void,
    ) {
      if (ms === 0) bounds.delete(this);
      if (ms < GRACE_MS) return real.call(this, ms, callback);
      asked.push(ms);
      if (!bounds.has(this)) {
        this.on('timeout', () => silences.set(this, (silences.get(this) ?? 0) + 1));
      }
      bounds.set(this, ms);
      return real.call(this, given(ms), callback);
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
    const pool = new pg.Pool({ ...pgPoolConfig(h.cfg), connectionTimeoutMillis: PATIENCE_MS });
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
  /** At the bound, and at no second one: each connection that was cut was silent once. */
  function expectCutAtTheBound({ err, ms }: { err: unknown; ms: number }, connections = 1): void {
    expect(err).toBeInstanceOf(Error);
    expect(ms).toBeGreaterThan(BOUND_MS - 100);
    const cut = [...silences].filter(([socket]) => socket.destroyed).map(([, n]) => n);
    expect(cut).toEqual(Array(connections).fill(1));
  }
  /** Until something that has to come has. */
  const until = (seen: () => void | Promise<void>) =>
    vi.waitFor(seen, { timeout: PATIENCE_MS, interval: 10 });
  /** A statement is in flight on one of the pool's connections. */
  const inFlight = (pool: pg.Pool) =>
    until(() =>
      expect(
        (pool as unknown as { _clients: { readyForQuery: boolean }[] })._clients.map(
          (c) => c.readyForQuery,
        ),
      ).toContain(false),
    );
  /** The host vanishes, and what is silent from here on is counted. */
  function vanish(proxy: { vanish(): void }): void {
    silences.clear();
    proxy.vanish();
  }
  const one = (db: Exec) => rawGet<{ v: number }>(db, sql`SELECT 1 AS v`);
  /** What the server says of the one connection of the test's own pool. */
  const backend = async (by: pg.Client) =>
    (
      await by.query<{ state: string; wait_event_type: string; wait_event: string }>(
        `SELECT state, wait_event_type, wait_event FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND backend_type = 'client backend' AND application_name = 'opportun'`,
      )
    ).rows.at(-1);
  const sleep = (exec: Exec, ms: number) => rawGet(exec, sql`SELECT pg_sleep(${ms / 1000})`);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** As after a process stood still: its timers run before what has come meanwhile is read. */
  const firstTheTimer = (socket: net.Socket) =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        socket.resume();
        isSilent(socket);
        resolve();
      }, 0);
    });

  describe('what is waiting ends', () => {
    it('a statement on its own', async () => {
      const t = await database();
      arm();
      vanish(t.proxy);
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
      arm();
      const cut = await timed(
        withTransaction(t.db, async (tx) => {
          await one(tx);
          vanish(t.proxy);
          await one(tx);
        }),
      );
      expectCutAtTheBound(cut);
      expect(t.pool.totalCount).toBe(0);
    });

    it('the database’s close, with a statement waiting', async () => {
      const t = await database();
      arm();
      vanish(t.proxy);
      const waiting = timed(one(t.db));
      await inFlight(t.pool);
      const { err } = await timed(t.close());
      expect(err).toBeUndefined();
      expectCutAtTheBound(await waiting);
    });

    it('a connection nothing waits for, once it is closed', async () => {
      const t = await database();
      await one(t.db);
      t.proxy.vanish();
      await t.close();
      const left = t.sockets.filter((s) => !s.destroyed);
      expect(left).not.toEqual([]); // pg-pool does not wait for it
      for (const socket of left) isSilent(socket);
      await until(() => expect(left.filter((s) => !s.destroyed)).toEqual([]));
    });

    it('one each in the whole pool; and the pool serves again once the host is back', async () => {
      const t = await database();
      await Promise.all([1, 2, 3].map(() => sleep(t.db, 100)));
      expect(t.pool.totalCount).toBe(3);
      arm();
      vanish(t.proxy);
      const all = [1, 2, 3].map(() => timed(one(t.db)));
      const next = one(t.db); // waits for a connection
      await until(() => expect(t.pool.waitingCount).toBe(1));
      t.proxy.back();
      const cuts = await Promise.all(all);
      const answer = await next;
      for (const cut of cuts) expectCutAtTheBound(cut, 3);
      expect(answer).toEqual({ v: 1 });
      expect(await Promise.all([1, 2, 3, 4].map(() => one(t.db)))).toEqual(Array(4).fill({ v: 1 }));
    });

    it('a statement of a bulk tool’s own connection', async () => {
      const { cfg, proxy } = await host();
      const session = await openPgSession(cfg);
      cleanups.push(() => session.close());
      await session.query('BEGIN');
      arm();
      vanish(proxy);
      expectCutAtTheBound(await timed(session.query('SELECT 1')));
    });

    it('a migration’s, at its own bound', async () => {
      const { cfg, dataDir, by, proxy } = await host();
      await by.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      // The ordinary one would never end it.
      given = (ms) => (ms === MIGRATION_LIMIT_MS + GRACE_MS ? BOUND_MS : FAR_MS);
      const opening = timed(connectDatabase({ dataDir, db: cfg }));
      await until(() => expect(asked).toContain(MIGRATION_LIMIT_MS + GRACE_MS));
      proxy.vanish();
      expect((await opening).err).toBeInstanceOf(Error);
    });

    it('a request answers, the next is served once the host is back, and one line says it', async () => {
      const { proxy, cfg } = await host();
      const { app, a } = await boot({ db: cfg, logLevel: 'error' });
      const me = () => a.request({ method: 'GET', url: '/api/v1/opportunities' });
      expect((await me()).statusCode).toBe(200);
      arm();
      proxy.vanish();
      expect((await me()).statusCode).toBe(500);
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
      // Before boot: a connection can keep the `query` it had.
      const sent = vi.spyOn(pg.Client.prototype, 'query');
      const { app, a } = await boot({ db: cfg, logLevel: 'error' });
      // The last thing a stop waits for: testApp's close goes on to drop a database of its own.
      const end = pg.Pool.prototype.end as () => Promise<void>;
      let stopped = false;
      vi.spyOn(pg.Pool.prototype, 'end').mockImplementation(async function (this: pg.Pool) {
        await end.call(this);
        stopped = true;
      });
      arm();
      proxy.vanish();
      sent.mockClear();
      const waiting = a.request({ method: 'GET', url: '/api/v1/opportunities' });
      await until(() => expect(sent).toHaveBeenCalled()); // a statement of it is in flight
      await app.close();
      expect(stopped).toBe(true);
      expect((await waiting).statusCode).toBe(500);
    });
  });

  describe('a write whose outcome is not known is not made twice', () => {
    it('a COMMIT that reached the server: the caller hears an error, and it is there once', async () => {
      const t = await database();
      await t.by.query('CREATE TABLE made (n int)');
      let bodies = 0;
      arm();
      const cut = await timed(
        withTransaction(t.db, async (tx) => {
          bodies += 1;
          await rawGet(tx, sql`INSERT INTO made VALUES (1) RETURNING n`);
          silences.clear();
          t.proxy.holdAnswers();
        }),
      );
      expectCutAtTheBound(cut);
      expect(isLockWaitEnded(cut.err)).toBe(false);
      expect(bodies).toBe(1);
      await until(async () =>
        expect((await t.by.query('SELECT n FROM made')).rows).toEqual([{ n: 1 }]),
      );
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
      arm();
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
      await until(async () => expect((await row()).status).toBe('done'));
      const written = await row(); // the first try, whose answer never comes
      await until(() => expect(warned).not.toEqual([]));
      const next = await enqueue(t.db, KIND, {}, {});
      await until(async () =>
        expect((await t.by.query('SELECT status FROM jobs WHERE id = $1', [next])).rows[0]).toEqual(
          { status: 'done' },
        ),
      );
      expect(await row()).toEqual(written);
      expect([runs, warned.length >= 1]).toEqual([2, true]);
    });
  });

  describe('what is only long is not cut', () => {
    it('a statement the server ends itself: its own answer comes first', async () => {
      const t = await database('?statement_timeout=600');
      arm(() => PATIENCE_MS);
      const { err } = await timed(sleep(t.db, 60_000));
      expect(isLockWaitEnded(err)).toBe(true); // 57014
      expect(t.ends).toEqual([]);
    });

    it('statements issued at once on one connection, longer together than the bound', async () => {
      const t = await database();
      const bound = 10_000;
      arm(() => bound);
      const from = performance.now();
      await withTransaction(t.db, async (tx) => {
        await Promise.all(Array.from({ length: 40 }, () => sleep(tx, 275)));
      });
      expect(performance.now() - from).toBeGreaterThan(bound);
      expect(t.ends).toEqual([]);
    }, 60_000);

    it('a transaction with nothing in flight for longer than the bound', async () => {
      const t = await database();
      await withTransaction(t.db, async (tx) => {
        await one(tx);
        for (const socket of t.sockets) isSilent(socket);
        await wait(50); // what would end it comes a turn later
        expect(await one(tx)).toEqual({ v: 1 });
      });
      expect(t.ends).toEqual([]);
    });

    // Not through the proxy, which is in this process and stands still with it.
    it('a process that stood still for longer than the bound, its answer there already', async () => {
      const t = await database(undefined, true);
      const client = await t.pool.connect();
      try {
        const socket = streamOf(client);
        socket.pause();
        const answer = client.query('SELECT 1 AS v');
        await until(async () => expect(await backend(t.by)).toMatchObject({ state: 'idle' }));
        await firstTheTimer(socket);
        expect((await answer).rows).toEqual([{ v: 1 }]);
      } finally {
        client.release();
      }
      expect(t.ends).toEqual([]);
    });

    it('the same, with more of the answer still to come than one turn reads', async () => {
      const t = await database(undefined, true);
      const client = await t.pool.connect();
      try {
        const socket = streamOf(client);
        socket.pause();
        const rows = client.query(
          "SELECT repeat('x', 10000) AS x FROM generate_series(1, 5000) AS n",
        );
        await until(async () =>
          expect(await backend(t.by)).toMatchObject({ wait_event: 'ClientWrite' }),
        );
        await firstTheTimer(socket);
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
        for (const turn of [1, 2]) {
          isSilent(streamOf(client));
          await wait(50);
          expect((await client.query('SELECT 1 AS v')).rows, `turn ${turn}`).toEqual([{ v: 1 }]);
        }
        arm();
        // Idle, past its own timer, and what that does comes a turn later.
        await until(() => expect(silences.get(streamOf(client))).toBeGreaterThan(2));
        await wait(50);
        vanish(t.proxy);
        expectCutAtTheBound(await timed(client.query('SELECT 1')));
      } finally {
        client.release(true);
      }
    });

    it('a statement still being sent to a slow host', async () => {
      const t = await database();
      const bound = 8_000;
      arm(() => bound);
      // More than the sockets between hold, for longer than the bound.
      const big = 'x'.repeat(64 * 1024 * 1024);
      t.proxy.slow(10);
      const client = await t.pool.connect();
      try {
        const { ms } = await timed(client.query(`SELECT length('${big}') AS n`));
        expect(ms).toBeGreaterThan(bound);
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
      given = (ms) => ms * 10;
      const opening = connectDatabase({ dataDir, db: cfg }, { pool });
      const [ordinary, migration] = [LIMIT_MS + GRACE_MS, MIGRATION_LIMIT_MS + GRACE_MS];
      // It waits for the lock, and its connection has the migration's bound meanwhile.
      await until(async () =>
        expect(await backend(by)).toMatchObject({
          wait_event_type: 'Lock',
          wait_event: 'advisory',
        }),
      );
      expect(sockets.map((s) => s.timeout)).toEqual([migration * 10]);
      await by.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      const handle = await opening;
      cleanups.push(() => closeDatabase(handle));
      expect(asked).toEqual([ordinary, migration, ordinary]);
      expect(sockets.map((s) => s.timeout)).toEqual([ordinary * 10]);
    });
  });

  // What the connection was really given: pg lets the URL's value win over the code's.
  it.each([
    ['', 60_000, '30s'],
    ['?statement_timeout=120000', 150_000, '2min'],
    // pg sends the number a value begins with, so a unit says nothing.
    ['?statement_timeout=120000ms', 150_000, '2min'],
    ['?statement_timeout=90000min', 120_000, '90s'],
    ['?statement_timeout=0', 0, '0'],
  ])('the bound of a connection whose URL ends %j', async (suffix, bound, limit) => {
    given = (ms) => ms * 10;
    const t = await database(suffix);
    const client = await t.pool.connect();
    cleanups.push(() => client.release(true));
    expect((await client.query('SHOW statement_timeout')).rows).toEqual([
      { statement_timeout: limit },
    ]);
    const all = asked.filter((ms) => ms !== MIGRATION_LIMIT_MS + GRACE_MS || ms === bound);
    expect([...new Set(all)]).toEqual(bound === 0 ? [] : [bound]);
    expect(streamOf(client).timeout ?? 0).toBe(bound * 10);
  });

  it('without a limit on the server there is none here', async () => {
    const t = await database('?statement_timeout=0');
    arm();
    await sleep(t.db, BOUND_MS + 500);
    t.proxy.vanish();
    const waiting = timed(one(t.db));
    expect(await Promise.race([waiting, wait(BOUND_MS + 1_000)])).toBeUndefined();
  });
});
