// Resumes (FR-R1, R2, R3): base resumes registered from an existing document, and tailored
// copies linked to an opportunity and to the base they were copied from.
import { newId } from '@opportun/core';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { attachments, resumes, settings } from '../db/schema';
import { HttpError, notFound } from '../lib/errors';
import type { Db, UserCtx } from './base';
import { assertOpportunityOwned } from './activities';
import { countWhere, type ListOpts, type Page } from './list';
import { withTransaction } from '../db/client';

export type ResumeRow = typeof resumes.$inferSelect;
export type ResumeStatus = ResumeRow['status'];

// ---------------------------------------------------------------------------
// Naming template (settings key resume_naming_template:<userId>)

export const DEFAULT_NAMING_TEMPLATE = '{{displayName}}-{{company}}-{{roleSlug}}';
export const NAMING_VARIABLES = ['displayName', 'company', 'roleSlug'] as const;
export type NamingVars = Record<(typeof NAMING_VARIABLES)[number], string>;

const NAMING_VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export const namingTemplateKey = (userId: string): string => `resume_naming_template:${userId}`;

/** The placeholders a template uses that the renderer does not know. */
export function unknownNamingVars(template: string): string[] {
  const known = new Set<string>(NAMING_VARIABLES);
  return [...template.matchAll(NAMING_VAR)].map((m) => m[1] as string).filter((n) => !known.has(n));
}

/** Lowercased, every run of non-alphanumerics collapsed to one underscore (edges trimmed). */
export function roleSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function renderResumeName(template: string, vars: NamingVars): string {
  const values = new Map(Object.entries(vars));
  return template.replace(NAMING_VAR, (whole, name: string) => values.get(name) ?? whole).trim();
}

export async function readNamingTemplate(db: Db, ctx: UserCtx): Promise<string> {
  const value = (
    await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.key, namingTemplateKey(ctx.userId)), eq(settings.userId, ctx.userId)))
      .get()
  )?.value;
  return typeof value === 'string' && value.trim().length > 0 ? value : DEFAULT_NAMING_TEMPLATE;
}

export async function writeNamingTemplate(db: Db, ctx: UserCtx, template: string): Promise<void> {
  const now = Date.now();
  await db
    .insert(settings)
    .values({
      key: namingTemplateKey(ctx.userId),
      userId: ctx.userId,
      value: template,
      updatedAt: now,
    })
    .onConflictDoUpdate({ target: settings.key, set: { value: template, updatedAt: now } })
    .run();
}

// ---------------------------------------------------------------------------
// Rows

export interface ResumeFilters {
  opportunityId?: string | undefined;
  kind?: ResumeRow['kind'] | undefined;
}

export async function listResumes(
  db: Db,
  ctx: UserCtx,
  opts: ListOpts & ResumeFilters,
): Promise<Page<ResumeRow>> {
  const where = and(
    eq(resumes.userId, ctx.userId),
    opts.opportunityId === undefined ? undefined : eq(resumes.opportunityId, opts.opportunityId),
    opts.kind === undefined ? undefined : eq(resumes.kind, opts.kind),
  ) as SQL;
  const items = await db
    .select()
    .from(resumes)
    .where(where)
    .orderBy(desc(resumes.updatedAt), desc(resumes.id))
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  return { items, total: await countWhere(db, resumes, where) };
}

export async function getResume(db: Db, ctx: UserCtx, id: string): Promise<ResumeRow> {
  const row = await db
    .select()
    .from(resumes)
    .where(and(eq(resumes.userId, ctx.userId), eq(resumes.id, id)))
    .get();
  if (row === undefined) throw notFound();
  return row;
}

/**
 * Persists a ref the store (never this row) returned from applyEdits (#284). Also drops the
 * attachments row the OLD ref named, once the new one is in place, not before: a crash
 * between the two leaves a resume pointing at a still-valid old row (the applyEdits doc
 * comment's named "superseded content" case), never a dangling one. A no-op delete for
 * google_doc/reactive_resume, whose refs never match an attachments id.
 */
export async function updateResumeDocRef(
  db: Db,
  ctx: UserCtx,
  id: string,
  docRef: string,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const row = await tx
      .select({ docRef: resumes.docRef })
      .from(resumes)
      .where(and(eq(resumes.userId, ctx.userId), eq(resumes.id, id)))
      .get();
    if (row === undefined) throw notFound();
    await tx
      .update(resumes)
      .set({ docRef, updatedAt: Date.now() })
      .where(and(eq(resumes.userId, ctx.userId), eq(resumes.id, id)))
      .run();
    if (row.docRef !== docRef) {
      await tx
        .delete(attachments)
        .where(and(eq(attachments.userId, ctx.userId), eq(attachments.id, row.docRef)))
        .run();
    }
  });
}

export type ResumeInsert = Pick<
  typeof resumes.$inferInsert,
  'kind' | 'title' | 'store' | 'docRef' | 'opportunityId' | 'parentResumeId'
>;

export async function insertResume(db: Db, ctx: UserCtx, input: ResumeInsert): Promise<ResumeRow> {
  const now = Date.now();
  return await db
    .insert(resumes)
    .values({
      ...input,
      id: newId(),
      userId: ctx.userId,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export interface ResumePatch {
  title?: string | undefined;
  status?: ResumeStatus | undefined;
  submittedTo?: string | undefined;
  submittedAt?: number | undefined;
  /**
   * Attach, detach or move (#77). Whether this key is present at all, not just its value,
   * carries meaning: absent leaves the link alone, `null` detaches, a string attaches or
   * moves. Callers must pass this object through from the request body unmodified (not
   * reconstruct it), or the absent/null distinction is lost before it gets here.
   */
  opportunityId?: string | null;
}

/**
 * Status changes. Submitted needs a recipient (submittedTo, given now or already stored) and
 * stamps submittedAt (default now); leaving submitted clears both.
 *
 * opportunityId: attaching (a string) or detaching (null) a base resume is refused (#77) -- a
 * base with tailored children that is itself attached to one opportunity is a shape nothing
 * else in the model expects, and Create tailored copy already covers that intent. kind is
 * never changed here either way.
 */
export async function updateResume(
  db: Db,
  ctx: UserCtx,
  id: string,
  patch: ResumePatch,
): Promise<ResumeRow> {
  return await withTransaction(db, async (tx) => {
    const row = await tx
      .select()
      .from(resumes)
      .where(and(eq(resumes.userId, ctx.userId), eq(resumes.id, id)))
      .get();
    if (row === undefined) throw notFound();
    const status = patch.status ?? row.status;
    let submittedTo: string | null = null;
    let submittedAt: number | null = null;
    if (status === 'submitted') {
      submittedTo = patch.submittedTo ?? row.submittedTo;
      if (submittedTo === null) throw new HttpError(422, 'submitted_to_required');
      submittedAt = patch.submittedAt ?? row.submittedAt ?? Date.now();
    } else if (patch.submittedTo !== undefined || patch.submittedAt !== undefined) {
      throw new HttpError(422, 'not_submitted');
    }
    const relink = 'opportunityId' in patch;
    if (relink && row.kind === 'base') throw new HttpError(422, 'base_cannot_attach');
    // Matches the convention every other cross-table relink in this layer follows (e.g.
    // communications.ts's reclassify): check ownership here too, rather than trusting the
    // route layer alone to have done it first.
    if (relink && patch.opportunityId != null) {
      await assertOpportunityOwned(tx, ctx, patch.opportunityId);
    }
    return await tx
      .update(resumes)
      .set({
        ...(patch.title === undefined ? {} : { title: patch.title }),
        status,
        submittedTo,
        submittedAt,
        ...(relink ? { opportunityId: patch.opportunityId ?? null } : {}),
        updatedAt: Date.now(),
      })
      .where(and(eq(resumes.userId, ctx.userId), eq(resumes.id, id)))
      .returning()
      .get();
  });
}

/** Sets the status only (tailoring completion moves a resume to in_review). */
export async function setResumeStatus(
  db: Db,
  ctx: UserCtx,
  id: string,
  status: ResumeStatus,
): Promise<void> {
  await db
    .update(resumes)
    .set({ status, updatedAt: Date.now() })
    .where(and(eq(resumes.userId, ctx.userId), eq(resumes.id, id)))
    .run();
}

export type DeleteResumeResult = { outcome: 'deleted' } | { outcome: 'archived'; row: ResumeRow };

/**
 * Stops tracking a resume. The document itself is left untouched, and a submitted resume is
 * archived (archivedAt set, status and every relationship left alone) rather than deleted,
 * so the record of what was sent is not destroyed (#70). An already-archived resume is a no-op
 * that reports 'archived' again, so a retried request is safe.
 */
export async function deleteResume(db: Db, ctx: UserCtx, id: string): Promise<DeleteResumeResult> {
  return await withTransaction(db, async (tx) => {
    const row = await tx
      .select()
      .from(resumes)
      .where(and(eq(resumes.userId, ctx.userId), eq(resumes.id, id)))
      .get();
    if (row === undefined) throw notFound();
    if (row.status !== 'submitted') {
      await tx
        .delete(resumes)
        .where(and(eq(resumes.userId, ctx.userId), eq(resumes.id, id)))
        .run();
      return { outcome: 'deleted' };
    }
    if (row.archivedAt !== null) return { outcome: 'archived', row };
    const archived = await tx
      .update(resumes)
      .set({ archivedAt: Date.now(), updatedAt: Date.now() })
      .where(and(eq(resumes.userId, ctx.userId), eq(resumes.id, id)))
      .returning()
      .get();
    return { outcome: 'archived', row: archived };
  });
}
