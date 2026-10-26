// Contacts (design 4.6, FR-C1). The current company is mapped by name on write (find-or-create
// within the caller's companies). linkedin_url is metadata only: nothing ever fetches it (C-1).
// Name and notes are kept in the FTS index (entity_kind 'contact') in the same transaction.
import { newId } from '@opportun/core';
import { and, asc, eq, or, type SQL } from 'drizzle-orm';
import { jsonContains } from '../db/dialect';
import { companies, contacts } from '../db/schema';
import { notFound } from '../lib/errors';
import { profileSlugOf } from '../lib/linkedinCapture';
import type { Db, Exec, UserCtx } from './base';
import { sameCompany } from './communications';
import { findOrCreateCompanySync } from './companies';
import { countWhere, likeContains, orderBy, sortColumns, type ListOpts, type Page } from './list';
import { indexContact, removeFromIndex } from './search';
import { runCount, withTransaction } from '../db/client';

export type ContactRow = typeof contacts.$inferSelect;
export type ContactSource = ContactRow['source'];

export interface ContactHistoryEntry {
  company: string;
  title: string | null;
  from: string | null;
  to: string | null;
}

export interface ContactView extends Omit<ContactRow, 'history'> {
  history: ContactHistoryEntry[];
  currentCompanyName: string | null;
}

/** What a caller writes. `company` is a name: null clears it, undefined leaves it alone. */
export interface ContactInput {
  name: string;
  emails?: string[] | undefined;
  linkedinUrl?: string | null | undefined;
  company?: string | null | undefined;
  history?: ContactHistoryEntry[] | undefined;
  strength?: number | null | undefined;
  notes?: string | null | undefined;
  source?: ContactSource | undefined;
  tags?: string[] | undefined;
}

export const CONTACT_SORTS = sortColumns({
  name: contacts.name,
  strength: contacts.strength,
  createdAt: contacts.createdAt,
  updatedAt: contacts.updatedAt,
});

function owned(ctx: UserCtx, id: string): SQL | undefined {
  return and(eq(contacts.userId, ctx.userId), eq(contacts.id, id));
}

/** Lowercased, trimmed and de-duplicated, first occurrence first. */
export function normalizeEmails(emails: readonly string[]): string[] {
  return [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0))];
}

/** Stored history entries are JSON; anything malformed is dropped on read. */
export function readHistory(raw: readonly Record<string, unknown>[]): ContactHistoryEntry[] {
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  return raw.flatMap((h) => {
    const company = str(h['company']);
    return company === null
      ? []
      : [{ company, title: str(h['title']), from: str(h['from']), to: str(h['to']) }];
  });
}

async function companyNameOf(
  exec: Exec,
  ctx: UserCtx,
  companyId: string | null,
): Promise<string | null> {
  if (companyId === null) return null;
  return (
    (
      await exec
        .select({ name: companies.name })
        .from(companies)
        .where(and(eq(companies.userId, ctx.userId), eq(companies.id, companyId)))
        .get()
    )?.name ?? null
  );
}

export async function toContactView(
  exec: Exec,
  ctx: UserCtx,
  row: ContactRow,
): Promise<ContactView> {
  return {
    ...row,
    history: readHistory(row.history),
    currentCompanyName: await companyNameOf(exec, ctx, row.currentCompanyId),
  };
}

async function resolveCompany(
  exec: Exec,
  ctx: UserCtx,
  company: string | null,
): Promise<string | null> {
  return company === null ? null : (await findOrCreateCompanySync(exec, ctx, company)).id;
}

export async function getContactRow(exec: Exec, ctx: UserCtx, id: string): Promise<ContactRow> {
  const row = await exec.select().from(contacts).where(owned(ctx, id)).get();
  if (row === undefined) throw notFound();
  return row;
}

export async function getContactSync(exec: Exec, ctx: UserCtx, id: string): Promise<ContactView> {
  return await toContactView(exec, ctx, await getContactRow(exec, ctx, id));
}

export async function listContacts(
  db: Db,
  ctx: UserCtx,
  opts: ListOpts & { q?: string | undefined; companyId?: string | undefined },
): Promise<Page<ContactView>> {
  const where = and(
    eq(contacts.userId, ctx.userId),
    opts.q === undefined
      ? undefined
      : or(likeContains(contacts.name, opts.q), jsonContains(contacts.emails, opts.q)),
    opts.companyId === undefined ? undefined : eq(contacts.currentCompanyId, opts.companyId),
  );
  const rows = await db
    .select()
    .from(contacts)
    .where(where)
    .orderBy(...orderBy(opts.sort, 'name', CONTACT_SORTS, contacts.id))
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  const items: ContactView[] = [];
  for (const r of rows) items.push(await toContactView(db, ctx, r));
  return { items, total: await countWhere(db, contacts, where) };
}

/** Inserts a contact inside the caller's transaction (the LinkedIn import composes this). */
export async function insertContactSync(
  exec: Exec,
  ctx: UserCtx,
  input: ContactInput,
): Promise<ContactRow> {
  const now = Date.now();
  const row = await exec
    .insert(contacts)
    .values({
      id: newId(),
      userId: ctx.userId,
      name: input.name,
      emails: normalizeEmails(input.emails ?? []),
      linkedinUrl: input.linkedinUrl ?? null,
      currentCompanyId: await resolveCompany(exec, ctx, input.company ?? null),
      history: (input.history ?? []) as unknown as Record<string, unknown>[],
      strength: input.strength ?? null,
      notes: input.notes ?? null,
      source: input.source ?? 'manual',
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  await indexContact(exec, ctx, row);
  return row;
}

export async function createContact(
  db: Db,
  ctx: UserCtx,
  input: ContactInput,
): Promise<ContactView> {
  return await withTransaction(
    db,
    async (tx) => await toContactView(tx, ctx, await insertContactSync(tx, ctx, input)),
  );
}

/** Applies a patch inside the caller's transaction; 404 unless the caller owns the contact. */
export async function updateContactSync(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  patch: Partial<ContactInput>,
): Promise<ContactRow> {
  const { company, emails, history, ...rest } = patch;
  const set: Partial<typeof contacts.$inferInsert> = { ...rest, updatedAt: Date.now() };
  if (emails !== undefined) set.emails = normalizeEmails(emails);
  if (history !== undefined) set.history = history as unknown as Record<string, unknown>[];
  if (company !== undefined) set.currentCompanyId = await resolveCompany(exec, ctx, company);
  const row = await exec.update(contacts).set(set).where(owned(ctx, id)).returning().get();
  if (row === undefined) throw notFound();
  if (patch.name !== undefined || patch.notes !== undefined) await indexContact(exec, ctx, row);
  return row;
}

export async function updateContact(
  db: Db,
  ctx: UserCtx,
  id: string,
  patch: Partial<ContactInput>,
): Promise<ContactView> {
  return await withTransaction(
    db,
    async (tx) => await toContactView(tx, ctx, await updateContactSync(tx, ctx, id, patch)),
  );
}

export async function deleteContact(db: Db, ctx: UserCtx, id: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    const changes = await runCount(tx.delete(contacts).where(owned(ctx, id)));
    if (changes === 0) throw notFound();
    await removeFromIndex(tx, ctx, 'contact', id);
  });
}

// ---------------------------------------------------------------------------
// Extension captures (FR-C5)

/** A profile the browser extension captured, already shape-checked (lib/linkedinCapture). */
export interface CapturedProfile {
  /** The profile URL as captured (query dropped); metadata only, never fetched (C-1). */
  profileUrl: string;
  /** The page's profile key (lib/linkedinCapture profileSlugOf). */
  slug: string;
  name: string;
  headline: string;
  /** Current employer and position, when known (AI refinement only). */
  company: string | null;
  title: string | null;
}

/** The one notes line a capture owns: rewritten on each capture, never duplicated. */
const CAPTURE_LINE = /^LinkedIn headline \(captured \d{4}-\d{2}-\d{2}\): .*$/m;

function withCaptureLine(notes: string | null, headline: string, now: number): string {
  const line = `LinkedIn headline (captured ${new Date(now).toISOString().slice(0, 10)}): ${headline}`;
  const current = notes ?? '';
  if (CAPTURE_LINE.test(current)) return current.replace(CAPTURE_LINE, () => line);
  return current.trim() === '' ? line : `${current.trimEnd()}\n\n${line}`;
}

function sameEmployer(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase() || sameCompany(a, b);
}

/**
 * Finds the caller's contact for a captured profile: by profile key first, else by name (any
 * case), but only when exactly one contact bears that name and it has no URL at all. A contact
 * with any URL (a legacy /pub/ profile, a short link, a homepage) may be someone else, and an
 * ambiguous name binds nobody: both cases create a new contact instead.
 */
async function findCaptured(
  exec: Exec,
  ctx: UserCtx,
  input: CapturedProfile,
): Promise<ContactRow | undefined> {
  const mine = await exec
    .select()
    .from(contacts)
    .where(eq(contacts.userId, ctx.userId))
    .orderBy(asc(contacts.createdAt), asc(contacts.id))
    .all();
  const byUrl = mine.find((c) => profileSlugOf(c.linkedinUrl) === input.slug);
  if (byUrl !== undefined) return byUrl;
  const name = input.name.toLowerCase();
  const named = mine.filter((c) => c.name.toLowerCase() === name);
  return named.length === 1 && named[0]!.linkedinUrl === null ? named[0] : undefined;
}

/**
 * Creates or updates the caller's contact for a captured profile, in one transaction. A
 * re-capture updates the same contact: the URL is filled in when missing, the headline line in
 * the notes is rewritten (the user's own notes are kept), and a new employer or position appends
 * one history entry. The contact's name and source are the user's and stay as they are.
 */
export async function upsertCapturedProfile(
  db: Db,
  ctx: UserCtx,
  input: CapturedProfile,
): Promise<{ contact: ContactRow; created: boolean }> {
  return await withTransaction(db, async (tx) => {
    const now = Date.now();
    const entry: ContactHistoryEntry | null =
      input.company === null
        ? null
        : { company: input.company, title: input.title, from: null, to: null };
    const match = await findCaptured(tx, ctx, input);
    if (match === undefined) {
      const contact = await insertContactSync(tx, ctx, {
        name: input.name,
        linkedinUrl: input.profileUrl,
        company: input.company,
        history: entry === null ? [] : [entry],
        notes: withCaptureLine(null, input.headline, now),
        source: 'capture',
      });
      return { contact, created: true };
    }
    const patch: Partial<ContactInput> = {};
    if (match.linkedinUrl === null) patch.linkedinUrl = input.profileUrl;
    const notes = withCaptureLine(match.notes, input.headline, now);
    if (notes !== match.notes) patch.notes = notes;
    if (entry !== null) {
      const history = readHistory(match.history);
      const last = history.at(-1);
      const moved =
        last === undefined ||
        !sameEmployer(last.company, entry.company) ||
        (last.title ?? null) !== entry.title;
      if (moved) {
        patch.history = [...history, entry];
        patch.company = entry.company;
      } else if (match.currentCompanyId === null) {
        patch.company = entry.company;
      }
    }
    if (Object.keys(patch).length === 0) return { contact: match, created: false };
    return { contact: await updateContactSync(tx, ctx, match.id, patch), created: false };
  });
}
