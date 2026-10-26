import { describe, expect, it, vi } from 'vitest';
import { checkSqliteFilesystem, detectFilesystemHazard } from '../src/lib/sqliteFilesystem';
import { readMountTable } from '../src/lib/storage';

vi.mock('../src/lib/storage', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/storage')>();
  return { ...real, readMountTable: vi.fn() };
});

const PATH = '/data/opportun.db';

/** `/proc/mounts`-shaped text: one fabricated table per test, as the issue's own testing
 *  guidance asks for, rather than an integration test needing a real NFS share or container. */
function mounts(...lines: string[]): string {
  return lines.join('\n');
}

describe('detectFilesystemHazard', () => {
  it('warns on the real Docker Desktop for Mac bridge (virtiofs), captured from a live container', () => {
    const table = mounts(
      'overlay / overlay ro,relatime,lowerdir=/a:/b,upperdir=/c,workdir=/d,nouserxattr 0 0',
      'virtiofs0 /data virtiofs rw,nosuid,nodev,relatime,ignore_atime,no_xattr 0 0',
    );
    const hazard = detectFilesystemHazard(table, PATH);
    expect(hazard?.fsType).toBe('virtiofs');
    expect(hazard?.message).toContain('virtiofs');
    expect(hazard?.message).toContain('#165');
    expect(hazard?.message).toContain('named Docker volume');
  });

  it('warns on the older gRPC-FUSE bridge name', () => {
    const table = mounts('grpcfuse /data fuse.grpcfuse rw,relatime 0 0');
    expect(detectFilesystemHazard(table, PATH)?.fsType).toBe('fuse.grpcfuse');
  });

  it('warns on a bare fuse mount', () => {
    const table = mounts('sshfs /data fuse rw,relatime 0 0');
    expect(detectFilesystemHazard(table, PATH)?.fsType).toBe('fuse');
  });

  it('warns on NFS, suggesting local storage rather than a named volume', () => {
    const table = mounts('fileserver:/export /data nfs4 rw,relatime 0 0');
    const hazard = detectFilesystemHazard(table, PATH);
    expect(hazard?.fsType).toBe('nfs4');
    expect(hazard?.message).toContain('network filesystem');
    expect(hazard?.message).not.toContain('Docker volume');
  });

  it('warns on an SMB/CIFS share', () => {
    const table = mounts('//server/share /data cifs rw,relatime 0 0');
    expect(detectFilesystemHazard(table, PATH)?.fsType).toBe('cifs');
  });

  it('says nothing on an ordinary Linux install (ext4): do not cry wolf', () => {
    const table = mounts(
      'overlay / overlay ro,relatime 0 0',
      '/dev/vda1 /data ext4 rw,relatime 0 0',
    );
    expect(detectFilesystemHazard(table, PATH)).toBeUndefined();
  });

  it('says nothing for the container root overlay filesystem', () => {
    const table = mounts('overlay / overlay ro,relatime,lowerdir=/a,upperdir=/b 0 0');
    expect(detectFilesystemHazard(table, PATH)).toBeUndefined();
  });

  it('says nothing for a filesystem it does not recognize, rather than guessing', () => {
    const table = mounts('exotic-thing /data zzzfs rw,relatime 0 0');
    expect(detectFilesystemHazard(table, PATH)).toBeUndefined();
  });

  it('says nothing when the path is not under any known mount', () => {
    const table = mounts('virtiofs0 /other virtiofs rw,relatime 0 0');
    expect(detectFilesystemHazard(table, PATH)).toBeUndefined();
  });

  it('picks the longest matching mount point, not the first one', () => {
    // /data is the safe root volume; /data/opportun.db's directory is itself a separate,
    // unsafe mount layered on top of it (an unusual but possible compose setup).
    const table = mounts(
      '/dev/vda1 /data ext4 rw,relatime 0 0',
      'virtiofs0 /data/opportun.db virtiofs rw,relatime 0 0',
    );
    expect(detectFilesystemHazard(table, '/data/opportun.db')?.fsType).toBe('virtiofs');
    expect(detectFilesystemHazard(table, '/data/backups')?.fsType).toBeUndefined();
  });

  it('does not match a mount point that merely shares a prefix string', () => {
    // /data and /database are unrelated: /data must not match a path under /database.
    const table = mounts('virtiofs0 /data virtiofs rw,relatime 0 0');
    expect(detectFilesystemHazard(table, '/database/opportun.db')).toBeUndefined();
  });
});

describe('checkSqliteFilesystem', () => {
  it('says nothing when the mount table cannot be read (no /proc, e.g. macOS)', () => {
    vi.mocked(readMountTable).mockReturnValueOnce(undefined);
    expect(checkSqliteFilesystem(PATH)).toBeUndefined();
  });

  it("reads the process's own mount table (storage.ts) and checks the given path against it", () => {
    vi.mocked(readMountTable).mockReturnValueOnce('virtiofs0 /data virtiofs rw,relatime 0 0');
    expect(checkSqliteFilesystem(PATH)?.fsType).toBe('virtiofs');
  });
});
