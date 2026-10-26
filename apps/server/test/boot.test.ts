// Boot-time migration lock (Task 36). Two app processes started against one data volume
// (a restart overlapping the old container, or two replicas by mistake) must not both
// apply the same migrations: one migrates, the other waits and finds nothing to do.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { MIGRATIONS_DIR, openDatabase } from '../src/db/client';
import { sqliteOnly } from './db';

const PROCESSES = 2;
/** Long enough for every child to reach the lock after being released. */
const HOLD_MS = 1500;
const CHILD = fileURLToPath(new URL('./fixtures/bootChild.ts', import.meta.url));

interface ChildResult {
  ok: boolean;
  migrations?: number;
  error?: string;
}

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opportun-boot-'));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function journalLength(): Promise<number> {
  const raw = await readFile(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: unknown[] }).entries.length;
}

function startChild(dataDir: string): {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  result: Promise<ChildResult>;
} {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, dataDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk;
    if (out.includes('ready\n')) markReady();
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    err += chunk;
  });
  const result = new Promise<ChildResult>((resolve) => {
    child.on('exit', () => {
      const line = out
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .at(-1);
      resolve(
        line === undefined ? { ok: false, error: `no result; stderr: ${err}` } : JSON.parse(line),
      );
    });
  });
  return { child, ready, result };
}

describe.runIf(sqliteOnly)('boot migration lock', () => {
  it('app processes booting at once on one database all succeed, migrating once', async () => {
    const dataDir = await tempDir();
    // A new WAL database with drizzle's empty bookkeeping table, then a writer holding the
    // lock while the children start: each child gets as far as reading "nothing applied"
    // and queues for the write lock. Released together, an unlocked migrator applies 0000
    // once per child (the later ones fail on existing tables); the boot lock serializes the
    // read-decide-apply sequence, so exactly one child migrates.
    const holder = new Database(join(dataDir, 'opportun.db'));
    holder.pragma('journal_mode = WAL');
    holder.exec(
      'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    holder.exec('BEGIN IMMEDIATE');
    const children = Array.from({ length: PROCESSES }, () => startChild(dataDir));
    try {
      await Promise.all(children.map((c) => c.ready));
      for (const c of children) c.child.stdin.end('go\n');
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    } finally {
      holder.exec('COMMIT');
      holder.close();
    }
    const results = await Promise.all(children.map((c) => c.result));

    const expected = await journalLength();
    expect(results).toEqual(
      Array.from({ length: PROCESSES }, () => ({ ok: true, migrations: expected })),
    );
    const db = new Database(join(dataDir, 'opportun.db'), { readonly: true });
    try {
      const hashes = db.prepare('SELECT hash FROM __drizzle_migrations').all() as {
        hash: string;
      }[];
      // Each migration recorded exactly once.
      expect(hashes).toHaveLength(expected);
      expect(new Set(hashes.map((h) => h.hash)).size).toBe(expected);
    } finally {
      db.close();
    }
  }, 60_000);

  it('two concurrent buildApp calls in one process on the same database succeed', async () => {
    const dataDir = await tempDir();
    const cfg = {
      port: 0,
      host: '127.0.0.1',
      dataDir,
      sqliteDir: dataDir,
      baseUrl: 'http://localhost:3000',
      masterKey: randomBytes(32),
      logLevel: 'silent',
      db: { dialect: 'sqlite' as const },
      demo: false,
      aiAllowLoopbackHttp: false,
      trustedProxies: [],
    };
    const apps = await Promise.all([
      buildApp(cfg, { jobRunner: false }),
      buildApp(cfg, { jobRunner: false }),
    ]);
    try {
      for (const app of apps) {
        expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({
          status: 'ok',
          db: 'ok',
        });
      }
    } finally {
      await Promise.all(apps.map((a) => a.close()));
    }
  });

  it('refuses to open a database migrated by a newer release', async () => {
    const dataDir = await tempDir();
    openDatabase(dataDir).sqlite.close();
    const db = new Database(join(dataDir, 'opportun.db'));
    db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(
      'from-the-future',
      9_999_999_999_999,
    );
    db.close();
    expect(() => openDatabase(dataDir)).toThrow(/newer release/);
  });
});
