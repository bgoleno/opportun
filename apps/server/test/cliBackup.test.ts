// The backup CLI (issue #142, the mirror of restore): a scriptable "take a backup right now"
// for right before an upgrade, so the only safe path is the one jobs/backup.ts already
// guarantees (VACUUM INTO / pg_dump), not a plain `cp` of a live database (issue #165).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli/backup';
import { useApi } from './api';
import { sqliteOnly, testDialect } from './db';

const boot = useApi();

describe.runIf(sqliteOnly)('backup CLI', () => {
  it('writes a snapshot through the same runBackup the job and the UI use, and reports it', async () => {
    const { app, dataDir } = await boot();
    const out: string[] = [];
    const now = Date.UTC(2026, 9, 21, 7, 0);
    const code = await main({
      db: app.db,
      storage: app.storage,
      now,
      io: { stdout: (l) => out.push(l), stderr: (l) => out.push(`ERR: ${l}`) },
    });
    expect(code).toBe(0);
    expect(out[0]).toContain('Wrote backups/opportun-20261021-0700.db');
    // issue #205: the silent-success gap this closes -- verification already ran (runBackup
    // would have thrown otherwise), so say so, not just not complain.
    expect(out[0]).toMatch(/verified/i);
    const file = join(dataDir, 'backups', 'opportun-20261021-0700.db');
    await expect(readFile(file)).resolves.toBeInstanceOf(Buffer);
  });

  it('exits nonzero and reports the failure, without throwing, when the backup itself fails', async () => {
    const { app } = await boot();
    const brokenStorage: typeof app.storage = {
      ...app.storage,
      writeText: () => {
        throw new Error('disk full');
      },
    };
    const out: string[] = [];
    const code = await main({
      db: app.db,
      storage: brokenStorage,
      io: { stdout: (l) => out.push(l), stderr: (l) => out.push(`ERR: ${l}`) },
    });
    expect(code).toBe(1);
    expect(out.some((l) => l.includes('ERR:') && l.includes('disk full'))).toBe(true);
  });
});

describe.runIf(testDialect === 'postgres')('backup CLI (Postgres wording, issue #205)', () => {
  it('names the weaker guarantee honestly: table of contents only, not row data', async () => {
    const { app } = await boot();
    const out: string[] = [];
    const code = await main({
      db: app.db,
      storage: app.storage,
      io: { stdout: (l) => out.push(l), stderr: (l) => out.push(`ERR: ${l}`) },
    });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/pg_restore --list/);
    expect(out[0]).toMatch(/row data is not read/);
  });
});
