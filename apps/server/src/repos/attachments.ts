// Attachment metadata (FR-O8). The bytes live in confined storage under a content-hash
// path; the original filename and mime are metadata only and never form a path.
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { newId } from '@opportun/core';
import { attachments } from '../db/schema';
import { notFound } from '../lib/errors';
import { assertOpportunityOwned } from './activities';
import type { Db, UserCtx } from './base';
import { countWhere, type Page } from './list';
import { runCount, withTransaction } from '../db/client';

export type AttachmentRow = typeof attachments.$inferSelect;
/** What the API returns: everything except the storage path. */
export type AttachmentMeta = Omit<AttachmentRow, 'storedPath'>;

export interface NewAttachment {
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  storedPath: string;
}

function owned(ctx: UserCtx, id: string): SQL | undefined {
  return and(eq(attachments.userId, ctx.userId), eq(attachments.id, id));
}

function toMeta(row: AttachmentRow): AttachmentMeta {
  return {
    id: row.id,
    userId: row.userId,
    opportunityId: row.opportunityId,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    sha256: row.sha256,
    createdAt: row.createdAt,
  };
}

export async function assertCanAttach(db: Db, ctx: UserCtx, opportunityId: string): Promise<void> {
  await assertOpportunityOwned(db, ctx, opportunityId);
}

export async function createAttachment(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  file: NewAttachment,
): Promise<AttachmentMeta> {
  return await withTransaction(db, async (tx) => {
    // Re-checked inside the transaction: the opportunity may be gone after the upload.
    await assertOpportunityOwned(tx, ctx, opportunityId);
    const row = await tx
      .insert(attachments)
      .values({ ...file, id: newId(), userId: ctx.userId, opportunityId, createdAt: Date.now() })
      .returning()
      .get();
    return toMeta(row);
  });
}

export async function listAttachments(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  page: { limit: number; offset: number },
): Promise<Page<AttachmentMeta>> {
  await assertOpportunityOwned(db, ctx, opportunityId);
  const where = and(
    eq(attachments.userId, ctx.userId),
    eq(attachments.opportunityId, opportunityId),
  );
  const rows = await db
    .select()
    .from(attachments)
    .where(where)
    .orderBy(desc(attachments.createdAt), desc(attachments.id))
    .limit(page.limit)
    .offset(page.offset)
    .all();
  return { items: rows.map(toMeta), total: await countWhere(db, attachments, where) };
}

/** The full row, storage path included: for the download handler only. */
export async function getAttachmentForDownload(
  db: Db,
  ctx: UserCtx,
  id: string,
): Promise<AttachmentRow> {
  const row = await db.select().from(attachments).where(owned(ctx, id)).get();
  if (row === undefined) throw notFound();
  return row;
}

/**
 * Removes the metadata row. The stored file is content-addressed and may back other
 * rows (identical uploads share it), so it is left for a later storage sweep.
 */
export async function deleteAttachment(db: Db, ctx: UserCtx, id: string): Promise<void> {
  const changes = await runCount(db.delete(attachments).where(owned(ctx, id)));
  if (changes === 0) throw notFound();
}
