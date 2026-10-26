// The SQLite-to-Postgres copy tool end to end (iteration 4 Task 14). The Postgres leg builds a
// SQLite source with every schema table populated (generated from the schema, so a new table
// or column is covered without editing this file) and the values that trip a naive copy:
// emoji, NUL characters, CJK and quotes in text; JSON objects with unsorted keys, the JSON
// string "123", JSON null next to SQL NULL, numbers beyond 2^53 inside JSON, \u0000 escapes;
// booleans, epoch-ms integers, the largest safe integer, Infinity and -0 in real columns;
// self-referencing prompts and resumes whose parents come later in the table; vault
// envelopes in the secrets table, users.totp_secret and a settings value; FTS rows, a stale
// one and an orphan. The copy goes into an empty, unmigrated scratch database through the
// command line entry, and the app then boots on it, signs in and searches.
import { TASK_KEYS } from '@opportun/ai';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { main, parseArgs } from '../src/cli/copyToPostgres';
import { PostgresConfig, type Config } from '../src/config';
import {
  knownMigrationHead,
  migrateLocked,
  migrateLockedPg,
  openSqliteSnapshot,
} from '../src/db/client';
import { copyOrder, tableSpecs } from '../src/db/copyPlan';
import { TABLE_EXPORTS } from '../src/db/schema.shared';
import * as sqliteTables from '../src/db/schema.sqlite';
import type { CopyReport } from '../src/lib/copyToPostgres';
import { hashPassword } from '../src/lib/passwords';
import { open as openSealed, seal } from '../src/lib/secretBox';
import { createStorage } from '../src/lib/storage';
import { testDialect } from './db';
import { createScratchDatabase } from './pgScratch';

const ROWS = 5;
const OWNER_EMAIL = 'owner@example.com';
const OWNER_PASSWORD = 'correct horse battery staple';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opportun-copy-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface Source {
  dataDir: string;
  key: Buffer;
  /** The one real attachment file (content-addressed under DATA_DIR). */
  attachmentPath: string;
}

const TEXTS = (uniq: string) => [
  `emoji 🎉 ${uniq}`,
  `nul\u0000inside ${uniq}`,
  `quotes ' " \\ 日本語 ${uniq}`,
  `plain ${uniq}`,
];
const JSONS = [
  '{"b":{"z":1,"a":[1,2,{"y":null,"x":"🎉"}]},"a":12345678901234567891,"f":0.1}',
  '"123"',
  '{"nul":"a\\u0000b","n":-0.0,"e":1.0E+2}',
  'null',
];
const INTS = [1792195200017, 0, -5, Number.MAX_SAFE_INTEGER];
const REALS = [0.1, 1.5e300, -0, Infinity];

/** A SQLite deployment at the migrated head with ROWS rows in every table. */
async function buildSource(): Promise<Source> {
  const dataDir = await tempDir();
  const key = randomBytes(32);
  const storage = createStorage(dataDir, dataDir);
  const { storedPath: attachmentPath } = await storage.writeAttachment(Buffer.from('a resume'));
  const ownerHash = await hashPassword(OWNER_PASSWORD);
  const sealedJson = (plain: string) => JSON.stringify(seal(key, plain));

  const sqlite = new Database(join(dataDir, 'opportun.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  migrateLocked(sqlite);
  // Self-references point at a LATER row, so table order alone would violate the key.
  const selfParent = (i: number) => (i < ROWS - 2 ? i + 1 : null);

  for (const spec of copyOrder(tableSpecs())) {
    const exportName = TABLE_EXPORTS.find(
      (e) => getTableConfig(sqliteTables[e] as SQLiteTable).name === spec.name,
    );
    const config = getTableConfig(sqliteTables[exportName as never] as SQLiteTable);
    const fks = new Map<string, string>();
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      const target = getTableConfig(ref.foreignTable).name;
      for (const c of ref.columns) fks.set(c.name, target);
    }
    const notNull = new Set(config.columns.filter((c) => c.notNull).map((c) => c.name));
    const cols = spec.columns.map((c) => c.name);
    const insert = sqlite.prepare(
      `INSERT INTO "${spec.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    );
    const pkIsFk = spec.pk.length === 1 && fks.has(spec.pk[0] as string);
    const later: [string, string, string][] = [];
    for (let i = 0; i < ROWS; i += 1) {
      const last = i === ROWS - 1;
      const values = spec.columns.map((c) => {
        const nullable = !notNull.has(c.name);
        const parent = fks.get(c.name);
        if (parent !== undefined) {
          if (parent === spec.name) {
            // Set after the parent row exists (SQLite checks the key per statement).
            const p = selfParent(i);
            if (p !== null) later.push([c.name, `${spec.name}-${p}`, `${spec.name}-${i}`]);
            return null;
          }
          return last && nullable ? null : `${parent}-${i}`;
        }
        if (spec.pk.includes(c.name) && !pkIsFk) {
          return c.kind === 'text' ? `${spec.name}-${i}` : i;
        }
        if (last && nullable) return null;
        switch (c.kind) {
          case 'text':
            return TEXTS(`${spec.name}.${c.name}.${i}`)[i % 4];
          case 'json':
            return JSONS[i % 4];
          case 'int':
            return INTS[i % 4];
          case 'real':
            return REALS[i % 4];
          case 'bool':
            return i % 2 === 0 ? 1 : 0;
        }
      });
      const row = new Map(cols.map((c, j) => [c, values[j]]));
      overrides(spec.name, i, row, { ownerHash, sealedJson, key, attachmentPath });
      insert.run(...cols.map((c) => row.get(c)));
    }
    for (const [column, parent, id] of later) {
      sqlite.prepare(`UPDATE "${spec.name}" SET "${column}" = ? WHERE id = ?`).run(parent, id);
    }
  }

  // The SQLite search index: every searchable entity, one stale row, one orphan.
  const index = sqlite.prepare(
    'INSERT INTO search_index (entity_kind, entity_id, user_id, text) VALUES (?, ?, ?, ?)',
  );
  const indexed: [string, string, string, string][] = [
    ['opportunity', 'opportunities', 'title', 'description_md'],
    ['activity', 'activities', 'title', 'body_md'],
    ['communication', 'communications', 'subject', 'snippet'],
    ['contact', 'contacts', 'name', 'notes'],
  ];
  for (const [kind, table, a, b] of indexed) {
    for (const r of sqlite
      .prepare(`SELECT id, user_id, "${a}" AS a, "${b}" AS b FROM "${table}"`)
      .all() as {
      id: string;
      user_id: string;
      a: string | null;
      b: string | null;
    }[]) {
      const text = [r.a, r.b].filter((p) => p != null && p !== '').join('\n');
      index.run(kind, r.id, r.user_id, r.id === 'activities-3' ? 'stale text' : text);
    }
  }
  index.run('opportunity', 'opportunities-gone', 'users-0', 'deleted long ago');
  sqlite.close();
  return { dataDir, key, attachmentPath };
}

/** Rows the app reads in the end-to-end checks, and vault envelopes. */
function overrides(
  table: string,
  i: number,
  row: Map<string, unknown>,
  ctx: {
    ownerHash: string;
    sealedJson: (p: string) => string;
    key: Buffer;
    attachmentPath: string;
  },
): void {
  if (table === 'users') {
    row.set('email', i === 0 ? OWNER_EMAIL : `user${i}@example.com`);
    if (i === 0) {
      row.set('password_hash', ctx.ownerHash);
      row.set('is_admin', 1);
      row.set('totp_enabled', 0);
      row.set('totp_recovery', null);
      row.set('totp_secret', ctx.sealedJson(TOTP_SECRET));
    }
  }
  if (table === 'secrets') {
    const s = seal(ctx.key, `api-key-${i}-🎉`);
    row.set('ciphertext', s.ciphertext);
    row.set('iv', s.iv);
    row.set('tag', s.tag);
    row.set('key_version', s.keyVersion);
  }
  if (table === 'settings' && i === 0) {
    row.set('key', 'oauth.google.client');
    row.set(
      'value',
      JSON.stringify({ clientId: 'cid', sealedSecret: ctx.sealedJson('client-secret') }),
    );
  }
  if (table === 'opportunities' && i === 0) row.set('title', 'Staff zebracorn engineer 🎉');
  if (table === 'attachments') {
    row.set('stored_path', i === 2 ? `attachments/ab/${'ab'.padEnd(64, '0')}` : ctx.attachmentPath);
  }
  if (table === 'communications' && row.get('body_ref') !== null)
    row.set('body_ref', ctx.attachmentPath);
}

interface Run {
  code: number;
  out: string;
  err: string;
  report: CopyReport | undefined;
}

async function runCopy(
  source: Source,
  url: string,
  argv: string[] = [],
  copy: Parameters<typeof main>[0]['copy'] = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  let report: CopyReport | undefined;
  const code = await main({
    argv: ['--from', source.dataDir, ...argv],
    env: {
      DB_DIALECT: 'postgres',
      DATABASE_URL: url,
      OPPORTUN_MASTER_KEY: source.key.toString('hex'),
    },
    io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
    copy,
    onReport: (r) => (report = r),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), report };
}

async function scratch(): Promise<string> {
  const db = await createScratchDatabase();
  cleanups.push(db.drop);
  return db.url;
}

async function pgQuery<T extends pg.QueryResultRow>(url: string, text: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

async function userCount(url: string): Promise<number> {
  const rows = await pgQuery<{ n: number }>(url, 'SELECT count(*)::int AS n FROM users');
  return rows[0]?.n ?? -1;
}

describe.runIf(testDialect === 'postgres')('copy tool (live Postgres)', () => {
  it('copies every table, verifies it, and the app runs on the copy', async () => {
    const source = await buildSource();
    const url = await scratch();
    const run = await runCopy(source, url);
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
    const report = run.report as CopyReport;
    expect(report.ok).toBe(true);
    // Derived, not pinned: a count edited whenever the schema changes tests the editor's
    // diligence rather than the copy tool. Same reasoning as deriving the seeded prompt count.
    expect(report.tables).toHaveLength(TABLE_EXPORTS.length);
    for (const t of report.tables) {
      expect(t.ok, t.name).toBe(true);
      expect(t.targetChecksum).toBe(t.sourceChecksum);
      expect(t.sourceRows).toBeGreaterThanOrEqual(ROWS);
    }
    const prompts = report.tables.find((t) => t.name === 'prompts');
    // One seeded system default per AI task, so this tracks TASK_KEYS rather than a literal
    // that goes stale the next time a task is added (it did, twice, on 2026-10-19).
    expect(prompts?.seededRows).toBe(TASK_KEYS.length);
    expect(prompts?.sourceRows).toBe(ROWS + TASK_KEYS.length);
    // NUL characters: cleaned, counted per column, never dropped silently.
    expect(report.sanitized.length).toBeGreaterThan(0);
    expect(run.out).toMatch(/sanitized \d+ value\(s\) in users\.display_name/);
    // The JSON row whose \u0000 was cleaned is re-encoded, and reported as such.
    expect(report.tables.find((t) => t.name === 'audit_log')).toMatchObject({
      reencoded: 1,
      ok: true,
    });
    // 5 secrets rows, the owner's TOTP secret, the sealed client secret in settings.
    expect(report.vault).toMatchObject({ envelopes: 7, verified: 7, ok: true });
    expect(report.search).toMatchObject({
      sourceRows: 4 * ROWS + 1,
      rebuiltRows: 4 * ROWS,
      targetRows: 4 * ROWS,
      orphans: 1,
      ok: true,
    });
    // The stale row and the four whose NUL was cleaned get fresh text.
    expect(report.search.textRefreshed).toBeGreaterThanOrEqual(1);
    expect(report.attachments.referenced).toBe(2);
    expect(report.warnings.join('\n')).toMatch(
      /attachment not found under DATA_DIR: attachments\/ab\//,
    );
    expect(run.out).toMatch(/table\s+source rows\s+target rows/);
    expect(run.out).toContain('Cutover checklist');

    // JSON fidelity on the Postgres side: string "123", JSON null and SQL NULL apart.
    const scopes = await pgQuery<{ id: string; t: string | null }>(
      url,
      'SELECT id, jsonb_typeof(scopes) AS t FROM device_tokens ORDER BY id',
    );
    expect(scopes.map((s) => s.t)).toEqual(['object', 'string', 'object', 'null', 'object']);
    const detail = await pgQuery<{ id: string; t: string | null; isnull: boolean }>(
      url,
      'SELECT id, jsonb_typeof(detail) AS t, detail IS NULL AS isnull FROM audit_log ORDER BY id',
    );
    expect(detail.at(3)).toMatchObject({ t: 'null', isnull: false });
    expect(detail.at(4)).toMatchObject({ t: null, isnull: true });
    const big = await pgQuery<{ a: string }>(
      url,
      "SELECT detail->>'a' AS a FROM audit_log WHERE id = 'audit_log-0'",
    );
    expect(big[0]?.a).toBe('12345678901234567891');
    // Vault ciphertexts byte for byte, decrypting with the unchanged master key.
    const secret = await pgQuery<{
      ciphertext: string;
      iv: string;
      tag: string;
      key_version: number;
    }>(url, "SELECT ciphertext, iv, tag, key_version FROM secrets WHERE id = 'secrets-2'");
    const s = secret[0] as { ciphertext: string; iv: string; tag: string; key_version: number };
    expect(openSealed(source.key, { ...s, keyVersion: s.key_version })).toBe('api-key-2-🎉');

    // The app on the copy: same DATA_DIR and master key, Postgres database.
    const cfg: Config = {
      port: 0,
      host: '127.0.0.1',
      dataDir: source.dataDir,
      sqliteDir: source.dataDir,
      baseUrl: 'http://localhost:3000',
      masterKey: source.key,
      logLevel: 'silent',
      db: new PostgresConfig(url, 4, 'disable'),
      demo: false,
      aiAllowLoopbackHttp: false,
      trustedProxies: [],
    };
    const app = await buildApp(cfg, { jobRunner: false });
    cleanups.push(() => app.close());
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const session = (login.cookies as { name: string; value: string }[]).find(
      (c) => c.name === 'opportun_session',
    );
    const found = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=zebracorn',
      cookies: { opportun_session: session?.value ?? '' },
    });
    expect(found.statusCode).toBe(200);
    expect(found.json().items.map((h: { entityId: string }) => h.entityId)).toEqual([
      'opportunities-0',
    ]);

    // Idempotent re-run: the target is not empty any more, so the copy refuses.
    const again = await runCopy(source, url);
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/target database is not empty: users \(5\)/);
  });

  it('a dry run checks both sides and writes nothing, not even migrations', async () => {
    const source = await buildSource();
    const url = await scratch();
    const run = await runCopy(source, url, ['--dry-run']);
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
    expect(run.report?.dryRun).toBe(true);
    expect(run.out).toContain('Dry run complete: nothing was written');
    expect(run.out).toContain('target is not migrated yet');
    expect(run.out).not.toContain('Cutover checklist');
    const tables = await pgQuery<{ n: number }>(
      url,
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
    );
    expect(tables[0]?.n).toBe(0);
  });

  it('names the table and rolls everything back when a checksum differs', async () => {
    const source = await buildSource();
    const url = await scratch();
    const run = await runCopy(source, url, [], {
      beforeVerify: async (query) => {
        await query("UPDATE companies SET name = name || ' (corrupted)' WHERE id = 'companies-2'");
      },
    });
    expect(run.code).toBe(1);
    expect(run.report?.ok).toBe(false);
    expect(run.report?.failures[0]).toMatch(/checksum mismatch in companies: 1 row\(s\) differ/);
    expect(run.report?.tables.find((t) => t.name === 'companies')?.ok).toBe(false);
    expect(run.out).toMatch(/companies .*MISMATCH/);
    expect(run.err).toMatch(/Copy NOT verified/);
    expect(run.err).toMatch(/rolled back: the target holds only its migrations/);
    expect(run.err).not.toMatch(/COMMIT outcome unknown/);
    expect(await userCount(url)).toBe(0);
    // Migrated and empty, so a corrected run can go ahead.
    const retry = await runCopy(source, url);
    expect(retry.code).toBe(0);
  });

  it('detects a vault value that no longer decrypts', async () => {
    const source = await buildSource();
    const url = await scratch();
    const run = await runCopy(source, url, [], {
      beforeVerify: async (query) => {
        // Valid base64 of the same length, different bytes: the checksum and GCM both catch it.
        await query("UPDATE secrets SET tag = 'AAAAAAAAAAAAAAAAAAAAAA==' WHERE id = 'secrets-1'");
      },
    });
    expect(run.code).toBe(1);
    expect(run.report?.vault.ok).toBe(false);
    expect(run.report?.failures.join('\n')).toMatch(
      /vault check failed for 1 value\(s\): secrets .*secrets-1.* does not decrypt/,
    );
    expect(await userCount(url)).toBe(0);
  });

  it('refuses a target that already holds data', async () => {
    const source = await buildSource();
    const url = await scratch();
    // A migrated database someone already signed up on.
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    await migrateLockedPg(pool);
    await pool.end();
    await pgQuery(
      url,
      "INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES ('u', 'u@example.com', 'x', 'U', 1, 1)",
    );
    const run = await runCopy(source, url);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(
      /Refused before any changes: the target database is not empty: users \(1\)/,
    );
    expect(run.err).toMatch(/Nothing was written/);
  });

  it('refuses a source behind the migration head, a running server, and invalid JSON', async () => {
    const url = await scratch();
    const behind = await buildSource();
    const db1 = new Database(join(behind.dataDir, 'opportun.db'));
    db1
      .prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?')
      .run(knownMigrationHead('sqlite'));
    db1.close();
    expect((await runCopy(behind, url)).err).toMatch(
      /Refused before any changes: the source database is behind this release/,
    );

    const live = await buildSource();
    const server = new Database(join(live.dataDir, 'opportun.db'));
    server.prepare("UPDATE users SET display_name = 'still running' WHERE id = 'users-1'").run();
    const running = await runCopy(live, url);
    server.close();
    expect(running.code).toBe(2);
    expect(running.err).toMatch(/opportun\.db-wal is not empty: the server is still running/);

    const bad = await buildSource();
    const db3 = new Database(join(bad.dataDir, 'opportun.db'));
    db3.prepare("UPDATE device_tokens SET scopes = '{not json' WHERE id = 'device_tokens-2'").run();
    db3.close();
    const invalid = await runCopy(bad, url);
    expect(invalid.code).toBe(2);
    expect(invalid.err).toMatch(
      /device_tokens\.scopes of row \["T\\"device_tokens-2\\""\]: invalid JSON/,
    );
    // None of the refusals wrote anything (the target is still unmigrated).
    const tables = await pgQuery<{ n: number }>(
      url,
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
    );
    expect(tables[0]?.n).toBe(0);
  });
});

describe('copy tool (any leg)', () => {
  it('parses its arguments and rejects unknown ones', () => {
    expect(parseArgs(['--from', '/d', '--dry-run', '--batch', '50'])).toEqual({
      from: '/d',
      dryRun: true,
      batchRows: 50,
      attachmentSample: undefined,
      allowUndecryptable: false,
    });
    expect(() => parseArgs(['--to', 'postgres://x'])).toThrow(/unknown argument: --to/);
    expect(() => parseArgs(['--batch', '0'])).toThrow(/at least 1/);
  });

  it('refuses to run without DB_DIALECT=postgres and a target URL', async () => {
    const err: string[] = [];
    const code = await main({
      argv: ['--from', '/nowhere'],
      env: { OPPORTUN_MASTER_KEY: 'ab'.repeat(32) },
      io: { stdout: () => undefined, stderr: (l) => err.push(l) },
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/DB_DIALECT=postgres/);
  });

  it('reads a SQLite file as one read-only snapshot with exact integers', async () => {
    const dir = await tempDir();
    const file = join(dir, 'opportun.db');
    const db = new Database(file);
    db.exec('CREATE TABLE t (n INTEGER)');
    db.prepare('INSERT INTO t VALUES (?)').run(2n ** 62n);
    db.close();
    const snap = openSqliteSnapshot(file);
    try {
      expect(snap.all<{ n: bigint }>('SELECT n FROM t')).toEqual([{ n: 2n ** 62n }]);
      expect(() => snap.all('INSERT INTO t VALUES (1)')).toThrow(/readonly|does not return data/);
    } finally {
      snap.close();
    }
  });
});

async function editSource(source: Source, statement: string): Promise<void> {
  const db = new Database(join(source.dataDir, 'opportun.db'));
  try {
    db.prepare(statement).run();
  } finally {
    db.close();
  }
}

async function publicTables(url: string): Promise<number> {
  const rows = await pgQuery<{ n: number }>(
    url,
    "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
  );
  return rows[0]?.n ?? -1;
}

describe.runIf(testDialect === 'postgres')('copy tool review fixes (live Postgres)', () => {
  it('refuses before any work when the master key opens none of the vault', async () => {
    const source = await buildSource();
    const url = await scratch();
    const run = await runCopy({ ...source, key: randomBytes(32) }, url);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(
      /Refused before any changes: the master key does not open the source vault \(0 of 7 values decrypt\)/,
    );
    expect(await publicTables(url)).toBe(0);
  });

  it('refuses a single undecryptable vault value unless allowed, then warns per value', async () => {
    const source = await buildSource();
    const url = await scratch();
    await editSource(
      source,
      "UPDATE secrets SET tag = 'AAAAAAAAAAAAAAAAAAAAAA==' WHERE id = 'secrets-1'",
    );
    const refused = await runCopy(source, url);
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(
      /Refused before any changes: 1 vault value\(s\) do not decrypt with this master key in the source: secrets \["T\\"secrets-1\\""\].*--allow-undecryptable/,
    );
    expect(await publicTables(url)).toBe(0);

    const allowed = await runCopy(source, url, ['--allow-undecryptable']);
    expect(allowed.code).toBe(0);
    expect(allowed.report?.vault).toMatchObject({ undecryptableInSource: 1, verified: 6 });
    expect(allowed.out).toMatch(
      /warning: vault value secrets \["T\\"secrets-1\\""\] does not decrypt in the source/,
    );
    expect(allowed.out).toMatch(
      /vault: .*: NOT VERIFIED \(1 undecryptable value\(s\) allowed by --allow-undecryptable\)/,
    );
  });

  it('refuses outright, with no --allow flag, a vault value that names ciphertext but will not parse (#148)', async () => {
    const source = await buildSource();
    const url = await scratch();
    // Stands in for corruption truncating a stored envelope: still names a ciphertext key, no
    // longer valid JSON. Before #148 this was indistinguishable from "not an envelope at all".
    await editSource(
      source,
      `UPDATE users SET totp_secret = '{"ciphertext":"trunc' WHERE email = '${OWNER_EMAIL}'`,
    );
    const refused = await runCopy(source, url);
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(
      /Refused before any changes: 1 value\(s\) in the source look like a sealed vault secret \(they name a ciphertext key\) but do not parse as one: users .* totp_secret: names a ciphertext key but is not valid JSON/,
    );
    // No --allow flag gets past this: unlike an undecryptable value, there is nothing to
    // verify a byte-for-byte copy against, so nothing offers to copy it anyway.
    expect(refused.err).not.toMatch(/--allow/);
    expect(await publicTables(url)).toBe(0);
  });

  it('fails verification on JSON number drift a parse-based checksum cannot see', async () => {
    const source = await buildSource();
    const url = await scratch();
    const big = await runCopy(source, url, [], {
      beforeVerify: async (query) => {
        await query(
          "UPDATE audit_log SET detail = jsonb_set(detail, '{a}', '12345678901234567892'::jsonb) WHERE id = 'audit_log-0'",
        );
      },
    });
    expect(big.code).toBe(1);
    expect(big.report?.failures.join('\n')).toMatch(
      /JSON mismatch in audit_log\.detail: 1 row\(s\) differ \(first: \["T\\"audit_log-0\\""\]\)/,
    );
    expect(big.report?.tables.find((t) => t.name === 'audit_log')?.ok).toBe(false);
    expect(await userCount(url)).toBe(0);

    const float = await runCopy(source, url, [], {
      beforeVerify: async (query) => {
        await query(
          "UPDATE audit_log SET detail = jsonb_set(detail, '{f}', '0.10000000000000001'::jsonb) WHERE id = 'audit_log-0'",
        );
      },
    });
    expect(float.code).toBe(1);
    expect(float.report?.failures.join('\n')).toMatch(/JSON mismatch in audit_log\.detail: 1 row/);
  });

  it('says when it refused after migrating the empty target', async () => {
    const source = await buildSource();
    const url = await scratch();
    await editSource(
      source,
      "UPDATE prompts SET name = 'edited' WHERE id = '0199e800-0000-7000-8000-000000000001'",
    );
    const run = await runCopy(source, url);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/Refused after migrating the empty target .*: system prompt/);
    expect(await publicTables(url)).toBeGreaterThan(0);
    expect(await userCount(url)).toBe(0);
  });

  it('says the copy was rolled back when it fails inside the transaction', async () => {
    const source = await buildSource();
    const url = await scratch();
    const run = await runCopy(source, url, [], {
      beforeVerify: async () => {
        throw new Error('boom');
      },
    });
    expect(run.code).toBe(1);
    expect(run.err).toMatch(
      /Copy failed and was rolled back: the target holds only its migrations/,
    );
    expect(run.err).toMatch(/boom/);
    expect(await userCount(url)).toBe(0);
  });

  it('re-checks tables, the vault and the search index after COMMIT', async () => {
    const source = await buildSource();
    const url = await scratch();
    const run = await runCopy(source, url, [], {
      afterCommit: async (query) => {
        await query("UPDATE secrets SET tag = 'AAAAAAAAAAAAAAAAAAAAAA==' WHERE id = 'secrets-1'");
        await query("DELETE FROM search_index WHERE entity_id = 'opportunities-1'");
      },
    });
    expect(run.code).toBe(1);
    const failures = run.report?.failures.join('\n') ?? '';
    expect(failures).toMatch(/after COMMIT: checksum mismatch in secrets/);
    expect(failures).toMatch(/after COMMIT: vault check failed for 1 value/);
    expect(failures).toMatch(/after COMMIT: search_index membership differs: 1 missing/);
    expect(run.err).toMatch(
      /COMMIT outcome unknown: verify the target before trusting either side/,
    );
    expect(run.err).not.toMatch(/rolled back/);
  });

  it('warns loudly when the source changed during the copy', async () => {
    const source = await buildSource();
    const url = await scratch();
    const run = await runCopy(source, url, [], {
      afterCommit: async () => {
        await editSource(
          source,
          "UPDATE users SET display_name = 'late write' WHERE id = 'users-1'",
        );
      },
    });
    expect(run.code).toBe(0);
    expect(run.err).toMatch(/WARNING: the SQLite source changed while it was being copied/);
    expect(run.report?.warnings.join('\n')).toMatch(/SQLite source changed/);
  });

  it("refuses a target holding tables that are not Opportun's", async () => {
    const source = await buildSource();
    const url = await scratch();
    await pgQuery(url, 'CREATE TABLE other_app (id int)');
    const run = await runCopy(source, url);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(
      /Refused before any changes: the target database holds tables but no Opportun migrations: other_app/,
    );
    expect(await publicTables(url)).toBe(1);
  });
});
