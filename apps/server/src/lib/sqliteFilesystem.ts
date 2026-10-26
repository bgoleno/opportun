// Issue #197: nothing told a user running SQLite on a filesystem where WAL's cross-process
// locking is not known to be dependable that they were in that configuration -- the exact
// substrate that corrupted the owner's live database invisibly for weeks (#165, a Docker
// Desktop bind mount). This says what filesystem the database directory was found on and why
// that matters for WAL specifically. It does not predict corruption, and it is not the thing
// watching this instance's actual data for it: dbIntegrityCheck.ts (#181) is that. This is the
// thing that warns about the substrate, once, at boot, before anything has necessarily gone
// wrong.
import { readMountTable } from './storage';

export interface FilesystemHazard {
  fsType: string;
  message: string;
}

type HazardKind = 'fuse-bridge' | 'network';

/**
 * fstype strings, as /proc/mounts reports them, known not to reliably support SQLite's WAL
 * byte-range locking and -shm coordination. A narrow, explicit set on purpose: a denylist of
 * "not ext4" would fire on anything unfamiliar, which is exactly the false positive that
 * trains someone to ignore the warning. An unrecognized filesystem is classified as
 * `undefined` below, rather than guessed at.
 */
function classify(fsType: string): HazardKind | undefined {
  if (fsType === 'virtiofs' || fsType === 'fuse' || fsType.startsWith('fuse.')) {
    return 'fuse-bridge';
  }
  if (fsType === 'cifs' || fsType.startsWith('nfs') || fsType.startsWith('smb')) {
    return 'network';
  }
  return undefined;
}

function hazardMessage(fsType: string, kind: HazardKind): string {
  const why =
    "SQLite's WAL journal mode depends on reliable byte-range locking and -shm shared-memory " +
    'coordination across processes, which this kind of filesystem is not known to provide ' +
    'consistently (the same class of substrate behind issue #165: a live database corrupted ' +
    'invisibly for weeks on a Docker Desktop bind mount).';
  const fix =
    kind === 'fuse-bridge'
      ? 'Move the database onto a named Docker volume instead of a bind mount (issue #179).'
      : 'Move the database onto local or block storage; a network filesystem is not a safe ' +
        'home for it, regardless of how it is mounted.';
  return `The database directory is on a ${fsType} filesystem. ${why} ${fix}`;
}

interface MountEntry {
  mountPoint: string;
  fsType: string;
}

/**
 * One entry per line of a mount table in /proc/mounts format (device, mount point, fstype,
 * options, two numbers). A mount point containing a space is octal-escaped (`\040`) in the
 * real file; unescaped here before comparison.
 */
function parseMounts(mountsText: string): MountEntry[] {
  return mountsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split(' ');
      return { mountPoint: (fields[1] ?? '').replace(/\\040/g, ' '), fsType: fields[2] ?? '' };
    })
    .filter((entry) => entry.mountPoint.length > 0);
}

/** The mount entry that actually governs `path`: the longest mount point that is a prefix of
 *  it, the same rule the kernel itself uses to resolve overlapping mounts. */
function findMount(mounts: MountEntry[], path: string): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const entry of mounts) {
    const prefix = entry.mountPoint.endsWith('/') ? entry.mountPoint : `${entry.mountPoint}/`;
    const matches = path === entry.mountPoint || path.startsWith(prefix);
    if (matches && (best === undefined || entry.mountPoint.length > best.mountPoint.length)) {
      best = entry;
    }
  }
  return best;
}

/**
 * Whether `path` sits on a filesystem known to be unsafe for SQLite's WAL locking, given the
 * raw text of a mount table. Pure and synchronous so it can be tested against a fabricated
 * table (issue #197's own suggestion) without a real NFS share or container.
 */
export function detectFilesystemHazard(
  mountsText: string,
  path: string,
): FilesystemHazard | undefined {
  const mount = findMount(parseMounts(mountsText), path);
  if (mount === undefined) return undefined;
  const kind = classify(mount.fsType);
  if (kind === undefined) return undefined;
  return { fsType: mount.fsType, message: hazardMessage(mount.fsType, kind) };
}

/**
 * Reads this process's own mount table (storage.ts's readMountTable, the one place the server
 * is allowed to touch the filesystem) and checks `path` against it. undefined when the table
 * cannot be read at all (macOS, a developer running from source) or says nothing about `path`.
 */
export function checkSqliteFilesystem(path: string): FilesystemHazard | undefined {
  const mountsText = readMountTable();
  if (mountsText === undefined) return undefined;
  return detectFilesystemHazard(mountsText, path);
}
