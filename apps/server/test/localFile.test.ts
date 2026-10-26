// The local_file document store (#284): plain-text resume content with no external
// dependency, so unlike googleDocs/reactiveResume this runs against the real db and storage
// rather than a fake. useApi() gives both for free (app.localFileStore, app.db), plus two
// real registered users for the ownership checks.
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { attachments, resumes } from '../src/db/schema';
import { HttpError } from '../src/lib/errors';
import { insertResume, updateResumeDocRef } from '../src/repos/resumes';
import type { UserCtx } from '../src/repos/base';
import { useApi } from './api';
import { createOpportunity } from './resumeFixtures';
import type { TestClient } from './isolation';

const boot = useApi();

const BASE_TEXT = ['Jane Doe', 'Senior Engineer', 'Built the billing platform in Go'].join('\n');

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err.code;
    throw err;
  }
  throw new Error('expected an HttpError');
}

/** A base local_file resume: a real attachments row (via copyFrom's own write path, copying
 *  from nothing is not a thing any store supports, so this writes a first row directly,
 *  exactly as seedDemo will) plus the resumes row pointing at it. */
async function seedBase(
  app: Awaited<ReturnType<typeof boot>>['app'],
  ctx: UserCtx,
  text = BASE_TEXT,
) {
  const { storedPath, sha256, bytes } = await app.storage.writeAttachment(
    Buffer.from(text, 'utf8'),
  );
  const row = await app.db
    .insert(attachments)
    .values({
      id: `${ctx.userId}-base`,
      userId: ctx.userId,
      opportunityId: null,
      filename: 'Base Resume.txt',
      mime: 'text/plain',
      bytes,
      sha256,
      storedPath,
      createdAt: Date.now(),
    })
    .returning()
    .get();
  const resume = await insertResume(app.db, ctx, {
    kind: 'base',
    title: 'Base Resume',
    store: 'local_file',
    docRef: row.id,
    opportunityId: null,
    parentResumeId: null,
  });
  return { attachmentId: row.id, resume };
}

function ctxFor(c: TestClient): UserCtx {
  return { userId: c.userId, isAdmin: false };
}

describe('local file document store', () => {
  it('registerExisting validates ownership and returns the title and ref', async () => {
    const { app, a } = await boot();
    const ctx = ctxFor(a);
    const { attachmentId } = await seedBase(app, ctx);
    const meta = await app.localFileStore.registerExisting(ctx, attachmentId);
    expect(meta).toEqual({ docRef: attachmentId, title: 'Base Resume', url: null });
  });

  it('registerExisting refuses a ref that does not exist or belongs to someone else', async () => {
    const { app, a, b } = await boot();
    const { attachmentId } = await seedBase(app, ctxFor(a));
    expect(await code(app.localFileStore.registerExisting(ctxFor(a), 'not-a-real-id'))).toBe(
      'not_found',
    );
    expect(await code(app.localFileStore.registerExisting(ctxFor(b), attachmentId))).toBe(
      'not_found',
    );
  });

  it('copyFrom writes an independent new row with the same text', async () => {
    const { app, a } = await boot();
    const ctx = ctxFor(a);
    const { attachmentId } = await seedBase(app, ctx);
    const meta = await app.localFileStore.copyFrom(ctx, attachmentId, 'Tailored Copy');
    expect(meta.title).toBe('Tailored Copy');
    expect(meta.docRef).not.toBe(attachmentId);
    expect(await app.localFileStore.readText(ctx, meta.docRef)).toBe(BASE_TEXT);
    // Editing the copy never touches the base.
    await app.localFileStore.applyEdits(ctx, meta.docRef, [
      { find: 'Jane Doe', replace: 'J. Doe' },
    ]);
    expect(await app.localFileStore.readText(ctx, attachmentId)).toBe(BASE_TEXT);
  });

  it('readText round-trips exactly what was written, newlines included', async () => {
    const { app, a } = await boot();
    const ctx = ctxFor(a);
    const { attachmentId } = await seedBase(app, ctx);
    expect(await app.localFileStore.readText(ctx, attachmentId)).toBe(BASE_TEXT);
  });

  it('refuses the whole batch before writing anything when a find is missing (409)', async () => {
    const { app, a } = await boot();
    const ctx = ctxFor(a);
    const { attachmentId } = await seedBase(app, ctx);
    const before = await app.db.select().from(attachments).all();
    const err = await code(
      app.localFileStore.applyEdits(ctx, attachmentId, [
        { find: 'Jane Doe', replace: 'J. Doe' },
        { find: 'Not in the document anywhere', replace: 'x' },
      ]),
    );
    expect(err).toBe('edit_target_missing');
    // Nothing written: same row, same content, no new row created by the refused batch.
    expect(await app.localFileStore.readText(ctx, attachmentId)).toBe(BASE_TEXT);
    expect(await app.db.select().from(attachments).all()).toHaveLength(before.length);
  });

  it('reports an edit an earlier one in the same batch already consumed, not a silent no-op (#146)', async () => {
    const { app, a } = await boot();
    const ctx = ctxFor(a);
    const { attachmentId } = await seedBase(app, ctx);
    // Both target "Senior Engineer" (present originally, so the missing check passes for
    // both), but the first edit already replaces its only occurrence.
    const { docRef, results } = await app.localFileStore.applyEdits(ctx, attachmentId, [
      { find: 'Senior Engineer', replace: 'Staff Engineer' },
      { find: 'Senior Engineer', replace: 'Principal Engineer' },
    ]);
    expect(results).toEqual([
      { index: 0, outcome: 'applied' },
      { index: 1, outcome: 'already_consumed' },
    ]);
    const text = await app.localFileStore.readText(ctx, docRef);
    expect(text).toContain('Staff Engineer');
    expect(text).not.toContain('Principal Engineer');
  });

  it('a replacement that reintroduces its own find text is not mistaken for a skipped one', async () => {
    const { app, a } = await boot();
    const ctx = ctxFor(a);
    const { attachmentId } = await seedBase(app, ctx);
    const { results } = await app.localFileStore.applyEdits(ctx, attachmentId, [
      { find: 'Go', replace: 'Go and Go' },
    ]);
    expect(results).toEqual([{ index: 0, outcome: 'applied' }]);
  });

  it('returns a new ref when content changes, without touching the superseded row', async () => {
    const { app, a } = await boot();
    const ctx = ctxFor(a);
    const { attachmentId } = await seedBase(app, ctx);
    const { docRef } = await app.localFileStore.applyEdits(ctx, attachmentId, [
      { find: 'Jane Doe', replace: 'J. Doe' },
    ]);
    expect(docRef).not.toBe(attachmentId);
    // The store itself never deletes the old row -- that is updateResumeDocRef's job, and
    // only once the caller has persisted the new ref (see its own comment for why that
    // ordering, not the store doing it eagerly, is what keeps a crash from ever leaving a
    // resume pointing at a row that is already gone).
    const old = await app.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), eq(attachments.userId, ctx.userId)))
      .get();
    expect(old).toBeDefined();
    expect(await app.localFileStore.readText(ctx, attachmentId)).toBe(BASE_TEXT);
    expect(await app.localFileStore.readText(ctx, docRef)).toContain('J. Doe');
  });

  it('keeps the same ref when a batch nets no real change, even with an edit reported applied', async () => {
    const { app, a } = await boot();
    const ctx = ctxFor(a);
    const { attachmentId } = await seedBase(app, ctx);
    const before = await app.db.select().from(attachments).all();
    // find exists originally (passes the pre-batch check) and is reported 'applied' (it did
    // find and replace a real occurrence), but replace equals find, so the resulting text is
    // byte-identical to what it started as -- this has to be caught by comparing the final
    // text, not by asking whether every result was already_consumed (there is no such result
    // here).
    const { docRef, results } = await app.localFileStore.applyEdits(ctx, attachmentId, [
      { find: 'Jane Doe', replace: 'Jane Doe' },
    ]);
    expect(results).toEqual([{ index: 0, outcome: 'applied' }]);
    expect(docRef).toBe(attachmentId);
    expect(await app.localFileStore.readText(ctx, attachmentId)).toBe(BASE_TEXT);
    expect(await app.db.select().from(attachments).all()).toHaveLength(before.length);
  });

  it('another user cannot read, edit or copy from a resume they do not own', async () => {
    const { app, a, b } = await boot();
    const { attachmentId } = await seedBase(app, ctxFor(a));
    const other = ctxFor(b);
    expect(await code(app.localFileStore.readText(other, attachmentId))).toBe('not_found');
    expect(
      await code(app.localFileStore.applyEdits(other, attachmentId, [{ find: 'x', replace: 'y' }])),
    ).toBe('not_found');
    expect(await code(app.localFileStore.copyFrom(other, attachmentId, 'Stolen'))).toBe(
      'not_found',
    );
  });

  it('updateResumeDocRef persists the new ref and deletes the superseded row, in that order', async () => {
    const { app, a } = await boot();
    const ctx = ctxFor(a);
    const { attachmentId, resume } = await seedBase(app, ctx);
    const { docRef } = await app.localFileStore.applyEdits(ctx, attachmentId, [
      { find: 'Jane Doe', replace: 'J. Doe' },
    ]);
    await updateResumeDocRef(app.db, ctx, resume.id, docRef);
    const row = await app.db
      .select({ docRef: resumes.docRef })
      .from(resumes)
      .where(eq(resumes.id, resume.id))
      .get();
    expect(row?.docRef).toBe(docRef);
    const old = await app.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .get();
    expect(old).toBeUndefined();
  });

  it('a local_file tailored resume can be edited through the real tailoring route end to end', async () => {
    const { app, a } = await boot();
    const c = a;
    const ctx = ctxFor(c);
    const { resume: base } = await seedBase(app, ctx);
    const oppId = await createOpportunity(c);
    const tailored = await c.request({
      method: 'POST',
      url: '/api/v1/resumes',
      payload: { baseResumeId: base.id, opportunityId: oppId },
    });
    expect(tailored.statusCode).toBe(201);
    const resume = tailored.json() as { id: string; docRef: string; store: string };
    expect(resume.store).toBe('local_file');

    const session = await c.request({
      method: 'POST',
      url: `/api/v1/resumes/${resume.id}/tailoring`,
    });
    expect(session.statusCode).toBe(200);
    const sessionId = session.json().id as string;

    const applied = await c.request({
      method: 'POST',
      url: `/api/v1/tailoring/${sessionId}/suggestions/apply`,
      payload: { edits: [{ find: 'Jane Doe', replace: 'J. Doe' }] },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toEqual({ results: [{ index: 0, outcome: 'applied' }] });

    // The resume's own docRef actually moved: the caller (tailoring.ts) persisted what
    // applyEdits returned, exactly as it must for a store whose content is immutable per
    // version.
    const row = await app.db
      .select({ docRef: resumes.docRef })
      .from(resumes)
      .where(eq(resumes.id, resume.id))
      .get();
    expect(row?.docRef).not.toBe(resume.docRef);
    expect(await app.localFileStore.readText(ctx, row!.docRef)).toContain('J. Doe');
  });
});
