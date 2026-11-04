// The rank_deferred_at migration (https://github.com/bgoleno/opportun/issues/214) on an upgrade
// path: a posting a budget refusal left unranked joins the wait, so the budget alone leaves nothing
// unranked; a dismissed one too, so that restoring it finds it waiting (tl on #230). A scored
// result loses any "not ranked" reason (tl on #213). The
// same SQL runs on both engines; each is tested on its own chain. All data is made up.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@opportun/core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, MIGRATIONS_PG_DIR, migrateLockedPg, openDatabase } from '../src/db/client';
import { sqliteOnly } from './db';
import { livePgUrl, withScratchDatabase } from './pgScratch';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opportun-rank-deferred-'));
  temps.push(dir);
  return dir;
}

/** A copy of a migrations folder whose journal stops just before `tag`. */
async function chainBefore(dir: string, tag: string): Promise<string> {
  const partial = await tempDir();
  await cp(dir, partial, { recursive: true });
  const path = join(partial, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(path, 'utf8')) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === tag);
  expect(at, `${tag} is in the journal`).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, at);
  await writeFile(path, JSON.stringify(journal));
  return partial;
}

const CREATED = 1_000;
interface Seed {
  id: string;
  disposition: string;
  score: number | null;
  reason: string | null;
}
const SEEDS: Seed[] = [
  { id: 'waits', disposition: 'pending', score: null, reason: 'budget_exceeded' },
  { id: 'dismissed', disposition: 'dismissed', score: null, reason: 'budget_exceeded' },
  { id: 'outage', disposition: 'pending', score: null, reason: 'provider_error' },
  { id: 'scored-budget', disposition: 'pending', score: 70, reason: 'budget_exceeded' },
  { id: 'scored-outage', disposition: 'pending', score: 70, reason: 'provider_error' },
  { id: 'plain', disposition: 'pending', score: 80, reason: null },
];
const EXPECTED = [
  { id: 'dismissed', deferred: CREATED, reason: null },
  { id: 'outage', deferred: null, reason: 'provider_error' },
  { id: 'plain', deferred: null, reason: null },
  { id: 'scored-budget', deferred: null, reason: null },
  { id: 'scored-outage', deferred: null, reason: null },
  { id: 'waits', deferred: CREATED, reason: null },
];

describe.runIf(sqliteOnly)('0047 on SQLite', () => {
  it('moves a pending budget refusal to the wait, and clears a scored result’s reason', async () => {
    const partial = await chainBefore(MIGRATIONS_DIR, '0047_discovery_rank_deferred');
    const dataDir = await tempDir();
    const old = new Database(join(dataDir, 'opportun.db'));
    migrate(drizzle(old), { migrationsFolder: partial });
    const userId = newId();
    old
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at)
         VALUES (?, ?, 'U', 'x', 1, 1)`,
      )
      .run(userId, `${userId}@example.com`);
    old
      .prepare(
        `INSERT INTO discovery_sources (id, user_id, kind, config, created_at, updated_at)
         VALUES ('s1', ?, 'manual', '{}', 1, 1)`,
      )
      .run(userId);
    old
      .prepare(
        `INSERT INTO discovery_runs (id, user_id, source_id, started_at) VALUES ('r1', ?, 's1', 1)`,
      )
      .run(userId);
    const insert = old.prepare(
      `INSERT INTO discovery_results (id, user_id, run_id, posting, ai_score, rank_skip_reason,
         resolution, disposition, created_at, updated_at)
       VALUES (?, ?, 'r1', '{}', ?, ?, 'full', ?, ${CREATED}, ${CREATED})`,
    );
    for (const s of SEEDS) insert.run(s.id, userId, s.score, s.reason, s.disposition);
    old.close();

    const { sqlite } = openDatabase(dataDir);
    try {
      const rows = sqlite
        .prepare(
          `SELECT id, rank_deferred_at AS deferred, rank_skip_reason AS reason
             FROM discovery_results ORDER BY id`,
        )
        .all();
      expect(rows).toEqual(EXPECTED);
    } finally {
      sqlite.close();
    }
  });
});

describe.runIf(livePgUrl !== undefined)('0029 on Postgres (live)', () => {
  it('moves a pending budget refusal to the wait, and clears a scored result’s reason', async () => {
    const partial = await chainBefore(MIGRATIONS_PG_DIR, '0029_discovery_rank_deferred');
    await withScratchDatabase(async (url) => {
      const pool = new pg.Pool({ connectionString: url, max: 2 });
      try {
        await migrateLockedPg(pool, partial);
        const userId = newId();
        await pool.query(
          `INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at)
           VALUES ($1, $2, 'x', 'U', 1, 1)`,
          [userId, `${userId}@example.com`],
        );
        await pool.query(
          `INSERT INTO discovery_sources (id, user_id, kind, config, created_at, updated_at)
           VALUES ('s1', $1, 'manual', '{}', 1, 1)`,
          [userId],
        );
        await pool.query(
          `INSERT INTO discovery_runs (id, user_id, source_id, started_at) VALUES ('r1', $1, 's1', 1)`,
          [userId],
        );
        for (const s of SEEDS) {
          await pool.query(
            `INSERT INTO discovery_results (id, user_id, run_id, posting, ai_score, rank_skip_reason,
               resolution, disposition, created_at, updated_at)
             VALUES ($1, $2, 'r1', '{}', $3, $4, 'full', $5, ${CREATED}, ${CREATED})`,
            [s.id, userId, s.score, s.reason, s.disposition],
          );
        }

        await migrateLockedPg(pool);

        const { rows } = await pool.query(
          `SELECT id, rank_deferred_at::int AS deferred, rank_skip_reason AS reason
             FROM discovery_results ORDER BY id`,
        );
        expect(rows).toEqual(EXPECTED);
      } finally {
        await pool.end();
      }
    });
  });
});
