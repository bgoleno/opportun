// Nightly backups (FR-I4): openable snapshots, retention, confinement, the nightly schedule
// and a restore of a snapshot into a fresh data directory.
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/client';
import { jobs, settings } from '../src/db/schema';
import {
  BACKUP_JOB_KIND,
  BACKUP_RETENTION,
  listBackups,
  MANUAL_BACKUP_DEDUPE_KEY,
  runBackup,
  snapshotName,
  verifySnapshot,
} from '../src/jobs/backup';
import { cancelJob, enqueue, materializeSchedules, nextOccurrence } from '../src/jobs/runner';
import { PathEscapeError } from '../src/lib/storage';
import { checkSqliteFilesystem } from '../src/lib/sqliteFilesystem';
import { useApi } from './api';
import { sqliteOnly } from './db';
import { testApp } from './helpers';

// issue #197: only the "surfaces the boot-time hazard" test below cares what this returns;
// every other test in this file needs it to stay out of the way, so the default is the real
// "nothing to report" answer the function itself gives when it cannot identify a filesystem.
vi.mock('../src/lib/sqliteFilesystem', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/sqliteFilesystem')>();
  return { ...real, checkSqliteFilesystem: vi.fn().mockReturnValue(undefined) };
});

const boot = useApi();

function countUsers(file: string): number {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    return (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe.runIf(sqliteOnly)('backups', () => {
  it('writes an openable sqlite snapshot containing users, plus an attachments manifest', async () => {
    const { app, dataDir, a } = await boot();
    const opp = await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { companyName: 'Acme', title: 'Engineer', sourceKind: 'manual' },
    });
    const boundary = '----opportunbackup';
    const upload = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${opp.json().id}/attachments`,
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cv.txt"\r\n` +
          `Content-Type: text/plain\r\n\r\nhello backup\r\n--${boundary}--\r\n`,
      ),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(upload.statusCode).toBe(201);

    const now = Date.UTC(2026, 9, 15, 3, 0);
    const result = await runBackup(app.db, app.storage, now);
    expect(result.file).toBe('opportun-20261015-0300.db');
    expect(result.bytes).toBeGreaterThan(0);

    const file = join(dataDir, 'backups', result.file);
    expect(countUsers(file)).toBe(2);
    const manifest = JSON.parse(
      await readFile(join(dataDir, 'backups', 'opportun-20261015-0300.attachments.json'), 'utf8'),
    );
    expect(manifest.snapshot).toBe(result.file);
    const sha = upload.json().sha256 as string;
    expect(manifest.attachments).toEqual([
      { storedPath: `attachments/${sha.slice(0, 2)}/${sha}`, sha256: sha, bytes: 12 },
    ]);
    // No temp files are left behind.
    expect((await readdir(join(dataDir, 'backups'))).sort()).toEqual([
      'opportun-20261015-0300.attachments.json',
      'opportun-20261015-0300.db',
      'opportun-20261015-0300.verify.json',
    ]);
    // The snapshot verified clean (issue #170), not just written.
    expect(result.verified).toEqual({ ok: true, checkedAt: expect.any(Number), detail: null });
  });

  it('verifySnapshot catches a corrupt file, not just a missing or unreadable one (#170)', async () => {
    const { app, dataDir } = await boot();
    await app.storage.ensureDir('backups');
    await writeFile(join(dataDir, 'backups', 'opportun-20261015-0300.db'), 'not a database');
    const result = await verifySnapshot(app.storage, 'opportun-20261015-0300.db', 'db', 1000);
    expect(result.ok).toBe(false);
    expect(result.checkedAt).toBe(1000);
    expect(result.detail).toMatch(/file is not a database|file is encrypted/i);
  });

  it('a snapshot that fails verification stays on disk with its failure recorded, and fails the job (#170)', async () => {
    const { app, dataDir } = await boot();
    const now = Date.UTC(2026, 9, 15, 3, 0);
    const fakeVerify: typeof verifySnapshot = async (_storage, _file, _kind, checkedAt) => ({
      ok: false,
      checkedAt,
      detail: 'simulated corruption',
    });
    await expect(runBackup(app.db, app.storage, now, fakeVerify)).rejects.toThrow(
      /backup verification failed.*simulated corruption/,
    );
    // Not deleted: a corrupt snapshot that vanished on its own would be exactly as invisible
    // as the one issue #170 was filed over.
    const names = (await readdir(join(dataDir, 'backups'))).sort();
    expect(names).toContain('opportun-20261015-0300.db');
    expect(names).toContain('opportun-20261015-0300.verify.json');
    const items = await listBackups(app.storage);
    expect(items[0]).toEqual({
      name: 'opportun-20261015-0300.db',
      bytes: expect.any(Number),
      createdAt: expect.any(Number),
      verified: { ok: false, checkedAt: now, detail: 'simulated corruption' },
    });
  });

  it('listBackups reports a snapshot with no verification sidecar as unchecked, not failed', async () => {
    const { app, dataDir } = await boot();
    await app.storage.ensureDir('backups');
    await writeFile(join(dataDir, 'backups', 'opportun-20261001-0300.db'), 'placeholder');
    const items = await listBackups(app.storage);
    expect(items[0]!.verified).toBeNull();
  });

  it('a snapshot restores into a fresh data directory (the documented restore)', async () => {
    const { app, dataDir } = await boot();
    const { file } = await runBackup(app.db, app.storage);
    const restored = await mkdtemp(join(tmpdir(), 'opportun-restore-'));
    try {
      await copyFile(join(dataDir, 'backups', file), join(restored, 'opportun.db'));
      const { sqlite } = openDatabase(restored);
      try {
        const n = sqlite.prepare('SELECT count(*) AS n FROM users').get() as { n: number };
        expect(n.n).toBe(2);
      } finally {
        sqlite.close();
      }
    } finally {
      await rm(restored, { recursive: true, force: true });
    }
  });

  it('prunes to the 14 newest snapshots by modification time, with their manifests', async () => {
    const { app, dataDir } = await boot();
    const dir = join(dataDir, 'backups');
    await mkdir(dir, { recursive: true });
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 16; i++) {
      const name = snapshotName(base + i * 86_400_000);
      await writeFile(join(dir, name), 'old');
      await writeFile(join(dir, name.replace('.db', '.attachments.json')), '{}');
      const t = new Date(base + i * 86_400_000);
      await utimes(join(dir, name), t, t);
    }
    await writeFile(join(dir, 'notes.txt'), 'not a snapshot');

    const result = await runBackup(app.db, app.storage, Date.UTC(2026, 9, 15, 3, 0));
    const left = await listBackups(app.storage);
    expect(left).toHaveLength(BACKUP_RETENTION);
    expect(left[0]!.name).toBe(result.file);
    // The newest 13 old ones survive; the 3 oldest are gone.
    expect(result.pruned.sort()).toEqual(
      [0, 1, 2].map((i) => snapshotName(base + i * 86_400_000)).sort(),
    );
    const names = await readdir(dir);
    for (const gone of result.pruned) {
      expect(names).not.toContain(gone);
      expect(names).not.toContain(gone.replace('.db', '.attachments.json'));
    }
    expect(names).toContain('notes.txt');
  });

  it('recognizes a same-minute-collision suffix for listing and pruning, like any snapshot', async () => {
    const { app, dataDir } = await boot();
    const dir = join(dataDir, 'backups');
    await mkdir(dir, { recursive: true });
    const base = Date.UTC(2026, 0, 1);
    // The oldest file is a suffixed one (as if it had collided the day it was written):
    // an unrecognized name here would either never be pruned (kept forever) or, worse,
    // never show up as a backup at all.
    const oldestSuffixed = snapshotName(base).replace('.db', '-2.db');
    for (let i = 0; i < 16; i++) {
      const name = i === 0 ? oldestSuffixed : snapshotName(base + i * 86_400_000);
      await writeFile(join(dir, name), 'old');
      await writeFile(join(dir, name.replace('.db', '.attachments.json')), '{}');
      const t = new Date(base + i * 86_400_000);
      await utimes(join(dir, name), t, t);
    }

    const beforePrune = await listBackups(app.storage);
    expect(beforePrune.map((f) => f.name)).toContain(oldestSuffixed);

    const result = await runBackup(app.db, app.storage, Date.UTC(2026, 9, 15, 3, 0));
    expect(result.pruned).toContain(oldestSuffixed);
    const names = await readdir(dir);
    expect(names).not.toContain(oldestSuffixed);
    expect(names).not.toContain('opportun-20260101-0000-2.attachments.json');
  });

  it('never lists a file an external script wrote, whatever it is named (issue #152, #165)', async () => {
    // #165: the owner's own pre-upgrade convenience script (opportun.sh, not part of this
    // repo) takes a live `cp` of the database file, which is not a consistent snapshot under
    // WAL and was found corrupt. It names its output manual-pre-upgrade-<stamp>.db. This
    // app's own "is there a recent backup" check (#152, PurgeCard) trusts listBackups to mean
    // "a snapshot this job actually wrote and moved into place", so a script-produced file
    // satisfying that check would be exactly the true-but-useless signal #152 exists to
    // prevent. It does not: isSnapshotName requires the opportun-<date>-<time> shape this
    // job's own snapshotName() produces, so anything else is invisible to listBackups,
    // whatever its extension, size or recency.
    const { app, dataDir } = await boot();
    const dir = join(dataDir, 'backups');
    await mkdir(dir, { recursive: true });
    const impostor = 'manual-pre-upgrade-20261021-0655.db';
    await writeFile(join(dir, impostor), 'not a real snapshot, just a plausible name');
    const now = new Date();
    await utimes(join(dir, impostor), now, now); // freshly "backed up", by name and mtime alone

    const result = await runBackup(app.db, app.storage, Date.UTC(2026, 9, 15, 3, 0));
    const names = (await listBackups(app.storage)).map((f) => f.name);
    expect(names).not.toContain(impostor);
    expect(names).toContain(result.file);
    // Untouched: this job only prunes what it recognizes as its own.
    expect(await readdir(dir)).toContain(impostor);
  });

  it('keeps backups inside the data directory and refuses a symlinked backups dir', async () => {
    const { app, dataDir } = await boot();
    const root = await realpath(dataDir);
    expect(app.storage.resolveInsideRoot('backups/x.db')).toBe(join(root, 'backups', 'x.db'));
    expect(() => app.storage.resolveInsideRoot('../backups/x.db')).toThrow(PathEscapeError);

    const outside = await mkdtemp(join(tmpdir(), 'opportun-outside-'));
    try {
      await symlink(outside, join(dataDir, 'backups'));
      await expect(runBackup(app.db, app.storage)).rejects.toThrow(PathEscapeError);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('concurrent backups are serialized and both leave valid snapshots', async () => {
    const { app, dataDir } = await boot();
    const t = Date.UTC(2026, 9, 15, 3, 0);
    const [one, two] = await Promise.all([
      runBackup(app.db, app.storage, t),
      runBackup(app.db, app.storage, t + 60_000),
    ]);
    for (const r of [one, two]) expect(countUsers(join(dataDir, 'backups', r.file))).toBe(2);
    // Same minute: neither snapshot replaces the other. The second gets a distinct name.
    const [three, four] = await Promise.all([
      runBackup(app.db, app.storage, t + 120_000),
      runBackup(app.db, app.storage, t + 120_000),
    ]);
    expect(three.file).not.toBe(four.file);
    for (const r of [three, four]) expect(countUsers(join(dataDir, 'backups', r.file))).toBe(2);
    expect((await readdir(join(dataDir, 'backups'))).filter((n) => n.startsWith('.tmp'))).toEqual(
      [],
    );
  });

  it('two backups in the same minute both survive, neither silently overwritten', async () => {
    const { app, dataDir } = await boot();
    const now = Date.UTC(2026, 9, 15, 3, 0);
    const first = await runBackup(app.db, app.storage, now);
    const second = await runBackup(app.db, app.storage, now);
    expect(first.file).toBe('opportun-20261015-0300.db');
    expect(second.file).toBe('opportun-20261015-0300-2.db');
    expect(countUsers(join(dataDir, 'backups', first.file))).toBe(2);
    expect(countUsers(join(dataDir, 'backups', second.file))).toBe(2);
    const files = await readdir(join(dataDir, 'backups'));
    expect(files).toContain(first.file);
    expect(files).toContain(second.file);
    expect(files).toContain('opportun-20261015-0300.attachments.json');
    expect(files).toContain('opportun-20261015-0300-2.attachments.json');
  });

  it('a backup enqueued while another is unfinished is deduplicated', async () => {
    const { app } = await boot();
    const first = await enqueue(app.db, 'backup', {}, { dedupeKey: MANUAL_BACKUP_DEDUPE_KEY });
    const second = await enqueue(app.db, 'backup', {}, { dedupeKey: MANUAL_BACKUP_DEDUPE_KEY });
    expect(second).toBe(first);
    expect(await app.db.select().from(jobs).where(eq(jobs.kind, 'backup')).all()).toHaveLength(1);
  });

  it('seeds the nightly 0 3 * * * schedule and the scheduler queues the next 3:00 run', async () => {
    const { app, dataDir } = await boot();
    const row = await app.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'schedule:backup'))
      .get();
    expect(row?.value).toEqual({ cron: '0 3 * * *', enabled: true });
    const now = Date.now();
    await materializeSchedules(app.db, now);
    const pending = await app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, 'backup'), eq(jobs.status, 'pending')))
      .all();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.runAt).toBe(nextOccurrence('0 3 * * *', now));
    expect(new Date(pending[0]!.runAt).getHours()).toBe(3);

    // Running it (as the runner would at 3:00) writes a snapshot and queues tomorrow's.
    await app.db.update(jobs).set({ runAt: now }).where(eq(jobs.id, pending[0]!.id)).run();
    await app.jobs.drain();
    expect(
      (await app.db.select().from(jobs).where(eq(jobs.id, pending[0]!.id)).get())!.status,
    ).toBe('done');
    expect((await readdir(join(dataDir, 'backups'))).some((n) => n.endsWith('.db'))).toBe(true);
    const next = await app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, 'backup'), eq(jobs.status, 'pending')))
      .all();
    expect(next).toHaveLength(1);
  });

  it('lists backups and runs one on demand for the admin only', async () => {
    const { app, a, b } = await boot();
    expect((await b.request({ method: 'GET', url: '/api/v1/backups' })).statusCode).toBe(403);
    expect((await b.request({ method: 'POST', url: '/api/v1/backups' })).statusCode).toBe(403);

    const queued = await a.request({ method: 'POST', url: '/api/v1/backups' });
    expect(queued.statusCode).toBe(202);
    await app.jobs.drain();
    const list = await a.request({ method: 'GET', url: '/api/v1/backups' });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual({
      name: expect.stringMatching(/^opportun-\d{8}-\d{4}\.db$/),
      bytes: expect.any(Number),
      createdAt: expect.any(Number),
      verified: { ok: true, checkedAt: expect.any(Number), detail: null },
    });
    expect(body.schedule).toEqual({ cron: '0 3 * * *', enabled: true });
    // No scheduled live check has run yet in this test.
    expect(body.liveCheck).toBeNull();
    // No filesystem hazard on an ordinary test run.
    expect(body.filesystemHazard).toBeNull();
    // Nothing has failed in this test.
    expect(body.lastBackupFailure).toBeNull();
  });

  // Issue #241: before this, a backup that had exhausted its retries was invisible from this
  // page, the only record sitting at Settings -> Jobs where nothing points an admin back here.
  it('surfaces a dead backup job here, not only at Settings -> Jobs (issue #241)', async () => {
    const { app, a } = await boot();
    const id = await enqueue(app.db, BACKUP_JOB_KIND, {}, { dedupeKey: MANUAL_BACKUP_DEDUPE_KEY });
    await cancelJob(
      app.db,
      id,
      'pg_dump exited with status 1: server closed the connection unexpectedly',
    );

    const list = await a.request({ method: 'GET', url: '/api/v1/backups' });
    expect(list.json().lastBackupFailure).toEqual({
      failedAt: expect.any(Number),
      attempts: 0,
      detail: 'pg_dump exited with status 1: server closed the connection unexpectedly',
    });
  });

  it.runIf(sqliteOnly)(
    'surfaces a filesystem hazard found at boot, next to the other trust signals (issue #197)',
    async () => {
      const hazard = { fsType: 'virtiofs', message: 'test hazard message' };
      vi.mocked(checkSqliteFilesystem).mockReturnValueOnce(hazard);
      const { a } = await boot();
      const list = await a.request({ method: 'GET', url: '/api/v1/backups' });
      expect(list.json().filesystemHazard).toEqual(hazard);
    },
  );

  it.runIf(sqliteOnly)(
    'checks sqliteDir, not dataDir, once the two are split (issue #179, #197)',
    async () => {
      // The whole point of this check is catching exactly this case: a database moved onto
      // safe storage while dataDir (attachments, backups, master.key) is still on something
      // unsafe, or the other way around. Checking the wrong one of the two either misses a
      // real hazard or warns about one that no longer applies.
      vi.mocked(checkSqliteFilesystem).mockReturnValueOnce(undefined);
      const sqliteDir = await mkdtemp(join(tmpdir(), 'opportun-sqlitedir-test-'));
      const { app } = await testApp({ sqliteDir });
      try {
        // liveDatabasePath resolves through realpath (storage.ts's symlink-confinement
        // walk), which on macOS differs from the raw mkdtemp path (/var is a symlink to
        // /private/var); resolve the same way before comparing.
        expect(vi.mocked(checkSqliteFilesystem)).toHaveBeenCalledWith(
          join(await realpath(sqliteDir), 'opportun.db'),
        );
      } finally {
        await app.close();
        await rm(sqliteDir, { recursive: true, force: true });
      }
    },
  );
});
