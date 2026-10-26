// Resume documents stored on this server (store local_file, #284): plain-text content, each
// version a real row in the `attachments` table (userId set, opportunityId always null -- see
// the schema comment on attachments.opportunity_id for why that is load-bearing). Chosen over
// a bare content-addressed path so attachmentSweep (jobs/attachmentSweep.ts) already
// understands these files with no change: a version's storedPath is protected while its row
// exists and collected after the row goes, exactly like any other attachment, including the
// demo's nightly reset (#280), which cascade-deletes every row a user's attachments own.
//
// Content is immutable per version: writeAttachment is content-addressed, so an edit cannot
// overwrite the bytes a ref already names. applyEdits therefore returns a new ref (the
// `docRef` in ResumeEditOutcomeResult) rather than mutating the document in place the way
// google_doc and reactive_resume do. This store never writes to the `resumes` table itself;
// repos/resumes.ts's updateResumeDocRef is what persists the new ref and deletes the
// superseded attachments row, strictly after that update commits -- see its own comment for
// why that ordering, not the reverse, is what keeps a crash from ever leaving resumes.doc_ref
// pointing at a row that no longer exists.
import { and, eq } from 'drizzle-orm';
import { newId } from '@opportun/core';
import { withTransaction, type Db } from '../db/client';
import { attachments } from '../db/schema';
import { HttpError, notFound } from '../lib/errors';
import type { Storage } from '../lib/storage';
import type { AttachmentRow } from '../repos/attachments';
import type { UserCtx } from '../repos/base';
import type {
  DocumentStore,
  ResumeDocMeta,
  ResumeEdit,
  ResumeEditOutcomeResult,
  ResumeEditResult,
} from './documentStore';

const MIME = 'text/plain';

export interface LocalFileDeps {
  storage: Storage;
  db: Db;
}

async function currentRow(db: Db, ctx: UserCtx, ref: string): Promise<AttachmentRow> {
  const row = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, ref), eq(attachments.userId, ctx.userId)))
    .get();
  if (row === undefined) throw notFound();
  return row;
}

async function readStoredText(storage: Storage, storedPath: string): Promise<string> {
  const stream = await storage.openAttachment(storedPath);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `${title}.txt`: metadata only (NFR-SEC11), never used to form a path. */
function filenameFor(title: string): string {
  return `${title}.txt`;
}

/** The title for a row this store created (every filename it writes ends in .txt); anything
 *  else (a filename this store never produced) is returned as-is rather than mangled. */
function titleFromFilename(filename: string): string {
  return filename.endsWith('.txt') ? filename.slice(0, -4) : filename;
}

export function createLocalFileStore(deps: LocalFileDeps): DocumentStore {
  /** Writes one new content version and its attachments row; never touches an old one. */
  async function insertVersion(
    ctx: UserCtx,
    text: string,
    filename: string,
  ): Promise<AttachmentRow> {
    const { storedPath, sha256, bytes } = await deps.storage.writeAttachment(
      Buffer.from(text, 'utf8'),
    );
    return await withTransaction(deps.db, async (tx) =>
      tx
        .insert(attachments)
        .values({
          id: newId(),
          userId: ctx.userId,
          opportunityId: null,
          filename,
          mime: MIME,
          bytes,
          sha256,
          storedPath,
          createdAt: Date.now(),
        })
        .returning()
        .get(),
    );
  }

  return {
    async registerExisting(ctx, ref): Promise<ResumeDocMeta> {
      const row = await currentRow(deps.db, ctx, ref);
      return { docRef: row.id, title: titleFromFilename(row.filename), url: null };
    },

    async copyFrom(ctx, baseRef, name): Promise<ResumeDocMeta> {
      const base = await currentRow(deps.db, ctx, baseRef);
      const text = await readStoredText(deps.storage, base.storedPath);
      const row = await insertVersion(ctx, text, filenameFor(name));
      return { docRef: row.id, title: name, url: null };
    },

    async readText(ctx, ref): Promise<string> {
      const row = await currentRow(deps.db, ctx, ref);
      return await readStoredText(deps.storage, row.storedPath);
    },

    async applyEdits(ctx, ref, edits: ResumeEdit[]): Promise<ResumeEditOutcomeResult> {
      const row = await currentRow(deps.db, ctx, ref);
      const text = await readStoredText(deps.storage, row.storedPath);
      const missing = edits.findIndex((e) => !text.includes(e.find));
      if (missing !== -1) {
        throw new HttpError(409, 'edit_target_missing', undefined, { index: missing });
      }
      let working = text;
      const results: ResumeEditResult[] = edits.map((edit, index) => {
        if (!working.includes(edit.find)) {
          // Present in the pre-batch snapshot above, but an earlier edit in this same batch
          // already replaced every occurrence by this edit's turn (issue #146).
          return { index, outcome: 'already_consumed' as const };
        }
        working = working.split(edit.find).join(edit.replace);
        return { index, outcome: 'applied' as const };
      });
      if (working === text) {
        // Every edit was already_consumed: nothing actually changed, so there is no new
        // version to write and the caller has nothing new to persist.
        return { docRef: ref, results };
      }
      const newRow = await insertVersion(ctx, working, row.filename);
      return { docRef: newRow.id, results };
    },
  };
}
