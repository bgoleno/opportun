// The contacts table is renamed network_contacts (issue
// https://github.com/bgoleno/opportun/issues/22) by drizzle/0038_network_contacts.sql and
// drizzle-pg/0020_network_contacts.sql. These tests upgrade a database that already holds
// contacts, and the rows that point at them or at their messages, through the real migrators,
// and compare every row of every table before and after: counts and content, not only that the
// migration ran. Then they check the renamed table's keys still hold and still act.
//
// The SQLite migration replaces a table rebuild drizzle-kit generated (see the SQL file): that
// rebuild, applied by migrateLocked with foreign_keys on, set every communications.contact_id,
// discovery_results.source_communication_id and dismissal_feedback.communication_id to null.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, MIGRATIONS_PG_DIR, migrateLockedPg, openDatabase } from '../src/db/client';
import { sqliteOnly } from './db';
import { livePgUrl, withScratchDatabase } from './pgScratch';

const SQLITE_TAG = '0038_network_contacts';
const PG_TAG = '0020_network_contacts';

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opportun-network-'));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

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

type Row = Record<string, string | number | null>;

const T = 1_790_000_000_000;
const U1 = 'u-1';
const U2 = 'u-2';

/**
 * Rows in the pre-rename schema, parents first. Contacts with every column set and with only
 * the required ones, two users' contacts sharing a name, messages linked to a contact and not,
 * and every row that points at a contact or at a message through a foreign key (a discovery
 * result and a dismissal pointing at a message), plus a referral activity naming a contact in
 * its participants and the contact's search index row.
 */
const SEED: [table: string, rows: Row[]][] = [
  [
    'users',
    [U1, U2].map((id) => ({
      id,
      email: `${id}@example.com`,
      password_hash: 'x',
      display_name: id,
      created_at: T,
      updated_at: T,
    })),
  ],
  [
    'companies',
    [
      { id: 'co-1', user_id: U1, name: 'Initech', created_at: T, updated_at: T },
      { id: 'co-2', user_id: U1, name: 'Globex', created_at: T, updated_at: T },
      { id: 'co-3', user_id: U2, name: 'Initech', created_at: T, updated_at: T },
    ],
  ],
  [
    'contacts',
    [
      {
        id: 'c-1',
        user_id: U1,
        name: 'Ada Lovelace',
        emails: '["ada@example.com","ada@initech.example"]',
        linkedin_url: 'https://www.linkedin.com/in/ada-example/',
        current_company_id: 'co-1',
        history: '[{"company":"Globex","title":"Analyst","from":"2019","to":"2022"}]',
        strength: 3,
        notes: 'Met at a meetup.\nPrefers email; écrit en français aussi.',
        source: 'linkedin_export',
        tags: '["mentor","initech"]',
        created_at: T + 1,
        updated_at: T + 2,
      },
      { id: 'c-2', user_id: U1, name: 'Grace Hopper', created_at: T + 3, updated_at: T + 3 },
      {
        id: 'c-3',
        user_id: U2,
        name: 'Ada Lovelace',
        current_company_id: 'co-3',
        source: 'capture',
        created_at: T + 4,
        updated_at: T + 5,
      },
      {
        id: 'c-4',
        user_id: U1,
        name: 'Linus Example',
        current_company_id: 'co-2',
        strength: 1,
        created_at: T + 6,
        updated_at: T + 6,
      },
    ],
  ],
  [
    'opportunities',
    [
      {
        id: 'o-1',
        user_id: U1,
        company_id: 'co-1',
        title: 'Staff Engineer',
        source_kind: 'manual',
        stage: 'interested',
        created_at: T,
        updated_at: T,
      },
    ],
  ],
  [
    'communications',
    [
      ['m-1', U1, 'c-1', 'o-1'],
      ['m-2', U1, 'c-2', null],
      ['m-3', U1, null, null],
      ['m-4', U2, 'c-3', null],
      ['m-5', U1, 'c-1', null],
    ].map(([id, user, contact, opp]) => ({
      id,
      user_id: user,
      channel: 'gmail',
      external_id: `ext-${id}`,
      from: 'someone@example.com',
      subject: `About ${id}`,
      sent_at: T,
      contact_id: contact,
      opportunity_id: opp,
      created_at: T,
      updated_at: T,
    })),
  ],
  [
    'discovery_sources',
    [{ id: 's-1', user_id: U1, kind: 'ats_greenhouse', created_at: T, updated_at: T }],
  ],
  ['discovery_runs', [{ id: 'r-1', user_id: U1, source_id: 's-1', started_at: T }]],
  [
    'discovery_results',
    [
      {
        id: 'dr-1',
        user_id: U1,
        run_id: 'r-1',
        posting: '{"title":"Staff Engineer"}',
        resolution: 'full',
        source_communication_id: 'm-1',
        created_at: T,
        updated_at: T,
      },
    ],
  ],
  [
    'dismissal_feedback',
    [{ id: 'f-1', user_id: U1, communication_id: 'm-2', reason: 'not_a_fit', at: T }],
  ],
  [
    'activities',
    [
      {
        id: 'a-1',
        user_id: U1,
        opportunity_id: 'o-1',
        kind: 'referral',
        title: 'Asked Ada Lovelace for a referral',
        participants: '[{"contactId":"c-1","name":"Ada Lovelace"}]',
        occurred_at: T,
        created_at: T,
        updated_at: T,
      },
    ],
  ],
];

/** The search index rows for contacts (the table is not drizzle's on either engine). */
const SEARCH_ROWS = [
  { entity_kind: 'contact', entity_id: 'c-1', user_id: U1, text: 'Ada Lovelace ada@example.com' },
  { entity_kind: 'contact', entity_id: 'c-3', user_id: U2, text: 'Ada Lovelace' },
];

/** Tables whose every row is compared; the renamed one is read under its old and new name. */
const COMPARED = SEED.map(([t]) => t);
const renamed = (table: string) => (table === 'contacts' ? 'network_contacts' : table);

describe.runIf(sqliteOnly)('0038 network_contacts on SQLite', () => {
  async function seededAtPreviousHead(): Promise<string> {
    const partial = await chainBefore(MIGRATIONS_DIR, SQLITE_TAG);
    const dataDir = await tempDir();
    const old = new Database(join(dataDir, 'opportun.db'));
    try {
      migrate(drizzle(old), { migrationsFolder: partial });
      old.pragma('foreign_keys = ON');
      for (const [table, rows] of SEED) {
        for (const row of rows) {
          const cols = Object.keys(row);
          old
            .prepare(
              `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            )
            .run(...Object.values(row));
        }
      }
      const index = old.prepare(
        'INSERT INTO search_index (entity_kind, entity_id, user_id, text) VALUES (?, ?, ?, ?)',
      );
      for (const r of SEARCH_ROWS) index.run(r.entity_kind, r.entity_id, r.user_id, r.text);
    } finally {
      old.close();
    }
    return dataDir;
  }

  type Sqlite = InstanceType<typeof Database>;
  const tableNames = (db: Sqlite) =>
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
  const counts = (db: Sqlite) =>
    Object.fromEntries(
      tableNames(db).map((t) => [
        renamed(t),
        (db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n,
      ]),
    );
  const contents = (db: Sqlite, name: (t: string) => string) =>
    Object.fromEntries(
      COMPARED.map((t) => [renamed(t), db.prepare(`SELECT * FROM "${name(t)}" ORDER BY id`).all()]),
    );
  const searchRows = (db: Sqlite) =>
    db
      .prepare(
        'SELECT entity_kind, entity_id, user_id, text FROM search_index ORDER BY entity_kind, entity_id',
      )
      .all();

  it('keeps every row of every table, and every link to a contact or a message', async () => {
    const dataDir = await seededAtPreviousHead();
    const before = new Database(join(dataDir, 'opportun.db'), { readonly: true });
    const countsBefore = counts(before);
    const rowsBefore = contents(before, (t) => t);
    const searchBefore = searchRows(before);
    before.close();
    // The seed is what the comparison is about: make sure it is all there to lose.
    expect(countsBefore.network_contacts).toBe(4);
    expect(countsBefore.communications).toBe(5);

    // The real upgrade path: openDatabase turns foreign keys on, then runs migrateLocked.
    const { sqlite } = openDatabase(dataDir);
    try {
      expect(tableNames(sqlite)).not.toContain('contacts');
      expect(counts(sqlite)).toEqual(countsBefore);
      expect(contents(sqlite, renamed)).toEqual(rowsBefore);
      expect(searchRows(sqlite)).toEqual(searchBefore);
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('leaves the keys and indexes on the new name, and the foreign keys still act', async () => {
    const dataDir = await seededAtPreviousHead();
    const { sqlite } = openDatabase(dataDir);
    try {
      const fks = sqlite
        .prepare('SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list(?)')
        .all('communications');
      expect(fks).toContainEqual({
        table: 'network_contacts',
        from: 'contact_id',
        to: 'id',
        on_delete: 'SET NULL',
      });
      const indexes = sqlite
        .prepare(
          "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND (name LIKE '%contacts%' OR tbl_name LIKE '%contacts%') ORDER BY name",
        )
        .all();
      expect(indexes).toEqual([
        { name: 'network_contacts_user_company_idx', tbl_name: 'network_contacts' },
        { name: 'network_contacts_user_id_idx', tbl_name: 'network_contacts' },
      ]);

      // Deleting a contact still unlinks only its own messages.
      sqlite.prepare('DELETE FROM network_contacts WHERE id = ?').run('c-2');
      const links = sqlite
        .prepare('SELECT id, contact_id FROM communications ORDER BY id')
        .all() as { id: string; contact_id: string | null }[];
      expect(links).toEqual([
        { id: 'm-1', contact_id: 'c-1' },
        { id: 'm-2', contact_id: null },
        { id: 'm-3', contact_id: null },
        { id: 'm-4', contact_id: 'c-3' },
        { id: 'm-5', contact_id: 'c-1' },
      ]);
      // And a message cannot point at a contact that does not exist.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO communications (id, user_id, channel, external_id, "from", sent_at, contact_id, created_at, updated_at)
             VALUES ('m-9', ?, 'gmail', 'ext-m-9', 'x@example.com', ?, 'c-missing', ?, ?)`,
          )
          .run(U1, T, T, T),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      sqlite.close();
    }
  });
});

describe.runIf(livePgUrl !== undefined)('0020 network_contacts on Postgres (live)', () => {
  async function query<R = Row>(pool: pg.Pool, text: string, params: unknown[] = []) {
    return (await pool.query(text, params)).rows as R[];
  }
  const tableNames = async (pool: pg.Pool) =>
    (
      await query<{ name: string }>(
        pool,
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '__drizzle_migrations'
         ORDER BY table_name`,
      )
    ).map((r) => r.name);
  const counts = async (pool: pg.Pool) => {
    const out: Record<string, number> = {};
    for (const t of await tableNames(pool)) {
      const [row] = await query<{ n: string }>(pool, `SELECT count(*) AS n FROM "${t}"`);
      out[renamed(t)] = Number(row?.n);
    }
    return out;
  };
  const contents = async (pool: pg.Pool, name: (t: string) => string) => {
    const out: Record<string, unknown[]> = {};
    for (const t of COMPARED) {
      out[renamed(t)] = await query(pool, `SELECT * FROM "${name(t)}" ORDER BY id`);
    }
    return out;
  };
  const searchRows = (pool: pg.Pool) =>
    query(
      pool,
      'SELECT entity_kind, entity_id, user_id, text, tsv::text AS tsv FROM search_index ORDER BY entity_kind, entity_id',
    );
  const constraints = async (pool: pg.Pool, table: string) =>
    (
      await query<{ name: string; valid: boolean }>(
        pool,
        `SELECT conname AS name, convalidated AS valid FROM pg_constraint
         WHERE conrelid = $1::regclass ORDER BY conname`,
        [table],
      )
    ).map((c) => `${c.name}${c.valid ? '' : ' (not valid)'}`);

  it('keeps every row, renames every key and index, and the foreign keys still act', async () => {
    const partial = await chainBefore(MIGRATIONS_PG_DIR, PG_TAG);
    await withScratchDatabase(async (url) => {
      const pool = new pg.Pool({ connectionString: url, max: 2 });
      try {
        await migrateLockedPg(pool, partial);
        for (const [table, rows] of SEED) {
          for (const row of rows) {
            const cols = Object.keys(row);
            await pool.query(
              `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_c, i) => `$${i + 1}`).join(', ')})`,
              Object.values(row),
            );
          }
        }
        for (const r of SEARCH_ROWS) {
          await pool.query(
            `INSERT INTO search_index (entity_kind, entity_id, user_id, text, tsv)
             VALUES ($1, $2, $3, $4, to_tsvector('simple', $4))`,
            [r.entity_kind, r.entity_id, r.user_id, r.text],
          );
        }
        const countsBefore = await counts(pool);
        const rowsBefore = await contents(pool, (t) => t);
        const searchBefore = await searchRows(pool);
        expect(countsBefore.network_contacts).toBe(4);
        expect(countsBefore.communications).toBe(5);

        await migrateLockedPg(pool);

        expect(await tableNames(pool)).not.toContain('contacts');
        expect(await counts(pool)).toEqual(countsBefore);
        expect(await contents(pool, renamed)).toEqual(rowsBefore);
        expect(await searchRows(pool)).toEqual(searchBefore);
        // Postgres's own foreign_key_check: no row points at a parent that is not there.
        const dangling = await query(
          pool,
          `SELECT 'communications' AS t, m.id FROM communications m
             LEFT JOIN network_contacts c ON c.id = m.contact_id
             WHERE m.contact_id IS NOT NULL AND c.id IS NULL
           UNION ALL
           SELECT 'discovery_results', r.id FROM discovery_results r
             LEFT JOIN communications m ON m.id = r.source_communication_id
             WHERE r.source_communication_id IS NOT NULL AND m.id IS NULL
           UNION ALL
           SELECT 'dismissal_feedback', f.id FROM dismissal_feedback f
             LEFT JOIN communications m ON m.id = f.communication_id
             WHERE f.communication_id IS NOT NULL AND m.id IS NULL`,
        );
        expect(dangling).toEqual([]);

        expect(await constraints(pool, 'network_contacts')).toEqual([
          'network_contacts_current_company_id_companies_id_fk',
          'network_contacts_pkey',
          'network_contacts_user_id_users_id_fk',
        ]);
        expect(await constraints(pool, 'communications')).toContain(
          'communications_contact_id_network_contacts_id_fk',
        );
        expect(
          (
            await query<{ name: string }>(
              pool,
              "SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%contacts%' ORDER BY indexname",
            )
          ).map((r) => r.name),
        ).toEqual([
          'network_contacts_pkey',
          'network_contacts_user_company_idx',
          'network_contacts_user_id_idx',
        ]);

        await pool.query('DELETE FROM network_contacts WHERE id = $1', ['c-2']);
        expect(await query(pool, 'SELECT id, contact_id FROM communications ORDER BY id')).toEqual([
          { id: 'm-1', contact_id: 'c-1' },
          { id: 'm-2', contact_id: null },
          { id: 'm-3', contact_id: null },
          { id: 'm-4', contact_id: 'c-3' },
          { id: 'm-5', contact_id: 'c-1' },
        ]);
        await expect(
          pool.query(
            `INSERT INTO communications (id, user_id, channel, external_id, "from", sent_at, contact_id, created_at, updated_at)
             VALUES ('m-9', $1, 'gmail', 'ext-m-9', 'x@example.com', $2, 'c-missing', $2, $2)`,
            [U1, T],
          ),
        ).rejects.toThrow(/communications_contact_id_network_contacts_id_fk/);
      } finally {
        await pool.end();
      }
    });
  });
});
