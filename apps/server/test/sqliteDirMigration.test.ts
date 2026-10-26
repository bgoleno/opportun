// The sqlite-dir split (issue #179, incident #165): opportun.db moves off the general data
// directory and onto its own directory (a named Docker volume in deploy/compose.yml), with
// VACUUM INTO rather than a file copy so a live WAL is captured correctly. Covers the
// migration's reachable branches: fresh install, already migrated, first migration (including
// data still only in the WAL, uncheckpointed, while a writer holds the old file open), and the
// dual-location refusal. The integrity_check-failure cleanup path (a VACUUM INTO copy that
// itself comes out corrupt) has no organic repro short of fault injection and is not covered
// here; it was verified by reading, not by a test.
import { copyFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, SqliteDirConflict } from '../src/db/client';
import { sqliteOnly } from './db';

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opportun-sqlitedir-'));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe.runIf(sqliteOnly)('sqlite-dir migration', () => {
  it('fresh install: creates the database only at sqliteDir, nothing at dataDir', async () => {
    const dataDir = await tempDir();
    const sqliteDir = await tempDir();
    const handle = openDatabase(dataDir, sqliteDir);
    try {
      expect(await readdir(sqliteDir)).toContain('opportun.db');
      expect(await readdir(dataDir)).toEqual([]);
    } finally {
      handle.sqlite.close();
    }
  });

  it('already migrated: a database only at sqliteDir opens as-is, dataDir stays empty', async () => {
    const dataDir = await tempDir();
    const sqliteDir = await tempDir();
    openDatabase(dataDir, sqliteDir).sqlite.close();
    expect(await readdir(dataDir)).toEqual([]);

    const reopened = openDatabase(dataDir, sqliteDir);
    try {
      expect(await readdir(dataDir)).toEqual([]);
    } finally {
      reopened.sqlite.close();
    }
  });

  it(
    'migrates an existing dataDir database into sqliteDir, including data still only in ' +
      'the WAL (uncheckpointed) while a writer holds the old file open, and retires the ' +
      'original by renaming rather than deleting it',
    async () => {
      const dataDir = await tempDir();
      // Simulates a pre-upgrade install: single location, fully migrated.
      const before = openDatabase(dataDir);
      before.sqlite.exec('CREATE TABLE marker(x INTEGER)');
      before.sqlite.prepare('INSERT INTO marker VALUES (?)').run(99);
      // Deliberately not checkpointed: this row lives only in dataDir/opportun.db-wal, the
      // exact condition that corrupted the database in #165 when something copied the main
      // file without it.
      expect(await readdir(dataDir)).toContain('opportun.db-wal');

      const sqliteDir = await tempDir();
      // before.sqlite stays open through this call: migrateSqliteDir's VACUUM INTO must read
      // a consistent snapshot through a second, independent connection while a writer is live.
      const migrated = openDatabase(dataDir, sqliteDir);
      try {
        expect(migrated.sqlite.prepare('SELECT x FROM marker').all()).toEqual([{ x: 99 }]);

        const dataDirFiles = await readdir(dataDir);
        expect(dataDirFiles).not.toContain('opportun.db');
        expect(dataDirFiles).not.toContain('opportun.db-wal');
        expect(dataDirFiles).not.toContain('opportun.db-shm');
        expect(dataDirFiles).toContain('opportun.db.pre-volume-migration');
        expect(dataDirFiles).toContain('opportun.db.pre-volume-migration-wal');
      } finally {
        migrated.sqlite.close();
        before.sqlite.close();
      }
    },
  );

  it(
    'preserves the original by a true byte copy made before anything opens it, so the ' +
      'preserved file matches what was on disk before migration touched anything, even if ' +
      'opening the original for VACUUM INTO altered it',
    async () => {
      const dataDir = await tempDir();
      const before = openDatabase(dataDir);
      before.sqlite.exec('CREATE TABLE marker(x INTEGER)');
      before.sqlite.prepare('INSERT INTO marker VALUES (?)').run(7);
      before.sqlite.close();

      const dbBytesBefore = await readFile(join(dataDir, 'opportun.db'));
      const walBytesBefore = await readFile(join(dataDir, 'opportun.db-wal')).catch(
        () => undefined,
      );

      const sqliteDir = await tempDir();
      openDatabase(dataDir, sqliteDir).sqlite.close();

      const dbBytesAfter = await readFile(join(dataDir, 'opportun.db.pre-volume-migration'));
      expect(dbBytesAfter.equals(dbBytesBefore)).toBe(true);
      if (walBytesBefore !== undefined) {
        const walBytesAfter = await readFile(join(dataDir, 'opportun.db.pre-volume-migration-wal'));
        expect(walBytesAfter.equals(walBytesBefore)).toBe(true);
      }
    },
  );

  it('refuses, and touches neither file, when both dataDir and sqliteDir hold a database', async () => {
    const dataDir = await tempDir();
    const sqliteDir = await tempDir();
    openDatabase(dataDir).sqlite.close();
    openDatabase(sqliteDir).sqlite.close();
    const dataDirBefore = await readdir(dataDir);
    const sqliteDirBefore = await readdir(sqliteDir);

    expect(() => openDatabase(dataDir, sqliteDir)).toThrow(SqliteDirConflict);

    expect(await readdir(dataDir)).toEqual(dataDirBefore);
    expect(await readdir(sqliteDir)).toEqual(sqliteDirBefore);
  });

  it(
    'refuses, rather than overwrite it, when a preserved copy from an earlier interrupted ' +
      'migration attempt already exists',
    async () => {
      const dataDir = await tempDir();
      openDatabase(dataDir).sqlite.close();
      // Simulates a process that preserved the original and then crashed before finishing.
      copyFileSync(join(dataDir, 'opportun.db'), join(dataDir, 'opportun.db.pre-volume-migration'));

      const sqliteDir = await tempDir();
      expect(() => openDatabase(dataDir, sqliteDir)).toThrow(/already exists/);
      expect(await readdir(sqliteDir)).toEqual([]);
    },
  );

  it(
    'refuses with a clean SqliteDirConflict, touching neither file, when another connection ' +
      'already holds the write lock on the old file (a second process racing this same ' +
      'migration, e.g. the server and a one-off CLI script started at once)',
    async () => {
      const dataDir = await tempDir();
      openDatabase(dataDir).sqlite.close();
      const sqliteDir = await tempDir();

      // Simulates another process's connection mid-migration: a real, separate better-sqlite3
      // handle to the same file, holding SQLite's own write lock (BEGIN IMMEDIATE), the same
      // way a second OS process would. A short migrationLockTimeoutMs keeps this test from
      // waiting out the real 120s production timeout.
      const oldFile = join(dataDir, 'opportun.db');
      const lock = new Database(oldFile);
      lock.exec('BEGIN IMMEDIATE');
      try {
        const dataDirBefore = await readdir(dataDir);
        const sqliteDirBefore = await readdir(sqliteDir);

        expect(() => openDatabase(dataDir, sqliteDir, { migrationLockTimeoutMs: 50 })).toThrow(
          SqliteDirConflict,
        );

        expect(await readdir(dataDir)).toEqual(dataDirBefore);
        expect(await readdir(sqliteDir)).toEqual(sqliteDirBefore);
      } finally {
        lock.exec('COMMIT');
        lock.close();
      }
    },
  );
});
