// The restore CLI (issue #142, the mirror of cliBackup.test.ts): main()'s own job is argument
// handling and mapping lib/restore.ts's three outcomes onto exit codes; the restore guarantees
// themselves are restore.test.ts's job, not retested here.
import Database from 'better-sqlite3';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbConfig } from '../src/config';
import { main } from '../src/cli/restore';
import { createStorage, type Storage } from '../src/lib/storage';

let base: string;
let dataDir: string;
let storage: Storage;
const sqlite: DbConfig = { dialect: 'sqlite' };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'opportun-cli-restore-')));
  dataDir = join(base, 'data');
  storage = createStorage(dataDir, dataDir);
  await mkdir(join(dataDir, 'backups'), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function writeValidSqlite(relPath: string): void {
  const db = new Database(join(dataDir, relPath));
  db.exec('CREATE TABLE t (x INTEGER)');
  db.prepare('INSERT INTO t VALUES (1)').run();
  db.close();
}

describe('restore CLI', () => {
  it('prints usage and exits 2 when no snapshot is given', async () => {
    const out: string[] = [];
    const code = await main({
      snapshot: undefined,
      storage,
      db: sqlite,
      io: { stdout: (l) => out.push(l), stderr: (l) => out.push(`ERR: ${l}`) },
    });
    expect(code).toBe(2);
    expect(out.some((l) => l.includes('Usage:'))).toBe(true);
  });

  it('exits 2 and reports a refusal, without throwing, for a snapshot that does not exist', async () => {
    const out: string[] = [];
    const code = await main({
      snapshot: 'opportun-20261021-0300.db',
      storage,
      db: sqlite,
      io: { stdout: (l) => out.push(l), stderr: (l) => out.push(`ERR: ${l}`) },
    });
    expect(code).toBe(2);
    expect(out.some((l) => l.startsWith('ERR: Refused:'))).toBe(true);
  });

  it('restores and prints the exact report on success, exit 0', async () => {
    writeValidSqlite('backups/opportun-20261021-0300.db');
    const out: string[] = [];
    const code = await main({
      snapshot: 'opportun-20261021-0300.db',
      storage,
      db: sqlite,
      io: { stdout: (l) => out.push(l), stderr: (l) => out.push(`ERR: ${l}`) },
    });
    expect(code).toBe(0);
    expect(out.some((l) => l.includes('Restored from opportun-20261021-0300.db'))).toBe(true);
  });

  it('exits 1 and reports the stage when the restore fails partway', async () => {
    writeValidSqlite('backups/opportun-20261021-0300.db');
    const brokenStorage: Storage = {
      ...storage,
      restoreDatabaseFile: () => {
        throw new Error('disk full mid-copy');
      },
    };
    const out: string[] = [];
    const code = await main({
      snapshot: 'opportun-20261021-0300.db',
      storage: brokenStorage,
      db: sqlite,
      io: { stdout: (l) => out.push(l), stderr: (l) => out.push(`ERR: ${l}`) },
    });
    expect(code).toBe(1);
    expect(out.some((l) => l.startsWith('ERR: Failed while restoring:'))).toBe(true);
    expect(out.some((l) => l.includes('disk full mid-copy'))).toBe(true);
  });
});
