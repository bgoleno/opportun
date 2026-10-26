// Import pipeline (FR-I1, I2). A pack is a zip or a directory upload holding
// opportunities.csv (required), contacts.csv (optional) and the .md notes the CSV refers to.
// The upload is validated and reduced to a JobPack at request time; the rows are applied by
// the `import` job. Re-running a pack is idempotent: opportunities upsert by
// dedupeKey(company, title, location), stages only move forward along the chain, and
// notes, applications, resumes and contacts are matched before anything is added.
import {
  dedupeKey,
  DISMISS_REASONS,
  newId,
  OPPORTUNITY_STAGES,
  type DismissReason,
  type OpportunityStage,
} from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import type { DocumentStore } from '../adapters/documentStore';
import { readDocumentStorePref } from '../adapters/reactiveResume';
import { withTransaction, type Db } from '../db/client';
import { activities, contacts, jobs, opportunities, resumes, stageHistory } from '../db/schema';
import type { JobHandler } from '../jobs/registry';
import { createActivity } from '../repos/activities';
import type { Exec, UserCtx } from '../repos/base';
import { findOrCreateCompanySync } from '../repos/companies';
import { createOpportunity } from '../repos/opportunities';
import { insertResume } from '../repos/resumes';
import { CsvError, parseCsv, unguardFormula, type CsvRecord } from './csv';
import { HttpError } from './errors';
import { cleanText } from './safeText';

export const OPPORTUNITY_COLUMNS = [
  'company',
  'title',
  'stage',
  'posting_url',
  'location',
  'source',
  'applied_at',
  'dismissed_reason',
  'notes_file',
  'resume_doc_ref',
] as const;
export const CONTACT_COLUMNS = ['name', 'email', 'linkedin_url', 'company', 'notes'] as const;

export const MAX_PACK_BYTES = 20 * 1024 * 1024;
const MAX_PACK_ENTRIES = 2000;
const PROGRESS_EVERY = 10;

/** The forward chain; closed and dismissed are off it and never left by an import. */
const CHAIN: readonly OpportunityStage[] = [
  'discovered',
  'interested',
  'preparing',
  'applied',
  'in_process',
  'offer',
];

export class PackError extends Error {
  override name = 'PackError';
}

/** What the import job carries: the CSV texts plus the notes the rows refer to. */
export const ImportPackSchema = z.object({
  opportunitiesCsv: z.string(),
  contactsCsv: z.string().optional(),
  notes: z.record(z.string(), z.string()),
});
export type ImportPack = z.infer<typeof ImportPackSchema>;

export interface ImportError {
  line: number;
  message: string;
}

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  /**
   * Rows the ingestion window left out (lib/lookback), when the importer applies one. Counted
   * apart from `skipped`, which means "already here": an import of a twenty-year archive that
   * stores four messages looks broken unless the report says what the window did (issue #53).
   */
  outsideWindow?: number;
  /**
   * LinkedIn connections with no name, profile link, email, company or role at all: nothing to
   * import, usually because the linked profile no longer exists. Counted apart from `errors`,
   * for the same reason as `outsideWindow`: it is LinkedIn's export doing this, not a problem
   * in the file the user can fix, and a long-lived account can accumulate dozens of them
   * (issue #132).
   */
  strippedConnections?: number;
  errors: ImportError[];
}

export interface ImportProgress {
  processed: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Pack assembly (request time)

/**
 * A safe relative path inside the pack, or undefined. Absolute paths, drive letters, `..`
 * and `.` segments are refused, so a zip entry name can never point outside the pack.
 * Nothing here touches the filesystem; names only index the uploaded contents.
 */
export function normalizePackPath(name: string): string | undefined {
  const p = name.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (p === '' || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\0')) return undefined;
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return undefined;
  return p;
}

function parseOrThrow(text: string, file: string): CsvRecord[] {
  try {
    return parseCsv(text);
  } catch (err) {
    if (err instanceof CsvError) throw new PackError(`${file}: ${err.message}`);
    throw err;
  }
}

function checkHeader(records: CsvRecord[], file: string, columns: readonly string[]): void {
  const header = records[0]?.fields.map((f) => f.trim().toLowerCase());
  if (header === undefined || header.join(',') !== columns.join(',')) {
    throw new PackError(`${file} header must be exactly: ${columns.join(',')}`);
  }
}

const decoder = new TextDecoder('utf-8');

/** Builds a pack from uploaded files keyed by their relative path (a directory upload). */
export function packFromFiles(entries: { name: string; data: Uint8Array }[]): ImportPack {
  const files = new Map<string, string>();
  for (const e of entries) {
    const p = normalizePackPath(e.name);
    // No NUL characters: Postgres text cannot hold them (lib/safeText).
    if (p !== undefined) files.set(p, cleanText(decoder.decode(e.data)));
  }
  // A folder upload arrives as <folder>/opportunities.csv: treat that folder as the root.
  if (!files.has('opportunities.csv')) {
    const roots = [...files.keys()].filter((k) => /^[^/]+\/opportunities\.csv$/.test(k));
    if (roots.length !== 1) {
      throw new PackError('opportunities.csv was not found at the top of the pack');
    }
    const prefix = (roots[0] as string).slice(0, -'opportunities.csv'.length);
    const rooted = new Map<string, string>();
    for (const [k, v] of files) if (k.startsWith(prefix)) rooted.set(k.slice(prefix.length), v);
    return packFromMap(rooted);
  }
  return packFromMap(files);
}

function packFromMap(files: Map<string, string>): ImportPack {
  const opportunitiesCsv = files.get('opportunities.csv') as string;
  const oppRecords = parseOrThrow(opportunitiesCsv, 'opportunities.csv');
  checkHeader(oppRecords, 'opportunities.csv', OPPORTUNITY_COLUMNS);
  const contactsCsv = files.get('contacts.csv');
  if (contactsCsv !== undefined) {
    checkHeader(parseOrThrow(contactsCsv, 'contacts.csv'), 'contacts.csv', CONTACT_COLUMNS);
  }
  const notesIdx = OPPORTUNITY_COLUMNS.indexOf('notes_file');
  const notes: Record<string, string> = {};
  for (const rec of oppRecords.slice(1)) {
    // Read the same way importOpportunity reads the column, guard and all (lib/csv).
    const ref = normalizePackPath(unguardFormula(rec.fields.at(notesIdx) ?? '').trim());
    if (ref === undefined || !ref.toLowerCase().endsWith('.md')) continue;
    const text = files.get(ref);
    // eslint-disable-next-line security/detect-object-injection -- ref is a validated pack path
    if (text !== undefined) notes[ref] = text;
  }
  return { opportunitiesCsv, ...(contactsCsv === undefined ? {} : { contactsCsv }), notes };
}

/** Builds a pack from a zip. Only .csv and .md entries are inflated, within size caps. */
export function packFromZip(data: Uint8Array): ImportPack {
  let entries = 0;
  let total = 0;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(data, {
      filter: (file) => {
        entries += 1;
        if (entries > MAX_PACK_ENTRIES) throw new PackError('the zip has too many entries');
        if (!/\.(csv|md)$/i.test(file.name) || normalizePackPath(file.name) === undefined) {
          return false;
        }
        total += file.originalSize;
        if (total > MAX_PACK_BYTES) throw new PackError('the pack is larger than 20 MB unpacked');
        return true;
      },
    });
  } catch (err) {
    if (err instanceof PackError) throw err;
    throw new PackError('the upload is not a readable zip file');
  }
  return packFromFiles(Object.entries(unzipped).map(([name, d]) => ({ name, data: d })));
}

// ---------------------------------------------------------------------------
// Applying a pack (job time)

class RowError extends Error {}

const HttpUrl = z.httpUrl().max(2048);
/** A date first (2026-09-01), optionally followed by a time Date.parse understands. */
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}(?:$|[T ])/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** One cell, with the export's formula guard removed before the outer whitespace. */
function cell(rec: CsvRecord, columns: readonly string[], name: string): string {
  return unguardFormula(rec.fields[columns.indexOf(name)] ?? '').trim();
}

function checkColumns(rec: CsvRecord, columns: readonly string[]): void {
  if (rec.fields.length > columns.length) {
    throw new RowError(`expected ${columns.length} columns, found ${rec.fields.length}`);
  }
}

function required(value: string, name: string, max: number): string {
  if (value === '') throw new RowError(`${name} is required`);
  if (value.length > max) throw new RowError(`${name} is longer than ${max} characters`);
  return value;
}

function optional(value: string, name: string, max: number): string | null {
  if (value.length > max) throw new RowError(`${name} is longer than ${max} characters`);
  return value === '' ? null : value;
}

function httpUrl(value: string, name: string): string | null {
  if (value === '') return null;
  if (!HttpUrl.safeParse(value).success) throw new RowError(`${name} must be an http(s) URL`);
  return value;
}

interface OpportunityRow {
  company: string;
  title: string;
  stage: OpportunityStage;
  postingUrl: string | null;
  location: string | null;
  source: string | null;
  appliedAt: number | null;
  dismissedReason: DismissReason | null;
  notesFile: string | null;
  resumeDocRef: string | null;
}

function parseOpportunityRow(rec: CsvRecord): OpportunityRow {
  checkColumns(rec, OPPORTUNITY_COLUMNS);
  const get = (name: (typeof OPPORTUNITY_COLUMNS)[number]) => cell(rec, OPPORTUNITY_COLUMNS, name);
  const stage = get('stage');
  if (!(OPPORTUNITY_STAGES as readonly string[]).includes(stage)) {
    throw new RowError(
      `stage "${stage}" is not one of: ${OPPORTUNITY_STAGES.join(', ')}`.slice(0, 300),
    );
  }
  const applied = get('applied_at');
  let appliedAt: number | null = null;
  if (applied !== '') {
    appliedAt = Date.parse(applied);
    if (!ISO_DATE_PREFIX.test(applied) || !Number.isFinite(appliedAt)) {
      throw new RowError('applied_at must be an ISO date such as 2026-09-01');
    }
  }
  const reason = get('dismissed_reason');
  if (reason !== '' && !(DISMISS_REASONS as readonly string[]).includes(reason)) {
    throw new RowError(`dismissed_reason must be one of: ${DISMISS_REASONS.join(', ')}`);
  }
  return {
    company: required(get('company'), 'company', 200),
    title: required(get('title'), 'title', 300),
    stage: stage as OpportunityStage,
    postingUrl: httpUrl(get('posting_url'), 'posting_url'),
    location: optional(get('location'), 'location', 200),
    source: optional(get('source'), 'source', 200),
    appliedAt,
    dismissedReason: reason === '' ? null : (reason as DismissReason),
    notesFile: optional(get('notes_file'), 'notes_file', 500),
    resumeDocRef: optional(get('resume_doc_ref'), 'resume_doc_ref', 500),
  };
}

function isForward(from: OpportunityStage, to: OpportunityStage): boolean {
  const a = CHAIN.indexOf(from);
  const b = CHAIN.indexOf(to);
  return a !== -1 && b !== -1 && b > a;
}

async function setStage(
  tx: Exec,
  ctx: UserCtx,
  oppId: string,
  from: OpportunityStage,
  to: OpportunityStage,
  dismissedReason: DismissReason | null,
): Promise<void> {
  const at = Date.now();
  await tx
    .update(opportunities)
    .set({
      stage: to,
      dismissedReason: to === 'dismissed' ? dismissedReason : null,
      closedReason: null,
      updatedAt: at,
    })
    .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, oppId)))
    .run();
  await tx
    .insert(stageHistory)
    .values({
      id: newId(),
      userId: ctx.userId,
      opportunityId: oppId,
      fromStage: from,
      toStage: to,
      note: 'imported',
      at,
    })
    .run();
}

async function hasActivity(
  db: Db,
  ctx: UserCtx,
  oppId: string,
  match: (a: typeof activities.$inferSelect) => boolean,
): Promise<boolean> {
  return (
    await db
      .select()
      .from(activities)
      .where(and(eq(activities.userId, ctx.userId), eq(activities.opportunityId, oppId)))
      .all()
  ).some(match);
}

async function trackedResume(db: Db, ctx: UserCtx, docRef: string): Promise<boolean> {
  return (
    (await db
      .select({ id: resumes.id })
      .from(resumes)
      .where(and(eq(resumes.userId, ctx.userId), eq(resumes.docRef, docRef)))
      .get()) !== undefined
  );
}

type Outcome = 'created' | 'updated' | 'skipped';

interface RowDeps {
  db: Db;
  ctx: UserCtx;
  /** The pack's notes by path. */
  notes: ReadonlyMap<string, string>;
  /** Both stores: which one registers a resume link is resolved per user (#19), the same way
   * POST /resumes does, rather than always through Google. */
  documentStore: DocumentStore | undefined;
  reactiveResumeStore: DocumentStore | undefined;
  /** Non-fatal problems on a row that was still imported. */
  warn: (message: string) => void;
}

async function importOpportunity(row: OpportunityRow, deps: RowDeps): Promise<Outcome> {
  const { db, ctx, warn } = deps;
  const key = dedupeKey(row.company, row.title, row.location);
  let existing = await db
    .select({ id: opportunities.id, stage: opportunities.stage })
    .from(opportunities)
    .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.dedupeKey, key)))
    .get();
  let created = false;
  let changed = false;

  if (existing === undefined) {
    const view = await createOpportunity(db, ctx, {
      companyName: row.company,
      title: row.title,
      postingUrl: row.postingUrl,
      location: row.location,
      sourceKind: 'import',
    });
    await withTransaction(db, async (tx) => {
      await tx
        .update(opportunities)
        .set({ sourceRef: row.source })
        .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, view.id)))
        .run();
      if (row.stage !== 'discovered') {
        await setStage(tx, ctx, view.id, 'discovered', row.stage, row.dismissedReason);
      }
    });
    existing = { id: view.id, stage: row.stage };
    created = true;
  } else if (isForward(existing.stage, row.stage)) {
    const { id, stage } = existing;
    await withTransaction(db, async (tx) => await setStage(tx, ctx, id, stage, row.stage, null));
    changed = true;
  }
  const oppId = existing.id;

  if (row.notesFile !== null) {
    const ref = normalizePackPath(row.notesFile);
    const body = ref === undefined ? undefined : deps.notes.get(ref);
    if (body === undefined) {
      warn(`notes_file "${row.notesFile}" is not a .md file in the pack`.slice(0, 600));
    } else if (
      !(await hasActivity(db, ctx, oppId, (a) => a.kind === 'note' && a.bodyMd === body))
    ) {
      await createActivity(db, ctx, oppId, {
        kind: 'note',
        title: 'Imported notes',
        bodyMd: body,
        occurredAt: Date.now(),
        participants: [],
      });
      changed = true;
    }
  }

  if (row.appliedAt !== null) {
    const at = row.appliedAt;
    if (
      !(await hasActivity(db, ctx, oppId, (a) => a.kind === 'application' && a.occurredAt === at))
    ) {
      await createActivity(db, ctx, oppId, {
        kind: 'application',
        title: 'Applied',
        occurredAt: at,
        participants: [],
      });
      changed = true;
    }
  }

  if (row.resumeDocRef !== null && !(await trackedResume(db, ctx, row.resumeDocRef))) {
    try {
      // Which store registers it is the user's own preference (#19), not always Google.
      const storeKind = await readDocumentStorePref(db, ctx);
      const store = storeKind === 'reactive_resume' ? deps.reactiveResumeStore : deps.documentStore;
      if (store === undefined) throw new Error('the document store is unavailable');
      const meta = await store.registerExisting(ctx, row.resumeDocRef);
      if (!(await trackedResume(db, ctx, meta.docRef))) {
        await insertResume(db, ctx, {
          kind: 'tailored',
          title: meta.title,
          store: storeKind === 'reactive_resume' ? 'reactive_resume' : 'google_doc',
          docRef: meta.docRef,
          opportunityId: oppId,
          parentResumeId: null,
        });
        changed = true;
      }
    } catch (err) {
      warn(`resume_doc_ref: ${err instanceof Error ? err.message : String(err)}`.slice(0, 600));
    }
  }

  if (created) return 'created';
  return changed ? 'updated' : 'skipped';
}

async function importContact(rec: CsvRecord, db: Db, ctx: UserCtx): Promise<Outcome> {
  checkColumns(rec, CONTACT_COLUMNS);
  const get = (name: (typeof CONTACT_COLUMNS)[number]) => cell(rec, CONTACT_COLUMNS, name);
  const name = required(get('name'), 'name', 200);
  const email = optional(get('email').toLowerCase(), 'email', 320);
  if (email !== null && !EMAIL.test(email)) throw new RowError('email is not an email address');
  const linkedinUrl = httpUrl(get('linkedin_url'), 'linkedin_url');
  const company = optional(get('company'), 'company', 200);
  // Notes keep their inner line breaks; only the cell's outer whitespace is trimmed.
  const notes = optional(get('notes'), 'notes', 10_000);

  return await withTransaction(db, async (tx) => {
    const companyId =
      company === null ? null : (await findOrCreateCompanySync(tx, ctx, company)).id;
    const mine = await tx.select().from(contacts).where(eq(contacts.userId, ctx.userId)).all();
    const match =
      (email === null
        ? undefined
        : mine.find((c) => c.emails.some((e) => e.toLowerCase() === email))) ??
      (linkedinUrl === null ? undefined : mine.find((c) => c.linkedinUrl === linkedinUrl)) ??
      mine.find((c) => c.name.toLowerCase() === name.toLowerCase());
    const now = Date.now();
    if (match === undefined) {
      await tx
        .insert(contacts)
        .values({
          id: newId(),
          userId: ctx.userId,
          name,
          emails: email === null ? [] : [email],
          linkedinUrl,
          currentCompanyId: companyId,
          notes,
          source: 'manual',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return 'created';
    }
    const patch: Partial<typeof contacts.$inferInsert> = {};
    if (email !== null && !match.emails.some((e) => e.toLowerCase() === email)) {
      patch.emails = [...match.emails, email];
    }
    if (linkedinUrl !== null && match.linkedinUrl === null) patch.linkedinUrl = linkedinUrl;
    if (companyId !== null && match.currentCompanyId === null) patch.currentCompanyId = companyId;
    if (notes !== null && match.notes === null) patch.notes = notes;
    if (Object.keys(patch).length === 0) return 'skipped';
    await tx
      .update(contacts)
      .set({ ...patch, updatedAt: now })
      .where(and(eq(contacts.userId, ctx.userId), eq(contacts.id, match.id)))
      .run();
    return 'updated';
  });
}

/** Failures that belong to one row; anything else aborts the run (and the job retries). */
function rowMessage(err: unknown): string | undefined {
  if (err instanceof RowError) return err.message;
  if (err instanceof HttpError)
    return err.code === 'duplicate' ? 'duplicate opportunity' : err.code;
  return undefined;
}

export interface ImportDeps {
  documentStore?: DocumentStore | undefined;
  reactiveResumeStore?: DocumentStore | undefined;
  onProgress?: (progress: ImportProgress, report: ImportReport) => Promise<void> | void;
}

/**
 * Applies a pack to the caller's data and returns the final progress and report. `onProgress`
 * covers only the live ticks along the way (issue #2): the true final state is this return
 * value, which the caller commits itself, together with whatever else must land in the same
 * write as "this import is finished" (importJob.run writes it alongside the payload purge, in
 * one statement, so nothing can observe one without the other).
 */
export async function runImport(
  db: Db,
  ctx: UserCtx,
  pack: ImportPack,
  deps: ImportDeps = {},
): Promise<ImportResult> {
  const oppRecords = parseCsv(pack.opportunitiesCsv).slice(1);
  const contactRecords = pack.contactsCsv === undefined ? [] : parseCsv(pack.contactsCsv).slice(1);
  const report: ImportReport = { created: 0, updated: 0, skipped: 0, errors: [] };
  const progress: ImportProgress = {
    processed: 0,
    total: oppRecords.length + contactRecords.length,
  };
  const tally = (o: Outcome) => {
    if (o === 'created') report.created += 1;
    else if (o === 'updated') report.updated += 1;
    else report.skipped += 1;
  };
  const notes = new Map(Object.entries(pack.notes));
  const step = async () => {
    progress.processed += 1;
    if (progress.processed % PROGRESS_EVERY === 0) await deps.onProgress?.(progress, report);
  };

  for (const rec of oppRecords) {
    try {
      const row = parseOpportunityRow(rec);
      tally(
        await importOpportunity(row, {
          db,
          ctx,
          notes,
          documentStore: deps.documentStore,
          reactiveResumeStore: deps.reactiveResumeStore,
          warn: (message) => report.errors.push({ line: rec.line, message }),
        }),
      );
    } catch (err) {
      const message = rowMessage(err);
      if (message === undefined) throw err;
      report.errors.push({ line: rec.line, message });
    }
    await step();
  }
  for (const rec of contactRecords) {
    try {
      tally(await importContact(rec, db, ctx));
    } catch (err) {
      const message = rowMessage(err);
      if (message === undefined) throw err;
      report.errors.push({ line: rec.line, message: `contacts.csv: ${message}` });
    }
    await step();
  }
  return { progress, report };
}

// ---------------------------------------------------------------------------
// The job

export const IMPORT_JOB_KIND = 'import';

/** jobs.result for an import: progress plus the (partial, then final) report. */
export interface ImportResult {
  progress: ImportProgress;
  report: ImportReport;
}

/**
 * What stays in jobs.payload after a successful import: a pack can be 20 MB, and a finished
 * job's payload would otherwise sit in the database (and every nightly backup) indefinitely.
 */
export interface PurgedImportPayload {
  purged: true;
  files: { opportunitiesCsvBytes: number; contactsCsvBytes: number; notes: number };
}

export function purgedPayload(pack: ImportPack): PurgedImportPayload {
  return {
    purged: true,
    files: {
      opportunitiesCsvBytes: Buffer.byteLength(pack.opportunitiesCsv),
      contactsCsvBytes: pack.contactsCsv === undefined ? 0 : Buffer.byteLength(pack.contactsCsv),
      notes: Object.keys(pack.notes).length,
    },
  };
}

export const importJob: JobHandler<{ pack: ImportPack }> = {
  kind: IMPORT_JOB_KIND,
  payloadSchema: z.object({ pack: ImportPackSchema }),
  maxAttempts: 3,
  async run(db, { pack }, ctx) {
    try {
      if (ctx.userId === null) throw new Error('import job has no user');
      const user: UserCtx = { userId: ctx.userId, isAdmin: false };
      const { progress, report } = await runImport(db, user, pack, {
        documentStore: ctx.services.documentStore,
        reactiveResumeStore: ctx.services.reactiveResumeStore,
        onProgress: async (p, r) =>
          await ctx.setResult({
            progress: { ...p },
            report: { ...r, errors: [...r.errors] },
          } satisfies ImportResult),
      });
      // Issue #2: this used to be two writes (the final result, then the purge, once
      // runImport had already returned), so a crash in between left the pack behind for a
      // (harmless, since imports are idempotent) retry to clean up. One write instead: the
      // report that says the import is finished and the purge that says the pack is gone now
      // commit together, so there is nothing left to observe in between.
      await db
        .update(jobs)
        .set({
          result: {
            progress: { ...progress },
            report: { ...report, errors: [...report.errors] },
          } satisfies ImportResult,
          payload: purgedPayload(pack),
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
            .set({ payload: purgedPayload(pack), updatedAt: Date.now() })
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
