// Restore (issue #142): the inverse of jobs/backup.ts. Each test here states what it is
// protecting, per review: these are not "does copyFile work", they are the four guarantees
// the ticket asked for, proven against a real SQLite file and a real second connection, not
// a mock of either.
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLiveCheck } from '../src/jobs/dbIntegrityCheck';
import { createStorage, type Storage } from '../src/lib/storage';
import {
  formatRestoreReport,
  RestoreFailed,
  RestoreRefused,
  restoreSqlite,
} from '../src/lib/restore';

let base: string;
let dataDir: string;
let storage: Storage;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'opportun-restore-')));
  dataDir = join(base, 'data');
  storage = createStorage(dataDir, dataDir);
  await mkdir(join(dataDir, 'backups'), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Writes a real, valid SQLite file at `relPath` (under dataDir) with one row in it. */
function writeValidSqlite(relPath: string): void {
  const db = new Database(join(dataDir, relPath));
  db.exec('CREATE TABLE t (x INTEGER)');
  db.prepare('INSERT INTO t VALUES (1)').run();
  db.close();
}

const SNAPSHOT = 'opportun-20261021-0300.db';

describe('restoreSqlite', () => {
  it('refuses a name this app’s own backup job did not produce (issue #165’s own shape)', async () => {
    writeValidSqlite('backups/manual-pre-upgrade-20261021-0655.db');
    await expect(
      restoreSqlite({ storage, snapshot: 'manual-pre-upgrade-20261021-0655.db' }),
    ).rejects.toThrow(RestoreRefused);
  });

  it('refuses a snapshot that does not exist, before touching anything', async () => {
    writeValidSqlite('opportun.db');
    await expect(restoreSqlite({ storage, snapshot: SNAPSHOT })).rejects.toThrow(RestoreRefused);
    expect((await readFile(join(dataDir, 'opportun.db'))).length).toBeGreaterThan(0);
  });

  it('refuses while another connection holds the live database open (requirement 1)', async () => {
    writeValidSqlite(`backups/${SNAPSHOT}`);
    writeValidSqlite('opportun.db');
    const holder = new Database(join(dataDir, 'opportun.db'));
    holder.pragma('journal_mode = WAL');
    // A real server does not just open the file, it uses it: an idle connection with no
    // statement run yet takes no lock at all in WAL mode. A held read transaction is what
    // actually contends, and is also the realistic shape (the gate.ts write gate, elsewhere in
    // this app, holds exactly this kind of open transaction for the duration of a request).
    holder.exec('BEGIN');
    holder.prepare('SELECT * FROM t').all();
    try {
      await expect(restoreSqlite({ storage, snapshot: SNAPSHOT })).rejects.toThrow(RestoreRefused);
      // Refused before anything else: the live file is exactly what it was.
      expect((await readFile(join(dataDir, 'opportun.db'))).length).toBeGreaterThan(0);
    } finally {
      holder.close();
    }
    // Once nothing holds it open, the same restore succeeds.
    await expect(restoreSqlite({ storage, snapshot: SNAPSHOT })).resolves.toMatchObject({
      dialect: 'sqlite',
    });
  });

  it('refuses a corrupt snapshot rather than trust a plausible-looking file (requirement 2, issue #165)', async () => {
    writeValidSqlite(`backups/${SNAPSHOT}`);
    // Truncate mid-file: a real corruption shape, not an empty or missing file.
    const bytes = await readFile(join(dataDir, 'backups', SNAPSHOT));
    await writeFile(join(dataDir, 'backups', SNAPSHOT), bytes.subarray(0, bytes.length / 2));
    writeValidSqlite('opportun.db');
    await expect(restoreSqlite({ storage, snapshot: SNAPSHOT })).rejects.toThrow(RestoreRefused);
    // Refused before preserving or overwriting anything.
    expect((await readFile(join(dataDir, 'opportun.db'))).length).toBeGreaterThan(bytes.length / 2);
  });

  it('preserves a crashed database’s un-checkpointed WAL exactly as it was, not a recovered version of it', async () => {
    // The specific regression this is pinned against: merely opening opportun.db to check
    // whether anything else holds it (the requirement-1 probe below) can itself trigger
    // SQLite's own WAL recovery -- a write -- the moment a real, un-checkpointed -wal file is
    // sitting beside a real crash (confirmed empirically before writing this fix: a plain
    // exclusive-lock probe checkpointed and removed a 12KB crash -wal as a side effect). If
    // preserving ran after that check, or used the live file's post-recovery state, what gets
    // preserved would already be a cleaned-up version of what was actually on disk at crash
    // time -- exactly the "corrupt original and its partial recovery" tonight's incident
    // needed both of, not one recovered into the other.
    //
    // The child kills itself with process.exit() right after its last synchronous SQLite call
    // returns, rather than printing a "ready" message for the parent to race a SIGKILL against:
    // that race was observed empirically to flake under this test runner (the write was
    // sometimes not yet visible to a second process by the time the parent's kill landed, or
    // vanished again before the parent's own read -- a timing hazard of racing two processes,
    // not of the fix under test). process.exit() skips any cleanup a graceful shutdown would
    // run (no db.close() is ever called) exactly as a real crash does, and happens on the
    // child's own timeline, synchronously after its last write, so there is nothing left to race.
    const dbFile = join(dataDir, 'opportun.db');
    const better = createRequire(import.meta.url).resolve('better-sqlite3');
    const child = spawn('node', [
      '-e',
      `const Database = require(${JSON.stringify(better)});
       const db = new Database(${JSON.stringify(dbFile)});
       db.pragma('journal_mode = WAL');
       db.exec('CREATE TABLE t (x INTEGER)');
       db.prepare('INSERT INTO t VALUES (1)').run();
       process.exit(1);`,
    ]);
    await new Promise((resolve) => child.once('exit', resolve));

    const walBefore = await readFile(`${dbFile}-wal`);
    expect(walBefore.length).toBeGreaterThan(0); // a real crash: un-checkpointed, not cleanly closed

    writeValidSqlite(`backups/${SNAPSHOT}`);
    const report = await restoreSqlite({ storage, snapshot: SNAPSHOT });

    const preservedWal = await readFile(join(report.preserved!, 'opportun.db-wal'));
    expect(preservedWal).toEqual(walBefore);
  });

  it('preserves the existing database (and its wal/shm) before overwriting it (requirement 3)', async () => {
    writeValidSqlite(`backups/${SNAPSHOT}`);
    writeValidSqlite('opportun.db');
    await writeFile(join(dataDir, 'opportun.db-wal'), 'wal bytes');
    await writeFile(join(dataDir, 'opportun.db-shm'), 'shm bytes');
    const liveBefore = await readFile(join(dataDir, 'opportun.db'));

    const report = await restoreSqlite({ storage, snapshot: SNAPSHOT });

    expect(report.preserved).not.toBeNull();
    const preservedDb = await readFile(join(report.preserved!, 'opportun.db'));
    expect(preservedDb).toEqual(liveBefore);
    expect((await readFile(join(report.preserved!, 'opportun.db-wal'))).toString()).toBe(
      'wal bytes',
    );
    expect((await readFile(join(report.preserved!, 'opportun.db-shm'))).toString()).toBe(
      'shm bytes',
    );
    // Nothing left behind at the live path for the siblings.
    await expect(readFile(join(dataDir, 'opportun.db-wal'))).rejects.toThrow(/ENOENT/);
  });

  it('restores with nothing to preserve when there was no existing database at all', async () => {
    writeValidSqlite(`backups/${SNAPSHOT}`);
    const report = await restoreSqlite({ storage, snapshot: SNAPSHOT });
    expect(report.preserved).toBeNull();
    await expect(readFile(join(dataDir, 'opportun.db'))).resolves.toBeInstanceOf(Buffer);
  });

  it('reports exactly what was restored and from when (requirement 4)', async () => {
    writeValidSqlite(`backups/${SNAPSHOT}`);
    const completedAt = Date.UTC(2026, 9, 21, 3, 0, 0);
    await utimes(join(dataDir, 'backups', SNAPSHOT), new Date(completedAt), new Date(completedAt));

    const report = await restoreSqlite({ storage, snapshot: SNAPSHOT });
    expect(report.snapshot).toBe(SNAPSHOT);
    expect(report.snapshotCompletedAt).toBe(completedAt);

    const text = formatRestoreReport(report);
    expect(text).toContain(SNAPSHOT);
    expect(text).toContain(new Date(completedAt).toISOString());
    expect(text).toMatch(/restored from/i);
  });

  it('says the snapshot was verified, and refreshes a stale failed live-check to match reality (issue #205)', async () => {
    writeValidSqlite(`backups/${SNAPSHOT}`);
    // The exact shape of the #198/#205 gap: a scheduled check found the PREVIOUS database
    // corrupt, hours or days before this restore, and nothing has touched that record since.
    const staleFailure = {
      ok: false,
      checkedAt: Date.UTC(2026, 9, 20, 2, 30),
      detail: 'row 2 missing from index x',
    };
    await storage.writeText('backups/.live-check.json', JSON.stringify(staleFailure));

    const report = await restoreSqlite({ storage, snapshot: SNAPSHOT });
    expect(report.verified.ok).toBe(true);
    expect(formatRestoreReport(report)).toMatch(/verified/i);

    // The restored file is what was just verified clean, not what the stale record describes.
    const refreshed = await readLiveCheck(storage);
    expect(refreshed?.ok).toBe(true);
    expect(refreshed?.checkedAt).toBeGreaterThan(staleFailure.checkedAt);
  });

  it('a failure while writing the restored file says the previous database is intact, and where', async () => {
    writeValidSqlite(`backups/${SNAPSHOT}`);
    writeValidSqlite('opportun.db');
    const liveBefore = await readFile(join(dataDir, 'opportun.db'));
    const brokenStorage: Storage = {
      ...storage,
      restoreDatabaseFile: () => {
        throw new Error('disk full mid-copy');
      },
    };
    const err = await restoreSqlite({ storage: brokenStorage, snapshot: SNAPSHOT }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RestoreFailed);
    expect((err as RestoreFailed).stage).toBe('restoring');
    expect((err as Error).message).toContain('disk full mid-copy');
    expect((err as Error).message).toMatch(/pre-restore-/);
    // The preserve step itself did complete, despite the overall call failing: the original
    // is recoverable from wherever the error says it is, not lost.
    const preservedDirMatch = /pre-restore-[^)\s]+/.exec((err as Error).message);
    expect(preservedDirMatch).not.toBeNull();
    const preservedDb = await readFile(join(dataDir, preservedDirMatch![0], 'opportun.db'));
    expect(preservedDb).toEqual(liveBefore);
  });
});
