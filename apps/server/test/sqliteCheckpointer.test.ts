// The optional background WAL checkpointer (https://github.com/bgoleno/opportun/issues/383):
// SQLite only, off by default. With it on, a worker thread checkpoints on its own connection
// once enough of the WAL waits to be copied, or once anything has waited long enough, and the
// main connection's own automatic checkpoint moves to a backstop. When the worker stops, for any
// reason, the main connection goes back to its default.
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { endianness, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDbConfig } from '../src/config';
import { rawRun, type SqliteHandle } from '../src/db/client';
import { startBackgroundCheckpointer, type CheckpointRecord } from '../src/db/checkpointer';
import { heldBackByReader, readWalIndex, unreadableTooLong } from '../src/db/checkpointWorker';
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

/**
 * Leaves the wal-index header's two copies unequal, as SQLite does for a moment in every commit
 * (it writes the second copy, then the first), by changing one byte of the second copy's change
 * counter. Returns what puts that byte back. Only while the test's own connection is idle: a
 * statement on it would find the copies unequal and rebuild the header itself.
 */
function tearHeader(shm: string): () => void {
  const at = 48 + 8;
  const original = Buffer.alloc(1);
  const fd = openSync(shm, 'r+');
  try {
    readSync(fd, original, 0, 1, at);
    writeSync(fd, Buffer.from([original[0]! ^ 0xff]), 0, 1, at);
  } finally {
    closeSync(fd);
  }
  return () => {
    const again = openSync(shm, 'r+');
    try {
      writeSync(again, original, 0, 1, at);
    } finally {
      closeSync(again);
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the background checkpointer flag (#383)', () => {
  it('is off unless OPPORTUN_SQLITE_BACKGROUND_CHECKPOINT=1', () => {
    expect(loadDbConfig({})).toEqual({ dialect: 'sqlite' });
    expect(loadDbConfig({ OPPORTUN_SQLITE_BACKGROUND_CHECKPOINT: '0' })).toEqual({
      dialect: 'sqlite',
    });
    // Empty, as compose passes a variable the operator left unset (`${...:-}`): off.
    expect(loadDbConfig({ OPPORTUN_SQLITE_BACKGROUND_CHECKPOINT: '' })).toEqual({
      dialect: 'sqlite',
    });
    expect(loadDbConfig({ OPPORTUN_SQLITE_BACKGROUND_CHECKPOINT: '1' })).toEqual({
      dialect: 'sqlite',
      backgroundCheckpoint: true,
    });
  });
});

describe('which checkpoint a reader held back (#383, tl on #393)', () => {
  // Arguments: the frames in the WAL when the worker read its header just before the checkpoint,
  // then the checkpoint's own log and checkpointed counts.
  it('not one that copied every frame there was when it started: the rest came in while it ran', () => {
    // Logged in "keeps up under steady writes": three frames were committed during the checkpoint.
    expect(heldBackByReader(123, 129, 126)).toBe(false);
    expect(heldBackByReader(123, 123, 123)).toBe(false);
  });

  it('one that stopped short of frames that were there when it started: a reader holds them', () => {
    expect(heldBackByReader(123, 123, 100)).toBe(true);
    expect(heldBackByReader(123, 129, 120)).toBe(true);
  });

  it('not one on a WAL that started again after the read, when it copied all of the new one', () => {
    expect(heldBackByReader(123, 10, 10)).toBe(false);
    expect(heldBackByReader(123, 10, 8)).toBe(true);
  });
});

describe('when a header that cannot be read ends the worker (#383, tl on #393)', () => {
  // Arguments: when the worker's looks started finding the header unreadable, the time of this
  // look, and the limit. SQLite writes the header's two copies one after the other with no lock a
  // plain read respects, so a writer descheduled in between leaves them unequal for a while.
  it('not the first unreadable look', () => {
    expect(unreadableTooLong(10_000, 10_000, 5_000)).toBe(false);
  });

  it('not while it has been unreadable for up to the limit', () => {
    expect(unreadableTooLong(10_000, 14_999, 5_000)).toBe(false);
    expect(unreadableTooLong(10_000, 15_000, 5_000)).toBe(false);
  });

  it('once it has stayed unreadable past the limit, as a layout the worker does not know does', () => {
    expect(unreadableTooLong(10_000, 15_001, 5_000)).toBe(true);
    expect(unreadableTooLong(10_000, 60_000, 5_000)).toBe(true);
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

  it('reads nothing from a FIFO, or through a relative path to a file that exists (sec)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opportun-383-'));
    try {
      // A FIFO is not a regular file: it is refused before any open, which on a FIFO with no
      // writer would wait forever.
      const fifo = join(dir, 'fifo');
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
      expect(readOperatorBytesAt(fifo, 0, 3)).toBeUndefined();
      // A relative path is refused even when it names a real file from the working directory.
      const file = join(dir, 'f');
      writeFileSync(file, 'abcdefgh');
      const fromCwd = relative(process.cwd(), file);
      expect(isAbsolute(fromCwd)).toBe(false);
      expect(existsSync(fromCwd)).toBe(true);
      expect(readOperatorBytesAt(fromCwd, 0, 3)).toBeUndefined();
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

  /** A -shm file whose two header copies hold these fields, and nBackfill after them. */
  function shm(fields: {
    version: number;
    isInit: number;
    szPage: number;
    mxFrame: number;
    nBackfill: number;
  }) {
    const b = Buffer.alloc(100);
    const little = endianness() === 'LE';
    const header = Buffer.alloc(48);
    if (little) header.writeUInt32LE(fields.version, 0);
    else header.writeUInt32BE(fields.version, 0);
    header.writeUInt8(fields.isInit, 12);
    if (little) header.writeUInt16LE(fields.szPage, 14);
    else header.writeUInt16BE(fields.szPage, 14);
    if (little) header.writeUInt32LE(fields.mxFrame, 16);
    else header.writeUInt32BE(fields.mxFrame, 16);
    header.copy(b, 0);
    header.copy(b, 48);
    if (little) b.writeUInt32LE(fields.nBackfill, 96);
    else b.writeUInt32BE(fields.nBackfill, 96);
    return b;
  }

  it('reads a header it recognises, an empty WAL as nothing waiting, and refuses the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opportun-383-'));
    try {
      const at = join(dir, 'x.db-shm');
      const read = (fields: Parameters<typeof shm>[0]) => {
        writeFileSync(at, shm(fields));
        return readWalIndex(at, 4_096);
      };
      const ok = { version: 3007000, isInit: 1, szPage: 4_096, mxFrame: 5, nBackfill: 2 };
      expect(read(ok)).toEqual({ mxFrame: 5, nBackfill: 2 });
      // A database closed cleanly and opened again: an initialised header for an empty WAL,
      // whose page size is not set until the first frame (tl on #393).
      expect(read({ ...ok, szPage: 0, mxFrame: 0, nBackfill: 0 })).toEqual({
        mxFrame: 0,
        nBackfill: 0,
      });
      expect(read({ ...ok, version: 3007001 })).toBeUndefined();
      expect(read({ ...ok, isInit: 0 })).toBeUndefined();
      expect(read({ ...ok, szPage: 8_192 })).toBeUndefined();
      expect(read({ ...ok, szPage: 0 })).toBeUndefined();
      expect(read({ ...ok, mxFrame: 1, nBackfill: 2 })).toBeUndefined();
    } finally {
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
      // Six bursts of 60 pages, each over the threshold. Each one's checkpoint comes within
      // 900 ms, so none waited the 1 s retry delay: a burst that did times out here. That wait
      // is the assertion; a bound on the whole run's time would only measure the machine's load.
      for (let burst = 0; burst < 6; burst++) {
        const before = h.checkpointer!.checkpoints;
        await write(h, 60);
        await until(() => h.checkpointer!.checkpoints > before, 900);
      }
      expect(h.checkpointer!.checkpoints).toBeGreaterThanOrEqual(6);
    } finally {
      await opened.close();
    }
  });

  it('starts on an existing database closed cleanly, whose WAL is empty until the first write', async () => {
    const opened = await openTestDb({
      backgroundCheckpoint: true,
      checkpointerTuning: { pollMs: 20 },
    });
    try {
      // The fresh database's migrations wrote frames; a clean close empties the WAL.
      const h = (await opened.reopen()) as SqliteHandle;
      await h.checkpointer!.ready;
      const outcome = await Promise.race([
        h.checkpointer!.stopped.then(() => 'stopped'),
        new Promise((r) => setTimeout(() => r('running'), 300)),
      ]);
      expect(outcome).toBe('running');
      expect(autocheckpoint(h)).toBe(10_000);
    } finally {
      await opened.close();
    }
  });

  it('the age bound runs from the oldest frame not yet copied: steady writes do not checkpoint on every poll', async () => {
    const opened = await openTestDb({
      backgroundCheckpoint: true,
      // The size threshold out of reach, so every checkpoint here is the age bound's.
      checkpointerTuning: { maxPages: 1_000_000, maxWaitMs: 300, pollMs: 20 },
    });
    try {
      const h = opened.handle as SqliteHandle;
      await h.checkpointer!.ready;
      await rawRun(h.db, sql`CREATE TABLE IF NOT EXISTS bench_383 (v TEXT)`);
      const started = Date.now();
      // Small writes back to back, one per turn of the loop: a frame is waiting at every look the
      // worker takes, the one straight after a checkpoint included. They go on until 3 s have
      // passed and 3 checkpoints have come, whichever is later (at most 15 s): a busy machine
      // can delay a checkpoint by more than its age bound, so a fixed window can miss one
      // (tl on #393), and the bound below is measured against the time the writes took.
      let writing = true;
      const writer = (async () => {
        while (writing) {
          await rawRun(h.db, sql`INSERT INTO bench_383 (v) VALUES ('x')`);
          await new Promise((r) => setImmediate(r));
        }
      })();
      try {
        await until(
          () => Date.now() - started >= 3_000 && h.checkpointer!.checkpoints >= 3,
          15_000,
        );
      } finally {
        writing = false;
        await writer;
      }
      const elapsed = Date.now() - started;
      // At most one checkpoint per age bound, plus two, not one per poll: with a bound that never
      // re-arms, 232 to 533 were measured in about 3 s.
      expect(h.checkpointer!.checkpoints).toBeLessThanOrEqual(Math.ceil(elapsed / 300) + 2);
    } finally {
      await opened.close();
    }
  });

  it('a checkpoint a reader holds back is retried after a delay, not on every poll', async () => {
    const opened = await openTestDb({
      backgroundCheckpoint: true,
      checkpointerTuning: { maxPages: 50, pollMs: 20 },
    });
    const h = opened.handle as SqliteHandle;
    // A reader with a snapshot from before the writes: no checkpoint can copy past it.
    const reader = new Database(join(opened.dataDir, 'opportun.db'), { readonly: true });
    try {
      await h.checkpointer!.ready;
      await write(h, 1);
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) FROM bench_383').get();
      const before = h.checkpointer!.checkpoints;
      await write(h, 100);
      await new Promise((r) => setTimeout(r, 800));
      // Once held back, the next attempt waits a second: one or two, not one per poll (about 40).
      expect(h.checkpointer!.checkpoints - before).toBeGreaterThanOrEqual(1);
      expect(h.checkpointer!.checkpoints - before).toBeLessThanOrEqual(2);
    } finally {
      if (reader.inTransaction) reader.exec('COMMIT');
      reader.close();
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
      // Running, not merely not started yet.
      await h.checkpointer!.ready;
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
    // A page size the header does not have: the worker cannot tell the WAL's size, on any look.
    const opened = await openTestDb({
      backgroundCheckpoint: true,
      checkpointerTuning: { pageSize: 512, pollMs: 20, unreadableMs: 200 },
    });
    try {
      const h = opened.handle as SqliteHandle;
      await expect(h.checkpointer!.stopped).resolves.toMatchObject({
        unexpected: true,
        err: expect.objectContaining({
          message: expect.stringMatching(/^the wal-index header has not been readable for \d+ ms$/),
        }),
      });
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

  it("the server's own worker waits 5 s for a header it cannot read before it stops (qa on #393)", async () => {
    // What the server starts, with no limit given: only the poll is faster, and a page size the
    // header does not have keeps every look unreadable. 5,000 is written here, not imported, so a
    // change to the server's limit fails this test.
    const startedAt = Date.now();
    const opened = await openTestDb({
      backgroundCheckpoint: true,
      checkpointerTuning: { pageSize: 512, pollMs: 20 },
    });
    try {
      const h = opened.handle as SqliteHandle;
      const stop = await h.checkpointer!.stopped;
      const elapsed = Date.now() - startedAt;
      expect(stop).toMatchObject({ unexpected: true });
      expect(elapsed).toBeGreaterThanOrEqual(5_000);
      // About one poll after the limit; the margin is for a loaded machine.
      expect(elapsed).toBeLessThan(8_000);
      const ms = /has not been readable for (\d+) ms$/.exec((stop.err as Error).message);
      expect(Number(ms?.[1])).toBeGreaterThan(5_000);
    } finally {
      await opened.close();
    }
  }, 20_000);

  it('a header unreadable for a while and then readable again: the worker goes on, and checkpoints', async () => {
    const checkpoints: CheckpointRecord[] = [];
    let stopped = false;
    const opened = await openTestDb();
    const h = opened.handle as SqliteHandle;
    try {
      h.sqlite.pragma('wal_autocheckpoint = 10000');
      const pageSize = Number(h.sqlite.pragma('page_size', { simple: true }));
      const shm = shmOf(opened.dataDir);
      await write(h, 1);
      const cp = startBackgroundCheckpointer(join(opened.dataDir, 'opportun.db'), {
        pragmas: [],
        pageSize,
        maxPages: 50,
        pollMs: 20,
        unreadableMs: 1_000,
        onStopped: () => (stopped = true),
        onCheckpoint: (c) => checkpoints.push(c),
      });
      try {
        await cp.ready;
        // Twice, each time for about 30 looks at a header it cannot read, with a few readable
        // looks between: together longer than the limit, so a readable look must start it again.
        for (let i = 0; i < 2; i++) {
          const restore = tearHeader(shm);
          expect(readWalIndex(shm, pageSize)).toBeUndefined();
          await new Promise((r) => setTimeout(r, 600));
          restore();
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(stopped).toBe(false);
        await write(h, 100);
        await until(() => checkpoints.length > 0 || stopped);
        expect(stopped).toBe(false);
        expect(checkpoints[0]).toMatchObject({ reason: 'size' });
      } finally {
        await cp.stop();
      }
    } finally {
      await opened.close();
    }
  });

  it('a header that stays unreadable past the limit: the worker stops, as unexpected, and says why', async () => {
    const checkpoints: CheckpointRecord[] = [];
    const opened = await openTestDb();
    const h = opened.handle as SqliteHandle;
    try {
      h.sqlite.pragma('wal_autocheckpoint = 10000');
      const pageSize = Number(h.sqlite.pragma('page_size', { simple: true }));
      const shm = shmOf(opened.dataDir);
      // More than maxPages waiting, so a worker that checkpointed on a guess would checkpoint here
      // (tl on #393).
      await write(h, 100);
      const cp = startBackgroundCheckpointer(join(opened.dataDir, 'opportun.db'), {
        pragmas: [],
        pageSize,
        maxPages: 50,
        // The first look comes a poll after ready, so the tear below lands before it.
        pollMs: 200,
        unreadableMs: 300,
        onStopped: () => undefined,
        onCheckpoint: (c) => checkpoints.push(c),
      });
      // Torn only once the worker is ready: opening its connection rebuilds a torn header (seen
      // when the header was torn before the worker started).
      await cp.ready;
      const restore = tearHeader(shm);
      expect(readWalIndex(shm, pageSize)).toBeUndefined();
      const tornAt = Date.now();
      try {
        const stop = await cp.stopped;
        expect(Date.now() - tornAt).toBeGreaterThanOrEqual(300);
        expect(stop).toMatchObject({ unexpected: true });
        const message = (stop.err as Error).message;
        const ms = /^the wal-index header has not been readable for (\d+) ms$/.exec(message);
        expect(ms, message).not.toBeNull();
        expect(Number(ms![1])).toBeGreaterThan(300);
        // While it could not read, it did nothing else: no checkpoint from a guess.
        expect(checkpoints).toEqual([]);
      } finally {
        restore();
      }
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
