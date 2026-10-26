import { newId } from '@opportun/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../src/db/client';
import { exec, listTables, queryAll, queryOne, sqliteOnly } from './db';
import { openTestDb } from './helpers';

/** Constraint errors as each engine words them (SQLite, then Postgres). */
const UNIQUE = /UNIQUE constraint failed|duplicate key value violates unique constraint/;
const FOREIGN_KEY = /FOREIGN KEY constraint failed|violates foreign key constraint/;

const EXPECTED_TABLES = [
  'activities',
  'attachments',
  'audit_log',
  'communications',
  'companies',
  'contacts',
  'device_tokens',
  'discovery_results',
  'discovery_runs',
  'discovery_sources',
  'dismissal_feedback',
  'jobs',
  'mail_filter_rules',
  'next_steps',
  'oauth_accounts',
  'opportunities',
  'opportunity_dedupe_candidates',
  'profiles',
  'prompts',
  'resume_match_reports',
  'resume_rules',
  'resumes',
  'role_targets',
  'secrets',
  'sessions',
  'settings',
  'stage_history',
  'sync_state',
  'tailoring_sessions',
  'task_runs',
  'users',
];

// Tables that hold one user's data must carry user_id NOT NULL with an index.
const USER_DATA_TABLES = EXPECTED_TABLES.filter(
  (t) => !['users', 'jobs', 'settings', 'audit_log', 'prompts'].includes(t),
);

const NOW = 1_760_000_000_000;

describe('database schema', () => {
  let h: DbHandle;
  let opened: Awaited<ReturnType<typeof openTestDb>>;

  beforeEach(async () => {
    opened = await openTestDb();
    h = opened.handle;
  });
  afterEach(async () => {
    await opened.close();
  });

  async function insertUser(email = `u${newId()}@example.com`): Promise<string> {
    const id = newId();
    await exec(
      h,
      `INSERT INTO users (id, email, password_hash, display_name, is_admin, created_at, updated_at)
         VALUES (?, ?, 'x', 'U', FALSE, ?, ?)`,
      id,
      email,
      NOW,
      NOW,
    );
    return id;
  }

  it('creates every expected table and nothing else', async () => {
    // search_index (and on SQLite its FTS5 shadow tables) is checked separately below.
    const tables = (await listTables(h)).filter(
      (t) =>
        !t.startsWith('sqlite_') && !t.startsWith('__drizzle') && !t.startsWith('search_index'),
    );
    expect(tables).toEqual(EXPECTED_TABLES);
  });

  it.runIf(!sqliteOnly)(
    'creates the search_index tsvector table (drizzle-pg 0001_search)',
    async () => {
      const cols = await queryAll<{ column_name: string; data_type: string }>(
        h,
        `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'search_index' ORDER BY ordinal_position`,
      );
      expect(cols.map((c) => `${c.column_name}:${c.data_type}`)).toEqual([
        'entity_kind:text',
        'entity_id:text',
        'user_id:text',
        'text:text',
        'tsv:tsvector',
      ]);
      const indexes = await queryAll<{ indexname: string; indexdef: string }>(
        h,
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'search_index' ORDER BY indexname`,
      );
      expect(indexes.map((i) => i.indexname)).toEqual(['search_index_pk', 'search_index_tsv_idx']);
      expect(indexes[1]?.indexdef).toMatch(/USING gin \(tsv\)/);
    },
  );

  it.runIf(sqliteOnly)('creates the search_index FTS5 virtual table (0001_fts)', async () => {
    const row = (await queryOne(h, `SELECT sql FROM sqlite_master WHERE name = 'search_index'`)) as
      { sql: string } | undefined;
    expect(row?.sql).toMatch(/CREATE VIRTUAL TABLE `search_index` USING fts5/);
    const shadows = (await queryAll(
      h,
      `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name LIKE 'search_index_%' ORDER BY name`,
    )) as { name: string }[];
    expect(shadows.map((r) => r.name)).toEqual([
      'search_index_config',
      'search_index_content',
      'search_index_data',
      'search_index_docsize',
      'search_index_idx',
    ]);
  });

  it('is idempotent: reopening applies no migration twice', async () => {
    const before = (await queryOne(h, 'SELECT count(*) AS n FROM __drizzle_migrations')) as {
      n: number;
    };
    h = await opened.reopen();
    const n = (await queryOne(h, 'SELECT count(*) AS n FROM __drizzle_migrations')) as {
      n: number;
    };
    expect(n.n).toBeGreaterThanOrEqual(1);
    expect(n.n).toBe(before.n);
  });

  it.runIf(sqliteOnly).each(USER_DATA_TABLES)(
    '%s has an indexed NOT NULL user_id',
    async (table) => {
      const cols = await queryAll<{ name: string; notnull: number; pk: number }>(
        h,
        'SELECT name, "notnull", pk FROM pragma_table_info(?)',
        table,
      );
      const userId = cols.find((c) => c.name === 'user_id');
      expect(userId, `${table}.user_id`).toBeDefined();
      expect(userId?.notnull === 1 || userId?.pk !== 0).toBe(true);
      const leading = await queryAll<{ name: string }>(
        h,
        `SELECT i.name FROM pragma_index_list(?) AS l, pragma_index_info(l.name) AS i
        WHERE i.seqno = 0`,
        table,
      );
      const indexed = leading.some((c) => c.name === 'user_id');
      expect(indexed, `${table} user_id index`).toBe(true);
    },
  );

  it.runIf(sqliteOnly)(
    'jobs has exactly two unique indexes: the primary key and the unfinished-dedupe one',
    async () => {
      // enqueue's ON CONFLICT names this partial index (review fix 6); a new unique index on
      // jobs would need its own conflict handling there.
      const unique = await queryAll<{ name: string; origin: string; partial: number }>(
        h,
        'SELECT name, origin, partial FROM pragma_index_list(\'jobs\') WHERE "unique" = 1 ORDER BY name',
      );
      expect(unique.map((u) => ({ origin: u.origin, partial: u.partial }))).toEqual([
        { origin: 'c', partial: 1 },
        { origin: 'pk', partial: 0 },
      ]);
      expect(unique[0]!.name).toBe('jobs_unfinished_dedupe_uq');
      const cols = await queryAll<{ name: string }>(
        h,
        "SELECT name FROM pragma_index_info('jobs_unfinished_dedupe_uq') ORDER BY seqno",
      );
      expect(cols.map((c) => c.name)).toEqual(['kind', 'dedupe_key']);
    },
  );

  it('rejects a second communication with the same (user_id, channel, external_id)', async () => {
    const userId = await insertUser();
    const insert = async (...params: unknown[]) =>
      await exec(
        h,
        `INSERT INTO communications (id, user_id, channel, external_id, "from", "to", sent_at, needs_review, created_at, updated_at)
         VALUES (?, ?, 'gmail', 'msg-1', 'r@example.com', '[]', ?, FALSE, ?, ?)`,
        ...params,
      );
    await insert(newId(), userId, NOW, NOW, NOW);
    await expect(insert(newId(), userId, NOW, NOW, NOW)).rejects.toThrow(UNIQUE);
    // Same external id on another channel is a different message.
    await exec(
      h,
      `INSERT INTO communications (id, user_id, channel, external_id, "from", "to", sent_at, needs_review, created_at, updated_at)
         VALUES (?, ?, 'linkedin', 'msg-1', 'r@example.com', '[]', ?, FALSE, ?, ?)`,
      newId(),
      userId,
      NOW,
      NOW,
      NOW,
    );
    // Another user's mailbox may hold the same external id; it must not collide.
    await insert(newId(), await insertUser(), NOW, NOW, NOW);
  });

  it('rejects a duplicate email', async () => {
    await insertUser('dup@example.com');
    await expect(insertUser('dup@example.com')).rejects.toThrow(UNIQUE);
  });

  it('enforces opportunities (user_id, dedupe_key) only when dedupe_key is set', async () => {
    const userId = await insertUser();
    const companyId = newId();
    await exec(
      h,
      `INSERT INTO companies (id, user_id, name, status, created_at, updated_at) VALUES (?, ?, 'Acme', 'none', ?, ?)`,
      companyId,
      userId,
      NOW,
      NOW,
    );
    const insert = async (...params: unknown[]) =>
      await exec(
        h,
        `INSERT INTO opportunities (id, user_id, company_id, title, source_kind, stage, priority, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, 'PM', 'manual', 'discovered', 2, ?, ?, ?)`,
        ...params,
      );
    await insert(newId(), userId, companyId, null, NOW, NOW);
    await insert(newId(), userId, companyId, null, NOW, NOW);
    await insert(newId(), userId, companyId, 'acme|pm|', NOW, NOW);
    await expect(insert(newId(), userId, companyId, 'acme|pm|', NOW, NOW)).rejects.toThrow(UNIQUE);
  });

  it('enforces prompts (task_key, version, user_id) including system defaults', async () => {
    const userId = await insertUser();
    const insert = async (...params: unknown[]) =>
      await exec(
        h,
        `INSERT INTO prompts (id, user_id, task_key, name, body, version, is_active, created_at, updated_at)
         VALUES (?, ?, 'test.unseeded', 'Default', 'body', 1, TRUE, ?, ?)`,
        ...params,
      );
    await insert(newId(), null, NOW, NOW);
    await expect(insert(newId(), null, NOW, NOW)).rejects.toThrow(UNIQUE);
    await insert(newId(), userId, NOW, NOW);
    await expect(insert(newId(), userId, NOW, NOW)).rejects.toThrow(UNIQUE);
  });

  it('defaults dismissal_feedback.kind to dismissal', async () => {
    const userId = await insertUser();
    const id = newId();
    await exec(
      h,
      `INSERT INTO dismissal_feedback (id, user_id, reason, at) VALUES (?, ?, 'seniority', ?)`,
      id,
      userId,
      NOW,
    );
    const row = (await queryOne(h, 'SELECT kind FROM dismissal_feedback WHERE id = ?', id)) as {
      kind: string;
    };
    expect(row.kind).toBe('dismissal');
  });

  it('enforces foreign keys', async () => {
    await expect(
      exec(
        h,
        `INSERT INTO companies (id, user_id, name, status, created_at, updated_at) VALUES (?, ?, 'Acme', 'none', ?, ?)`,
        newId(),
        newId(),
        NOW,
        NOW,
      ),
    ).rejects.toThrow(FOREIGN_KEY);
  });
});
