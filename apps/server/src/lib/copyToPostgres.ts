// The verified SQLite-to-Postgres copy (iteration 4 Task 14; command line in
// cli/copyToPostgres.ts, cutover runbook in docs/install.md). Carries one SQLite deployment's
// database into an empty Postgres database, then proves the copy before committing it.
//
// Order of work:
// 1. Source: SQLITE_DIR/opportun.db (defaults to DATA_DIR; issue #179) opened read-only in
//    one read transaction (a snapshot). It must be at exactly the SQLite migration head this
//    build knows, hold no table the schema does not, pass PRAGMA quick_check and
//    foreign_key_check, and have no write-ahead log left (a non-empty -wal means a server is
//    still running or did not stop cleanly).
// 2. Every table is read and normalized (db/copyPlan.ts): canonical cells for the checksums,
//    parameters for the inserts, NUL characters and lone surrogates removed through
//    cleanText and counted. Every vault envelope (the secrets table, users.totp_secret,
//    sealed values inside settings) is decrypted with the master key and its plaintext hashed.
// 3. Target: migrated to the Postgres head first (migrateLockedPg), C collation required, and
//    empty: no row in any table except the system prompts its own migrations seeded, which
//    must equal the source's (they are then skipped, not inserted twice). A non-empty target
//    is refused, always: there is no flag that overwrites a database.
// 4. One transaction: tables in FK order (self-references parent first), batched inserts;
//    the search index rebuilt through the repository indexers (repos/search.ts) for the
//    entities the SQLite index holds, never copied from FTS5 internals; then, still inside
//    the transaction, every table read back and compared by row count and checksum, the
//    index by membership, and every vault envelope decrypted again and its plaintext hash
//    compared. Any difference rolls the whole copy back and names the table.
// 5. After COMMIT, row counts and checksums are compared once more on the committed data,
//    and the attachment files the rows point at (attachments/ under DATA_DIR, which stays
//    on the filesystem in both deployments, like master.key) are spot-checked by content hash.
//
// Nothing here prints a row value: reports carry counts, table names, primary keys and
// truncated checksums only.
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { PostgresConfig } from '../config';
import {
  knownMigrationHead,
  openPgSession,
  openSqliteSnapshot,
  type PgSession,
  type SqliteSnapshot,
} from '../db/client';
import {
  CopyDataError,
  MalformedEnvelope,
  TableDigest,
  copyOrder,
  fromPg,
  fromSqlite,
  parentsFirst,
  rowKey,
  rowLine,
  sealedEnvelopes,
  tableSpecs,
  type SanitizeCounter,
  type SealedEnvelope,
  type SourceValue,
  type TableSpec,
} from '../db/copyPlan';
import { SCHEMA_DIALECT } from '../db/schema';
import type { UserCtx } from '../repos/base';
import {
  indexActivity,
  indexCommunication,
  indexContact,
  indexOpportunity,
  SEARCH_KINDS,
  type SearchKind,
} from '../repos/search';
import { open as openSealed } from './secretBox';
import { createStorage, isOperatorFile, operatorFileStat } from './storage';

/**
 * A precondition failed and nothing was copied. `afterMigrate` says whether the (empty)
 * target had already been migrated to head when the refusal came; otherwise nothing at all
 * was changed. The message says what to do.
 */
export class CopyRefused extends Error {
  override name = 'CopyRefused';
  afterMigrate = false;
}

/**
 * Where the target stands when a copy fails:
 * - 'untouched': nothing was changed;
 * - 'migrated': the copy transaction never committed (rolled back, or never began), so the
 *   target holds only its migrations;
 * - 'unknown': the failure came at or after COMMIT, so the target may hold the copy, or a
 *   copy that failed its post-COMMIT check: verify it before trusting either side.
 */
export type TargetState = 'untouched' | 'migrated' | 'unknown';

/** The copy failed with an error (not a verification mismatch); see `target`. */
export class CopyFailed extends Error {
  override name = 'CopyFailed';
  constructor(
    message: string,
    readonly target: TargetState,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface CopyOptions {
  /** DATA_DIR of the SQLite deployment (attachments/; read only). */
  dataDir: string;
  /** SQLITE_DIR of the SQLite deployment (opportun.db; read only). Defaults to dataDir,
   *  which is right for a deployment that never split the two (config.ts's loadSqliteDir). */
  sqliteDir?: string;
  /** The Postgres database to fill (DATABASE_URL). */
  target: PostgresConfig;
  /** The deployment's vault master key (OPPORTUN_MASTER_KEY), for the decryptability check. */
  masterKey: Buffer;
  /** Check everything and print the plan; write nothing to the target (not even migrations). */
  dryRun?: boolean;
  /** Rows per INSERT statement (default 500). */
  batchRows?: number;
  /** Attachment references to verify on disk (default 500; 0 checks every one). */
  attachmentSample?: number;
  /** Progress lines. */
  log?: (line: string) => void;
  /**
   * Copy even when some vault values already fail to decrypt in the source (they are copied
   * byte for byte, warned about one by one, and the vault line is not 'ok'). Without it such a
   * source is refused.
   */
  allowUndecryptable?: boolean;
  /** Tests only: runs inside the copy transaction after the writes, before verification. */
  beforeVerify?: (query: PgSession['query']) => Promise<void>;
  /** Tests only: runs after COMMIT, before the post-COMMIT check. */
  afterCommit?: (query: PgSession['query']) => Promise<void>;
}

export interface TableReport {
  name: string;
  sourceRows: number;
  /** Null on a dry run. */
  targetRows: number | null;
  /** Identical system rows the target's migrations had already seeded (not inserted). */
  seededRows: number;
  sourceChecksum: string;
  targetChecksum: string | null;
  /** Values cleaned of NUL characters or lone surrogates in this table. */
  sanitized: number;
  /**
   * Rows with a JSON value re-encoded because cleaning changed it: compared with the cleaned
   * value, not the source text (numbers in it beyond double precision are rounded).
   */
  reencoded: number;
  ok: boolean;
}

export interface CopyReport {
  ok: boolean;
  dryRun: boolean;
  tables: TableReport[];
  search: {
    sourceRows: number;
    rebuiltRows: number;
    targetRows: number | null;
    /** SQLite index rows whose entity is missing or belongs to another user (not rebuilt). */
    orphans: number;
    /** Rebuilt rows whose text differs from the SQLite index's (stale there, fresh here). */
    textRefreshed: number;
    ok: boolean;
  };
  vault: {
    /** Envelopes found (secrets rows plus sealed fields). */
    envelopes: number;
    /** Decrypt in the source with this master key. */
    decryptInSource: number;
    /** Decrypted on both sides with equal plaintext hashes. */
    verified: number;
    /** Already undecryptable in the source with this master key (copied byte for byte). */
    undecryptableInSource: number;
    ok: boolean;
  };
  /**
   * 'committed' after a verified COMMIT; 'rolled-back' when verification failed inside the
   * transaction; 'unknown' when the post-COMMIT check failed; 'none' on a dry run.
   */
  outcome: 'committed' | 'rolled-back' | 'unknown' | 'none';
  attachments: { referenced: number; checked: number; resolved: number };
  sanitized: { table: string; column: string; count: number }[];
  /** Why the copy is not trusted; empty on success. */
  failures: string[];
  warnings: string[];
  /** Notes about the target's state (dry run). */
  notes: string[];
  durationMs: number;
}

const DEFAULT_BATCH_ROWS = 500;
const DEFAULT_ATTACHMENT_SAMPLE = 500;
/** Postgres accepts at most 65535 bind parameters per statement. */
const MAX_PARAMS = 60_000;
/** Tables the SQLite file may hold besides the schema's own. */
const SQLITE_OWN_TABLES = new Set(['__drizzle_migrations', 'search_index']);

interface SourceRow {
  key: string;
  params: SourceValue['param'][];
  values: Map<string, SourceValue['param']>;
}

interface SourceTable {
  spec: TableSpec;
  rows: SourceRow[];
  /** Canonical line per row key (what the target must read back). */
  lines: Map<string, string>;
  checksum: string;
  sanitized: number;
  reencoded: number;
}

interface IndexRow {
  kind: SearchKind;
  id: string;
  userId: string;
  text: string;
}

const short = (checksum: string | null) => (checksum === null ? '-' : checksum.slice(0, 16));
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// Source

function checkSource(source: SqliteSnapshot, specs: TableSpec[]): void {
  const known = new Set(specs.map((s) => s.name));
  const tables = source.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
  );
  const names = new Set(tables.map((t) => t.name));
  if (!names.has('__drizzle_migrations')) {
    throw new CopyRefused('the source is not an Opportun database (no migration bookkeeping)');
  }
  const last = source.all<{ created_at: bigint | number | string }>(
    'SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1',
  )[0];
  const head = knownMigrationHead('sqlite');
  const at = last === undefined ? 0 : Number(last.created_at);
  if (at !== head) {
    throw new CopyRefused(
      at < head
        ? 'the source database is behind this release: start this release once on SQLite (it migrates the database), stop it, then run the copy again'
        : 'the source database was migrated by a newer release: run the copy tool of that release',
    );
  }
  const unknown = [...names].filter(
    (n) => !known.has(n) && !SQLITE_OWN_TABLES.has(n) && !n.startsWith('search_index_'),
  );
  if (unknown.length > 0) {
    throw new CopyRefused(
      `the source holds tables this release does not know: ${unknown.join(', ')}`,
    );
  }
  const missing = specs.filter((s) => !names.has(s.name)).map((s) => s.name);
  if (missing.length > 0) throw new CopyRefused(`the source lacks tables: ${missing.join(', ')}`);
  const check = source.all<{ quick_check: string }>('PRAGMA quick_check');
  if (check.length !== 1 || check[0]?.quick_check !== 'ok') {
    throw new CopyRefused('the source database fails PRAGMA quick_check: restore a backup first');
  }
  const orphans = source.all<{ table: string }>('PRAGMA foreign_key_check');
  if (orphans.length > 0) {
    const counts = new Map<string, number>();
    for (const o of orphans) counts.set(o.table, (counts.get(o.table) ?? 0) + 1);
    const list = [...counts].map(([t, n]) => `${t} (${n})`).join(', ');
    throw new CopyRefused(
      `the source has rows whose foreign keys point at missing rows, which Postgres would reject: ${list}`,
    );
  }
}

function readSource(
  source: SqliteSnapshot,
  spec: TableSpec,
  counters: Map<string, SanitizeCounter>,
): SourceTable {
  const cols = spec.columns.map((c) => quote(c.name)).join(', ');
  const raw = source.all<Record<string, unknown>>(`SELECT ${cols} FROM ${quote(spec.name)}`);
  const digest = new TableDigest(spec.name);
  const lines = new Map<string, string>();
  let reencoded = 0;
  const counterOf = (column: string) => {
    const id = `${spec.name}.${column}`;
    let c = counters.get(id);
    if (c === undefined) {
      c = { count: 0 };
      counters.set(id, c);
    }
    return c;
  };
  const rows = raw.map((r, index) => {
    // The key for messages before the row's own key is known: its position.
    const provisional = `#${index + 1}`;
    const pkCells = new Map<string, string>();
    for (const name of spec.pk) {
      const kind = spec.columns.find((c) => c.name === name)?.kind ?? 'text';
      const site = { table: spec.name, column: name, rowKey: provisional };
      pkCells.set(name, fromSqlite(kind, r[name], site, { count: 0 }).cell);
    }
    const key = rowKey(spec, pkCells);
    const cells = new Map<string, string>();
    const values = new Map<string, SourceValue['param']>();
    let rowReencoded = false;
    const params = spec.columns.map((c) => {
      const v = fromSqlite(
        c.kind,
        r[c.name],
        { table: spec.name, column: c.name, rowKey: key },
        counterOf(c.name),
      );
      if (v.reencoded === true) rowReencoded = true;
      cells.set(c.name, v.cell);
      values.set(c.name, v.param);
      return v.param;
    });
    const line = rowLine(spec, cells);
    digest.add(key, line);
    lines.set(key, line);
    if (rowReencoded) reencoded += 1;
    return { key, params, values };
  });
  const sanitized = spec.columns.reduce(
    (n, c) => n + (counters.get(`${spec.name}.${c.name}`)?.count ?? 0),
    0,
  );
  return { spec, rows, lines, checksum: digest.finish().checksum, sanitized, reencoded };
}

function readSourceIndex(source: SqliteSnapshot): IndexRow[] {
  return source
    .all<{ entity_kind: string; entity_id: string; user_id: string; text: string | null }>(
      'SELECT entity_kind, entity_id, user_id, text FROM search_index',
    )
    .map((r) => ({
      kind: r.entity_kind as SearchKind,
      id: String(r.entity_id),
      userId: String(r.user_id),
      text: r.text ?? '',
    }));
}

// ---------------------------------------------------------------------------
// Vault

/** Every vault envelope of one row: the secrets table's columns, or sealed text/JSON values. */
function envelopesOf(
  spec: TableSpec,
  key: string,
  value: (column: string) => unknown,
): { id: string; sealed: SealedEnvelope }[] {
  if (spec.name === 'secrets') {
    return [
      {
        id: `secrets ${key}`,
        sealed: {
          ciphertext: String(value('ciphertext')),
          iv: String(value('iv')),
          tag: String(value('tag')),
          keyVersion: Number(value('key_version')),
        },
      },
    ];
  }
  const out: { id: string; sealed: SealedEnvelope }[] = [];
  for (const c of spec.columns) {
    if (c.kind !== 'text' && c.kind !== 'json') continue;
    const v = value(c.name);
    if (typeof v !== 'string' || !v.includes('ciphertext')) continue;
    const decoded = c.kind === 'json' ? (JSON.parse(v) as unknown) : v;
    let found: { path: string; sealed: SealedEnvelope }[];
    try {
      found = sealedEnvelopes(decoded);
    } catch (err) {
      if (!(err instanceof MalformedEnvelope)) throw err;
      // Re-thrown with the row and column this value actually came from: sealedEnvelopes
      // only ever sees the decoded value, not where it was read from.
      throw new MalformedEnvelope(`${spec.name} ${key} ${c.name}: ${err.message}`);
    }
    for (const e of found) {
      out.push({ id: `${spec.name} ${key} ${c.name}${e.path.slice(1)}`, sealed: e.sealed });
    }
  }
  return out;
}

/** Plaintext SHA-256 per envelope id; undefined when it does not decrypt with `key`. */
function vaultHashes(
  items: { id: string; sealed: SealedEnvelope }[],
  key: Buffer,
): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const { id, sealed } of items) {
    let hash: string | undefined;
    try {
      hash = sha256(openSealed(key, sealed));
    } catch {
      hash = undefined;
    }
    out.set(id, hash);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Target

async function targetHead(session: PgSession): Promise<number | undefined> {
  const exists = await session.query<{ t: string | null }>(
    "SELECT to_regclass('public.__drizzle_migrations')::text AS t",
  );
  if (exists.rows[0]?.t == null) return undefined;
  const last = await session.query<{ created_at: number }>(
    'SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1',
  );
  return last.rows[0]?.created_at;
}

/** The target's rows of one table as canonical lines by key (read back for verification). */
async function readTarget(
  session: PgSession,
  spec: TableSpec,
): Promise<{ lines: Map<string, string>; rows: Record<string, unknown>[] }> {
  const cols = spec.columns.map((c) => quote(c.name)).join(', ');
  const res = await session.query<Record<string, unknown>>(
    `SELECT ${cols} FROM ${quote(spec.name)}`,
  );
  const lines = new Map<string, string>();
  for (const r of res.rows) {
    const cells = new Map(spec.columns.map((c) => [c.name, fromPg(c.kind, r[c.name])]));
    lines.set(rowKey(spec, cells), rowLine(spec, cells));
  }
  return { lines, rows: res.rows };
}

function checksumOf(table: string, lines: Map<string, string>): string {
  const digest = new TableDigest(table);
  for (const [k, l] of lines) digest.add(k, l);
  return digest.finish().checksum;
}

/** Tables in the target's public schema. */
async function publicTables(session: PgSession): Promise<string[]> {
  const res = await session.query<{ name: string }>(
    "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return res.rows.map((r) => r.name);
}

/** Refuses a target holding anything but its own migrations' system prompts. */
async function checkTargetEmpty(session: PgSession, specs: TableSpec[]): Promise<void> {
  const busy: string[] = [];
  const present = new Set(await publicTables(session));
  for (const spec of specs) {
    if (!present.has(spec.name)) continue;
    const where = spec.name === 'prompts' ? ' WHERE user_id IS NOT NULL' : '';
    const res = await session.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${quote(spec.name)}${where}`,
    );
    const n = res.rows[0]?.n ?? 0;
    if (n > 0) busy.push(`${spec.name} (${n})`);
  }
  if (present.has('search_index')) {
    const index = await session.query<{ n: number }>('SELECT count(*)::int AS n FROM search_index');
    if ((index.rows[0]?.n ?? 0) > 0) busy.push(`search_index (${index.rows[0]?.n})`);
  }
  if (busy.length > 0) {
    throw new CopyRefused(
      `the target database is not empty: ${busy.join(', ')}. The copy only fills a new, empty database; create one (docs/install.md) and point DATABASE_URL at it`,
    );
  }
}

/** Keys of the seeded system prompts, after checking they equal the source's rows. */
async function seededPromptKeys(session: PgSession, source: SourceTable): Promise<Set<string>> {
  const { lines } = await readTarget(session, source.spec);
  const keys = new Set<string>();
  for (const [key, line] of lines) {
    if (source.lines.get(key) !== line) {
      throw new CopyRefused(
        `system prompt ${key} differs between the source and the target's migrations: run the copy tool of the release the source was last migrated by`,
      );
    }
    keys.add(key);
  }
  return keys;
}

async function insertRows(
  session: PgSession,
  spec: TableSpec,
  rows: SourceRow[],
  batchRows: number,
): Promise<void> {
  const cols = spec.columns.map((c) => quote(c.name)).join(', ');
  const width = spec.columns.length;
  const perBatch = Math.max(1, Math.min(batchRows, Math.floor(MAX_PARAMS / width)));
  for (let start = 0; start < rows.length; start += perBatch) {
    const batch = rows.slice(start, start + perBatch);
    const params: unknown[] = [];
    const tuples = batch.map((row) => {
      const slots = row.params.map((p) => {
        params.push(p);
        return `$${params.length}`;
      });
      return `(${slots.join(', ')})`;
    });
    await session.query(
      `INSERT INTO ${quote(spec.name)} (${cols}) VALUES ${tuples.join(', ')}`,
      params,
    );
  }
}

/** The source rows of `table` in insertion order (parents first for self-references). */
function insertionOrder(table: SourceTable, skip: Set<string>): SourceRow[] {
  const rows = table.rows.filter((r) => !skip.has(r.key));
  const { spec } = table;
  if (spec.selfRefs.length === 0) return rows;
  const idColumn = spec.selfRefs[0]?.references ?? 'id';
  const asId = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return parentsFirst(
    rows,
    (r) => String(r.values.get(idColumn)),
    spec.selfRefs.map((ref) => (r: SourceRow) => asId(r.values.get(ref.column))),
  );
}

// ---------------------------------------------------------------------------
// Search

const INDEXED: Record<SearchKind, string> = {
  opportunity: 'opportunities',
  activity: 'activities',
  communication: 'communications',
  contact: 'contacts',
};

interface Rebuild {
  rows: IndexRow[];
  orphans: number;
  duplicates: number;
}

/** The SQLite index's membership, deduplicated, without rows whose entity is gone. */
function rebuildSet(index: IndexRow[], tables: Map<string, SourceTable>): Rebuild {
  const owners = new Map<string, string>();
  for (const kind of SEARCH_KINDS) {
    for (const row of tables.get(INDEXED[kind])?.rows ?? []) {
      owners.set(`${kind}\u0000${String(row.values.get('id'))}`, String(row.values.get('user_id')));
    }
  }
  const seen = new Set<string>();
  const rows: IndexRow[] = [];
  let orphans = 0;
  let duplicates = 0;
  for (const r of index) {
    const id = `${r.kind}\u0000${r.id}\u0000${r.userId}`;
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
    if (owners.get(`${r.kind}\u0000${r.id}`) !== r.userId) {
      orphans += 1;
      continue;
    }
    rows.push(r);
  }
  return { rows, orphans, duplicates };
}

async function rebuildIndex(
  session: PgSession,
  plan: Rebuild,
  tables: Map<string, SourceTable>,
): Promise<void> {
  const byId = new Map<string, Map<string, SourceValue['param']>>();
  for (const kind of SEARCH_KINDS) {
    for (const row of tables.get(INDEXED[kind])?.rows ?? []) {
      byId.set(`${kind}\u0000${String(row.values.get('id'))}`, row.values);
    }
  }
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  for (const r of plan.rows) {
    const v = byId.get(`${r.kind}\u0000${r.id}`);
    if (v === undefined) continue;
    const ctx: UserCtx = { userId: r.userId, isAdmin: false };
    const id = r.id;
    if (r.kind === 'opportunity') {
      await indexOpportunity(session.db, ctx, {
        id,
        title: String(v.get('title')),
        descriptionMd: str(v.get('description_md')),
      });
    } else if (r.kind === 'activity') {
      await indexActivity(session.db, ctx, {
        id,
        title: String(v.get('title')),
        bodyMd: str(v.get('body_md')),
      });
    } else if (r.kind === 'communication') {
      await indexCommunication(session.db, ctx, {
        id,
        subject: str(v.get('subject')),
        snippet: str(v.get('snippet')),
      });
    } else {
      await indexContact(session.db, ctx, {
        id,
        name: String(v.get('name')),
        notes: str(v.get('notes')),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Attachments

/** Content-addressed files referenced by rows: attachments.stored_path, communications.body_ref. */
function attachmentRefs(tables: Map<string, SourceTable>): string[] {
  const refs = new Set<string>();
  for (const row of tables.get('attachments')?.rows ?? []) {
    const p = row.values.get('stored_path');
    if (typeof p === 'string') refs.add(p);
  }
  for (const row of tables.get('communications')?.rows ?? []) {
    const p = row.values.get('body_ref');
    if (typeof p === 'string') refs.add(p);
  }
  return [...refs].sort();
}

/** Evenly spaced references (all of them when `sample` is 0 or covers them). */
function sampleOf(refs: string[], sample: number): string[] {
  if (sample <= 0 || refs.length <= sample) return refs;
  const step = refs.length / sample;
  return Array.from({ length: sample }, (_, i) => refs[Math.floor(i * step)] as string);
}

async function checkAttachments(
  dataDir: string,
  sqliteDir: string,
  refs: string[],
  sample: number,
): Promise<{ checked: number; resolved: number; missing: string[] }> {
  const storage = createStorage(dataDir, sqliteDir);
  const picked = sampleOf(refs, sample);
  const missing: string[] = [];
  for (const ref of picked) {
    try {
      const hash = createHash('sha256');
      for await (const chunk of await storage.openAttachment(ref)) hash.update(chunk as Buffer);
      // Content-addressed: the file name is the SHA-256 of its bytes.
      if (!ref.endsWith(`/${hash.digest('hex')}`))
        missing.push(`${ref} (content does not match its hash)`);
    } catch {
      missing.push(ref);
    }
  }
  return { checked: picked.length, resolved: picked.length - missing.length, missing };
}

// ---------------------------------------------------------------------------
// The copy

/** Copies and verifies; resolves with the report (ok false names every failure). */
export async function copyToPostgres(opts: CopyOptions): Promise<CopyReport> {
  const progress = { target: 'untouched' as TargetState };
  try {
    return await runCopy(opts, progress);
  } catch (err) {
    if (err instanceof CopyRefused) {
      if (progress.target !== 'untouched') err.afterMigrate = true;
      throw err;
    }
    if (err instanceof CopyFailed) throw err;
    if (err instanceof CopyDataError) {
      throw new CopyFailed(err.message, progress.target, { cause: err });
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new CopyFailed(message, progress.target, { cause: err });
  }
}

/** The source file's state, to notice a server writing to it during the copy. */
function sourceStamp(file: string): string {
  const db = operatorFileStat(file);
  const wal = operatorFileStat(`${file}-wal`);
  return JSON.stringify([db?.bytes, db?.mtimeMs, wal?.bytes ?? 0]);
}

async function runCopy(opts: CopyOptions, progress: { target: TargetState }): Promise<CopyReport> {
  const started = performance.now();
  const log = opts.log ?? (() => undefined);
  const dryRun = opts.dryRun === true;
  if (SCHEMA_DIALECT !== 'postgres') {
    throw new CopyRefused(
      'run the copy tool with DB_DIALECT=postgres (and DATABASE_URL set to the target)',
    );
  }
  const dataDir = resolve(opts.dataDir);
  const sqliteDir = resolve(opts.sqliteDir ?? opts.dataDir);
  const file = join(sqliteDir, 'opportun.db');
  if (!isOperatorFile(file)) throw new CopyRefused(`no SQLite database at ${file}`);
  if ((operatorFileStat(`${file}-wal`)?.bytes ?? 0) > 0) {
    throw new CopyRefused(
      `${file}-wal is not empty: the server is still running, or did not stop cleanly. Stop it (or start and stop it once), then run the copy again`,
    );
  }
  const stampBefore = sourceStamp(file);

  const specs = copyOrder(tableSpecs());
  const counters = new Map<string, SanitizeCounter>();
  const tables = new Map<string, SourceTable>();
  let index: IndexRow[];
  const source = openSqliteSnapshot(file);
  try {
    checkSource(source, specs);
    for (const spec of specs) tables.set(spec.name, readSource(source, spec, counters));
    index = readSourceIndex(source);
  } catch (err) {
    if (err instanceof CopyDataError)
      throw new CopyRefused(`the source cannot be copied faithfully: ${err.message}`);
    throw err;
  } finally {
    source.close();
  }
  const sanitized = [...counters]
    .filter(([, c]) => c.count > 0)
    .map(([id, c]) => {
      const [table = '', column = ''] = id.split('.');
      return { table, column, count: c.count };
    });
  for (const s of sanitized) {
    log(
      `sanitized ${s.count} value(s) in ${s.table}.${s.column}: NUL characters or lone surrogates removed (Postgres rejects them)`,
    );
  }

  // The vault check is never vacuous: it runs on the source before anything else happens.
  // A value that names a ciphertext key but will not parse as one is collected here rather
  // than bailing on the first one, so a single refusal names every row affected (#148): a
  // shrug is not an option for the one check whose entire job is proving the copy is honest.
  const malformed: string[] = [];
  const sourceVault = [...tables.values()].flatMap((t) =>
    t.rows.flatMap((r) => {
      try {
        return envelopesOf(t.spec, r.key, (c) => r.values.get(c));
      } catch (err) {
        if (!(err instanceof MalformedEnvelope)) throw err;
        malformed.push(err.message);
        return [];
      }
    }),
  );
  if (malformed.length > 0) {
    throw new CopyRefused(
      `${malformed.length} value(s) in the source look like a sealed vault secret (they name a ciphertext key) but do not parse as one: ${malformed.slice(0, 5).join('; ')}. The source may be corrupted; this has no safe byte-for-byte fallback, unlike an undecryptable value, because a malformed envelope cannot be proven to hold the secret it claims to at all.`,
    );
  }
  const sourceHashes = vaultHashes(sourceVault, opts.masterKey);
  const undecryptableIds = [...sourceHashes].filter(([, h]) => h === undefined).map(([id]) => id);
  const undecryptable = undecryptableIds.length;
  if (sourceVault.length > 0 && undecryptable === sourceVault.length) {
    throw new CopyRefused(
      `the master key does not open the source vault (0 of ${sourceVault.length} values decrypt): use the OPPORTUN_MASTER_KEY of the deployment that wrote this database`,
    );
  }
  const warnings: string[] = [];
  if (undecryptable > 0) {
    if (opts.allowUndecryptable !== true) {
      throw new CopyRefused(
        `${undecryptable} vault value(s) do not decrypt with this master key in the source: ${undecryptableIds.slice(0, 5).join('; ')}. Check the key; to copy them anyway, byte for byte, pass --allow-undecryptable`,
      );
    }
    for (const id of undecryptableIds) {
      warnings.push(
        `vault value ${id} does not decrypt in the source with this master key (copied byte for byte, allowed by --allow-undecryptable)`,
      );
    }
  }
  const rebuild = rebuildSet(index, tables);
  const failures: string[] = [];
  const notes: string[] = [];
  if (rebuild.orphans > 0)
    warnings.push(
      `${rebuild.orphans} search index row(s) whose entity is missing or not the row's user (not rebuilt)`,
    );
  if (rebuild.duplicates > 0)
    warnings.push(
      `${rebuild.duplicates} duplicate search index row(s) in the source (rebuilt once)`,
    );
  const refs = attachmentRefs(tables);
  const files = await checkAttachments(
    dataDir,
    sqliteDir,
    refs,
    opts.attachmentSample ?? DEFAULT_ATTACHMENT_SAMPLE,
  );
  for (const m of files.missing.slice(0, 10))
    warnings.push(`attachment not found under DATA_DIR: ${m}`);
  if (files.missing.length > 10)
    warnings.push(`... and ${files.missing.length - 10} more missing attachments`);

  const report: CopyReport = {
    ok: false,
    dryRun,
    tables: specs.map((spec) => {
      const t = tables.get(spec.name) as SourceTable;
      return {
        name: spec.name,
        sourceRows: t.rows.length,
        targetRows: null,
        seededRows: 0,
        sourceChecksum: t.checksum,
        targetChecksum: null,
        sanitized: t.sanitized,
        reencoded: t.reencoded,
        ok: dryRun,
      };
    }),
    search: {
      sourceRows: index.length,
      rebuiltRows: rebuild.rows.length,
      targetRows: null,
      orphans: rebuild.orphans,
      textRefreshed: 0,
      ok: dryRun,
    },
    vault: {
      envelopes: sourceVault.length,
      decryptInSource: sourceVault.length - undecryptable,
      verified: 0,
      undecryptableInSource: undecryptable,
      ok: dryRun,
    },
    attachments: { referenced: refs.length, checked: files.checked, resolved: files.resolved },
    sanitized,
    failures,
    warnings,
    notes,
    outcome: 'none',
    durationMs: 0,
  };
  const finish = () => {
    report.ok = failures.length === 0;
    report.durationMs = Math.round(performance.now() - started);
    return report;
  };

  // The target is inspected before anything is written to it, migrations included.
  const session = await openPgSession(opts.target);
  try {
    if (session.collation !== undefined) throw new CopyRefused(`target: ${session.collation}`);
    const head = await targetHead(session);
    const pgHead = knownMigrationHead('postgres');
    if (head === undefined) {
      const foreign = await publicTables(session);
      if (foreign.length > 0) {
        throw new CopyRefused(
          `the target database holds tables but no Opportun migrations: ${foreign.slice(0, 10).join(', ')}. Point DATABASE_URL at a new, empty database`,
        );
      }
    } else {
      if (head > pgHead)
        throw new CopyRefused('the target database was migrated by a newer release');
      await checkTargetEmpty(session, specs);
    }
    const promptsSource = tables.get('prompts') as SourceTable;
    if (dryRun) {
      if (head === undefined)
        notes.push('target is not migrated yet: the copy migrates it to head first');
      else if (head < pgHead) notes.push('target is behind: the copy migrates it to head first');
      if (head === pgHead) {
        const seeded = await seededPromptKeys(session, promptsSource);
        const row = report.tables.find((t) => t.name === 'prompts');
        if (row !== undefined) row.seededRows = seeded.size;
        notes.push('target is migrated and empty');
      }
      return finish();
    }
    if (head !== pgHead) {
      await session.migrate();
      progress.target = 'migrated';
      if ((await targetHead(session)) !== pgHead) {
        throw new CopyRefused('the target did not reach the Postgres migration head');
      }
      await checkTargetEmpty(session, specs);
    }
    const seeded = await seededPromptKeys(session, promptsSource);
    progress.target = 'migrated';

    const verify: VerifyContext = {
      specs,
      tables,
      report,
      rebuild,
      sourceHashes,
      masterKey: opts.masterKey,
      seeded,
    };
    await session.query('BEGIN');
    try {
      for (const [i, spec] of specs.entries()) {
        const t = tables.get(spec.name) as SourceTable;
        const skip = spec.name === 'prompts' ? seeded : new Set<string>();
        const rows = insertionOrder(t, skip);
        try {
          await insertRows(session, spec, rows, opts.batchRows ?? DEFAULT_BATCH_ROWS);
        } catch (err) {
          throw new Error(
            `copying ${spec.name}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        const n = String(i + 1).padStart(2);
        log(
          `[${n}/${specs.length}] ${spec.name}: ${rows.length} row(s)${skip.size > 0 ? ` (+${skip.size} seeded)` : ''}`,
        );
      }
      await rebuildIndex(session, rebuild, tables);
      log(`search index: ${rebuild.rows.length} row(s) rebuilt through the indexers`);
      await opts.beforeVerify?.(session.query);

      log('verifying inside the transaction...');
      failures.push(...(await verifyTarget(session, verify, '')));
    } catch (err) {
      await rollback(session, progress);
      throw err;
    }
    if (failures.length > 0) {
      await rollback(session, progress);
      report.outcome = 'rolled-back';
      return finish();
    }
    // From here the outcome is not known until COMMIT answers, and a failed post-COMMIT
    // check leaves a target that must be verified before either side is trusted.
    progress.target = 'unknown';
    await session.query('COMMIT');
    await opts.afterCommit?.(session.query);

    log('verifying the committed copy...');
    failures.push(...(await verifyTarget(session, verify, 'after COMMIT: ')));
    report.outcome = failures.length === 0 ? 'committed' : 'unknown';
    if (sourceStamp(file) !== stampBefore) {
      warnings.push(
        'WARNING: the SQLite source changed while it was being copied (was the server started?): writes made after the snapshot are not in Postgres. Stop the server, drop and recreate the target database, and copy again',
      );
    }
    return finish();
  } finally {
    await session.close();
  }
}

/** ROLLBACK; if even that fails, the target's state is unknown. */
async function rollback(session: PgSession, progress: { target: TargetState }): Promise<void> {
  try {
    await session.query('ROLLBACK');
  } catch {
    progress.target = 'unknown';
  }
}

interface VerifyContext {
  specs: TableSpec[];
  tables: Map<string, SourceTable>;
  report: CopyReport;
  rebuild: Rebuild;
  sourceHashes: Map<string, string | undefined>;
  masterKey: Buffer;
  seeded: Set<string>;
}

/**
 * Compares the target with the source: per table row count, checksum and (JSON columns)
 * server-side jsonb equality; search index membership; vault plaintext hashes. Updates the
 * report (a later pass can only turn an 'ok' into a mismatch) and returns the failures,
 * each prefixed with `label`.
 */
async function verifyTarget(
  session: PgSession,
  ctx: VerifyContext,
  label: string,
): Promise<string[]> {
  const failures: string[] = [];
  const first = label === '';
  const targetVault: { id: string; sealed: SealedEnvelope }[] = [];
  for (const spec of ctx.specs) {
    const source = ctx.tables.get(spec.name) as SourceTable;
    const row = ctx.report.tables.find((r) => r.name === spec.name) as TableReport;
    const { lines, rows } = await readTarget(session, spec);
    const targetChecksum = checksumOf(spec.name, lines);
    let ok = true;
    if (lines.size !== row.sourceRows) {
      ok = false;
      failures.push(
        `${label}row count mismatch in ${spec.name}: source ${row.sourceRows}, target ${lines.size}`,
      );
    } else if (targetChecksum !== row.sourceChecksum) {
      ok = false;
      const bad = [...lines].filter(([k, l]) => source.lines.get(k) !== l).map(([k]) => k);
      failures.push(
        `${label}checksum mismatch in ${spec.name}: ${bad.length} row(s) differ (first: ${bad.slice(0, 3).join(', ')})`,
      );
    }
    for (const mismatch of await jsonMismatches(session, source)) {
      ok = false;
      failures.push(`${label}${mismatch}`);
    }
    if (first) {
      row.targetRows = lines.size;
      row.targetChecksum = targetChecksum;
      row.seededRows = spec.name === 'prompts' ? ctx.seeded.size : 0;
      row.ok = ok;
    } else if (!ok) {
      row.ok = false;
    }
    for (const r of rows) {
      const cells = new Map(spec.columns.map((c) => [c.name, fromPg(c.kind, r[c.name])]));
      targetVault.push(...envelopesOf(spec, rowKey(spec, cells), (c) => r[c]));
    }
  }
  const search = verifySearch(await readTargetIndex(session), ctx.rebuild);
  const vault = verifyVault(ctx.sourceHashes, vaultHashes(targetVault, ctx.masterKey));
  if (first) {
    ctx.report.search.targetRows = search.targetRows;
    ctx.report.search.textRefreshed = search.textRefreshed;
    ctx.report.search.ok = search.failure === undefined;
    ctx.report.vault.verified = vault.verified;
    ctx.report.vault.ok =
      vault.failure === undefined && ctx.report.vault.undecryptableInSource === 0;
  } else {
    if (search.failure !== undefined) ctx.report.search.ok = false;
    if (vault.failure !== undefined) ctx.report.vault.ok = false;
  }
  if (search.failure !== undefined) failures.push(`${label}${search.failure}`);
  if (vault.failure !== undefined) failures.push(`${label}${vault.failure}`);
  return failures;
}

const CASTS: Record<TableSpec['columns'][number]['kind'], string> = {
  text: 'text',
  json: 'jsonb',
  int: 'bigint',
  real: 'double precision',
  bool: 'boolean',
};

/**
 * JSON columns compared by the server: each stored jsonb against the source's JSON text cast
 * to jsonb (jsonb equality compares numbers exactly), batched. This catches what the
 * checksum, which compares values parsed into doubles, cannot: a number beyond 2^53 or a
 * decimal that rounds to the same double. Rows whose JSON was re-encoded after cleaning are
 * compared with the cleaned value (counted in the report as re-encoded).
 */
async function jsonMismatches(session: PgSession, table: SourceTable): Promise<string[]> {
  const { spec } = table;
  const json = spec.columns.flatMap((c, i) => (c.kind === 'json' ? [{ name: c.name, i }] : []));
  if (json.length === 0 || table.rows.length === 0) return [];
  const pk = spec.pk.map((name) => {
    const i = spec.columns.findIndex((c) => c.name === name);
    return { name, i, cast: CASTS[spec.columns[i]?.kind ?? 'text'] };
  });
  const differing = json.map(() => [] as string[]);
  const perBatch = Math.max(1, Math.floor(30_000 / (1 + pk.length + json.length)));
  for (let start = 0; start < table.rows.length; start += perBatch) {
    const batch = table.rows.slice(start, start + perBatch);
    const params: unknown[] = [];
    const slot = (value: unknown, cast: string) => {
      params.push(value);
      return `$${params.length}::${cast}`;
    };
    const tuples = batch.map((row, r) => {
      const cells = [
        slot(start + r, 'int'),
        ...pk.map((k) => slot(row.params[k.i], k.cast)),
        ...json.map((j) => slot(row.params[j.i], 'jsonb')),
      ];
      return `(${cells.join(', ')})`;
    });
    const names = ['r', ...pk.map((_, i) => `p${i}`), ...json.map((_, i) => `j${i}`)];
    const differs = json.map((j, i) => `t.${quote(j.name)} IS DISTINCT FROM v.j${i}`);
    const res = await session.query<Record<string, unknown>>(
      `SELECT v.r, ${differs.map((d, i) => `(${d}) AS d${i}`).join(', ')}
         FROM (VALUES ${tuples.join(', ')}) AS v(${names.join(', ')})
         JOIN ${quote(spec.name)} t ON ${pk.map((k, i) => `t.${quote(k.name)} = v.p${i}`).join(' AND ')}
        WHERE ${differs.join(' OR ')}`,
      params,
    );
    for (const r of res.rows) {
      const key = table.rows[Number(r.r)]?.key ?? '?';
      json.forEach((_, i) => {
        if (r[`d${i}`] === true) differing[i]?.push(key);
      });
    }
  }
  return json.flatMap((j, i) => {
    const keys = differing[i] ?? [];
    return keys.length === 0
      ? []
      : [
          `JSON mismatch in ${spec.name}.${j.name}: ${keys.length} row(s) differ (first: ${keys.slice(0, 3).join(', ')})`,
        ];
  });
}

async function readTargetIndex(session: PgSession): Promise<IndexRow[]> {
  const res = await session.query<{
    entity_kind: SearchKind;
    entity_id: string;
    user_id: string;
    text: string;
  }>('SELECT entity_kind, entity_id, user_id, text FROM search_index WHERE tsv IS NOT NULL');
  return res.rows.map((r) => ({
    kind: r.entity_kind,
    id: r.entity_id,
    userId: r.user_id,
    text: r.text,
  }));
}

function verifySearch(
  target: IndexRow[],
  plan: Rebuild,
): { targetRows: number; textRefreshed: number; failure: string | undefined } {
  const id = (r: IndexRow) => `${r.kind}\u0000${r.id}\u0000${r.userId}`;
  const expected = new Map(plan.rows.map((r) => [id(r), r]));
  const got = new Set(target.map(id));
  const missing = [...expected.keys()].filter((k) => !got.has(k)).length;
  const extra = [...got].filter((k) => !expected.has(k)).length;
  const textRefreshed = target.filter((r) => {
    const e = expected.get(id(r));
    return e !== undefined && e.text !== r.text;
  }).length;
  return {
    targetRows: target.length,
    textRefreshed,
    failure:
      missing === 0 && extra === 0
        ? undefined
        : `search_index membership differs: ${missing} missing, ${extra} unexpected`,
  };
}

function verifyVault(
  source: Map<string, string | undefined>,
  target: Map<string, string | undefined>,
): { verified: number; failure: string | undefined } {
  let verified = 0;
  const bad: string[] = [];
  for (const [id, hash] of source) {
    if (!target.has(id)) {
      bad.push(`${id} missing`);
      continue;
    }
    const other = target.get(id);
    if (hash === undefined) {
      if (other !== undefined) bad.push(`${id} decrypts only in the target`);
      continue;
    }
    if (other === undefined) bad.push(`${id} does not decrypt in the target`);
    else if (other !== hash) bad.push(`${id} decrypts to different plaintext`);
    else verified += 1;
  }
  for (const id of target.keys()) if (!source.has(id)) bad.push(`${id} unexpected`);
  return {
    verified,
    failure:
      bad.length === 0
        ? undefined
        : `vault check failed for ${bad.length} value(s): ${bad.slice(0, 3).join('; ')}`,
  };
}

function vaultStatus(report: CopyReport): string {
  const v = report.vault;
  if (v.undecryptableInSource > 0) {
    return `NOT VERIFIED (${v.undecryptableInSource} undecryptable value(s) allowed by --allow-undecryptable)${v.ok || report.dryRun ? '' : '; MISMATCH'}`;
  }
  if (report.dryRun) return 'planned';
  return v.ok ? 'ok' : 'MISMATCH';
}

/** The report as a table, for the terminal. */
export function formatReport(report: CopyReport): string {
  const head = [
    'table',
    'source rows',
    'target rows',
    'seeded',
    'sanitized',
    're-encoded',
    'source checksum',
    'target checksum',
    'status',
  ];
  const rows = report.tables.map((t) => [
    t.name,
    String(t.sourceRows),
    t.targetRows === null ? '-' : String(t.targetRows),
    String(t.seededRows),
    String(t.sanitized),
    String(t.reencoded),
    short(t.sourceChecksum),
    short(t.targetChecksum),
    report.dryRun ? 'planned' : t.ok ? 'ok' : 'MISMATCH',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === 0 || i >= 6 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  const out = [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)];
  const s = report.search;
  out.push(
    '',
    `search_index: ${s.sourceRows} row(s) in the SQLite index, ${s.rebuiltRows} rebuilt, ${s.targetRows ?? '-'} in the target, ${s.orphans} skipped (entity missing or not the row's user), ${s.textRefreshed} with refreshed text: ${report.dryRun ? 'planned' : s.ok ? 'ok' : 'MISMATCH'}`,
    `vault: ${report.vault.envelopes} envelope(s); source: ${report.vault.decryptInSource} decrypt, ${report.vault.undecryptableInSource} do not; target: ${report.dryRun ? '-' : report.vault.verified} decrypt to the same plaintext (SHA-256 compared): ${vaultStatus(report)}`,
    `attachments: ${report.attachments.referenced} referenced, ${report.attachments.checked} checked under DATA_DIR, ${report.attachments.resolved} resolved`,
  );
  if (report.sanitized.length > 0) {
    const total = report.sanitized.reduce((n, s) => n + s.count, 0);
    out.push(
      `sanitized: ${total} value(s) in ${report.sanitized.length} column(s) had NUL characters or lone surrogates removed (listed above)`,
    );
  }
  const reencoded = report.tables.reduce((n, t) => n + t.reencoded, 0);
  if (reencoded > 0) {
    out.push(
      `re-encoded: ${reencoded} row(s) hold JSON re-encoded after cleaning; they are verified against the cleaned value, not the source text`,
    );
  }
  if (!report.dryRun) {
    out.push(
      'checked: inside the transaction and again after COMMIT: row counts, checksums, JSON values (jsonb equality), the search index and the vault',
    );
  }
  for (const n of report.notes) out.push(`note: ${n}`);
  for (const w of report.warnings) out.push(`warning: ${w}`);
  for (const f of report.failures) out.push(`FAILED: ${f}`);
  out.push(`duration: ${(report.durationMs / 1000).toFixed(1)} s`);
  return out.join('\n');
}
