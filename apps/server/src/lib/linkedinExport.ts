// LinkedIn data export import (FR-C2, FR-M6 export part). The user downloads their data export
// from LinkedIn and uploads the ZIP; that upload is the ONLY LinkedIn data path (C-1): nothing
// in the app ever contacts LinkedIn (safeFetch prohibits its hosts), and profile URLs are stored
// as metadata only.
//
// Connections.csv (a "Notes:" preamble precedes the header; BOM and CRLF) becomes contacts,
// upserted on linkedin_url, else on name + company, with a history entry appended when the
// company or position changed. messages.csv becomes communications on channel 'linkedin'
// (external_id: conversation id plus a hash of the row, thread_key: conversation id, snippet and
// no body), and each new message queues comms.classify carrying the text. The rows are applied by
// a job with the pack importer's report shape, so re-importing the same export changes nothing.
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import { withTransaction, type Db } from '../db/client';
import { communications, companies, contacts, jobs } from '../db/schema';
import { ingestLookbackDays } from '../adapters/gmail';
import { enqueueClassify } from '../jobs/gmailSync';
import type { JobHandler } from '../jobs/registry';
import type { UserCtx } from '../repos/base';
import { upsertInbound, sameCompany } from '../repos/communications';
import {
  insertContactSync,
  normalizeEmails,
  readHistory,
  updateContactSync,
  type ContactHistoryEntry,
  type ContactInput,
  type ContactRow,
} from '../repos/contacts';
import { CsvError, parseCsv, type CsvRecord } from './csv';
import { lookbackCutoff } from './lookback';
import {
  normalizePackPath,
  PackError,
  type ImportError,
  type ImportProgress,
  type ImportReport,
  type ImportResult,
} from './importer';
import { cleanText, truncateText } from './safeText';

export const LINKEDIN_IMPORT_JOB_KIND = 'import.linkedin';
export const CONNECTIONS_FILE = 'Connections.csv';
export const MESSAGES_FILE = 'messages.csv';

export const CONNECTION_COLUMNS = [
  'First Name',
  'Last Name',
  'URL',
  'Email Address',
  'Company',
  'Position',
  'Connected On',
] as const;
/** Required message columns; newer exports add more (RECIPIENT PROFILE URLS, FOLDER), ignored. */
export const MESSAGE_COLUMNS = [
  'CONVERSATION ID',
  'CONVERSATION TITLE',
  'FROM',
  'SENDER PROFILE URL',
  'TO',
  'DATE',
  'SUBJECT',
  'CONTENT',
] as const;

/** Both CSVs together, unpacked. Message histories can be large. */
export const MAX_LINKEDIN_UNPACKED_BYTES = 50 * 1024 * 1024;
/** The header must appear within the first few records (after the Notes: preamble). */
const HEADER_SEARCH_RECORDS = 10;
const PROGRESS_EVERY = 25;
const MAX_NAME = 200;
const MAX_COMPANY = 200;
const MAX_POSITION = 300;
const MAX_URL = 2048;
const MAX_ADDRESS = 320;
const MAX_CONVERSATION_ID = 200;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export const LinkedInPackSchema = z.object({
  connectionsCsv: z.string().optional(),
  messagesCsv: z.string().optional(),
});
export type LinkedInPack = z.infer<typeof LinkedInPackSchema>;

// ---------------------------------------------------------------------------
// Parsing

interface Header {
  /** Index of the header record. */
  index: number;
  column: Map<string, number>;
}

/** Finds the header record (skipping a preamble) and maps every required column. */
function findHeader(records: CsvRecord[], required: readonly string[]): Header | undefined {
  for (const [i, record] of records.slice(0, HEADER_SEARCH_RECORDS).entries()) {
    const fields = record.fields.map((f) => f.trim().toLowerCase());
    const column = new Map<string, number>();
    for (const name of required) {
      const at = fields.indexOf(name.toLowerCase());
      if (at === -1) break;
      column.set(name, at);
    }
    if (column.size === required.length) return { index: i, column };
  }
  return undefined;
}

function headerOrThrow(text: string, file: string, required: readonly string[]) {
  let records: CsvRecord[];
  try {
    records = parseCsv(text);
  } catch (err) {
    if (err instanceof CsvError) throw new PackError(`${file}: ${err.message}`);
    throw err;
  }
  const header = findHeader(records, required);
  if (header === undefined) {
    throw new PackError(`${file} does not have the LinkedIn export columns: ${required.join(',')}`);
  }
  return { records: records.slice(header.index + 1), column: header.column };
}

function cellOf(rec: CsvRecord, column: Map<string, number>) {
  return (name: string): string => (rec.fields[column.get(name) ?? -1] ?? '').trim();
}

const orNull = (s: string, max: number): string | null => (s === '' ? null : truncateText(s, max));

/**
 * A profile URL as a stable key: http(s) only (anything else is dropped, it is metadata and
 * never fetched), lowercased, without query, fragment or trailing slash.
 */
export function normalizeLinkedinUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (value === '' || value.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '').toLowerCase();
}

export interface ConnectionRow {
  line: number;
  name: string;
  linkedinUrl: string | null;
  email: string | null;
  company: string | null;
  position: string | null;
}

export function parseConnections(text: string): {
  rows: ConnectionRow[];
  errors: ImportError[];
  stripped: number;
} {
  const { records, column } = headerOrThrow(text, CONNECTIONS_FILE, CONNECTION_COLUMNS);
  const rows: ConnectionRow[] = [];
  const errors: ImportError[] = [];
  let stripped = 0;
  for (const rec of records) {
    const get = cellOf(rec, column);
    const name = `${get('First Name')} ${get('Last Name')}`.replace(/\s+/g, ' ').trim();
    if (name === '') {
      // LinkedIn's own export carries rows exactly like this for connections whose profile no
      // longer exists: every identity field empty, often with only Connected On populated
      // (issue #132). There is nothing to import, but it is not a problem in the file either,
      // so it is kept apart from a genuine missing-name row, one that still names a URL,
      // email, company or role and so is still worth surfacing as a problem.
      const strippedByLinkedin =
        get('URL') === '' &&
        get('Email Address') === '' &&
        get('Company') === '' &&
        get('Position') === '';
      if (strippedByLinkedin) stripped += 1;
      else errors.push({ line: rec.line, message: `${CONNECTIONS_FILE}: a name is required` });
      continue;
    }
    const email = get('Email Address').toLowerCase();
    rows.push({
      line: rec.line,
      name: truncateText(name, MAX_NAME),
      linkedinUrl: normalizeLinkedinUrl(get('URL')),
      email: email.length <= MAX_ADDRESS && EMAIL.test(email) ? email : null,
      company: orNull(get('Company'), MAX_COMPANY),
      position: orNull(get('Position'), MAX_POSITION),
    });
  }
  return { rows, errors, stripped };
}

export interface MessageRow {
  line: number;
  conversationId: string;
  conversationTitle: string | null;
  from: string;
  senderUrl: string | null;
  to: string | null;
  date: string;
  sentAt: number;
  subject: string | null;
  content: string;
}

/** "2026-09-14 16:02:11 UTC" (the export's format), or anything Date.parse reads with a year. */
export function parseExportDate(raw: string): number | undefined {
  // Anchored, and every optional group starts with a distinct literal: matching stays linear.
  // eslint-disable-next-line security/detect-unsafe-regex -- see above
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?) ?(?:UTC|Z)?$/i.exec(
    raw.trim(),
  );
  const ms = m === null ? Date.parse(raw) : Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isFinite(ms) && /\d{4}/.test(raw) ? ms : undefined;
}

export function parseMessages(text: string): { rows: MessageRow[]; errors: ImportError[] } {
  const { records, column } = headerOrThrow(text, MESSAGES_FILE, MESSAGE_COLUMNS);
  const rows: MessageRow[] = [];
  const errors: ImportError[] = [];
  const fail = (line: number, message: string) =>
    errors.push({ line, message: `${MESSAGES_FILE}: ${message}` });
  for (const rec of records) {
    const get = cellOf(rec, column);
    const conversationId = get('CONVERSATION ID');
    if (conversationId === '' || conversationId.length > MAX_CONVERSATION_ID) {
      fail(rec.line, 'CONVERSATION ID is required (at most 200 characters)');
      continue;
    }
    const date = get('DATE');
    const sentAt = parseExportDate(date);
    if (sentAt === undefined) {
      fail(rec.line, 'DATE is not a date');
      continue;
    }
    // CONTENT keeps its inner line breaks; only the outer whitespace is trimmed.
    rows.push({
      line: rec.line,
      conversationId,
      conversationTitle: orNull(get('CONVERSATION TITLE'), 998),
      from: get('FROM') === '' ? '(unknown sender)' : get('FROM'),
      senderUrl: normalizeLinkedinUrl(get('SENDER PROFILE URL')),
      to: orNull(get('TO'), 998),
      date,
      sentAt,
      subject: orNull(get('SUBJECT'), 998),
      content: get('CONTENT'),
    });
  }
  return { rows, errors };
}

const externalIdOf = (fields: readonly string[], occurrence: number, conversationId: string) => {
  const hash = createHash('sha256').update(fields.join('\0')).digest('hex').slice(0, 24);
  return `${conversationId}:${hash}${occurrence > 1 ? `:${occurrence}` : ''}`;
};

/**
 * Stable across re-imports of the same or a newer export: the conversation id plus a hash of
 * the row's identifying fields; `occurrence` (1-based) separates byte-identical rows.
 *
 * Hashes `sentAt` (the parsed instant), not the DATE column's raw text (issue #14): LinkedIn
 * changing how it formats a date in a later export must not fork a message's id, the way
 * hashing the text did. `legacyMessageExternalId` below is the formula this replaces, kept
 * (not migrated) so rows already stored under it are still found and not duplicated.
 */
export function messageExternalId(row: MessageRow, occurrence: number): string {
  return externalIdOf(
    [row.conversationId, String(row.sentAt), row.senderUrl ?? '', row.from, row.content],
    occurrence,
    row.conversationId,
  );
}

/**
 * The id this row would have gotten before issue #14's fix: the same fields, but the DATE
 * column's raw text instead of the parsed `sentAt`. `content` and `date` are not retained once a
 * row is stored (issue #53), so a row imported under this formula cannot be migrated to the new
 * one from stored data alone; this computes what the CURRENT row being imported would have
 * hashed to under the old rule, so dedupe can check for it without touching any stored row.
 */
export function legacyMessageExternalId(row: MessageRow, occurrence: number): string {
  return externalIdOf(
    [row.conversationId, row.date, row.senderUrl ?? '', row.from, row.content],
    occurrence,
    row.conversationId,
  );
}

// ---------------------------------------------------------------------------
// Pack assembly (request time)

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1).toLowerCase();

/** Reads Connections.csv and messages.csv out of an export ZIP (anywhere in it), validated. */
export function linkedInPackFromZip(data: Uint8Array): LinkedInPack {
  const wanted = new Set([CONNECTIONS_FILE.toLowerCase(), MESSAGES_FILE.toLowerCase()]);
  let total = 0;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(data, {
      filter: (file) => {
        const path = normalizePackPath(file.name);
        if (path === undefined || !wanted.has(basename(path))) return false;
        total += file.originalSize;
        if (total > MAX_LINKEDIN_UNPACKED_BYTES) {
          throw new PackError('the export files are larger than 50 MB unpacked');
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof PackError) throw err;
    throw new PackError('the upload is not a readable zip file');
  }
  const decoder = new TextDecoder('utf-8');
  const pick = (file: string): string | undefined => {
    // The shallowest match wins (the export puts both files at the top).
    const names = Object.keys(unzipped)
      .filter((n) => basename(n) === file.toLowerCase())
      .sort((x, y) => x.split('/').length - y.split('/').length);
    const first = names[0];
    const data = first === undefined ? undefined : new Map(Object.entries(unzipped)).get(first);
    // No NUL characters: Postgres text cannot hold them (lib/safeText).
    return data === undefined ? undefined : cleanText(decoder.decode(data));
  };
  const connectionsCsv = pick(CONNECTIONS_FILE);
  const messagesCsv = pick(MESSAGES_FILE);
  if (connectionsCsv === undefined && messagesCsv === undefined) {
    throw new PackError(`the zip has neither ${CONNECTIONS_FILE} nor ${MESSAGES_FILE}`);
  }
  if (connectionsCsv !== undefined)
    headerOrThrow(connectionsCsv, CONNECTIONS_FILE, CONNECTION_COLUMNS);
  if (messagesCsv !== undefined) headerOrThrow(messagesCsv, MESSAGES_FILE, MESSAGE_COLUMNS);
  return {
    ...(connectionsCsv === undefined ? {} : { connectionsCsv }),
    ...(messagesCsv === undefined ? {} : { messagesCsv }),
  };
}

// ---------------------------------------------------------------------------
// Applying a pack (job time)

type Outcome = 'created' | 'updated' | 'skipped' | 'outside_window';

/** The caller's contacts, indexed for matching; kept current as the import writes. */
class ContactIndex {
  private readonly byUrl = new Map<string, ContactRow>();
  private readonly rows = new Map<string, ContactRow>();
  private readonly companyNames = new Map<string, string>();

  static async load(db: Db, ctx: UserCtx): Promise<ContactIndex> {
    const index = new ContactIndex();
    for (const c of await db
      .select()
      .from(companies)
      .where(eq(companies.userId, ctx.userId))
      .all()) {
      index.companyNames.set(c.id, c.name);
    }
    for (const row of await db
      .select()
      .from(contacts)
      .where(eq(contacts.userId, ctx.userId))
      .all()) {
      index.put(row);
    }
    return index;
  }

  put(row: ContactRow): void {
    this.rows.set(row.id, row);
    const url = normalizeLinkedinUrl(row.linkedinUrl);
    if (url !== null && !this.byUrl.has(url)) this.byUrl.set(url, row);
  }

  noteCompany(id: string | null, name: string | null): void {
    if (id !== null && name !== null) this.companyNames.set(id, name);
  }

  companyName(row: ContactRow): string | null {
    return row.currentCompanyId === null
      ? null
      : (this.companyNames.get(row.currentCompanyId) ?? null);
  }

  byProfileUrl(url: string | null): ContactRow | undefined {
    return url === null ? undefined : this.byUrl.get(url);
  }

  /** Same name (any case) at the same company, without a conflicting profile URL. */
  byNameAndCompany(
    name: string,
    company: string | null,
    url: string | null,
  ): ContactRow | undefined {
    const lower = name.toLowerCase();
    for (const row of this.rows.values()) {
      if (row.name.toLowerCase() !== lower) continue;
      const own = normalizeLinkedinUrl(row.linkedinUrl);
      if (own !== null && url !== null && own !== url) continue;
      const current = this.companyName(row);
      const same =
        company === null ? current === null : current !== null && companiesMatch(current, company);
      if (same) return row;
    }
    return undefined;
  }
}

function companiesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase() || sameCompany(a, b);
}

async function importConnection(
  db: Db,
  ctx: UserCtx,
  index: ContactIndex,
  row: ConnectionRow,
): Promise<Outcome> {
  return await withTransaction(db, async (tx) => {
    const match =
      index.byProfileUrl(row.linkedinUrl) ??
      index.byNameAndCompany(row.name, row.company, row.linkedinUrl);
    const entry: ContactHistoryEntry | null =
      row.company === null
        ? null
        : { company: row.company, title: row.position, from: null, to: null };

    if (match === undefined) {
      const input: ContactInput = {
        name: row.name,
        emails: row.email === null ? [] : [row.email],
        linkedinUrl: row.linkedinUrl,
        company: row.company,
        history: entry === null ? [] : [entry],
        source: 'linkedin_export',
      };
      const created = await insertContactSync(tx, ctx, input);
      index.noteCompany(created.currentCompanyId, row.company);
      index.put(created);
      return 'created';
    }

    const patch: Partial<ContactInput> = {};
    if (row.email !== null && !match.emails.some((e) => e.toLowerCase() === row.email)) {
      patch.emails = normalizeEmails([...match.emails, row.email]);
    }
    if (row.linkedinUrl !== null && match.linkedinUrl === null) patch.linkedinUrl = row.linkedinUrl;
    if (entry !== null) {
      const history = readHistory(match.history);
      const last = history.at(-1);
      const moved =
        last === undefined ||
        !companiesMatch(last.company, entry.company) ||
        (last.title ?? null) !== entry.title;
      if (moved) {
        patch.history = [...history, entry];
        patch.company = entry.company;
      } else if (match.currentCompanyId === null) {
        patch.company = entry.company;
      }
    }
    if (Object.keys(patch).length === 0) return 'skipped';
    const updated = await updateContactSync(tx, ctx, match.id, patch);
    if (patch.company !== undefined) index.noteCompany(updated.currentCompanyId, patch.company);
    index.put(updated);
    return 'updated';
  });
}

function snippetOf(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

async function importMessage(
  db: Db,
  ctx: UserCtx,
  index: ContactIndex,
  row: MessageRow,
  occurrence: number,
  cutoff: number,
): Promise<Outcome> {
  // Stage 0 (spec D0, lib/lookback): outside the ingestion window the message is not stored at
  // all, which is what the Gmail query does for mail. An export is an archive rather than a
  // feed, so this is the cut that decides whether an import means "the last few months of my
  // messages" or "everything since 2006".
  if (row.sentAt < cutoff) return 'outside_window';
  const externalId = messageExternalId(row, occurrence);
  // Issue #14: a row stored under the pre-fix formula is still found here, by the id this same
  // row would have hashed to under it, so it is never re-created under the new one.
  const existing = await db
    .select({ id: communications.id })
    .from(communications)
    .where(
      and(
        eq(communications.userId, ctx.userId),
        eq(communications.channel, 'linkedin'),
        inArray(communications.externalId, [externalId, legacyMessageExternalId(row, occurrence)]),
      ),
    )
    .get();
  if (existing !== undefined) return 'skipped';
  const sender = index.byProfileUrl(row.senderUrl);
  const { id, inserted } = await withTransaction(db, async (tx) => {
    const res = await upsertInbound(tx, ctx, 'linkedin', {
      externalId,
      threadKey: row.conversationId,
      from: row.from,
      to: row.to === null ? [] : [row.to],
      subject: row.subject ?? row.conversationTitle ?? '',
      snippet: snippetOf(row.content),
      // Read for the ATS job references (design D-5) and not kept: upsertInbound extracts
      // them here, where the whole message is in hand for the only time.
      bodyText: row.content,
      sentAt: row.sentAt,
    });
    if (res.inserted && sender !== undefined) {
      await tx
        .update(communications)
        .set({ contactId: sender.id })
        .where(and(eq(communications.userId, ctx.userId), eq(communications.id, res.id)))
        .run();
    }
    return res;
  });
  if (!inserted) return 'skipped';
  // Classification is left to the comms.classify job, queued once per new message, and the text
  // travels in its payload (issue #53). The export ZIP is gone once the import finishes and
  // LinkedIn cannot be asked for a message again, so this payload is the only copy there will
  // be: a job that finishes without a key classifies on the snippet later, which is the trade
  // this makes rather than keeping twenty years of messages on disk against that possibility.
  await enqueueClassify(db, ctx, id, row.content);
  return 'created';
}

export interface LinkedInImportDeps {
  onProgress?: (progress: ImportProgress, report: ImportReport) => Promise<void> | void;
}

/**
 * Applies an export to the caller's data and returns the final progress and report.
 * `onProgress` covers only the live ticks along the way (issue #2): the true final state is
 * this return value, which the caller commits itself, together with the payload purge, in one
 * write, so nothing can observe one without the other.
 */
export async function runLinkedInImport(
  db: Db,
  ctx: UserCtx,
  pack: LinkedInPack,
  deps: LinkedInImportDeps,
): Promise<ImportResult> {
  const conns =
    pack.connectionsCsv === undefined ? undefined : parseConnections(pack.connectionsCsv);
  const msgs = pack.messagesCsv === undefined ? undefined : parseMessages(pack.messagesCsv);
  const report: ImportReport = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [...(conns?.errors ?? []), ...(msgs?.errors ?? [])],
    ...(conns !== undefined && conns.stripped > 0 ? { strippedConnections: conns.stripped } : {}),
  };
  const progress: ImportProgress = {
    processed: 0,
    total: (conns?.rows.length ?? 0) + (msgs?.rows.length ?? 0),
  };
  const tally = async (o: Outcome) => {
    if (o === 'created') report.created += 1;
    else if (o === 'updated') report.updated += 1;
    else if (o === 'outside_window') report.outsideWindow = (report.outsideWindow ?? 0) + 1;
    else report.skipped += 1;
    progress.processed += 1;
    if (progress.processed % PROGRESS_EVERY === 0) await deps.onProgress?.(progress, report);
  };

  const index = await ContactIndex.load(db, ctx);
  for (const row of conns?.rows ?? []) await tally(await importConnection(db, ctx, index, row));

  const seen = new Map<string, number>();
  // One window for the whole import, read once: a run that straddled midnight would otherwise
  // admit a message at the start and refuse the same message at the end.
  const cutoff = lookbackCutoff(await ingestLookbackDays(db, ctx));
  for (const row of msgs?.rows ?? []) {
    const base = messageExternalId(row, 1);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    await tally(await importMessage(db, ctx, index, row, occurrence, cutoff));
  }
  return { progress, report };
}

// ---------------------------------------------------------------------------
// The job

/** What stays in jobs.payload after a successful import (the export can be large). */
export function purgedLinkedInPayload(pack: LinkedInPack) {
  return {
    purged: true,
    files: {
      connectionsCsvBytes:
        pack.connectionsCsv === undefined ? 0 : Buffer.byteLength(pack.connectionsCsv),
      messagesCsvBytes: pack.messagesCsv === undefined ? 0 : Buffer.byteLength(pack.messagesCsv),
    },
  };
}

export const linkedInImportJob: JobHandler<{ pack: LinkedInPack }> = {
  kind: LINKEDIN_IMPORT_JOB_KIND,
  payloadSchema: z.object({ pack: LinkedInPackSchema }),
  maxAttempts: 3,
  async run(db, { pack }, ctx) {
    try {
      if (ctx.userId === null) throw new Error('linkedin import job has no user');
      const user: UserCtx = { userId: ctx.userId, isAdmin: false };
      const { progress, report } = await runLinkedInImport(db, user, pack, {
        onProgress: async (p, r) =>
          await ctx.setResult({
            progress: { ...p },
            report: { ...r, errors: [...r.errors] },
          } satisfies ImportResult),
      });
      // Issue #2: this used to be two writes (the final result, then the purge, once
      // runLinkedInImport had already returned), so a crash in between left the pack behind
      // for a (harmless, since imports are idempotent) retry to clean up. One write instead:
      // the report that says the import is finished and the purge that says the pack is gone
      // now commit together, so there is nothing left to observe in between.
      await db
        .update(jobs)
        .set({
          result: {
            progress: { ...progress },
            report: { ...report, errors: [...report.errors] },
          } satisfies ImportResult,
          payload: purgedLinkedInPayload(pack),
          updatedAt: Date.now(),
        })
        .where(eq(jobs.id, ctx.jobId))
        .run();
    } catch (err) {
      // Issue #2: a failed attempt still needs the pack for its retry, but the attempt about
      // to exhaust the budget (the runner is about to mark this job dead) does not get one, so
      // purge here or the pack sits in the row, and in every nightly backup, forever.
      if (ctx.attempt >= ctx.maxAttempts) {
        try {
          await db
            .update(jobs)
            .set({ payload: purgedLinkedInPayload(pack), updatedAt: Date.now() })
            .where(eq(jobs.id, ctx.jobId))
            .run();
        } catch {
          // The database is the likeliest reason the import itself failed; that original
          // error is more useful than this one, so it is what gets thrown below.
        }
      }
      throw err;
    }
  },
};
