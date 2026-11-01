// The local_file document store (#284): plain-text resume content with no external
// dependency, so unlike googleDocs/reactiveResume this runs against the real db and storage
// rather than a fake. useApi() gives both for free (app.localFileStore, app.db), plus two
// real registered users for the ownership checks.
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { attachments, resumes } from '../src/db/schema';
import { sweepOrphanedAttachments } from '../src/jobs/attachmentSweep';
import { HttpError } from '../src/lib/errors';
import { setRaceHook } from '../src/lib/racePoints';
import { insertResume, updateResumeDocRef } from '../src/repos/resumes';
import type { UserCtx } from '../src/repos/base';
import { APPLY_ATTEMPTS } from '../src/routes/tailoring';
import { useApi } from './api';
import { createOpportunity } from './resumeFixtures';
import type { TestClient } from './isolation';
import { holdAt } from './race';

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

type App = Awaited<ReturnType<typeof boot>>['app'];

/** A local_file tailored copy of a seeded base, with an open tailoring session to apply through. */
async function tailoredSession(app: App, c: TestClient) {
  const ctx = ctxFor(c);
  const { attachmentId: baseRef, resume: base } = await seedBase(app, ctx);
  const opportunityId = await createOpportunity(c);
  const tailored = await c.request({
    method: 'POST',
    url: '/api/v1/resumes',
    payload: { baseResumeId: base.id, opportunityId },
  });
  if (tailored.statusCode !== 201) throw new Error(`tailored copy: ${tailored.statusCode}`);
  const resumeId = tailored.json().id as string;
  const session = await c.request({ method: 'POST', url: `/api/v1/resumes/${resumeId}/tailoring` });
  if (session.statusCode !== 200) throw new Error(`tailoring session: ${session.statusCode}`);
  return { ctx, baseRef, resumeId, sessionId: session.json().id as string };
}

function applyEdit(c: TestClient, sessionId: string, edit: { find: string; replace: string }) {
  return c.request({
    method: 'POST',
    url: `/api/v1/tailoring/${sessionId}/suggestions/apply`,
    payload: { edits: [edit] },
  });
}

async function liveDocRef(app: App, resumeId: string): Promise<string> {
  const row = await app.db
    .select({ docRef: resumes.docRef })
    .from(resumes)
    .where(eq(resumes.id, resumeId))
    .get();
  if (row === undefined) throw new Error('resume row missing');
  return row.docRef;
}

/** Every attachments row the user owns, sorted: the base, the live version, and any leak. */
async function versionIds(app: App, ctx: UserCtx): Promise<string[]> {
  const rows = await app.db
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.userId, ctx.userId))
    .all();
  return rows.map((r) => r.id).sort();
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
    expect(await updateResumeDocRef(app.db, ctx, resume.id, attachmentId, docRef)).toBe(true);
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

  it('updateResumeDocRef is a compare-and-set: a writer holding a stale ref changes nothing live (#23)', async () => {
    const { app, a } = await boot();
    const ctx = ctxFor(a);
    const { attachmentId, resume } = await seedBase(app, ctx);
    // Two versions computed from the same original, as two racing applies compute them.
    const { docRef: won } = await app.localFileStore.applyEdits(ctx, attachmentId, [
      { find: 'Jane Doe', replace: 'J. Doe' },
    ]);
    const { docRef: stale } = await app.localFileStore.applyEdits(ctx, attachmentId, [
      { find: 'Senior Engineer', replace: 'Staff Engineer' },
    ]);
    expect(await updateResumeDocRef(app.db, ctx, resume.id, attachmentId, won)).toBe(true);
    const resumeBefore = await app.db.select().from(resumes).where(eq(resumes.id, resume.id)).get();
    const liveBefore = await app.db.select().from(attachments).where(eq(attachments.id, won)).get();

    expect(await updateResumeDocRef(app.db, ctx, resume.id, attachmentId, stale)).toBe(false);
    // The stored state, not just the return value: the resume row and the live version's row
    // are exactly as they were, and the live text still reads back.
    expect(await app.db.select().from(resumes).where(eq(resumes.id, resume.id)).get()).toEqual(
      resumeBefore,
    );
    expect(await app.db.select().from(attachments).where(eq(attachments.id, won)).get()).toEqual(
      liveBefore,
    );
    expect(await app.localFileStore.readText(ctx, won)).toBe(
      BASE_TEXT.replace('Jane Doe', 'J. Doe'),
    );
    // The stale writer's own version is the only row dropped: nothing references it.
    expect(await versionIds(app, ctx)).toEqual([won]);
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

// Two applies on one resume used to both read version D0, write D1 and D2 from it, and persist
// in turn, so the second replaced the first and its edit was silently lost
// (https://github.com/bgoleno/opportun/issues/23). holdAt parks both at the race point between
// writing a version and persisting it: the interleaving that lost the edit, every run.
describe('concurrent applies to one local_file resume (#23)', () => {
  it('two applies of different edits at once: both land, and nothing is left behind', async () => {
    const { app, a } = await boot();
    const { ctx, baseRef, resumeId, sessionId } = await tailoredSession(app, a);
    const barrier = holdAt('tailoring.apply', 2);
    const responses = await Promise.all([
      applyEdit(a, sessionId, { find: 'Jane Doe', replace: 'J. Doe' }),
      applyEdit(a, sessionId, { find: 'Senior Engineer', replace: 'Staff Engineer' }),
    ]);
    expect(barrier.arrived()).toBe(2);
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ results: [{ index: 0, outcome: 'applied' }] });
    }
    const live = await liveDocRef(app, resumeId);
    const text = await app.localFileStore.readText(ctx, live);
    expect(text).toContain('J. Doe');
    expect(text).toContain('Staff Engineer');
    // Superseded versions and the losing attempt's own version are all gone.
    expect(await versionIds(app, ctx)).toEqual([baseRef, live].sort());
  });

  it('two applies rewriting the same text at once: one lands, the other is refused, not lost', async () => {
    const { app, a } = await boot();
    const { ctx, baseRef, resumeId, sessionId } = await tailoredSession(app, a);
    const edits = [
      { find: 'Jane Doe', replace: 'J. Doe' },
      { find: 'Jane Doe', replace: 'Jane Q. Doe' },
    ];
    const barrier = holdAt('tailoring.apply', 2);
    const outcomes = await Promise.all(
      edits.map(async (edit) => ({ edit, res: await applyEdit(a, sessionId, edit) })),
    );
    expect(barrier.arrived()).toBe(2);
    expect(outcomes.map((o) => o.res.statusCode).sort()).toEqual([200, 409]);
    const won = outcomes.find((o) => o.res.statusCode === 200)!;
    const lost = outcomes.find((o) => o.res.statusCode === 409)!;
    // The loser retried against the winner's version, where its find text no longer is.
    expect(lost.res.json().error.code).toBe('edit_target_missing');
    const live = await liveDocRef(app, resumeId);
    const text = await app.localFileStore.readText(ctx, live);
    expect(text).toContain(won.edit.replace);
    expect(text).not.toContain(lost.edit.replace);
    expect(await versionIds(app, ctx)).toEqual([baseRef, live].sort());
  });

  it('two identical applies at once share one stored file: dropping the loser keeps the live bytes', async () => {
    const { app, a } = await boot();
    const { ctx, baseRef, resumeId, sessionId } = await tailoredSession(app, a);
    const edit = { find: 'Jane Doe', replace: 'J. Doe' };
    const barrier = holdAt('tailoring.apply', 2);
    const responses = await Promise.all([
      applyEdit(a, sessionId, edit),
      applyEdit(a, sessionId, edit),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    // Identical text is one content-addressed file under two version rows. Only the losing
    // row is dropped, so the sweep, run with no grace period, still finds the file referenced.
    await sweepOrphanedAttachments(app.db, app.storage, { graceMs: 0 });
    const live = await liveDocRef(app, resumeId);
    expect(await app.localFileStore.readText(ctx, live)).toBe(
      BASE_TEXT.replace('Jane Doe', 'J. Doe'),
    );
    expect(await versionIds(app, ctx)).toEqual([baseRef, live].sort());
  });

  it('an apply that loses every compare-and-set answers 409 and leaves the live version alone', async () => {
    const { app, a } = await boot();
    const { ctx, baseRef, resumeId, sessionId } = await tailoredSession(app, a);
    // Another apply lands between this one writing its version and persisting it, every time.
    let landed = 0;
    let lastLanded = '';
    setRaceHook(async (point) => {
      if (point !== 'tailoring.apply') return;
      const from = await liveDocRef(app, resumeId);
      const { docRef } = await app.localFileStore.applyEdits(ctx, from, [
        { find: 'Go', replace: 'Go!' },
      ]);
      if (!(await updateResumeDocRef(app.db, ctx, resumeId, from, docRef))) {
        throw new Error('the competing apply lost its own compare-and-set');
      }
      landed += 1;
      lastLanded = docRef;
    });
    const res = await applyEdit(a, sessionId, { find: 'Jane Doe', replace: 'J. Doe' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('resume_changed');
    expect(landed).toBe(APPLY_ATTEMPTS);
    const live = await liveDocRef(app, resumeId);
    expect(live).toBe(lastLanded);
    const text = await app.localFileStore.readText(ctx, live);
    expect(text).toContain(`Go${'!'.repeat(APPLY_ATTEMPTS)}`);
    expect(text).toContain('Jane Doe');
    expect(await versionIds(app, ctx)).toEqual([baseRef, live].sort());
  });
});
