// The optional background WAL checkpointer (https://github.com/bgoleno/opportun/issues/383):
// SQLite only, off by default. With it on, a worker thread checkpoints on its own connection
// once enough of the WAL waits to be copied, or once anything has waited long enough, and the
// main connection's own automatic checkpoint moves to a backstop. When the worker stops, for any
// reason, the main connection goes back to its default.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDbConfig } from '../src/config';
import { rawRun, type SqliteHandle } from '../src/db/client';
import { startBackgroundCheckpointer, type CheckpointRecord } from '../src/db/checkpointer';
import { readWalIndex } from '../src/db/checkpointWorker';
import { readOperatorBytesAt } from '../src/lib/storage';
import { sqliteOnly } from './db';
import { openTestDb } from './helpers';

const until = async (check: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const autocheckpoint = (h: SqliteHandle) =>
  h.sqlite.pragma('wal_autocheckpoint', { simple: true }) as number;

/** Writes `rows` rows of about a page each. */
async function write(h: SqliteHandle, rows: number): Promise<void> {
  await rawRun(h.db, sql`CREATE TABLE IF NOT EXISTS bench_383 (v TEXT)`);
  for (let i = 0; i < rows; i++) {
    await rawRun(h.db, sql`INSERT INTO bench_383 (v) VALUES (${'x'.repeat(3_500)})`);
  }
}

const shmOf = (dataDir: string) => join(dataDir, 'opportun.db-shm');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the background checkpointer flag (#383)', () => {
  it('is off unless OPPORTUN_SQLITE_BACKGROUND_CHECKPOINT=1', () => {
    expect(loadDbConfig({})).toEqual({ dialect: 'sqlite' });
    expect(loadDbConfig({ OPPORTUN_SQLITE_BACKGROUND_CHECKPOINT: '0' })).toEqual({
      dialect: 'sqlite',
    });
    expect(loadDbConfig({ OPPORTUN_SQLITE_BACKGROUND_CHECKPOINT: '1' })).toEqual({
      dialect: 'sqlite',
      backgroundCheckpoint: true,
    });
  });
});

describe('readOperatorBytesAt, the read the worker makes (#383, NFR-SEC11)', () => {
  it('reads a slice of a regular file, and nothing through a symlink or a relative path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opportun-383-'));
    try {
      const file = join(dir, 'f');
      writeFileSync(file, 'abcdefgh');
      expect(readOperatorBytesAt(file, 2, 3)?.toString()).toBe('cde');
      // Past the end: fewer bytes, as a short read.
      expect(readOperatorBytesAt(file, 6, 10)?.toString()).toBe('gh');
      const link = join(dir, 'link');
      symlinkSync(file, link);
      expect(readOperatorBytesAt(link, 0, 3)).toBeUndefined();
      expect(readOperatorBytesAt('f', 0, 3)).toBeUndefined();
      expect(readOperatorBytesAt(join(dir, 'missing'), 0, 3)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(sqliteOnly)('the wal-index header the worker reads (#383)', () => {
  // The worker's one dependency on SQLite's internals: if a better-sqlite3 upgrade changes the
  // layout, this fails before the worker misreads it.
  it("matches SQLite's own figures before and after a checkpoint, and after a WAL restart", () => {
    const dir = mkdtempSync(join(tmpdir(), 'opportun-383-'));
    const file = join(dir, 't.db');
    const db = new Database(file);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 0');
      const pageSize = Number(db.pragma('page_size', { simple: true }));
      db.exec('CREATE TABLE t (v TEXT)');
      const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
      for (let i = 0; i < 50; i++) insert.run('x'.repeat(3_500));
      const before = readWalIndex(`${file}-shm`, pageSize)!;
      expect(before.nBackfill).toBe(0);
      const [first] = db.pragma('wal_checkpoint(PASSIVE)') as {
        log: number;
        checkpointed: number;
      }[];
      expect(before.mxFrame).toBe(first!.log);
      expect(readWalIndex(`${file}-shm`, pageSize)).toEqual({
        mxFrame: first!.log,
        nBackfill: first!.checkpointed,
      });
      // All of it copied, the next write restarts the WAL from its first frame.
      insert.run('y');
      const restarted = readWalIndex(`${file}-shm`, pageSize)!;
      expect(restarted.mxFrame).toBeLessThan(before.mxFrame);
      const [second] = db.pragma('wal_checkpoint(PASSIVE)') as { log: number }[];
      expect(restarted.mxFrame).toBe(second!.log);
      // A page size other than the database's is a header it does not recognise.
      expect(readWalIndex(`${file}-shm`, pageSize * 2)).toBeUndefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(sqliteOnly)('the background checkpointer (#383)', () => {
  it('off by default: the main connection checkpoints at 100 pages, and no worker runs', async () => {
    const opened = await openTestDb();
    try {
      const h = opened.handle as SqliteHandle;
      expect(autocheckpoint(h)).toBe(100);
      expect(h.checkpointer).toBeUndefined();
    } finally {
      await opened.close();
    }
  });

  it('on: the main connection keeps a backstop, and the worker checkpoints once enough waits', async () => {
    const opened = await openTestDb({
      backgroundCheckpoint: true,
      checkpointerTuning: { maxPages: 200, pollMs: 20 },
    });
    try {
      const h = opened.handle as SqliteHandle;
      expect(autocheckpoint(h)).toBe(10_000);
      const file = join(opened.dataDir, 'opportun.db');
      const before = statSync(file).size;
      await write(h, 300);
      // Only a checkpoint copies the WAL's pages into the database file, and the backstop is
      // far above what was written: the worker ran it.
      await until(() => h.checkpointer!.checkpoints > 0);
      await until(() => statSync(file).size > before + 500_000);
    } finally {
      await opened.close();
    }
  });

  it('keeps up under steady writes: the retry delay is only for a checkpoint a reader held back', async () => {
    const opened = await openTestDb({
      backgroundCheckpoint: true,
      checkpointerTuning: { maxPages: 50, pollMs: 20 },
    });
    try {
      const h = opened.handle as SqliteHandle;
      const started = Date.now();
      // 60 pages at a time, each burst over the threshold, well inside a second.
      for (let burst = 0; burst < 6 && Date.now() - started < 900; burst++) {
        const before = h.checkpointer!.checkpoints;
        await write(h, 60);
        await until(() => h.checkpointer!.checkpoints > before, 900);
      }
      expect(h.checkpointer!.checkpoints).toBeGreaterThanOrEqual(3);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await opened.close();
    }
  });

  it('under the size threshold and its time bound, nothing is checkpointed', async () => {
    const opened = await openTestDb({
      backgroundCheckpoint: true,
      checkpointerTuning: { maxPages: 1_000, maxWaitMs: 60_000, pollMs: 20 },
    });
    try {
      const h = opened.handle as SqliteHandle;
      await write(h, 20);
      await new Promise((r) => setTimeout(r, 400));
      expect(h.checkpointer!.checkpoints).toBe(0);
    } finally {
      await opened.close();
    }
  });

  it('a write left waiting past the time bound is checkpointed: a quiet server is still synced', async () => {
    const checkpoints: CheckpointRecord[] = [];
    const opened = await openTestDb();
    const h = opened.handle as SqliteHandle;
    try {
      // What db/client.ts starts, with a short time bound and the checkpoints recorded.
      h.sqlite.pragma('wal_autocheckpoint = 10000');
      const cp = startBackgroundCheckpointer(join(opened.dataDir, 'opportun.db'), {
        pragmas: [],
        pageSize: Number(h.sqlite.pragma('page_size', { simple: true })),
        maxPages: 1_000,
        maxWaitMs: 300,
        pollMs: 20,
        onStopped: () => undefined,
        onCheckpoint: (c) => checkpoints.push(c),
      });
      try {
        await write(h, 5);
        await until(() => checkpoints.length > 0);
        expect(checkpoints[0]).toMatchObject({ reason: 'age' });
        expect(checkpoints[0]!.checkpointed).toBe(checkpoints[0]!.log);
      } finally {
        await cp.stop();
      }
    } finally {
      await opened.close();
    }
  });

  it("after the worker's checkpoint, the next write reuses the WAL from its start", async () => {
    const opened = await openTestDb({
      backgroundCheckpoint: true,
      checkpointerTuning: { maxPages: 200, pollMs: 20 },
    });
    try {
      const h = opened.handle as SqliteHandle;
      const pageSize = Number(h.sqlite.pragma('page_size', { simple: true }));
      await write(h, 300);
      await until(() => {
        const index = readWalIndex(shmOf(opened.dataDir), pageSize);
        return index !== undefined && index.nBackfill === index.mxFrame && index.mxFrame > 0;
      });
      const full = readWalIndex(shmOf(opened.dataDir), pageSize)!;
      await write(h, 1);
      expect(readWalIndex(shmOf(opened.dataDir), pageSize)!.mxFrame).toBeLessThan(full.mxFrame);
    } finally {
      await opened.close();
    }
  });

  it("the worker's connection runs with the sync settings it is given", async () => {
    const opened = await openTestDb();
    const h = opened.handle as SqliteHandle;
    try {
      const cp = startBackgroundCheckpointer(join(opened.dataDir, 'opportun.db'), {
        // Not the defaults, so the worker reporting them shows it applied them.
        pragmas: ['synchronous = 2', 'fullfsync = 1', 'checkpoint_fullfsync = 1'],
        pageSize: Number(h.sqlite.pragma('page_size', { simple: true })),
        onStopped: () => undefined,
      });
      try {
        await expect(cp.ready).resolves.toEqual({
          synchronous: 2,
          fullfsync: 1,
          checkpoint_fullfsync: 1,
        });
      } finally {
        await cp.stop();
      }
    } finally {
      await opened.close();
    }
  });

  it("the server passes the worker the main connection's own sync settings", async () => {
    const opened = await openTestDb({ backgroundCheckpoint: true });
    try {
      const h = opened.handle as SqliteHandle;
      const main = (name: string) => h.sqlite.pragma(name, { simple: true });
      await expect(h.checkpointer!.ready).resolves.toEqual({
        synchronous: main('synchronous'),
        fullfsync: main('fullfsync'),
        checkpoint_fullfsync: main('checkpoint_fullfsync'),
      });
    } finally {
      await opened.close();
    }
  });

  it('stopped: the main connection goes back to its default, and close stops the worker', async () => {
    const opened = await openTestDb({ backgroundCheckpoint: true });
    try {
      const h = opened.handle as SqliteHandle;
      await h.checkpointer!.stop();
      expect(autocheckpoint(h)).toBe(100);
    } finally {
      await opened.close();
    }
    // Closing the database alone stops its worker: the checkpointer reports an expected stop.
    const again = await openTestDb({ backgroundCheckpoint: true });
    const stopped = (again.handle as SqliteHandle).checkpointer!.stopped;
    await again.close();
    await expect(stopped).resolves.toMatchObject({ unexpected: false });
  });

  it('a worker that cannot read the WAL stops, and the server goes back to its own checkpoints, saying so', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    // A page size the header does not have: the worker cannot tell the WAL's size.
    const opened = await openTestDb({
      backgroundCheckpoint: true,
      checkpointerTuning: { pageSize: 512, pollMs: 20 },
    });
    try {
      const h = opened.handle as SqliteHandle;
      await expect(h.checkpointer!.stopped).resolves.toMatchObject({ unexpected: true });
      expect(autocheckpoint(h)).toBe(100);
      await until(() =>
        lines.some((l) =>
          l.includes('background checkpointer stopped: automatic checkpoints are back on'),
        ),
      );
    } finally {
      await opened.close();
    }
  });

  it('a worker whose own open fails is reported as an unexpected stop', async () => {
    const reports: { unexpected: boolean }[] = [];
    const cp = startBackgroundCheckpointer(join('/nonexistent-383', 'opportun.db'), {
      pragmas: [],
      pageSize: 4_096,
      onStopped: (r) => reports.push(r),
    });
    await expect(cp.stopped).resolves.toMatchObject({ unexpected: true });
    expect(reports).toEqual([expect.objectContaining({ unexpected: true })]);
  });

  it('a shutdown waits for the worker: close finishes, the main connection with it', () => {
    // The worker is unref'd, so it never keeps a process alive; while it stops, it must.
    const dir = mkdtempSync(join(tmpdir(), 'opportun-383-'));
    try {
      const child = fileURLToPath(new URL('./fixtures/checkpointerChild.ts', import.meta.url));
      const res = spawnSync(process.execPath, ['--import', 'tsx', child, dir], {
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(res.stdout).toBe('closed shut\n');
      expect(res.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
