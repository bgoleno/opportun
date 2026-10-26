import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildOptions, type LogStream } from '../src/app';
import type { Config } from '../src/config';
import { createSafeFetch } from '../src/lib/safeFetch';
import { mockGoogleTokenFetch } from '../src/testSupport/mockGoogle';
import {
  closeDatabase,
  connectDatabase,
  type ConnectOptions,
  type DbHandle,
} from '../src/db/client';
import { testDialect } from './db';
import { createTestDatabase, type TestDatabase } from './pgHarness';

/** A safeFetch whose DNS always fails: no test reaches the real network by accident. */
const offlineSourceFetch = createSafeFetch({
  now: () => 0,
  sleep: async () => undefined,
  resolve: async (host) => {
    throw new Error(`offline test fetch: no dns for ${host}`);
  },
  request: async () => {
    throw new Error('offline test fetch: unreachable');
  },
});

export interface TestAppOptions {
  /** Runs after buildApp and before ready: register test-only routes or hooks here. */
  setup?: (app: FastifyInstance) => void | Promise<void>;
  /** Receives every log line (pair with a logLevel override to capture output). */
  logStream?: LogStream;
  /** Fakes passed to buildApp (e.g. the Google client). */
  build?: Omit<BuildOptions, 'logStream'>;
}

/**
 * Boots a full app on a fresh temp data dir with a random master key. On the Postgres leg
 * (TEST_DB_DIALECT=postgres) the app also gets a fresh database cloned from the run's
 * migrated template (test/pgHarness.ts), dropped when the app closes.
 */
export async function testApp(
  overrides: Partial<Config> = {},
  opts: TestAppOptions = {},
): Promise<{ app: FastifyInstance; dataDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'opportun-test-'));
  const pgDb = testDialect === 'postgres' ? await createTestDatabase() : undefined;
  const cfg: Config = {
    port: 0,
    // Loopback only: a test that does listen must never open a network-visible socket.
    host: '127.0.0.1',
    dataDir,
    sqliteDir: dataDir,
    baseUrl: 'http://localhost:3000',
    masterKey: randomBytes(32),
    logLevel: 'silent',
    db: pgDb?.config ?? { dialect: 'sqlite' },
    demo: false,
    aiAllowLoopbackHttp: false,
    // Trust no proxy by default, matching production (issue #333). Tests that exercise proxy
    // trust pass trustedProxies through overrides.
    trustedProxies: [],
    ...overrides,
  };
  let app: FastifyInstance;
  try {
    app = await buildApp(cfg, {
      // No polling runner in tests: they drain the queue with app.jobs.drain().
      jobRunner: false,
      // No network for the Google OAuth client probe: it answers as for a live client.
      googleFetch: mockGoogleTokenFetch,
      // No network for discovery/enrichment fetches either: every host fails DNS instantly.
      // Tests that need responses substitute their own recording fake.
      sourceFetch: offlineSourceFetch,
      ...opts.build,
      ...(opts.logStream ? { logStream: opts.logStream } : {}),
    });
  } catch (err) {
    await pgDb?.drop();
    await rm(dataDir, { recursive: true, force: true });
    throw err;
  }
  app.addHook('onClose', async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  // The copy is dropped around close rather than from an onClose hook, because Fastify runs
  // those last-registered-first: a hook added here runs before buildApp's own, which is the
  // one that ends the pool. DROP DATABASE ... WITH (FORCE) would then terminate connections
  // under a live pool. An idle one only logs (db/client.ts installs a pool error listener),
  // but a connection checked out mid-query rejects with nobody left to catch it, and
  // pool.end() can wait on a killed socket until the hook times out: both reached CI from
  // the one test that aborts a stream mid-flight.
  if (pgDb !== undefined) {
    const closeApp = app.close.bind(app);
    app.close = (async () => {
      await closeApp();
      await pgDb.drop();
    }) as typeof app.close;
  }
  try {
    await opts.setup?.(app);
    await app.ready();
  } catch (err) {
    // A failed start still owns a database copy, a pool and a data dir: closing the app
    // runs the onClose hooks above and the drop around them, which release all three.
    await app.close().catch(() => undefined);
    throw err;
  }
  return { app, dataDir };
}

/** Collects log lines in memory; `text()` joins everything written so far. */
export function captureLogs(): LogStream & { lines: string[]; text: () => string } {
  const lines: string[] = [];
  return {
    lines,
    write(msg: string) {
      lines.push(msg);
    },
    text: () => lines.join(''),
  };
}

/**
 * A database handle (no app) on this run's dialect, for tests of repos and jobs below the
 * routes: SQLite in a temp dir, or a fresh Postgres database cloned from the run's template.
 * `close` closes the handle and removes the directory or database.
 */
export async function openTestDb(opts: ConnectOptions = {}): Promise<{
  handle: DbHandle;
  dataDir: string;
  /** Closes the handle and opens the same database again (a restart). */
  reopen: () => Promise<DbHandle>;
  close: () => Promise<void>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'opportun-test-'));
  let pgDb: TestDatabase | undefined;
  try {
    pgDb = testDialect === 'postgres' ? await createTestDatabase() : undefined;
    const cfg = { dataDir, db: pgDb?.config ?? { dialect: 'sqlite' as const } };
    let handle = await connectDatabase(cfg, opts);
    let closed = false;
    return {
      handle,
      dataDir,
      reopen: async () => {
        await closeDatabase(handle);
        handle = await connectDatabase(cfg, opts);
        return handle;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await closeDatabase(handle);
        await pgDb?.drop();
        await rm(dataDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await pgDb?.drop();
    await rm(dataDir, { recursive: true, force: true });
    throw err;
  }
}
