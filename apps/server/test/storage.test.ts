import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createStorage,
  FileExistsError,
  PathEscapeError,
  readOperatorTree,
  type Storage,
} from '../src/lib/storage';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe('storage', () => {
  let base: string;
  let dataDir: string;
  let outside: string;
  let storage: Storage;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'opportun-storage-')));
    dataDir = join(base, 'data');
    outside = join(base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'top secret');
    storage = createStorage(dataDir, dataDir);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  describe('resolveInsideRoot', () => {
    it('resolves a relative path under the data dir', () => {
      expect(storage.resolveInsideRoot('backups/x.db')).toBe(join(dataDir, 'backups', 'x.db'));
    });

    it.each(['../x', 'a/../../x', '..', 'a/../..', '../data-sibling/x'])(
      'rejects traversal %s',
      (p) => {
        expect(() => storage.resolveInsideRoot(p)).toThrow(PathEscapeError);
      },
    );

    it('rejects absolute paths, the root itself and NUL bytes', () => {
      expect(() => storage.resolveInsideRoot('/etc/passwd')).toThrow(PathEscapeError);
      expect(() => storage.resolveInsideRoot(join(dataDir, 'x'))).toThrow(PathEscapeError);
      expect(() => storage.resolveInsideRoot('.')).toThrow(PathEscapeError);
      expect(() => storage.resolveInsideRoot('')).toThrow(PathEscapeError);
      expect(() => storage.resolveInsideRoot('a\0b')).toThrow(PathEscapeError);
    });

    it('rejects a path through a symlinked directory that leaves the root', async () => {
      await symlink(outside, join(dataDir, 'link'));
      expect(() => storage.resolveInsideRoot('link/secret.txt')).toThrow(PathEscapeError);
      expect(() => storage.resolveInsideRoot('link/new/file.txt')).toThrow(PathEscapeError);
    });

    it('rejects a path through any symlink, even one pointing inside the root', async () => {
      await mkdir(join(dataDir, 'real'));
      await symlink(join(dataDir, 'real'), join(dataDir, 'alias'));
      expect(() => storage.resolveInsideRoot('alias/x')).toThrow(PathEscapeError);
    });
  });

  describe('attachments', () => {
    it('stores content under its sha256 and round-trips', async () => {
      const res = await storage.writeAttachment(Buffer.from('abc'));
      expect(res).toEqual({
        sha256: ABC_SHA256,
        storedPath: `attachments/ba/${ABC_SHA256}`,
        bytes: 3,
      });
      expect(await readFile(join(dataDir, 'attachments', 'ba', ABC_SHA256), 'utf8')).toBe('abc');
      expect((await readAll(await storage.openAttachment(res.storedPath))).toString()).toBe('abc');
    });

    it('accepts a stream and deduplicates identical content', async () => {
      const big = Buffer.alloc(256 * 1024, 7);
      const a = await storage.writeAttachment(
        Readable.from([big.subarray(0, 1000), big.subarray(1000)]),
      );
      const b = await storage.writeAttachment(big);
      expect(a).toEqual(b);
      expect(a.bytes).toBe(big.length);
      expect((await readAll(await storage.openAttachment(a.storedPath))).equals(big)).toBe(true);
    });

    it('rejects absolute and malformed stored paths', async () => {
      const { storedPath } = await storage.writeAttachment(Buffer.from('abc'));
      await expect(storage.openAttachment(join(dataDir, storedPath))).rejects.toThrow(
        PathEscapeError,
      );
      await expect(storage.openAttachment('/etc/passwd')).rejects.toThrow(PathEscapeError);
      await expect(storage.openAttachment('attachments/../../outside/secret.txt')).rejects.toThrow(
        PathEscapeError,
      );
      await expect(storage.openAttachment(`attachments/zz/${ABC_SHA256}`)).rejects.toThrow(
        PathEscapeError,
      );
    });

    it('refuses to open an attachment that is a symlink pointing outside', async () => {
      const fake = 'cd'.padEnd(64, '0');
      await mkdir(join(dataDir, 'attachments', 'cd'), { recursive: true });
      await symlink(join(outside, 'secret.txt'), join(dataDir, 'attachments', 'cd', fake));
      await expect(storage.openAttachment(`attachments/cd/${fake}`)).rejects.toThrow(
        PathEscapeError,
      );
    });

    describe('listAttachmentFiles (issue #4)', () => {
      it('lists stored attachment files with their mtime', async () => {
        const { storedPath } = await storage.writeAttachment(Buffer.from('abc'));
        const files = await storage.listAttachmentFiles();
        expect(files).toHaveLength(1);
        expect(files[0]!.storedPath).toBe(storedPath);
        expect(files[0]!.mtimeMs).toBeGreaterThan(0);
        expect(files[0]!.bytes).toBe(3);
      });

      it('is empty when nothing has been stored yet (no attachments/ directory at all)', async () => {
        expect(await storage.listAttachmentFiles()).toEqual([]);
      });

      it('skips anything that is not a well-formed attachments/<aa>/<sha256> entry', async () => {
        await storage.writeAttachment(Buffer.from('abc'));
        // writeAttachment's own temp-file area: in-progress uploads, not finished attachments.
        await mkdir(join(dataDir, 'attachments', 'tmp'), { recursive: true });
        await writeFile(join(dataDir, 'attachments', 'tmp', 'partial-upload'), 'partial');
        // A directory one level down that merely looks like a hash prefix.
        await mkdir(join(dataDir, 'attachments', 'ab', 'nested'), { recursive: true });
        await writeFile(join(dataDir, 'attachments', 'ab', 'nested', 'file'), 'x');
        // A file whose name is not a sha256 hex digest.
        await mkdir(join(dataDir, 'attachments', 'cd'), { recursive: true });
        await writeFile(join(dataDir, 'attachments', 'cd', 'not-a-hash'), 'x');
        // A file whose directory prefix does not match the start of its own name.
        await mkdir(join(dataDir, 'attachments', 'ff'), { recursive: true });
        await writeFile(join(dataDir, 'attachments', 'ff', ABC_SHA256), 'x');

        const files = await storage.listAttachmentFiles();

        expect(files).toHaveLength(1);
        expect(files[0]!.storedPath).toBe(`attachments/ba/${ABC_SHA256}`);
      });
    });

    describe('attachmentMtime (issue #4)', () => {
      it('reads the mtime of a stored attachment', async () => {
        const { storedPath } = await storage.writeAttachment(Buffer.from('abc'));
        const [listed] = await storage.listAttachmentFiles();
        expect(await storage.attachmentMtime(storedPath)).toBe(listed!.mtimeMs);
      });

      it('is undefined for a path nothing has stored', async () => {
        const fake = 'ab'.padEnd(64, '0');
        expect(await storage.attachmentMtime(`attachments/ab/${fake}`)).toBeUndefined();
      });
    });

    it("bumps an existing file's mtime when a later write reuses it by content (issue #4)", async () => {
      const first = await storage.writeAttachment(Buffer.from('reused content'));
      const before = await storage.attachmentMtime(first.storedPath);
      await new Promise((r) => setTimeout(r, 20));

      const second = await storage.writeAttachment(Buffer.from('reused content'));

      expect(second.storedPath).toBe(first.storedPath);
      const after = await storage.attachmentMtime(first.storedPath);
      expect(after!).toBeGreaterThan(before!);
    });
  });

  describe('text files', () => {
    it('writes and reads text, creating parent directories', async () => {
      await storage.writeText('exports/2026/out.json', '{"a":1}');
      expect(await storage.readText('exports/2026/out.json')).toBe('{"a":1}');
      await storage.writeText('exports/2026/out.json', 'v2');
      expect(await storage.readText('exports/2026/out.json')).toBe('v2');
    });

    it('rejects escapes on read and write', async () => {
      await expect(storage.readText('../outside/secret.txt')).rejects.toThrow(PathEscapeError);
      await expect(storage.writeText('../outside/pwned.txt', 'x')).rejects.toThrow(PathEscapeError);
    });

    it('refuses to read through a symlinked file pointing outside', async () => {
      await mkdir(join(dataDir, 'exports'), { recursive: true });
      await symlink(join(outside, 'secret.txt'), join(dataDir, 'exports', 'leak.txt'));
      await expect(storage.readText('exports/leak.txt')).rejects.toThrow(PathEscapeError);
    });

    it.each([
      'opportun.db',
      'notes.txt',
      'attachments/aa/x',
      'backups',
      'exports',
      'backupsx/a.txt',
      'backups/../opportun.db',
      'exports/../attachments/x',
    ])('confines text files to backups/ and exports/: rejects %s', async (p) => {
      await expect(storage.writeText(p, 'x')).rejects.toThrow(PathEscapeError);
      await expect(storage.readText(p)).rejects.toThrow(PathEscapeError);
    });

    it('lists, moves and removes backup files, confined like text files', async () => {
      await storage.ensureDir('backups');
      await storage.writeText('backups/a.tmp', 'x');
      await storage.moveFile('backups/a.tmp', 'backups/a.db');
      const files = await storage.listFiles('backups');
      expect(files.map((f) => f.name)).toEqual(['a.db']);
      expect(files[0]!.bytes).toBe(1);
      await storage.removeFile('backups/a.db');
      await storage.removeFile('backups/a.db');
      expect(await storage.listFiles('backups')).toEqual([]);
      expect(await storage.listFiles('exports/none')).toEqual([]);

      await expect(storage.ensureDir('attachments')).rejects.toThrow(PathEscapeError);
      await expect(storage.listFiles('attachments')).rejects.toThrow(PathEscapeError);
      await expect(storage.listFiles('../outside')).rejects.toThrow(PathEscapeError);
      await expect(storage.removeFile('opportun.db')).rejects.toThrow(PathEscapeError);
      await expect(storage.moveFile('backups/x', 'opportun.db')).rejects.toThrow(PathEscapeError);
      await expect(storage.moveFile('../outside/secret.txt', 'backups/s')).rejects.toThrow(
        PathEscapeError,
      );
    });

    it('moveFile never clobbers an existing destination', async () => {
      await storage.ensureDir('backups');
      await storage.writeText('backups/a.tmp', 'first');
      await storage.moveFile('backups/a.tmp', 'backups/a.db');
      await storage.writeText('backups/b.tmp', 'second');
      await expect(storage.moveFile('backups/b.tmp', 'backups/a.db')).rejects.toThrow(
        FileExistsError,
      );
      // The destination keeps its original content; the source of the failed move is untouched.
      expect(await storage.readText('backups/a.db')).toBe('first');
      expect(await storage.readText('backups/b.tmp')).toBe('second');
    });

    it('accepts text files under backups/', async () => {
      await storage.writeText('backups/m.json', '[]');
      expect(await storage.readText('backups/m.json')).toBe('[]');
    });

    it('does not write through a symlinked directory', async () => {
      await symlink(outside, join(dataDir, 'backups'));
      await expect(storage.writeText('backups/x.txt', 'x')).rejects.toThrow(PathEscapeError);
      await expect(readFile(join(outside, 'x.txt'))).rejects.toThrow(/ENOENT/);
    });
  });

  describe('database file management (issue #142)', () => {
    it('stats a database file at the root, undefined when absent', async () => {
      expect(await storage.statDatabaseFile('opportun.db')).toBeUndefined();
      await writeFile(join(dataDir, 'opportun.db'), 'sqlite bytes');
      const st = await storage.statDatabaseFile('opportun.db');
      expect(st?.bytes).toBe('sqlite bytes'.length);
    });

    it('copies a database file to a new directory, leaving the original in place', async () => {
      await writeFile(join(dataDir, 'opportun.db'), 'live');
      expect(await storage.copyDatabaseFile('opportun.db', 'pre-restore-1')).toBe(true);
      expect((await storage.statDatabaseFile('opportun.db'))?.bytes).toBe('live'.length);
      expect((await readFile(join(dataDir, 'pre-restore-1', 'opportun.db'))).toString()).toBe(
        'live',
      );
    });

    it('a later change to the original does not change the copy (a true copy, not a link)', async () => {
      await writeFile(join(dataDir, 'opportun.db'), 'live');
      await storage.copyDatabaseFile('opportun.db', 'pre-restore-1');
      await writeFile(join(dataDir, 'opportun.db'), 'changed afterward');
      expect((await readFile(join(dataDir, 'pre-restore-1', 'opportun.db'))).toString()).toBe(
        'live',
      );
    });

    it('removes a database file; a missing one is not an error', async () => {
      await writeFile(join(dataDir, 'opportun.db'), 'live');
      await storage.removeDatabaseFile('opportun.db');
      expect(await storage.statDatabaseFile('opportun.db')).toBeUndefined();
      await expect(storage.removeDatabaseFile('opportun.db-wal')).resolves.toBeUndefined();
    });

    it('copying a sibling that does not exist (opportun.db-wal) is not an error, resolves false', async () => {
      await writeFile(join(dataDir, 'opportun.db'), 'live');
      await expect(storage.copyDatabaseFile('opportun.db-wal', 'pre-restore-1')).resolves.toBe(
        false,
      );
      expect(await readdir(dataDir)).not.toContain('opportun.db-wal');
    });

    it('refuses to copy over a file already at the destination', async () => {
      await writeFile(join(dataDir, 'opportun.db'), 'first');
      await storage.copyDatabaseFile('opportun.db', 'pre-restore-1');
      await writeFile(join(dataDir, 'opportun.db'), 'second');
      await expect(storage.copyDatabaseFile('opportun.db', 'pre-restore-1')).rejects.toThrow(
        FileExistsError,
      );
      // The second attempt changed nothing: "second" is still live, "first" still preserved.
      expect((await readFile(join(dataDir, 'opportun.db'))).toString()).toBe('second');
      expect((await readFile(join(dataDir, 'pre-restore-1', 'opportun.db'))).toString()).toBe(
        'first',
      );
    });

    it('copies a snapshot from backups/ onto opportun.db, as an independent copy', async () => {
      await mkdir(join(dataDir, 'backups'), { recursive: true });
      await writeFile(join(dataDir, 'backups', 'opportun-20261021-0300.db'), 'snapshot bytes');
      await storage.restoreDatabaseFile('backups/opportun-20261021-0300.db');
      expect((await readFile(join(dataDir, 'opportun.db'))).toString()).toBe('snapshot bytes');
      // Independent copy, not a link: changing one must not change the other.
      await writeFile(join(dataDir, 'opportun.db'), 'changed after restore');
      expect(
        (await readFile(join(dataDir, 'backups', 'opportun-20261021-0300.db'))).toString(),
      ).toBe('snapshot bytes');
    });

    it('refuses to restore onto an opportun.db that already exists', async () => {
      await mkdir(join(dataDir, 'backups'), { recursive: true });
      await writeFile(join(dataDir, 'backups', 'opportun-20261021-0300.db'), 'snapshot bytes');
      await writeFile(join(dataDir, 'opportun.db'), 'still live');
      await expect(
        storage.restoreDatabaseFile('backups/opportun-20261021-0300.db'),
      ).rejects.toThrow(FileExistsError);
      expect((await readFile(join(dataDir, 'opportun.db'))).toString()).toBe('still live');
    });

    it('refuses a snapshot path outside backups/, same confinement as every other text path', async () => {
      await writeFile(join(dataDir, 'notes.db'), 'not a backup');
      await expect(storage.restoreDatabaseFile('notes.db')).rejects.toThrow(PathEscapeError);
    });

    it(
      'resolveInsideRoot refuses opportun.db and its siblings (even under an equivalent ' +
        'spelling), steering a caller to the dedicated methods instead of a DATA_DIR-rooted ' +
        'path that is wrong once SQLITE_DIR differs (issue #179/#189)',
      () => {
        for (const spelling of ['opportun.db', './opportun.db', 'opportun.db-wal']) {
          expect(() => storage.resolveInsideRoot(spelling)).toThrow(PathEscapeError);
        }
      },
    );
  });

  describe('database file management with a separate SQLITE_DIR (issue #179/#189)', () => {
    let sqliteDir: string;
    let split: Storage;

    beforeEach(async () => {
      sqliteDir = join(base, 'sqlite');
      split = createStorage(dataDir, sqliteDir);
    });

    it('statDatabaseFile finds opportun.db in SQLITE_DIR and ignores one left in DATA_DIR', async () => {
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'opportun.db'), 'stale, wrong location');
      expect(await split.statDatabaseFile('opportun.db')).toBeUndefined();

      await mkdir(sqliteDir, { recursive: true, mode: 0o700 });
      await writeFile(join(sqliteDir, 'opportun.db'), 'live, in sqlite_dir');
      const st = await split.statDatabaseFile('opportun.db');
      expect(st?.bytes).toBe('live, in sqlite_dir'.length);
    });

    it('liveDatabasePath points at SQLITE_DIR, not DATA_DIR', () => {
      expect(split.liveDatabasePath('opportun.db')).toBe(join(sqliteDir, 'opportun.db'));
      expect(split.liveDatabasePath('opportun.db')).not.toBe(join(dataDir, 'opportun.db'));
    });

    it('copyDatabaseFile reads the live file from SQLITE_DIR and preserves it under DATA_DIR', async () => {
      await mkdir(sqliteDir, { recursive: true, mode: 0o700 });
      await writeFile(join(sqliteDir, 'opportun.db'), 'live, in sqlite_dir');
      expect(await split.copyDatabaseFile('opportun.db', 'pre-restore-1')).toBe(true);
      expect((await readFile(join(dataDir, 'pre-restore-1', 'opportun.db'))).toString()).toBe(
        'live, in sqlite_dir',
      );
      // The live file itself is untouched, still in SQLITE_DIR.
      expect((await readFile(join(sqliteDir, 'opportun.db'))).toString()).toBe(
        'live, in sqlite_dir',
      );
    });

    it('restoreDatabaseFile reads the snapshot from DATA_DIR/backups and writes SQLITE_DIR', async () => {
      await mkdir(join(dataDir, 'backups'), { recursive: true });
      await writeFile(join(dataDir, 'backups', 'opportun-20261021-0300.db'), 'snapshot bytes');
      await mkdir(sqliteDir, { recursive: true, mode: 0o700 });
      await split.restoreDatabaseFile('backups/opportun-20261021-0300.db');
      expect((await readFile(join(sqliteDir, 'opportun.db'))).toString()).toBe('snapshot bytes');
      expect(await readdir(dataDir)).not.toContain('opportun.db');
    });
  });
});

describe('readOperatorTree', () => {
  it('stops rather than buffering a tree larger than the caller allows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opportun-tree-'));
    try {
      await mkdir(join(dir, 'sub'));
      await writeFile(join(dir, 'a.txt'), 'x'.repeat(64));
      await writeFile(join(dir, 'sub', 'b.txt'), 'y'.repeat(64));
      expect(Object.keys(readOperatorTree(dir, 1024)).sort()).toEqual(['a.txt', 'sub/b.txt']);
      // A mis-set ARTIFACTS_DIR should fail loudly, not stall the process reading a disk.
      expect(() => readOperatorTree(dir, 100)).toThrow(/too large/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
