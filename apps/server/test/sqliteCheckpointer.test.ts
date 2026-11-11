// The optional background WAL checkpointer (https://github.com/bgoleno/opportun/issues/383):
// SQLite only, off by default. With it on, the main connection runs no automatic checkpoint
// and a worker thread checkpoints on its own connection, so no commit on the main thread waits
// for a checkpoint's IO. When the worker stops, for any reason, the main connection goes back to
// automatic checkpoints, so the WAL can never grow without bound.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loadDbConfig } from '../src/config';
import { rawRun, type SqliteHandle } from '../src/db/client';
import { startBackgroundCheckpointer } from '../src/db/checkpointer';
import { sqliteOnly } from './db';
import { openTestDb } from './helpers';

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const autocheckpoint = (h: SqliteHandle) =>
  h.sqlite.pragma('wal_autocheckpoint', { simple: true }) as number;

/** Writes about 300 pages that the WAL holds until something checkpoints them. */
async function write(h: SqliteHandle): Promise<void> {
  await rawRun(h.db, sql`CREATE TABLE IF NOT EXISTS bench_383 (v TEXT)`);
  for (let i = 0; i < 300; i++) {
    await rawRun(h.db, sql`INSERT INTO bench_383 (v) VALUES (${'x'.repeat(3_500)})`);
  }
}

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

describe.runIf(sqliteOnly)('the background checkpointer (#383)', () => {
  it('off by default: the main connection checkpoints automatically, and no worker runs', async () => {
    const opened = await openTestDb();
    try {
      const h = opened.handle as SqliteHandle;
      expect(autocheckpoint(h)).toBe(100);
      expect(h.checkpointer).toBeUndefined();
    } finally {
      await opened.close();
    }
  });

  it('on: the main connection runs no automatic checkpoint, and the worker writes the WAL into the database', async () => {
    const opened = await openTestDb({ backgroundCheckpoint: true, checkpointIntervalMs: 20 });
    try {
      const h = opened.handle as SqliteHandle;
      expect(autocheckpoint(h)).toBe(0);
      const file = join(opened.dataDir, 'opportun.db');
      const before = statSync(file).size;
      await write(h);
      // Only a checkpoint copies the WAL's pages into the database file, and nothing on the
      // main connection runs one now.
      await until(() => statSync(file).size > before + 500_000);
    } finally {
      await opened.close();
    }
  });

  it('stopped: the main connection goes back to automatic checkpoints, and close stops the worker', async () => {
    const opened = await openTestDb({ backgroundCheckpoint: true, checkpointIntervalMs: 20 });
    try {
      const h = opened.handle as SqliteHandle;
      await h.checkpointer!.stop();
      expect(autocheckpoint(h)).toBe(100);
    } finally {
      await opened.close();
    }
    // Closing the database alone stops its worker: the checkpointer reports an expected stop.
    const again = await openTestDb({ backgroundCheckpoint: true, checkpointIntervalMs: 20 });
    const stopped = (again.handle as SqliteHandle).checkpointer!.stopped;
    await again.close();
    await expect(stopped).resolves.toMatchObject({ unexpected: false });
  });

  it('a worker that fails is reported as an unexpected stop', async () => {
    const reports: { unexpected: boolean; err?: unknown }[] = [];
    // A database file that does not exist: the worker's own open fails.
    const cp = startBackgroundCheckpointer(join('/nonexistent-383', 'opportun.db'), {
      intervalMs: 20,
      pragmas: [],
      onStopped: (r) => reports.push(r),
    });
    await expect(cp.stopped).resolves.toMatchObject({ unexpected: true });
    expect(reports).toEqual([expect.objectContaining({ unexpected: true })]);
  });

  it("the worker uses the main connection's sync settings", async () => {
    const opened = await openTestDb({ backgroundCheckpoint: true, checkpointIntervalMs: 20 });
    try {
      const h = opened.handle as SqliteHandle;
      expect(h.checkpointer!.pragmas).toEqual([
        `synchronous = ${h.sqlite.pragma('synchronous', { simple: true })}`,
        `fullfsync = ${h.sqlite.pragma('fullfsync', { simple: true })}`,
        `checkpoint_fullfsync = ${h.sqlite.pragma('checkpoint_fullfsync', { simple: true })}`,
      ]);
    } finally {
      await opened.close();
    }
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
