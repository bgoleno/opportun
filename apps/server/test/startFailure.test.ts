// A server that cannot start says why, and what to check, and reveals nothing
// (https://github.com/bgoleno/opportun/issues/887). The cases an operator meets most are started
// for real, as a process, with canaries in every connection setting; the rest are the errors the
// same drivers throw, classified in this process. None needs a Postgres: a small server here
// answers as one would.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresConfig } from '../src/config';
import { DatabaseRefused, migrateLocked, migrateLockedPg, pgPoolConfig } from '../src/db/client';
import { LOG_MESSAGES, START_FAILURES, type StartFailureReason } from '../src/obs/catalog';
import { createLogger } from '../src/obs/log';
import { ListenFailure, logStartFailure, startFailureReason } from '../src/startFailure';

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const USER = 'canaryuser';
const PASSWORD = 'canarypassword';
const DB_NAME = 'canarydatabase';
const HOST = 'canaryhost.invalid';
const KEY = 'ca9a1e'.repeat(10) + 'cafe';
const DIR = 'canarydir';
const CANARIES = [USER, PASSWORD, DB_NAME, HOST, KEY, DIR, 'canary'];

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const done of cleanups.splice(0)) await done();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), `opportun-${DIR}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A TCP server on a free local port. */
async function listen(onConnection: (socket: Socket) => void): Promise<number> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

/** A port nothing listens on: one that was just given back. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Answers a client's first message as Postgres refuses one, quoting what it was sent. */
function refusingPostgres(code: string): Promise<number> {
  return listen((socket) => {
    socket.once('data', () => {
      const text = `refused ${USER} ${PASSWORD} at postgres://${USER}:${PASSWORD}@${HOST}/${DB_NAME}`;
      const fields = `SFATAL\0VFATAL\0C${code}\0M${text}\0D${text}\0\0`;
      const body = Buffer.from(fields);
      const head = Buffer.alloc(5);
      head.write('E');
      head.writeInt32BE(body.length + 4, 1);
      socket.end(Buffer.concat([head, body]));
    });
  });
}

const url = (port: number): string => `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/${DB_NAME}`;

/** A database file as a later release leaves it. */
function newerDatabase(dir: string): void {
  const db = new Database(join(dir, 'opportun.db'));
  db.exec(
    'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  );
  db.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)').run(
    'from-the-future',
    9_999_999_999_999,
  );
  db.close();
}

interface Started {
  code: number | null;
  output: string;
  lines: Record<string, unknown>[];
}

/** Starts the real server in a process of its own, with none of this one's settings. */
async function startServer(settings: Record<string, string>): Promise<Started> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER,
    env: {
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      DATA_DIR: tempDir(),
      DB_DIALECT: 'sqlite',
      OPPORTUN_MASTER_KEY: KEY,
      OPPORTUN_BASE_URL: 'http://localhost:3000',
      PORT: '0',
      ...settings,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  const kill = setTimeout(() => child.kill('SIGKILL'), 45_000);
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(kill);
  const lines = output
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { code, output, lines };
}

function expectFailed(started: Started, reason: StartFailureReason): void {
  const failed = started.lines.filter((l) => String(l.msg).startsWith('server failed to start'));
  expect(failed.map((l) => l.msg)).toEqual([START_FAILURES[reason]]);
  expect(started.code).toBe(1);
  for (const canary of CANARIES) expect(started.output.toLowerCase()).not.toContain(canary);
}

describe('a server that cannot start, as a process', () => {
  const T = 60_000;

  it(
    'a newer database: the message written for the operator is in the log',
    async () => {
      const dir = tempDir();
      newerDatabase(dir);
      const started = await startServer({ DATA_DIR: dir });
      expectFailed(started, 'newer_database');
      expect(started.output).toContain(
        'Upgrade the image, or restore a backup taken before the upgrade.',
      );
    },
    T,
  );

  it(
    'a file that is not a database',
    async () => {
      const dir = tempDir();
      writeFileSync(join(dir, 'opportun.db'), `${PASSWORD} `.repeat(200));
      expectFailed(await startServer({ DATA_DIR: dir }), 'sqlite_damaged');
    },
    T,
  );

  it(
    'a port in use, which the line names',
    async () => {
      const port = await listen(() => undefined);
      const started = await startServer({ PORT: String(port) });
      expectFailed(started, 'port_in_use');
      expect(started.lines.at(-1)).toMatchObject({ 'server.port': port });
    },
    T,
  );

  it(
    'a Postgres nothing listens for',
    async () => {
      const started = await startServer({
        DB_DIALECT: 'postgres',
        DATABASE_URL: url(await closedPort()),
      });
      expectFailed(started, 'postgres_unreachable');
    },
    T,
  );

  it(
    'a Postgres host that does not resolve, which the driver names',
    async () => {
      const started = await startServer({
        DB_DIALECT: 'postgres',
        DATABASE_URL: `postgres://${USER}:${PASSWORD}@${HOST}/${DB_NAME}`,
        DB_SSL: 'disable',
      });
      expectFailed(started, 'postgres_unreachable');
    },
    T,
  );

  it(
    'a Postgres that refuses the sign-in, quoting the whole connection string',
    async () => {
      const started = await startServer({
        DB_DIALECT: 'postgres',
        DATABASE_URL: url(await refusingPostgres('28P01')),
      });
      expectFailed(started, 'postgres_sign_in');
    },
    T,
  );

  it(
    'a DATABASE_URL the driver cannot parse, whose error holds it',
    async () => {
      const started = await startServer({
        DB_DIALECT: 'postgres',
        DATABASE_URL: `postgres://${USER}:${PASSWORD}@127.0.0.1:not-a-port/${DB_NAME}`,
      });
      expectFailed(started, 'postgres_url');
    },
    T,
  );
});

describe('why a start failed', () => {
  const SQLITE = { dataDir: '/data', sqliteDir: '/data/db', db: { dialect: 'sqlite' as const } };
  const POSTGRES = { ...SQLITE, db: { dialect: 'postgres' as const } };

  async function postgresError(connection: string, ssl: 'disable' | 'require' = 'disable') {
    const pool = new pg.Pool(pgPoolConfig(new PostgresConfig(connection, 1, ssl)));
    pool.on('error', () => undefined);
    try {
      await migrateLockedPg(pool);
    } catch (err) {
      return err;
    } finally {
      await pool.end();
    }
    throw new Error('connected');
  }

  it.each<[string, StartFailureReason]>([
    ['28000', 'postgres_sign_in'],
    ['3D000', 'postgres_no_database'],
    ['42501', 'postgres_permission'],
    ['57P03', 'postgres_not_ready'],
    ['53300', 'postgres_not_ready'],
  ])('Postgres answers %s: %s', async (code, reason) => {
    const err = await postgresError(url(await refusingPostgres(code)));
    expect(startFailureReason(err, POSTGRES)).toBe(reason);
  });

  it('something that is not Postgres hangs up', async () => {
    const port = await listen((socket) => socket.destroy());
    expect(startFailureReason(await postgresError(url(port)), POSTGRES)).toBe(
      'postgres_unreachable',
    );
  });

  it('a Postgres without TLS, when DB_SSL asks for it', async () => {
    const port = await listen((socket) => socket.once('data', () => socket.write('N')));
    expect(startFailureReason(await postgresError(url(port), 'require'), POSTGRES)).toBe(
      'postgres_tls',
    );
  });

  const withCode = (code: string, message = 'x') => Object.assign(new Error(message), { code });
  it.each<[string, unknown, StartFailureReason]>([
    ['a self-signed certificate', withCode('DEPTH_ZERO_SELF_SIGNED_CERT'), 'postgres_tls'],
    ['a wrong name on it', withCode('ERR_TLS_CERT_ALTNAME_INVALID'), 'postgres_tls'],
    ['no route', withCode('EHOSTUNREACH'), 'postgres_unreachable'],
    [
      'no answer in time',
      new Error('timeout exceeded when trying to connect'),
      'postgres_unreachable',
    ],
    [
      'no answer in time, from the pool',
      new Error('Connection terminated due to connection timeout'),
      'postgres_unreachable',
    ],
  ])('Postgres: %s', (_what, err, reason) => {
    expect(startFailureReason(err, POSTGRES)).toBe(reason);
    // The same error with SQLite is not about Postgres.
    expect(startFailureReason(err, SQLITE)).toBeUndefined();
  });

  it.each(['ENOENT', 'EACCES'])('%s is about Postgres only on connecting to its socket', (code) => {
    const at = (syscall: string, path: string) =>
      startFailureReason(Object.assign(withCode(code), { syscall, path }), POSTGRES);
    expect(at('connect', '/run/pg/.s.PGSQL.5432')).toBe('postgres_unreachable');
    expect(at('open', '/app/web/index.html')).toBeUndefined();
  });

  it.each<[string, StartFailureReason]>([
    ['SQLITE_NOTADB', 'sqlite_damaged'],
    ['SQLITE_CORRUPT', 'sqlite_damaged'],
    ['SQLITE_CORRUPT_INDEX', 'sqlite_damaged'],
    ['SQLITE_CANTOPEN', 'sqlite_unopenable'],
    ['SQLITE_READONLY_DIRECTORY', 'sqlite_unopenable'],
    ['SQLITE_BUSY', 'sqlite_busy'],
    ['SQLITE_FULL', 'disk_full'],
  ])('SQLite says %s: %s', (code, reason) => {
    expect(startFailureReason(new Database.SqliteError('x', code), SQLITE)).toBe(reason);
  });

  it("another error with a code of SQLite's shape is not SQLite's", () => {
    expect(startFailureReason(withCode('SQLITE_CORRUPT'), SQLITE)).toBeUndefined();
    expect(startFailureReason(withCode('ERR_BUSY'), SQLITE)).toBeUndefined();
  });

  it.each<[string, string, StartFailureReason | undefined]>([
    ['EACCES', '/data', 'data_dir'],
    ['EROFS', '/data/db', 'data_dir'],
    ['ENOTDIR', '/data/files/x', 'data_dir'],
    ['ENOSPC', '/data/files/x', 'disk_full'],
    // Not a data directory: a file of the app's own.
    ['EACCES', '/database-elsewhere', undefined],
    ['ENOENT', '/app/web/index.html', undefined],
  ])('%s on %s: %s', (code, path, reason) => {
    expect(startFailureReason(Object.assign(withCode(code), { path }), SQLITE)).toBe(reason);
  });

  it('a parent of a data directory that cannot be used, where the system names that', () => {
    const cfg = { ...SQLITE, dataDir: '/srv/opportun/data', sqliteDir: '/srv/opportun/data' };
    const at = (path: string) =>
      startFailureReason(Object.assign(withCode('EACCES'), { path }), cfg);
    expect(at('/srv/opportun')).toBe('data_dir');
    expect(at('/srv/oppo')).toBeUndefined();
  });

  it.each<[string, StartFailureReason | undefined]>([
    ['EADDRINUSE', 'port_in_use'],
    ['EACCES', 'port_not_allowed'],
    ['EADDRNOTAVAIL', 'listen_address'],
    ['ENOTFOUND', 'listen_address'],
    ['EWHATEVER', undefined],
  ])('listening answers %s: %s', (code, reason) => {
    expect(startFailureReason(new ListenFailure(withCode(code), 8080), POSTGRES)).toBe(reason);
  });

  it('every refusal written for the operator has its line, saying what the refusal says', () => {
    const dir = tempDir();
    newerDatabase(dir);
    const db = new Database(join(dir, 'opportun.db'));
    try {
      migrateLocked(db);
      throw new Error('migrated');
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseRefused);
      // The line is that message itself: the two are kept in step here.
      expect(START_FAILURES.newer_database).toBe(
        `server failed to start: ${(err as DatabaseRefused).message}`,
      );
      expect(startFailureReason(err, SQLITE)).toBe('newer_database');
    } finally {
      db.close();
    }
  });

  it('anything else keeps the line it had', () => {
    expect(startFailureReason(new TypeError('x'), SQLITE)).toBeUndefined();
    expect(startFailureReason(new TypeError('x'), POSTGRES)).toBeUndefined();
    expect(startFailureReason('thrown text', undefined)).toBeUndefined();
    // Postgres's other answers (a failed migration's) are not about reaching it.
    expect(startFailureReason(withCode('42P01'), POSTGRES)).toBeUndefined();
  });
});

describe('the line itself', () => {
  function logged(err: unknown): Record<string, unknown> {
    const lines: string[] = [];
    logStartFailure(
      createLogger({ level: 'error', stream: { write: (l) => lines.push(l) } }),
      err,
      {
        dataDir: '/data',
        sqliteDir: '/data',
        db: { dialect: 'postgres' },
      },
    );
    expect(lines).toHaveLength(1);
    for (const canary of CANARIES) expect(lines[0]!.toLowerCase()).not.toContain(canary);
    return JSON.parse(lines[0]!) as Record<string, unknown>;
  }

  const SECRET = `postgres://${USER}:${PASSWORD}@${HOST}/${DB_NAME}`;
  it.each<[string, unknown, StartFailureReason | undefined]>([
    [
      'a driver error whose every property holds it',
      Object.assign(new Error(SECRET), {
        code: 'ECONNREFUSED',
        address: HOST,
        input: SECRET,
        connectionString: SECRET,
        detail: SECRET,
        cause: new Error(SECRET),
      }),
      'postgres_unreachable',
    ],
    [
      'an error of several, as Node throws for a host with two addresses',
      Object.assign(new AggregateError([new Error(SECRET)], SECRET), { code: 'ECONNREFUSED' }),
      'postgres_unreachable',
    ],
    ['a code that is a secret', Object.assign(new Error(SECRET), { code: PASSWORD }), undefined],
    ['an unknown error', new Error(SECRET), undefined],
    ['a listen error', new ListenFailure(new Error(SECRET), 8080), undefined],
    ['a thrown string', SECRET, undefined],
  ])('reveals nothing: %s', (_what, err, reason) => {
    expect(logged(err).msg).toBe(
      reason === undefined ? 'server failed to start' : START_FAILURES[reason],
    );
  });

  it('names the class of what failed, not of what wraps it', () => {
    const err = new ListenFailure(Object.assign(new TypeError('x'), { code: 'EADDRINUSE' }), 8080);
    expect(logged(err)).toMatchObject({ 'error.type': 'TypeError', 'server.port': 8080 });
  });

  it('every reason has a catalogued line that names a setting, a file or a step', () => {
    for (const [reason, line] of Object.entries(START_FAILURES)) {
      expect(LOG_MESSAGES.has(line), reason).toBe(true);
      expect(line, reason).toMatch(/^server failed to start: .+\.$/);
    }
  });
});
