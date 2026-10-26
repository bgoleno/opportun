// The database seam (ADR-4, docs/adr/0004-postgres.md). Everything that knows which engine
// sits under Drizzle lives here: the drivers, connection settings, the locked migrators, the
// dialect-bound types the repos compose with, transactions (the SQLite write gate, Postgres
// advisory scope locks), raw SQL, the health probe and the drivers' constraint error codes.
// App boot, the reset-password CLI and the tests all open the database through
// connectDatabase (or openDatabase for SQLite directly); no other module touches a driver.
//
// Iteration 4: the data layer is async. SQLite: Drizzle's sqlite-proxy driver runs every
// statement through one callback over the better-sqlite3 connection, behind the write gate
// (gate.ts), so a transaction body may await while nothing from another request interleaves
// with it. Postgres (DB_DIALECT=postgres): node-postgres over a pool; each transaction owns a
// pooled connection, so there is no gate. Repos are typed against the SQLite driver and
// tables either way (dialect erasure, db/schema.ts); the Postgres database is shimmed to the
// same surface (builder .get()/.all()/.run(), raw helpers, runCount, unwrapped errors).
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import pg, { type Pool, type PoolConfig, type QueryResult } from 'pg';
import { DrizzleQueryError, is, sql, type SQL } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  PgDatabase,
  PgDeleteBase,
  PgInsertBase,
  PgPreparedQuery,
  PgSelectBase,
  PgTransaction,
  PgUpdateBase,
} from 'drizzle-orm/pg-core';
import {
  SQLiteAsyncDialect,
  SQLiteTransaction,
  type BaseSQLiteDatabase,
  type SQLiteColumn,
  type SQLiteTable,
} from 'drizzle-orm/sqlite-core';
import {
  drizzle as drizzleProxy,
  RemotePreparedQuery,
  type AsyncRemoteCallback,
  type SqliteRemoteDatabase,
  type SqliteRemoteResult,
} from 'drizzle-orm/sqlite-proxy';
import {
  copyOperatorFile,
  ensureDataDir,
  isOperatorFile,
  removeOperatorFile,
} from '../lib/storage';
import { armGateWatchdog, reportSlowTransaction, SLOW_TRANSACTION_MS, WriteGate } from './gate';
import type { DbConfig, DbSsl, PostgresConfig } from '../config';
import { SCHEMA_DIALECT } from './schema';
import * as pgSchema from './schema.pg';
import * as schema from './schema.sqlite';

export type Db = SqliteRemoteDatabase<typeof schema>;
export type Sqlite = Database.Database;

/** The database or a transaction on it: repo helpers that compose inside a transaction. */
export type Exec = BaseSQLiteDatabase<'async', SqliteRemoteResult, typeof schema>;
/** A schema table, for helpers generic over tables (list counts, the exporter). */
export type DbTable = SQLiteTable;
/** A schema column, for helpers generic over columns. */
export type DbColumn = SQLiteColumn;

/** apps/server/drizzle, resolved relative to this file so cwd does not matter. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));
/** apps/server/drizzle-pg: the Postgres chain, from 0000_baseline (drizzle-pg.config.ts). */
export const MIGRATIONS_PG_DIR = fileURLToPath(new URL('../../drizzle-pg', import.meta.url));

/** An open SQLite database (openDatabase). */
export interface SqliteHandle {
  dialect: 'sqlite';
  db: Db;
  sqlite: Sqlite;
}

/** An open Postgres database: `db` is typed as the SQLite driver (dialect erasure). */
export interface PgHandle {
  dialect: 'postgres';
  db: Db;
  pool: Pool;
  /** Boot-time findings to log (e.g. a non-C collation). */
  warnings: string[];
}

export type DbHandle = SqliteHandle | PgHandle;

/** Normal statement wait for a busy database. */
const BUSY_TIMEOUT_MS = 5000;
/** How long a booting process waits for another one to finish migrating. */
const MIGRATION_LOCK_TIMEOUT_MS = 120_000;

const NEWER_DATABASE =
  'This database was migrated by a newer release of Opportun; refusing to start an older release against it. Upgrade the image, or restore a backup taken before the upgrade.';

/** drizzle's bookkeeping table; kept identical so databases migrated either way agree. */
const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * Applies pending migrations under a database-wide write lock.
 *
 * drizzle's own migrator reads the applied set outside its transaction and then issues a
 * plain BEGIN, so two processes booting on one volume can both decide a migration is
 * pending and both apply it. Here the whole read-decide-apply sequence runs inside
 * BEGIN IMMEDIATE, which takes SQLite's write lock up front: a second process blocks on
 * the lock (busy_timeout), then sees the first one's bookkeeping rows and applies nothing.
 * Bookkeeping matches drizzle exactly (table, hash, created_at = journal `when`).
 *
 * A database whose newest applied migration is newer than any this build knows was
 * written by a later release; booting an older release against it is refused.
 */
export function migrateLocked(sqlite: Sqlite, migrationsFolder: string = MIGRATIONS_DIR): void {
  const migrations = readMigrationFiles({ migrationsFolder });
  const newestKnown = Math.max(0, ...migrations.map((m) => m.folderMillis));
  sqlite.pragma(`busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.exec(
        `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
      );
      const last = sqlite
        .prepare(`SELECT created_at FROM "${MIGRATIONS_TABLE}" ORDER BY created_at DESC LIMIT 1`)
        .get() as { created_at: number | string } | undefined;
      const lastApplied = last === undefined ? undefined : Number(last.created_at);
      if (lastApplied !== undefined && lastApplied > newestKnown) {
        throw new Error(NEWER_DATABASE);
      }
      const record = sqlite.prepare(
        `INSERT INTO "${MIGRATIONS_TABLE}" ("hash", "created_at") VALUES (?, ?)`,
      );
      for (const migration of migrations) {
        if (lastApplied !== undefined && lastApplied >= migration.folderMillis) continue;
        for (const stmt of migration.sql) {
          if (stmt.trim() !== '') sqlite.exec(stmt);
        }
        record.run(migration.hash, migration.folderMillis);
      }
      sqlite.exec('COMMIT');
    } catch (err) {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      throw err;
    }
  } finally {
    sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
}

/**
 * The session advisory lock key serializing Postgres migrations across booting processes:
 * 'opportun' as a big-endian int8, far outside the int4 range of hashtext() scope locks
 * (lockScope), so the two can never collide.
 */
export const MIGRATION_LOCK_KEY = BigInt('0x6f70706f7274756e').toString();

/**
 * migrateLocked for Postgres (iteration 4 Task 8). One pooled connection takes a session
 * advisory lock (pg_advisory_lock) before reading the bookkeeping table, then applies every
 * pending migration and its bookkeeping row in one transaction (Postgres DDL is
 * transactional), so a second booting process waits on the lock and then finds nothing to
 * apply, and a failing migration leaves neither its changes nor a bookkeeping row. Same
 * bookkeeping table and columns as SQLite's (public."__drizzle_migrations", created_at =
 * journal `when`), the same refusal of a newer database, and the same 120 s wait budget
 * (statement_timeout bounds the lock wait).
 */
export async function migrateLockedPg(
  pool: Pool,
  migrationsFolder: string = MIGRATIONS_PG_DIR,
): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const newestKnown = Math.max(0, ...migrations.map((m) => m.folderMillis));
  const client = await pool.connect();
  let broken: unknown;
  try {
    await client.query(`SET statement_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query('BEGIN');
      try {
        await client.query(
          `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
        );
        const last = await client.query<{ created_at: number | string }>(
          `SELECT created_at FROM "${MIGRATIONS_TABLE}" ORDER BY created_at DESC LIMIT 1`,
        );
        const row = last.rows[0];
        const lastApplied = row === undefined ? undefined : Number(row.created_at);
        if (lastApplied !== undefined && lastApplied > newestKnown) {
          throw new Error(NEWER_DATABASE);
        }
        for (const migration of migrations) {
          if (lastApplied !== undefined && lastApplied >= migration.folderMillis) continue;
          for (const stmt of migration.sql) {
            if (stmt.trim() !== '') await client.query(stmt);
          }
          await client.query(
            `INSERT INTO "${MIGRATIONS_TABLE}" ("hash", "created_at") VALUES ($1, $2)`,
            [migration.hash, migration.folderMillis],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
    await client.query('RESET statement_timeout');
  } catch (err) {
    broken = err;
    throw scrubPgError(err);
  } finally {
    // After an error the connection may be mid-failure: destroy it rather than pool it.
    client.release(broken === undefined ? undefined : true);
  }
}

/**
 * Switches to WAL. SQLite answers SQLITE_BUSY to a journal-mode change without consulting
 * the busy handler while another connection (a second booting process) is converting the
 * same new file, so this retries with a short sleep until the deadline.
 */
function enableWal(sqlite: Sqlite, deadlineMs: number): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      sqlite.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if ((code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED') || Date.now() > deadlineMs) {
        throw err;
      }
      Atomics.wait(pause, 0, 0, 25);
    }
  }
}

// ---------------------------------------------------------------------------
// The async driver

/** One open connection and the gate that serializes transactions on it. */
interface Conn {
  sqlite: Sqlite;
  gate: WriteGate;
  /** The unwrapped drizzle database: only withTransaction opens transactions on it. */
  raw?: Db;
}

/** Drizzle session (shared by a database and all its transactions) to its connection. */
const connections = new WeakMap<object, Conn>();

/** Compiles raw SQL for the facade helpers (bound parameters, never interpolation). */
const dialect = new SQLiteAsyncDialect();

/**
 * The async driver wraps every driver error in DrizzleQueryError, whose message embeds the
 * SQL and every bound parameter (password hashes, token hashes, ciphertexts). Callers keep
 * seeing the driver error itself, as with the sync driver, so nothing sensitive reaches a
 * log line or jobs.last_error.
 */
function unwrapDriverError(err: unknown): unknown {
  const e = err instanceof DrizzleQueryError && err.cause !== undefined ? err.cause : err;
  return scrubPgError(e);
}

/** Error fields in which Postgres echoes row values or the failing statement. */
const PG_VALUE_FIELDS = ['detail', 'where', 'internalQuery', 'internalPosition'] as const;

function isPgError(e: unknown): e is Error & Record<string, unknown> {
  if (!(e instanceof Error)) return false;
  const { code, severity } = e as { code?: unknown; severity?: unknown };
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && typeof severity === 'string';
}

/**
 * A node-postgres error without the values it can carry: `detail` ("Key (email)=(...)
 * already exists"), `where` and `internalQuery` are removed, and a data exception (SQLSTATE
 * class 22, e.g. 22P02 "invalid input syntax for type bigint: "<input>"") loses everything
 * after its first ": ", in the message and the stack. code, constraint, table, column and
 * severity stay, so callers still branch on them. Applied in place (same object and class).
 */
export function scrubPgError(err: unknown): unknown {
  if (!isPgError(err)) return err;
  for (const field of PG_VALUE_FIELDS) delete err[field];
  if (String(err.code).startsWith('22')) {
    const original = err.message;
    const cut = original.indexOf(': ');
    if (cut !== -1) {
      const scrubbed = `${original.slice(0, cut)}: [value withheld]`;
      err.message = scrubbed;
      if (err.stack !== undefined) err.stack = err.stack.split(original).join(scrubbed);
    }
  }
  return err;
}
/**
 * Both drivers' prepared queries funnel through queryWithCache, which wraps the driver error
 * (SQLite: sqlite-proxy's RemotePreparedQuery; Postgres: pg-core's PgPreparedQuery, shared
 * by node-postgres builder statements and db.execute). Patched once per process.
 */
function unwrapQueryErrors(prototype: object): void {
  type QueryWithCache = (this: unknown, ...args: unknown[]) => Promise<unknown>;
  const proto = prototype as { queryWithCache: QueryWithCache; __opportunUnwrapped?: true };
  if (proto.__opportunUnwrapped === true) return;
  const original = proto.queryWithCache;
  // .catch (not async/await) keeps the statement's synchronous start: see proxyCallback.
  proto.queryWithCache = function (this: unknown, ...args: unknown[]) {
    return original.apply(this, args).catch((err: unknown) => {
      throw unwrapDriverError(err);
    });
  };
  proto.__opportunUnwrapped = true;
}
unwrapQueryErrors(RemotePreparedQuery.prototype);
unwrapQueryErrors(PgPreparedQuery.prototype);

type Method = Parameters<AsyncRemoteCallback>[2];

function execute(sqlite: Sqlite, text: string, params: unknown[], method: Method) {
  const stmt = sqlite.prepare(text);
  if (method === 'run') {
    const r = stmt.run(...params);
    // Passed through to the caller of .run() as-is; runCount() reads `changes`.
    return { rows: [], changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }
  // Drizzle maps positional rows onto the selected fields itself (array mode).
  if (method === 'get') return { rows: stmt.raw(true).get(...params) as unknown[] };
  return { rows: stmt.raw(true).all(...params) };
}

/**
 * Every builder statement lands here. While the gate is free (or held by the caller's own
 * transaction) the statement runs synchronously at call time, so statement order is the
 * call order exactly as with the sync driver; otherwise it waits for the holder to finish.
 *
 * LOAD-BEARING INVARIANT: a statement executes only in the same synchronous step as a
 * mustWait() check that passed. idleFor() resolving is not a licence: the gate can be taken
 * again before the continuation runs (gate.test pins that), so every wake-up re-checks, and
 * nothing may be awaited between the check and execute(). Breaking this lets a statement
 * from another request run inside someone else's open transaction.
 */
function proxyCallback(conn: Conn): AsyncRemoteCallback {
  return (text, params, method) => {
    const attempt = (): Promise<ReturnType<typeof execute>> => {
      if (conn.gate.mustWait()) return conn.gate.idleFor().then(attempt);
      try {
        return Promise.resolve(execute(conn.sqlite, text, params, method));
      } catch (err) {
        return Promise.reject(err);
      }
    };
    return attempt();
  };
}

function connOf(exec: Exec): Conn {
  const session = (exec as unknown as { session: object }).session;
  const conn = connections.get(session);
  if (conn === undefined) throw new Error('not a database opened by openDatabase');
  return conn;
}

/** Builders and raw terminals: what a body could reach for on the root handle by mistake. */
const ROOT_QUERY_METHODS = new Set([
  'select',
  'selectDistinct',
  'insert',
  'update',
  'delete',
  'run',
  'all',
  'get',
  'values',
  '$count',
  'execute',
]);

/**
 * The handle callers get: the drizzle database behind a guard. `inOwnTransaction` says
 * whether the calling async context is inside a transaction opened on this database. `strict`
 * (normally isTestRun(), overridable per-connection via ConnectOptions#isTestRun, issue #292)
 * is resolved by the caller rather than read here, so this has no process.env dependency of
 * its own.
 */
function guardRoot<T extends object>(db: T, inOwnTransaction: () => boolean, strict: boolean): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      // Every environment: a transaction opened on the root handle would bypass
      // withTransaction (SQLite: the write gate, so other requests' statements would run
      // inside it and commit or roll back with it; Postgres: the context tracking below).
      if (prop === 'transaction') {
        return () => {
          throw new Error('db.transaction bypasses the write gate: use withTransaction');
        };
      }
      // Tests: a transaction body that queries through the root handle instead of its `tx` is
      // refused. On SQLite it would still land in the transaction (one connection, same gate
      // token); on a Postgres pool it runs on another connection, outside the transaction,
      // and can wait on the transaction's own row locks.
      if (strict && typeof prop === 'string' && ROOT_QUERY_METHODS.has(prop)) {
        if (inOwnTransaction()) {
          throw new Error(`db.${prop} inside a transaction on the same database: use its tx`);
        }
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

function asyncDatabase(sqlite: Sqlite, opts: ConnectOptions = {}): Db {
  const conn: Conn = { sqlite, gate: new WriteGate() };
  const db = drizzleProxy(proxyCallback(conn), { schema });
  connections.set((db as unknown as { session: object }).session, conn);
  conn.raw = db;
  return guardRoot(
    db,
    () => {
      const current = conn.gate.currentToken();
      return current !== undefined && conn.gate.holder() === current;
    },
    opts.isTestRun ?? isTestRun(),
  );
}

/** Both the data directory and sqliteDir hold a database (issue #179, incident #165). */
export class SqliteDirConflict extends Error {
  override name = 'SqliteDirConflict';
}

/**
 * One-time migration for the sqlite-dir split (issue #179, incident #165): moves
 * opportun.db off the general data directory and onto its own directory (a named Docker
 * volume in deploy/compose.yml), with VACUUM INTO rather than a file copy. VACUUM INTO
 * reads through SQLite's own connection, including whatever is still in the WAL, so it
 * produces a correct snapshot of a live database the way copying the file (and its
 * -wal/-shm siblings) cannot: that is the mechanism that corrupted the database in #165.
 *
 * The original is preserved by a true byte copy before anything -- including this
 * function's own opening of it -- touches it through SQLite's API: opening a database
 * whose WAL a prior crash left un-checkpointed can itself trigger WAL recovery, which is
 * a write, and would alter the one copy that might later need to be untouched (found
 * empirically building #142's restore command). The preserved copy
 * (opportun.db.pre-volume-migration, plus -wal/-shm) is what a human falls back to; the
 * original's own name is freed only once the new copy has passed integrity_check.
 *
 * A no-op once migrated (dataDir holds no database) or on a fresh install (neither
 * location does). When both locations hold a database, this refuses rather than guessing
 * which one is current: silently picking the wrong one is the same failure #165 was, just
 * slower.
 */
function migrateSqliteDir(
  dataDir: string,
  sqliteDir: string,
  lockTimeoutMs: number = MIGRATION_LOCK_TIMEOUT_MS,
): void {
  if (dataDir === sqliteDir) return;
  const oldFile = join(dataDir, 'opportun.db');
  const newFile = join(sqliteDir, 'opportun.db');
  if (!isOperatorFile(oldFile)) return;

  // Serializes the whole one-time migration the same way migrateLocked serializes schema
  // migrations: BEGIN IMMEDIATE takes SQLite's write lock up front, so a second process
  // racing this one (a server process and a one-off CLI script started at once, say) blocks
  // on busy_timeout and then fails cleanly rather than racing the checks and copies below --
  // which are each individually race-safe (copyOperatorFile's COPYFILE_EXCL, VACUUM INTO's
  // own exists-check) but not collectively, since the second process can still observe a
  // consistent-looking state between two of the first process's steps. Taken on oldFile
  // specifically, not newFile: it is the one file both racing processes are guaranteed to
  // already have, since the new location's own connection does not exist yet at this point.
  const lock = new Database(oldFile);
  try {
    lock.pragma(`busy_timeout = ${lockTimeoutMs}`);
    try {
      lock.exec('BEGIN IMMEDIATE');
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
        throw new SqliteDirConflict(
          `another process appears to be migrating ${oldFile} to ${sqliteDir} right now; ` +
            'refusing to run concurrently rather than guess. Wait for it to finish, then ' +
            'restart if the migration is still needed.',
        );
      }
      throw err;
    }

    if (isOperatorFile(newFile)) {
      throw new SqliteDirConflict(
        `a database exists at both ${oldFile} and ${newFile}. Opportun will not guess which one ` +
          'is current: move or remove whichever one is stale, then restart.',
      );
    }

    const retiredBase = `${oldFile}.pre-volume-migration`;
    const files: [string, string][] = [
      [oldFile, retiredBase],
      [`${oldFile}-wal`, `${retiredBase}-wal`],
      [`${oldFile}-shm`, `${retiredBase}-shm`],
    ];
    for (const [, to] of files) {
      if (isOperatorFile(to)) {
        throw new Error(
          `${to} already exists: an earlier migration attempt may have been interrupted. ` +
            `Check it by hand (sqlite3 ${to} 'PRAGMA integrity_check;') before removing it, ` +
            'then restart.',
        );
      }
    }
    for (const [from, to] of files) {
      if (isOperatorFile(from)) copyOperatorFile(from, to);
    }

    const source = new Database(oldFile, { readonly: true, fileMustExist: true });
    try {
      source.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      source.prepare('VACUUM INTO ?').run(newFile);
    } finally {
      source.close();
    }
    const copy = new Database(newFile, { fileMustExist: true });
    let check: unknown;
    try {
      check = copy.pragma('integrity_check', { simple: true });
    } finally {
      copy.close();
    }
    if (check !== 'ok') {
      removeOperatorFile(newFile);
      throw new Error(
        `the copy of ${oldFile} written to ${newFile} by VACUUM INTO failed integrity_check ` +
          `(${String(check)}); the pre-migration original is preserved at ${retiredBase}`,
      );
    }
    // The preserved copy already holds everything; the original's own name is redundant
    // (and may have been altered by opening it above) now that migration is verified good.
    for (const [from] of files) {
      if (isOperatorFile(from)) removeOperatorFile(from);
    }
  } finally {
    if (lock.inTransaction) lock.exec('COMMIT');
    lock.close();
  }
}

/** Opens `${sqliteDir}/opportun.db` with WAL and foreign keys on, then applies migrations. */
export function openDatabase(
  dataDir: string,
  sqliteDir: string = dataDir,
  opts: ConnectOptions = {},
): SqliteHandle {
  // The repos' tables were picked from DB_DIALECT at load (db/schema.ts): SQLite statements
  // built from Postgres tables would be garbage, so the two must agree.
  if (SCHEMA_DIALECT !== 'sqlite') {
    throw new Error(`DB_DIALECT=${SCHEMA_DIALECT}: refusing to open the SQLite database`);
  }
  ensureDataDir(dataDir);
  ensureDataDir(sqliteDir);
  migrateSqliteDir(dataDir, sqliteDir, opts.migrationLockTimeoutMs);
  const sqlite = new Database(join(sqliteDir, 'opportun.db'));
  try {
    // Set before anything else: switching to WAL itself needs the lock another booting
    // process may hold.
    sqlite.pragma(`busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
    enableWal(sqlite, Date.now() + MIGRATION_LOCK_TIMEOUT_MS);
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // Migrations run on the raw connection before the async driver exists.
    migrateLocked(sqlite);
    return { dialect: 'sqlite', db: asyncDatabase(sqlite, opts), sqlite };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The Postgres driver (DB_DIALECT=postgres)

type PgDb = NodePgDatabase<typeof pgSchema>;
type AnyPgDatabase = PgDatabase<never, typeof pgSchema>;

/** A Postgres database opened by connectDatabase. */
interface PgConn {
  pool: Pool;
  /** The unwrapped drizzle database: only withTransaction opens transactions on it. */
  raw: PgDb;
}

/** Root drizzle session to its connection (transactions get a session of their own). */
const pgConnections = new WeakMap<object, PgConn>();

/**
 * The Postgres database whose transaction the calling async context is inside. The SQLite
 * gate token's twin: it lets the guards refuse the root handle (another pooled connection,
 * outside the transaction) and a second withTransaction(db) inside the caller's transaction.
 */
const pgTransactionContext = new AsyncLocalStorage<PgConn>();

/** Per-statement ceiling on Postgres (a runaway query, a lock wait). */
const STATEMENT_TIMEOUT_MS = 30_000;

/** int8 as a JS number; refuses, rather than rounds, a value beyond 2^53. */
function parseInt8(text: string): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`int8 value ${text} is outside the JS safe integer range`);
  }
  return n;
}

/**
 * Epoch-ms timestamps and every other integer are bigint on Postgres (schema.pg.ts), and
 * count(*) and sum(integer) are int8, sum(bigint) and avg() numeric: node-postgres returns
 * all of those as strings by default, where SQLite returns numbers. The parsers are
 * process-global because drizzle's per-query type parser falls back to pg.types; all values
 * the app stores are below 2^53.
 */
function installPgTypeParsers(): void {
  pg.types.setTypeParser(pg.types.builtins.INT8, parseInt8);
  pg.types.setTypeParser(pg.types.builtins.NUMERIC, (text: string) => Number(text));
  // json/jsonb stay text, as SQLite returns them: drizzle's json columns parse them (once),
  // and raw rows go through dialect decodeJson. With node-postgres parsing too, a stored JSON
  // string such as "123" would be parsed twice and come back as the number 123.
  const asText = (text: string) => text;
  pg.types.setTypeParser(pg.types.builtins.JSON, asText);
  pg.types.setTypeParser(pg.types.builtins.JSONB, asText);
}

interface Executable {
  execute: () => Promise<unknown>;
}

/**
 * The terminal shim (Task 9). Repos call the SQLite builders' .get()/.all()/.run() (140, 65
 * and 112 sites at Wave 1's count) and read .run() results only through runCount. Postgres
 * builders have execute() alone, so their prototypes gain the same three terminals:
 * all = rows, get = first row or undefined, run = { changes: rowCount }. A drizzle upgrade
 * that adds a member of the same name fails loudly here instead of being shadowed.
 */
function installPgTerminalShim(): void {
  const builders = { PgSelectBase, PgInsertBase, PgUpdateBase, PgDeleteBase };
  const rowsOf = (r: unknown): unknown[] => (Array.isArray(r) ? r : (r as QueryResult).rows);
  for (const [name, cls] of Object.entries(builders)) {
    const proto = cls.prototype as object as Record<string, unknown>;
    if (proto.__opportunTerminals === true) continue;
    for (const terminal of ['get', 'all', 'run']) {
      if (terminal in proto) {
        throw new Error(
          `drizzle ${name}.${terminal} exists: the Postgres terminal shim would shadow it`,
        );
      }
    }
    Object.defineProperties(proto, {
      all: {
        value(this: Executable) {
          return this.execute().then(rowsOf);
        },
      },
      get: {
        value(this: Executable) {
          return this.execute().then((r) => rowsOf(r)[0]);
        },
      },
      run: {
        value(this: Executable) {
          return this.execute().then((r) => ({
            changes: Array.isArray(r) ? r.length : ((r as QueryResult).rowCount ?? 0),
          }));
        },
      },
      __opportunTerminals: { value: true },
    });
  }
}
installPgTerminalShim();

/** node-postgres pool settings for a PostgresConfig (DB_SSL semantics as in libpq). */
export function pgPoolConfig(cfg: PostgresConfig): PoolConfig {
  return {
    connectionString: cfg.url,
    max: cfg.poolMax,
    // require: encrypted, certificate not checked; verify-full: chain and hostname checked
    // (a private CA goes in NODE_EXTRA_CA_CERTS).
    ssl: cfg.ssl === 'disable' ? false : { rejectUnauthorized: cfg.ssl === 'verify-full' },
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: 'opportun',
    connectionTimeoutMillis: 10_000,
  };
}

const LOCALE_PROVIDERS: Record<string, string> = { c: 'libc', i: 'icu', b: 'builtin' };

/**
 * Why a database's collation differs from SQLite's byte order, or undefined when it does
 * not. Postgres orders text by the database collation; SQLite by bytes (BINARY). Names and
 * titles sort alike only under the libc C (or POSIX) locale, which also keeps lower() and
 * ILIKE ASCII-only like SQLite's. datcollate alone is not enough: an ICU (or Postgres 17
 * builtin) database reports datcollate C while ordering by its own locale.
 */
export function collationProblem(
  row: { datcollate: string; datctype: string; datlocprovider?: string } | undefined,
): string | undefined {
  const fix =
    "create the database with LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C' (docs/install.md)";
  if (row === undefined) return `database collation is unknown: ${fix}`;
  const provider = row.datlocprovider ?? 'c';
  if (provider !== 'c') {
    return `database locale provider is ${LOCALE_PROVIDERS[provider] ?? provider}, not libc: names and titles sort differently than on SQLite (${fix})`;
  }
  const isC = (v: string) => v === 'C' || v === 'POSIX';
  if (isC(row.datcollate) && isC(row.datctype)) return undefined;
  const which = isC(row.datcollate) ? row.datctype : row.datcollate;
  return `database collation is ${which}, not C: names and titles sort differently than on SQLite (${fix})`;
}

async function collationWarnings(pool: Pool): Promise<string[]> {
  const res = await pool.query<{ datcollate: string; datctype: string; datlocprovider: string }>(
    'SELECT datcollate, datctype, datlocprovider FROM pg_database WHERE datname = current_database()',
  );
  const problem = collationProblem(res.rows[0]);
  return problem === undefined ? [] : [problem];
}

export interface ConnectOptions {
  /** Postgres only: an existing pool (tests pass a recording fake). Not ended on failure. */
  pool?: Pool;
  /** Postgres only: an idle pooled connection failed (e.g. the server restarted). */
  onIdleError?: (err: Error) => void;
  /**
   * Overrides isTestRun()'s own process.env-based detection for this one connection (issue
   * #292): a test that needs to open a handle as if it were NOT a test run passes `false`
   * here instead of mutating process.env.VITEST/NODE_ENV, which vitest's threads pool shares
   * across every test file in the same worker and could silently affect one of them.
   */
  isTestRun?: boolean;
  /**
   * SQLite only: overrides migrateSqliteDir's busy_timeout for the concurrent-migration lock
   * it takes on the old data-directory file. Production always uses MIGRATION_LOCK_TIMEOUT_MS
   * (120s); a test simulating a second process already holding that lock passes a much
   * smaller value here so it does not have to wait out the real production timeout.
   */
  migrationLockTimeoutMs?: number;
}

async function openPostgres(cfg: PostgresConfig, opts: ConnectOptions): Promise<PgHandle> {
  installPgTypeParsers();
  const owned = opts.pool === undefined;
  const pool = opts.pool ?? new pg.Pool(pgPoolConfig(cfg));
  // Without a listener an idle connection's error would crash the process.
  pool.on(
    'error',
    opts.onIdleError ??
      ((err: Error) => console.error(`postgres: idle connection error: ${err.message}`)),
  );
  try {
    await migrateLockedPg(pool);
    const warnings = await collationWarnings(pool);
    const raw = drizzlePg(pool, { schema: pgSchema });
    const conn: PgConn = { pool, raw };
    pgConnections.set((raw as unknown as { session: object }).session, conn);
    const db = guardRoot(
      raw,
      () => pgTransactionContext.getStore() === conn,
      opts.isTestRun ?? isTestRun(),
    );
    return { dialect: 'postgres', db: db as unknown as Db, pool, warnings };
  } catch (err) {
    if (owned) await pool.end().catch(() => undefined);
    throw err;
  }
}

/**
 * Opens the configured database: SQLite in sqliteDir, defaulting to dataDir (openDatabase),
 * or Postgres from DATABASE_URL (migrated with migrateLockedPg, collation checked). The
 * dialect must be the one db/schema loaded its tables for (both read DB_DIALECT).
 */
export async function connectDatabase(
  cfg: { dataDir: string; sqliteDir?: string; db: DbConfig },
  opts: ConnectOptions = {},
): Promise<DbHandle> {
  if (cfg.db.dialect !== SCHEMA_DIALECT) {
    const name = cfg.db.dialect === 'sqlite' ? 'SQLite' : 'Postgres';
    throw new Error(`DB_DIALECT=${SCHEMA_DIALECT}: refusing to open the ${name} database`);
  }
  if (cfg.db.dialect === 'sqlite') {
    return openDatabase(cfg.dataDir, cfg.sqliteDir ?? cfg.dataDir, opts);
  }
  return openPostgres(cfg.db, opts);
}

// ---------------------------------------------------------------------------
// The SQLite-to-Postgres copy tool's connections (lib/copyToPostgres.ts)

/** The journal `when` of the newest migration this build knows, per dialect. */
export function knownMigrationHead(dialect: 'sqlite' | 'postgres'): number {
  const folder = dialect === 'sqlite' ? MIGRATIONS_DIR : MIGRATIONS_PG_DIR;
  return Math.max(
    0,
    ...readMigrationFiles({ migrationsFolder: folder }).map((m) => m.folderMillis),
  );
}

/**
 * A SQLite database file opened read-only, inside one read transaction from open to close:
 * every query sees the same snapshot. Nothing is written (no WAL switch, no migrations, no
 * checkpoint). Integers arrive as bigint (safe integers), so none is rounded silently.
 */
export interface SqliteSnapshot {
  all<T = Record<string, unknown>>(text: string, ...params: unknown[]): T[];
  close(): void;
}

export function openSqliteSnapshot(file: string): SqliteSnapshot {
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    sqlite.exec('BEGIN');
    // A deferred transaction takes its snapshot at the first read.
    sqlite.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (err) {
    sqlite.close();
    throw err;
  }
  return {
    all: <T>(text: string, ...params: unknown[]) =>
      sqlite
        .prepare(text)
        .safeIntegers(true)
        .all(...params) as T[],
    close: () => {
      if (sqlite.inTransaction) sqlite.exec('COMMIT');
      sqlite.close();
    },
  };
}

/**
 * One dedicated Postgres connection for a bulk tool that runs its own transaction (BEGIN,
 * COMMIT and ROLLBACK through `query`). `db` is a drizzle database over the same connection,
 * typed as Db, so repository helpers (the search indexers) write inside that transaction.
 * Values arrive through the app's type parsers (int8 as number, jsonb as text).
 */
export interface PgSession {
  db: Db;
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
  /** Why the database's collation differs from SQLite's byte order, or undefined. */
  collation: string | undefined;
  /** Migrates the database to head (migrateLockedPg, on a second pooled connection). */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens a PgSession on `cfg` without changing the database: the caller inspects it first
 * and migrates it (migrate()) only once it is known to be one it may write. Requires
 * DB_DIALECT=postgres for the same reason connectDatabase does: the repository helpers build
 * SQL from db/schema's tables.
 */
export async function openPgSession(cfg: PostgresConfig): Promise<PgSession> {
  if (SCHEMA_DIALECT !== 'postgres') {
    throw new Error(`DB_DIALECT=${SCHEMA_DIALECT}: refusing to open the Postgres database`);
  }
  installPgTypeParsers();
  // Two connections: the session's own, and one for migrate().
  const pool = new pg.Pool({ ...pgPoolConfig(cfg), max: 2, application_name: 'opportun-copy' });
  pool.on('error', (err: Error) =>
    console.error(`postgres: idle connection error: ${err.message}`),
  );
  let client: pg.PoolClient | undefined;
  try {
    const [collation] = await collationWarnings(pool);
    client = await pool.connect();
    const own = client;
    let broken = false;
    return {
      db: drizzlePg(own, { schema: pgSchema }) as unknown as Db,
      collation,
      migrate: () => migrateLockedPg(pool),
      query: async <T>(text: string, params?: unknown[]) => {
        try {
          const r = await own.query(text, params);
          return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
        } catch (err) {
          broken = true;
          throw scrubPgError(err);
        }
      },
      close: async () => {
        own.release(broken ? true : undefined);
        await pool.end();
      },
    };
  } catch (err) {
    client?.release(true);
    await pool.end().catch(() => undefined);
    throw scrubPgError(err);
  }
}

function isPg(exec: unknown): exec is AnyPgDatabase {
  return is(exec, PgDatabase);
}

function isPgTransaction(exec: unknown): exec is PgTransaction<never, typeof pgSchema> {
  return is(exec, PgTransaction);
}

function pgConnOf(exec: unknown): PgConn {
  const session = (exec as { session: object }).session;
  const conn = pgConnections.get(session);
  if (conn === undefined) throw new Error('not a database opened by connectDatabase');
  return conn;
}

// ---------------------------------------------------------------------------
// Transactions

export interface TransactionOptions {
  /** SQLite always uses BEGIN IMMEDIATE (the write lock up front). */
  behavior?: 'immediate';
  /**
   * Serialization scope (e.g. 'registration', 'user:<id>'). Ignored on SQLite, where the
   * write gate already serializes every transaction; Postgres takes an advisory lock on it.
   */
  scope?: string;
  /** Names the transaction in the production watchdog's warning (default: the call site). */
  label?: string;
  /**
   * Overrides isTestRun()'s own process.env-based detection for this one call (issue #292):
   * a test exercising the production watchdog passes `false` here instead of mutating
   * process.env.VITEST/NODE_ENV, which vitest's threads pool shares across every test file in
   * the same worker and could silently affect one of them.
   */
  isTestRun?: boolean;
}

/** The first stack frame outside db/client.ts: who opened the transaction. */
function callSite(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 4;
  const stack = new Error().stack;
  Error.stackTraceLimit = limit;
  return stack
    ?.split('\n')
    .slice(1)
    .map((l) => l.trim())
    .find((l) => !l.includes('db/client'));
}

function isTestRun(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined;
}

/**
 * Runs `fn` in a transaction that commits when it resolves and rolls back when it throws.
 * On the database it holds the write gate from BEGIN IMMEDIATE to COMMIT/ROLLBACK; on a
 * transaction it is a savepoint. Opening one on the database from inside another of the
 * caller's transactions is refused (pass the tx): on a Postgres pool that would be a second,
 * independent transaction. The body must not do external I/O (fetch, AI, files, argon2, timers): every
 * other request waits while it runs.
 */
export async function withTransaction<T>(
  exec: Exec,
  fn: (tx: Exec) => Promise<T>,
  opts: TransactionOptions = {},
): Promise<T> {
  const body =
    opts.scope === undefined
      ? fn
      : async (tx: Exec) => {
          await lockScope(tx, opts.scope as string);
          return fn(tx);
        };
  if (isPgTransaction(exec)) {
    // A savepoint on the transaction's own connection.
    return exec.transaction((tx) => body(tx as unknown as Exec));
  }
  if (isPg(exec)) {
    const conn = pgConnOf(exec);
    if (pgTransactionContext.getStore() === conn) {
      throw new Error('withTransaction(db) inside a transaction on the same database: pass its tx');
    }
    return pgTransaction(conn, body, opts);
  }
  if (is(exec, SQLiteTransaction)) return exec.transaction((tx) => body(tx));
  const { gate } = connOf(exec);
  const current = gate.currentToken();
  if (current !== undefined && gate.holder() === current) {
    throw new Error('withTransaction(db) inside a transaction on the same database: pass its tx');
  }
  const db = connOf(exec).raw ?? (exec as Db);
  const token = Symbol('transaction');
  const testRun = opts.isTestRun ?? isTestRun();
  const caller = testRun ? new Error('withTransaction caller').stack : undefined;
  // Production: name the holder cheaply (one short stack) for the watchdog's warning.
  const site = testRun || opts.label !== undefined ? undefined : callSite();
  const release = await gate.acquire(token);
  const disarm = testRun
    ? undefined
    : armGateWatchdog(() => opts.label ?? site ?? 'unknown transaction');
  const started = performance.now();
  // In tests: did the event loop turn while the gate was held (see SlowTransaction)?
  let awaitedOutside = false;
  const turn = caller === undefined ? undefined : setImmediate(() => (awaitedOutside = true));
  try {
    return await gate.run(token, () => db.transaction((tx) => body(tx), { behavior: 'immediate' }));
  } finally {
    const durationMs = Math.round(performance.now() - started);
    release();
    disarm?.();
    if (turn !== undefined) clearImmediate(turn);
    if (caller !== undefined && (awaitedOutside || durationMs > SLOW_TRANSACTION_MS)) {
      reportSlowTransaction({ durationMs, awaitedOutside, stack: caller });
    }
  }
}

/**
 * A transaction on its own pooled connection, READ COMMITTED (the Task 5 atomic forms assume
 * it). There is no gate on Postgres, so the SQLite guards are replaced by timing:
 * - outside tests, the same watchdog as SQLite's gate warns once about a transaction open
 *   longer than GATE_WATCHDOG_MS (it holds a pooled connection and its row locks);
 * - in tests, the body's wall time (from its start, after the connection was acquired and
 *   BEGIN ran, to its end, before COMMIT) is split into time with a statement in flight on
 *   the transaction's connection and time without one. The SQLite check (did the event loop
 *   turn?) cannot work here, since every statement is network I/O. A body that spent more
 *   than SLOW_TRANSACTION_MS waiting on something other than its own statements is reported
 *   as awaitedOutside (test/setup.ts fails the test). Blind spots: an outside await shorter
 *   than the budget (an argon2 hash, a fast fake fetch) passes; the SQLite leg, which runs the
 *   same code paths with the stricter event-loop check, is the authority for those.
 */
async function pgTransaction<T>(
  conn: PgConn,
  body: (tx: Exec) => Promise<T>,
  opts: TransactionOptions,
): Promise<T> {
  const testRun = opts.isTestRun ?? isTestRun();
  const caller = testRun ? new Error('withTransaction caller').stack : undefined;
  const site = testRun || opts.label !== undefined ? undefined : callSite();
  const disarm = testRun
    ? undefined
    : armGateWatchdog(() => opts.label ?? site ?? 'unknown transaction');
  // The body's own time: from when it starts (after the pooled connection was acquired and
  // BEGIN ran) to when it settles (before COMMIT/ROLLBACK). Waiting for a connection while
  // other transactions hold the pool is not the body's doing and is not counted.
  let started: number | undefined;
  let ended: number | undefined;
  const timing = { dbMs: 0, inFlight: 0, since: 0 };
  let restore: (() => void) | undefined;
  try {
    return await pgTransactionContext.run(conn, () =>
      conn.raw.transaction(
        async (tx) => {
          if (caller === undefined) return body(tx as unknown as Exec);
          restore = timeStatements(tx, timing);
          started = performance.now();
          try {
            return await body(tx as unknown as Exec);
          } finally {
            ended = performance.now();
            restore?.();
            restore = undefined;
          }
        },
        { isolationLevel: 'read committed' },
      ),
    );
  } finally {
    restore?.();
    disarm?.();
    if (caller !== undefined && started !== undefined) {
      const durationMs = Math.round((ended ?? performance.now()) - started);
      const outsideMs = durationMs - Math.round(timing.dbMs);
      const awaitedOutside = outsideMs > SLOW_TRANSACTION_MS;
      if (awaitedOutside || durationMs > SLOW_TRANSACTION_MS) {
        reportSlowTransaction({ durationMs, awaitedOutside, stack: caller });
      }
    }
  }
}

/**
 * Tests: accumulates into `timing.dbMs` the time during which at least one statement is in
 * flight on the transaction's pooled connection (overlapping statements counted once).
 * Returns the undo; the connection goes back to the pool unpatched.
 */
function timeStatements(
  tx: unknown,
  timing: { dbMs: number; inFlight: number; since: number },
): (() => void) | undefined {
  const client = (tx as { session?: { client?: { query?: unknown } } }).session?.client;
  if (client === undefined || typeof client.query !== 'function') return undefined;
  const original = client.query as (...args: unknown[]) => unknown;
  const done = () => {
    timing.inFlight -= 1;
    if (timing.inFlight === 0) timing.dbMs += performance.now() - timing.since;
  };
  client.query = function (this: unknown, ...args: unknown[]) {
    if (timing.inFlight === 0) timing.since = performance.now();
    timing.inFlight += 1;
    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (err) {
      done();
      throw err;
    }
    if (result instanceof Promise) result.then(done, done);
    else done();
    return result;
  };
  return () => {
    client.query = original;
  };
}

/**
 * Serializes the rest of the caller's transaction with every other transaction holding the
 * same scope (e.g. 'user:<id>' around a check-then-insert that has no unique index to lean
 * on). Must run inside a transaction: in-transaction helpers call it themselves, so the guard
 * holds whichever transaction they are composed into.
 *
 * SQLite: the write gate already serializes all transactions, so this only asserts the caller
 * is in one. Postgres: pg_advisory_xact_lock(hashtext(scope)) on the transaction's own
 * connection, held until that transaction's COMMIT or ROLLBACK, so composed into an outer
 * transaction it holds exactly as long as Wave 1's gate does: to the end of the outermost
 * transaction. Parity notes: (1) taken inside a savepoint that later rolls back, Postgres
 * releases the lock with the savepoint while the outer transaction continues; the guarded
 * check and writes rolled back with it, and every guarded helper takes the lock again before
 * its next check, so nothing relies on the lock outliving the savepoint. (2) hashtext() is
 * int4, so two scopes can share a key: that over-serializes, never under-serializes. (3) The
 * wait is bounded by statement_timeout (30 s), after which the transaction fails.
 */
export async function lockScope(exec: Exec, scope: string): Promise<void> {
  if (scope.length === 0) throw new Error('lockScope: empty scope');
  if (isPgTransaction(exec)) {
    await exec.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${scope}))`);
    return;
  }
  // A transaction object, never the root handle (on Postgres the lock would be taken on some
  // other pool connection and protect nothing).
  if (!is(exec, SQLiteTransaction)) throw new Error(`lockScope(${scope}) outside a transaction`);
}

// ---------------------------------------------------------------------------
// Raw SQL and counts

async function onConnection<T>(
  exec: Exec,
  query: SQL,
  run: (stmt: Database.Statement, params: unknown[]) => T,
): Promise<T> {
  const conn = connOf(exec);
  const { sql: text, params } = dialect.sqlToQuery(query);
  // Same invariant as proxyCallback: the last mustWait() check and the statement share one
  // synchronous step (no await between the loop condition and run()).
  while (conn.gate.mustWait()) await conn.gate.idleFor();
  return run(conn.sqlite.prepare(text), params);
}

/** Postgres: the statement on the exec's connection (a transaction's own, or the pool). */
async function pgExecute(exec: AnyPgDatabase, query: SQL): Promise<QueryResult> {
  return (await exec.execute(query)) as unknown as QueryResult;
}

/** Every row of a raw query, as objects keyed by column alias. */
export function rawAll<T>(exec: Exec, query: SQL): Promise<T[]> {
  if (isPg(exec)) return pgExecute(exec, query).then((r) => r.rows as T[]);
  return onConnection(exec, query, (stmt, params) => stmt.all(...params) as T[]);
}

/** The first row of a raw query, or undefined. */
export function rawGet<T>(exec: Exec, query: SQL): Promise<T | undefined> {
  if (isPg(exec)) return pgExecute(exec, query).then((r) => r.rows[0] as T | undefined);
  return onConnection(exec, query, (stmt, params) => stmt.get(...params) as T | undefined);
}

/** Runs a raw statement; `changes` is the number of rows it wrote. */
export function rawRun(exec: Exec, query: SQL): Promise<{ changes: number }> {
  if (isPg(exec)) return pgExecute(exec, query).then((r) => ({ changes: r.rowCount ?? 0 }));
  return onConnection(exec, query, (stmt, params) => ({ changes: stmt.run(...params).changes }));
}

/**
 * Runs an insert/update/delete builder and returns how many rows it wrote (SQLite `changes`;
 * Postgres rowCount, through the terminal shim's run()).
 */
export async function runCount(builder: { run: () => Promise<unknown> }): Promise<number> {
  const result = (await builder.run()) as { changes?: number };
  return result.changes ?? 0;
}

// ---------------------------------------------------------------------------
// Client tools (pg_dump for backups)

/** Connection parameters for libpq client tools, as environment variables. */
export type LibpqEnv = Record<string, string>;

/**
 * libpq environment variables reaching the database at `url` with Opportun's DB_SSL
 * semantics, for client tools spawned by the app (pg_dump, jobs/backup.ts). The connection,
 * password included, travels in the child's environment, never in its argv (visible to every
 * user through ps). verify-full checks the chain against the URL's sslrootcert, else the CA
 * bundle Node is told about (NODE_EXTRA_CA_CERTS), else the system trust store.
 */
export function libpqEnvFor(
  url: string,
  ssl: DbSsl,
  processEnv: Record<string, string | undefined> = process.env,
): LibpqEnv {
  // A socket URL (postgres://user@/db?host=/run/postgresql) has an empty host, which the
  // WHATWG parser refuses after userinfo; parse it with a placeholder host instead.
  let hostless = false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    hostless = true;
    u = new URL(url.replace('@/', '@socket.invalid/'));
  }
  const q = u.searchParams;
  const env: LibpqEnv = {};
  const set = (key: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && value !== '') env[key] = value;
  };
  set('PGHOST', q.get('host') ?? (hostless ? undefined : u.hostname.replace(/^\[(.*)\]$/, '$1')));
  set('PGPORT', q.get('port') ?? u.port);
  set('PGUSER', q.get('user') ?? decodeURIComponent(u.username));
  set('PGPASSWORD', q.get('password') ?? decodeURIComponent(u.password));
  set('PGDATABASE', q.get('dbname') ?? decodeURIComponent(u.pathname.replace(/^\//, '')));
  env.PGSSLMODE = ssl;
  if (ssl === 'verify-full') {
    set('PGSSLROOTCERT', q.get('sslrootcert') ?? processEnv.NODE_EXTRA_CA_CERTS ?? 'system');
  }
  env.PGAPPNAME = 'opportun-backup';
  env.PGCONNECT_TIMEOUT = '10';
  return env;
}

/** libpq variables for the Postgres database behind `db`, or undefined on SQLite. */
export function pgClientEnv(db: Db): LibpqEnv | undefined {
  if (!isPg(db)) return undefined;
  const { pool } = pgConnOf(db);
  const opts = (pool as unknown as { options: PoolConfig }).options;
  const ssl: DbSsl =
    opts.ssl === false || opts.ssl === undefined
      ? 'disable'
      : typeof opts.ssl === 'object' && opts.ssl.rejectUnauthorized === true
        ? 'verify-full'
        : 'require';
  return libpqEnvFor(opts.connectionString ?? '', ssl);
}

// ---------------------------------------------------------------------------
// Health, close, errors

/** True while the connection answers a trivial query (the /healthz database probe). */
export async function pingDatabase(handle: DbHandle): Promise<boolean> {
  return (await rawGet(handle.db, sql`SELECT 1 AS ok`)) !== undefined;
}

/** Closes the connection (SQLite) or ends the pool (Postgres); the handle is unusable after. */
export async function closeDatabase(handle: DbHandle): Promise<void> {
  if (handle.dialect === 'sqlite') handle.sqlite.close();
  else await handle.pool.end();
}

/** True when `err` is the driver's unique-constraint violation (a lost insert race). */
export function isUniqueViolation(err: unknown): boolean {
  const e = unwrapDriverError(err);
  return (
    e instanceof Error &&
    'code' in e &&
    typeof e.code === 'string' &&
    // SQLite's extended code, or Postgres SQLSTATE unique_violation.
    (e.code.startsWith('SQLITE_CONSTRAINT_UNIQUE') || e.code === '23505')
  );
}
