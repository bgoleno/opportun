// NFR-SEC11: the only module in apps/server/src allowed to touch the filesystem.
// Every read and write is confined to DATA_DIR, except the live SQLite database (opportun.db
// and its -wal/-shm siblings), which lives in SQLITE_DIR instead (issue #179, incident #165)
// and is reachable only through statDatabaseFile/copyDatabaseFile/removeDatabaseFile/
// restoreDatabaseFile/liveDatabasePath -- resolveInsideRoot itself refuses DATABASE_FILE_NAMES,
// so a caller reaching for the familiar DATA_DIR-rooted path fails loudly instead of silently
// reading or writing wherever DATA_DIR happens to be. Candidate paths are joined to a root,
// checked lexically, then each existing component is lstat'ed and any symlink is rejected, so
// neither `..` nor a planted link can reach outside it. Files are opened with O_NOFOLLOW to
// close the race between that check and the open.
/* eslint-disable security/detect-non-literal-fs-filename -- every path in this module is
   produced by resolveInsideRoot, or is DATA_DIR / an operator key file from config. */
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readdir, rename, rm, utimes } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

export class PathEscapeError extends Error {
  override name = 'PathEscapeError';
}

/** moveFile's target already exists. Thrown instead of silently replacing it. */
export class FileExistsError extends Error {
  override name = 'FileExistsError';
}

export interface Storage {
  /**
   * Stores bytes under attachments/<aa>/<sha256>; identical content is stored once. When the
   * content already exists, its mtime is bumped to now (issue #4): a sweep deciding whether
   * that path is still worth keeping must be able to see that someone just started referencing
   * it again, not only how long ago it was first written.
   */
  writeAttachment(
    data: Buffer | Readable,
  ): Promise<{ sha256: string; storedPath: string; bytes: number }>;
  openAttachment(storedPath: string): Promise<Readable>;
  /**
   * Deletes one stored attachment (spec D5's purge). Confined exactly as openAttachment is: the
   * path must be an attachments/<aa>/<sha256> whose prefix matches its own digest, so nothing
   * else under the data directory can be reached through here. A missing file is not an error,
   * which makes a purge safe to re-run after a crash.
   */
  removeAttachment(storedPath: string): Promise<void>;
  /**
   * Every well-formed attachments/<aa>/<sha256> file on disk, with its mtime (issue #4, the
   * garbage-collection sweep). Anything that is not exactly that shape — the tmp/ directory
   * writeAttachment itself uses for in-progress uploads, a stray file, a directory one level
   * too deep, a name that is not a sha256 digest, a prefix that does not match the digest it
   * sits beside — is silently excluded, never reaching a caller whose job is deciding what to
   * delete. A sweep built on this can only ever consider deleting a real attachment file.
   */
  listAttachmentFiles(): Promise<{ storedPath: string; bytes: number; mtimeMs: number }[]>;
  /** mtime of one stored attachment, or undefined if it does not exist (issue #4). */
  attachmentMtime(storedPath: string): Promise<number | undefined>;
  /** Backups and exports only: relPath must lie under top-level backups/ or exports/. Atomic replace. */
  writeText(relPath: string, text: string): Promise<void>;
  /** Same confinement as writeText. */
  readText(relPath: string): Promise<string>;
  /** Absolute path for relPath inside DATA_DIR; throws PathEscapeError otherwise, including
   *  for any of DATABASE_FILE_NAMES, which live in SQLITE_DIR instead (liveDatabasePath). */
  resolveInsideRoot(relPath: string): string;
  /** Creates a directory under backups/ or exports/ (and its parents) if missing. */
  ensureDir(relDir: string): Promise<void>;
  /** Regular files directly inside relDir (backups/ or exports/ only); symlinks are skipped. */
  listFiles(relDir: string): Promise<StoredFile[]>;
  /** Deletes a file under backups/ or exports/; a missing file is not an error. */
  removeFile(relPath: string): Promise<void>;
  /**
   * Moves a file within backups/ or exports/ to a new name, atomically. Never replaces an
   * existing file at toRel: throws FileExistsError instead, so two writers racing for the
   * same name cannot destroy one another's file (link() is atomic create-or-EEXIST; this
   * is not a check then a separate write).
   */
  moveFile(fromRel: string, toRel: string): Promise<void>;
  /** Stat for one of DATABASE_FILE_NAMES in SQLITE_DIR, or undefined if absent (issue #142's
   *  restore command). Nothing else (master.key, attachments/, backups/, exports/) is
   *  reachable through this or the methods below: they live in DATA_DIR, a different root. */
  statDatabaseFile(name: DatabaseFileName): Promise<{ bytes: number; mtimeMs: number } | undefined>;
  /**
   * Copies (a true byte copy, not a link) one of DATABASE_FILE_NAMES from SQLITE_DIR to the
   * same name under a new directory at the data directory root (created if it does not
   * exist), leaving the original in place; a missing source file is not an error, so calling
   * this for a sibling that may not exist (e.g. opportun.db-wal) is always safe. Resolves
   * false when there was no source to copy. Refuses (FileExistsError) rather than overwrite
   * anything already at the destination, so a second, mistaken call cannot destroy what the
   * first one already preserved. A copy, never a move: issue #142 found that merely opening a
   * live SQLite file to check whether anything else holds it can itself trigger WAL recovery,
   * a write, so the independent copy this makes has to happen before any such check, not
   * depend on one.
   */
  copyDatabaseFile(name: DatabaseFileName, toDir: string): Promise<boolean>;
  /** Removes one of DATABASE_FILE_NAMES from SQLITE_DIR; a missing file is not an error.
   *  Paired with copyDatabaseFile: call this only once the copy already holds what is about
   *  to be removed. */
  removeDatabaseFile(name: DatabaseFileName): Promise<void>;
  /**
   * Copies a file from under DATA_DIR's backups/ onto opportun.db in SQLITE_DIR (a true
   * copy, not a link: the snapshot in backups/ must stay independent of whatever happens to
   * opportun.db afterward). Refuses (FileExistsError) if opportun.db already exists, so this
   * can only run after the caller has removed it with removeDatabaseFile — it does not trust
   * its own caller to have done that in the right order, it checks.
   */
  restoreDatabaseFile(fromBackupRelPath: string): Promise<void>;
  /** The absolute path of one of DATABASE_FILE_NAMES in SQLITE_DIR: the only supported way to
   *  learn where the live database is (issue #179/#189). resolveInsideRoot refuses these
   *  names precisely so a caller is steered here instead of guessing DATA_DIR. */
  liveDatabasePath(name: DatabaseFileName): string;
}

/** The live SQLite database and its WAL/SHM siblings: the only root-level files
 *  statDatabaseFile/copyDatabaseFile/removeDatabaseFile/restoreDatabaseFile may touch. */
export const DATABASE_FILE_NAMES = ['opportun.db', 'opportun.db-wal', 'opportun.db-shm'] as const;
export type DatabaseFileName = (typeof DATABASE_FILE_NAMES)[number];

export interface StoredFile {
  name: string;
  bytes: number;
  mtimeMs: number;
}

/** The only top-level directories text files (and backup files) may live in. */
export const TEXT_ROOTS: ReadonlySet<string> = new Set(['backups', 'exports']);

const ATTACHMENT_PATH = /^attachments\/([0-9a-f]{2})\/([0-9a-f]{64})$/;
// O_NOFOLLOW is POSIX only; on Windows the lstat walk is the only guard.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * The attachment path, checked. The digest's first two characters have to be the directory it
 * sits in, so a caller cannot reach another file by pairing a real directory with any name.
 */
function attachmentPath(storedPath: string): string {
  const [, prefix, sha] = ATTACHMENT_PATH.exec(storedPath) ?? [];
  if (prefix === undefined || sha === undefined || !sha.startsWith(prefix)) {
    throw new PathEscapeError('not an attachment path');
  }
  return storedPath;
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

/** Turns ELOOP from O_NOFOLLOW (final component is a symlink) into PathEscapeError. */
function mapOpenError(err: unknown, relPath: string): never {
  if (isErrno(err, 'ELOOP')) throw new PathEscapeError(`symlink not allowed: ${relPath}`);
  throw err;
}

/**
 * Resolves relPath against root: joined, checked lexically, then each existing component
 * lstat'ed and any symlink (even one pointing back inside) rejected, so neither `..` nor a
 * planted link can reach outside it. Shared by both of createStorage's roots (DATA_DIR and
 * SQLITE_DIR), so there is exactly one implementation of this confinement to get right.
 */
function confineToRoot(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath === '' || relPath.includes('\0')) {
    throw new PathEscapeError('invalid path');
  }
  if (isAbsolute(relPath)) {
    throw new PathEscapeError('absolute paths are not allowed');
  }
  const candidate = resolve(root, relPath);
  const rel = relative(root, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PathEscapeError(`path escapes its root: ${relPath}`);
  }
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    let st;
    try {
      st = lstatSync(current);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) break; // the rest does not exist yet
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new PathEscapeError(`path traverses a symlink: ${relPath}`);
    }
  }
  return candidate;
}

export function createStorage(dataDir: string, sqliteDir: string): Storage {
  ensureDataDir(dataDir);
  ensureDataDir(sqliteDir);
  const root = realpathSync(dataDir);
  const sqliteRoot = realpathSync(sqliteDir);

  function resolveInsideRoot(relPath: string): string {
    const candidate = confineToRoot(root, relPath);
    // Checked against the normalized relative path, not the raw argument, so an equivalent
    // spelling (./opportun.db, opportun.db with a redundant segment) cannot slip past this.
    const rel = relative(root, candidate);
    if ((DATABASE_FILE_NAMES as readonly string[]).includes(rel)) {
      throw new PathEscapeError(
        `${rel} lives in SQLITE_DIR, not DATA_DIR: use statDatabaseFile, copyDatabaseFile, ` +
          'removeDatabaseFile, restoreDatabaseFile or liveDatabasePath instead',
      );
    }
    return candidate;
  }

  /** The only entry point SQLITE_DIR's three file names resolve through. */
  function resolveSqliteFile(name: DatabaseFileName): string {
    return confineToRoot(sqliteRoot, name);
  }

  /** A top-level TEXT_ROOTS directory itself, or a directory below one. */
  function resolveTextDir(relDir: string): string {
    const abs = resolveInsideRoot(relDir);
    const top = relative(root, abs).split(sep)[0] as string;
    if (!TEXT_ROOTS.has(top)) {
      throw new PathEscapeError(`only backups/ and exports/ are managed here: ${relDir}`);
    }
    return abs;
  }

  /**
   * resolveInsideRoot, then also requires the resolved path to sit strictly below one of
   * TEXT_ROOTS, so text helpers can never touch the database, attachments or anything else.
   */
  function resolveTextPath(relPath: string): string {
    const abs = resolveInsideRoot(relPath);
    const parts = relative(root, abs).split(sep);
    if (parts.length < 2 || !TEXT_ROOTS.has(parts[0] as string)) {
      throw new PathEscapeError(`text files live under backups/ or exports/ only: ${relPath}`);
    }
    return abs;
  }

  async function ensureParentDir(relPath: string): Promise<string> {
    const target = resolveInsideRoot(relPath);
    const parentRel = relative(root, resolve(target, '..'));
    if (parentRel !== '') {
      await mkdir(resolveInsideRoot(parentRel), { recursive: true, mode: 0o700 });
    }
    // Re-check after mkdir: a symlink planted concurrently is caught here.
    return resolveInsideRoot(relPath);
  }

  /** Writes chunks to a temp file beside the target, fsyncs, then renames over it. */
  async function writeAtomic(
    relPath: string,
    chunks: Iterable<Uint8Array> | AsyncIterable<unknown>,
    onChunk?: (buf: Buffer) => void,
  ): Promise<number> {
    const target = await ensureParentDir(relPath);
    const tmp = `${target}.tmp-${randomBytes(8).toString('hex')}`;
    const fh = await open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    let bytes = 0;
    try {
      for await (const chunk of chunks) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        onChunk?.(buf);
        await fh.write(buf);
        bytes += buf.length;
      }
      await fh.sync();
    } catch (err) {
      await fh.close();
      await rm(tmp, { force: true });
      throw err;
    }
    await fh.close();
    try {
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return bytes;
  }

  async function openNoFollow(relPath: string) {
    const abs = resolveInsideRoot(relPath);
    try {
      return await open(abs, constants.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      return mapOpenError(err, relPath);
    }
  }

  return {
    resolveInsideRoot,

    async writeAttachment(data) {
      const hash = createHash('sha256');
      const tmpRel = `attachments/tmp/${randomBytes(16).toString('hex')}`;
      const bytes = await writeAtomic(tmpRel, Buffer.isBuffer(data) ? [data] : data, (buf) =>
        hash.update(buf),
      );
      const sha256 = hash.digest('hex');
      const storedPath = `attachments/${sha256.slice(0, 2)}/${sha256}`;
      const tmpAbs = resolveInsideRoot(tmpRel);
      try {
        const target = await ensureParentDir(storedPath);
        try {
          await lstat(target);
          // Same content already stored: keep the existing file, but bump its mtime (issue
          // #4) so a GC sweep that is mid-decision about this exact path can see it was just
          // referenced again, not only how old it originally is.
          const now = new Date();
          await utimes(target, now, now);
        } catch (err) {
          if (!isErrno(err, 'ENOENT')) throw err;
          await rename(tmpAbs, target);
        }
      } finally {
        await rm(tmpAbs, { force: true });
      }
      return { sha256, storedPath, bytes };
    },

    async openAttachment(storedPath) {
      const fh = await openNoFollow(attachmentPath(storedPath));
      return fh.createReadStream();
    },

    async removeAttachment(storedPath) {
      await rm(resolveInsideRoot(attachmentPath(storedPath)), { force: true });
    },

    async listAttachmentFiles() {
      const out: { storedPath: string; bytes: number; mtimeMs: number }[] = [];
      const attachmentsDir = resolveInsideRoot('attachments');
      let prefixes: string[];
      try {
        prefixes = await readdir(attachmentsDir);
      } catch (err) {
        if (isErrno(err, 'ENOENT')) return [];
        throw err;
      }
      for (const prefix of prefixes) {
        if (!/^[0-9a-f]{2}$/.test(prefix)) continue; // e.g. tmp/, or anything else stray
        const prefixAbs = join(attachmentsDir, prefix);
        let names: string[];
        try {
          names = await readdir(prefixAbs);
        } catch (err) {
          if (isErrno(err, 'ENOENT')) continue;
          throw err;
        }
        for (const name of names) {
          const storedPath = `attachments/${prefix}/${name}`;
          try {
            attachmentPath(storedPath); // same validation openAttachment/removeAttachment use
          } catch {
            continue; // wrong shape, or the prefix does not match this name's own digest
          }
          let st;
          try {
            st = await lstat(join(prefixAbs, name));
          } catch (err) {
            if (isErrno(err, 'ENOENT')) continue; // raced with a delete; not this call's problem
            throw err;
          }
          if (!st.isFile()) continue; // e.g. a directory one level too deep
          out.push({ storedPath, bytes: st.size, mtimeMs: st.mtimeMs });
        }
      }
      return out;
    },

    async attachmentMtime(storedPath) {
      try {
        const st = await lstat(resolveInsideRoot(attachmentPath(storedPath)));
        return st.isFile() ? st.mtimeMs : undefined;
      } catch (err) {
        if (isErrno(err, 'ENOENT')) return undefined;
        throw err;
      }
    },

    async writeText(relPath, text) {
      resolveTextPath(relPath);
      await writeAtomic(relPath, [Buffer.from(text, 'utf8')]);
    },

    async ensureDir(relDir) {
      resolveTextDir(relDir);
      await mkdir(resolveTextDir(relDir), { recursive: true, mode: 0o700 });
      // Re-check: a symlink planted concurrently is caught here.
      resolveTextDir(relDir);
    },

    async listFiles(relDir) {
      const abs = resolveTextDir(relDir);
      let names: string[];
      try {
        names = await readdir(abs);
      } catch (err) {
        if (isErrno(err, 'ENOENT')) return [];
        throw err;
      }
      const out: StoredFile[] = [];
      for (const name of names) {
        const st = await lstat(join(abs, name));
        if (st.isFile()) out.push({ name, bytes: st.size, mtimeMs: st.mtimeMs });
      }
      return out;
    },

    async removeFile(relPath) {
      await rm(resolveTextPath(relPath), { force: true });
    },

    async moveFile(fromRel, toRel) {
      const from = resolveTextPath(fromRel);
      resolveTextPath(toRel);
      const to = await ensureParentDir(toRel);
      try {
        await link(from, to);
      } catch (err) {
        if (isErrno(err, 'EEXIST')) throw new FileExistsError(`already exists: ${toRel}`);
        throw err;
      }
      await rm(from, { force: true });
    },

    liveDatabasePath: resolveSqliteFile,

    async statDatabaseFile(name) {
      const abs = resolveSqliteFile(name);
      try {
        const st = await lstat(abs);
        return { bytes: st.size, mtimeMs: st.mtimeMs };
      } catch (err) {
        if (isErrno(err, 'ENOENT')) return undefined;
        throw err;
      }
    },

    async copyDatabaseFile(name, toDir) {
      const from = resolveSqliteFile(name);
      try {
        await lstat(from);
      } catch (err) {
        if (isErrno(err, 'ENOENT')) return false;
        throw err;
      }
      const destDir = resolveInsideRoot(toDir);
      await mkdir(destDir, { recursive: true, mode: 0o700 });
      const to = resolveInsideRoot(`${toDir}/${name}`);
      try {
        await copyFile(from, to, constants.COPYFILE_EXCL);
      } catch (err) {
        if (isErrno(err, 'EEXIST')) throw new FileExistsError(`already exists: ${toDir}/${name}`);
        throw err;
      }
      return true;
    },

    async removeDatabaseFile(name) {
      await rm(resolveSqliteFile(name), { force: true });
    },

    async restoreDatabaseFile(fromBackupRelPath) {
      const from = resolveTextPath(fromBackupRelPath);
      const to = resolveSqliteFile('opportun.db');
      try {
        await copyFile(from, to, constants.COPYFILE_EXCL);
      } catch (err) {
        if (isErrno(err, 'EEXIST')) {
          throw new FileExistsError('opportun.db already exists; move it aside first');
        }
        throw err;
      }
    },

    async readText(relPath) {
      resolveTextPath(relPath);
      const fh = await openNoFollow(relPath);
      try {
        return await fh.readFile({ encoding: 'utf8' });
      } finally {
        await fh.close();
      }
    },
  };
}

/**
 * Reads an operator-supplied configuration file (e.g. OPPORTUN_MASTER_KEY_FILE) at
 * boot. The path comes from the environment, never from client input.
 */
export function readOperatorFile(absPath: string): string {
  if (!isAbsolute(absPath)) {
    throw new Error('operator file path must be absolute');
  }
  return readFileSync(absPath, 'utf8');
}

/**
 * True when an operator-configured absolute path (e.g. the built SPA's index.html) is a
 * regular file. The path comes from configuration, never from client input.
 */
export function isOperatorFile(absPath: string): boolean {
  if (!isAbsolute(absPath)) return false;
  try {
    return lstatSync(absPath).isFile();
  } catch {
    return false;
  }
}

/**
 * One file from an operator-configured directory as bytes, or undefined when it is not a
 * regular file. For callers that want a single file out of a build output and should not pay
 * for walking the whole tree to get it.
 */
export function readOperatorBytes(absPath: string): Uint8Array | undefined {
  if (!isOperatorFile(absPath)) return undefined;
  try {
    return new Uint8Array(readFileSync(absPath));
  } catch {
    return undefined;
  }
}

/**
 * Every regular file under an operator-configured directory, keyed by its path relative to
 * that directory with forward slashes, as bytes rather than text: the caller is zipping a
 * build output that may hold anything (routes/artifacts.ts). Symlinks are skipped, as
 * everywhere else here. An absent directory reads as {}, which is how an artifacts directory
 * that was never built reports itself.
 */
export function readOperatorTree(absPath: string, maxBytes = Infinity): Record<string, Uint8Array> {
  if (!isAbsolute(absPath)) return {};
  const out: Record<string, Uint8Array> = {};
  let total = 0;
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${name}/`);
      else if (entry.isFile()) {
        const bytes = new Uint8Array(readFileSync(join(dir, entry.name)));
        total += bytes.byteLength;
        // A mis-set directory should fail where someone sees it, not by quietly reading a disk
        // into memory and stalling the process that serves everything else.
        if (total > maxBytes) {
          throw new Error(`operator tree too large: ${absPath} exceeds ${maxBytes} bytes`);
        }
        out[name] = bytes;
      }
    }
  };
  walk(absPath, '');
  return out;
}

/**
 * Size and modification time of an operator-configured absolute path when it is a regular
 * file, else undefined (the copy tool's checks for a running server on the SQLite source).
 */
export function operatorFileStat(absPath: string): { bytes: number; mtimeMs: number } | undefined {
  if (!isAbsolute(absPath)) return undefined;
  try {
    const st = lstatSync(absPath);
    return st.isFile() ? { bytes: st.size, mtimeMs: st.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This process's own mount table (/proc/self/mounts, Linux only), or undefined when it does
 * not exist (macOS, a developer running from source) or cannot be read for any other reason
 * (issue #197: a check that cannot identify the filesystem says nothing, rather than
 * guessing). Not operator-configured like the functions above: the path is fixed and
 * kernel-exposed, the same for every process on a given host, so there is nothing here for a
 * caller to control.
 */
export function readMountTable(): string | undefined {
  try {
    return readFileSync('/proc/self/mounts', 'utf8');
  } catch {
    return undefined;
  }
}

/** Creates the data directory (owner-only permissions) if it does not exist. */
export function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

/**
 * True byte copy (never a link) of one operator-configured absolute path to another;
 * refuses (FileExistsError) rather than overwrite anything already at the destination.
 * Both paths come from configuration, never from client input. Used by the sqlite-dir
 * migration to preserve a pre-migration database file (and its -wal/-shm siblings, one
 * call per file) before anything -- including this process's own integrity check --
 * opens it through SQLite's API: opening a database whose WAL a crash left
 * un-checkpointed can itself trigger WAL recovery, which is a write, and would alter the
 * one copy an operator might later need untouched (#142's restore command found this
 * empirically; the same ordering applies here).
 */
export function copyOperatorFile(fromAbs: string, toAbs: string): void {
  if (!isAbsolute(fromAbs) || !isAbsolute(toAbs)) {
    throw new Error('operator file copy requires absolute paths');
  }
  try {
    copyFileSync(fromAbs, toAbs, constants.COPYFILE_EXCL);
  } catch (err) {
    if (isErrno(err, 'EEXIST')) throw new FileExistsError(`already exists: ${toAbs}`);
    throw err;
  }
}

/**
 * Removes an operator-configured absolute path if present; a no-op when it is already
 * gone. Used by the sqlite-dir migration to clean up a VACUUM INTO target that failed
 * integrity_check, before it could be mistaken for a working database.
 */
export function removeOperatorFile(absPath: string): void {
  if (!isAbsolute(absPath)) {
    throw new Error('operator file remove requires an absolute path');
  }
  rmSync(absPath, { force: true });
}
