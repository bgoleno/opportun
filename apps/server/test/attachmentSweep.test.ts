// Garbage-collecting orphaned attachment files (issue #4). Content addressing means a file
// under attachments/<aa>/<sha256> can be referenced by an attachments row, a communications
// row (bodyRef), both, or neither — and a fresh upload can reuse an old, already-orphaned
// path while a sweep is deciding what to do with it. "Must not delete" is tested first and
// more thoroughly than "must delete": a sweep that removes a file something still references
// is worse than the leak it exists to fix.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { newId } from '@opportun/core';
import { attachments, auditLog, communications, jobs } from '../src/db/schema';
import { ATTACHMENT_SWEEP_JOB_KIND, sweepOrphanedAttachments } from '../src/jobs/attachmentSweep';
import { enqueue } from '../src/jobs/runner';
import { upsertInbound } from '../src/repos/communications';
import type { TestClient } from './isolation';
import { pauseAt } from './race';
import { useApi } from './api';

const boot = useApi();
const ctxOf = (userId: string) => ({ userId, isAdmin: false });

/** A real attachment row, uploaded through the same storage path production uses. */
async function withAttachment(
  app: FastifyInstance,
  userId: string,
  oppId: string,
  body = `attachment content ${newId()}`,
): Promise<{ id: string; storedPath: string }> {
  const stored = await app.storage.writeAttachment(Buffer.from(body, 'utf8'));
  const row = await app.db
    .insert(attachments)
    .values({
      id: newId(),
      userId,
      opportunityId: oppId,
      filename: 'resume.pdf',
      mime: 'application/pdf',
      bytes: stored.bytes,
      sha256: stored.sha256,
      storedPath: stored.storedPath,
      createdAt: Date.now(),
    })
    .returning()
    .get();
  return { id: row.id, storedPath: stored.storedPath };
}

/** A communications row whose bodyRef points at real stored bytes (pre-#59 shape). */
async function withCommBody(
  app: FastifyInstance,
  userId: string,
  body = `message body ${newId()}`,
): Promise<{ id: string; storedPath: string }> {
  const stored = await app.storage.writeAttachment(Buffer.from(body, 'utf8'));
  const { id } = await upsertInbound(app.db, ctxOf(userId), 'gmail', {
    externalId: `sweep-${newId()}`,
    threadKey: `sweep-${newId()}`,
    from: 'recruiter@example.com',
    to: ['me@user.example'],
    subject: 'Next steps',
    snippet: body.slice(0, 80),
    bodyText: body,
    sentAt: Date.now(),
  });
  await app.db
    .update(communications)
    .set({ bodyRef: stored.storedPath })
    .where(eq(communications.id, id))
    .run();
  return { id, storedPath: stored.storedPath };
}

const fileExists = async (app: FastifyInstance, storedPath: string): Promise<boolean> => {
  try {
    (await app.storage.openAttachment(storedPath)).destroy();
    return true;
  } catch {
    return false;
  }
};

async function createOpportunity(c: TestClient): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName: 'Initech', title: 'Staff Engineer', sourceKind: 'manual' },
  });
  return (res.json() as { id: string }).id;
}

/**
 * Every file written in these tests gets a real, current mtime from the filesystem, so "old
 * enough to sweep" is tested by shrinking the grace period to effectively zero (real now,
 * tiny window) rather than by faking "now" far from a real mtime it would never naturally sit
 * near. The one test for the grace period itself does the opposite: real now, the production
 * default window, immediately after the file was created.
 */
const PAST_GRACE = { graceMs: 0 };

describe('sweepOrphanedAttachments: must not delete (issue #4)', () => {
  it('leaves a file referenced only from communications.bodyRef alone, with no attachments row at all', async () => {
    const { app, a } = await boot();
    const { storedPath } = await withCommBody(app, a.userId);

    const result = await sweepOrphanedAttachments(app.db, app.storage, PAST_GRACE);

    expect(result.deleted).toBe(0);
    expect(await fileExists(app, storedPath)).toBe(true);
  });

  it('leaves a file shared by a second attachments row alone, even after the first row is deleted', async () => {
    const { app, a } = await boot();
    const oppId = await createOpportunity(a);
    const shared = `shared bytes ${newId()}`;
    const first = await withAttachment(app, a.userId, oppId, shared);
    const second = await withAttachment(app, a.userId, oppId, shared);
    expect(first.storedPath).toBe(second.storedPath);
    await app.db.delete(attachments).where(eq(attachments.id, first.id)).run();

    const result = await sweepOrphanedAttachments(app.db, app.storage, PAST_GRACE);

    expect(result.deleted).toBe(0);
    expect(await fileExists(app, first.storedPath)).toBe(true);
  });

  it('leaves an unreferenced file alone while it is younger than the grace period', async () => {
    const { app, a } = await boot();
    const oppId = await createOpportunity(a);
    const { id, storedPath } = await withAttachment(app, a.userId, oppId);
    await app.db.delete(attachments).where(eq(attachments.id, id)).run();

    // "now" is right after the file was written: nowhere near graceMs old yet.
    const result = await sweepOrphanedAttachments(app.db, app.storage, { now: Date.now() });

    expect(result.deleted).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(await fileExists(app, storedPath)).toBe(true);
  });

  it('does not touch anything under attachments/ that is not a content-addressed attachment file', async () => {
    const { app, dataDir } = await boot();
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    // The exact shape writeAttachment itself uses for in-progress uploads (storage.ts), plus a
    // stray file that merely looks adjacent to the real structure.
    await mkdir(join(dataDir, 'attachments', 'tmp'), { recursive: true });
    await writeFile(join(dataDir, 'attachments', 'tmp', 'in-progress-upload'), 'partial');
    await mkdir(join(dataDir, 'attachments', 'ab'), { recursive: true });
    await writeFile(join(dataDir, 'attachments', 'ab', 'not-a-sha256'), 'stray');

    const result = await sweepOrphanedAttachments(app.db, app.storage, PAST_GRACE);

    expect(result.deleted).toBe(0);
    const { readFile } = await import('node:fs/promises');
    await expect(
      readFile(join(dataDir, 'attachments', 'tmp', 'in-progress-upload'), 'utf8'),
    ).resolves.toBe('partial');
    await expect(
      readFile(join(dataDir, 'attachments', 'ab', 'not-a-sha256'), 'utf8'),
    ).resolves.toBe('stray');
  });

  it('does not delete a file a concurrent re-upload starts referencing while the sweep is mid-decision (the reuse race)', async () => {
    const { app, a } = await boot();
    const oppId = await createOpportunity(a);
    const content = `reused bytes ${newId()}`;
    const { id, storedPath } = await withAttachment(app, a.userId, oppId, content);
    await app.db.delete(attachments).where(eq(attachments.id, id)).run();

    // The sweep has already decided storedPath is an orphan (old, unreferenced) and is parked
    // right before its final, closest-to-the-unlink re-check. A whole competing upload of the
    // same bytes runs to completion in between: same content, same storedPath, a brand new row.
    const pause = pauseAt('attachments.sweep.beforeDelete');
    const sweepDone = sweepOrphanedAttachments(app.db, app.storage, PAST_GRACE);
    await pause.reached;

    const reused = await withAttachment(app, a.userId, oppId, content);
    expect(reused.storedPath).toBe(storedPath);

    pause.release();
    const result = await sweepDone;

    expect(result.deleted).toBe(0);
    expect(await fileExists(app, storedPath)).toBe(true);
    const row = await app.db.select().from(attachments).where(eq(attachments.id, reused.id)).get();
    expect(row?.storedPath).toBe(storedPath);
  });
});

describe('sweepOrphanedAttachments: must delete (issue #4)', () => {
  it('deletes a file nothing references once it is older than the grace period, and reports bytes reclaimed', async () => {
    const { app, a } = await boot();
    const oppId = await createOpportunity(a);
    const { id, storedPath } = await withAttachment(app, a.userId, oppId, '0123456789');
    await app.db.delete(attachments).where(eq(attachments.id, id)).run();

    const result = await sweepOrphanedAttachments(app.db, app.storage, PAST_GRACE);

    expect(result.deleted).toBe(1);
    expect(result.bytesReclaimed).toBe(10);
    expect(await fileExists(app, storedPath)).toBe(false);
  });

  it('is safe to run twice: the second pass finds nothing left to do', async () => {
    const { app, a } = await boot();
    const oppId = await createOpportunity(a);
    const { id } = await withAttachment(app, a.userId, oppId);
    await app.db.delete(attachments).where(eq(attachments.id, id)).run();

    await sweepOrphanedAttachments(app.db, app.storage, PAST_GRACE);
    const second = await sweepOrphanedAttachments(app.db, app.storage, PAST_GRACE);

    expect(second.deleted).toBe(0);
  });

  it('clears an orphaned communications body file the same way as an orphaned attachment file', async () => {
    const { app, a } = await boot();
    const { id, storedPath } = await withCommBody(app, a.userId);
    await app.db
      .update(communications)
      .set({ bodyRef: null })
      .where(eq(communications.id, id))
      .run();

    const result = await sweepOrphanedAttachments(app.db, app.storage, PAST_GRACE);

    expect(result.deleted).toBe(1);
    expect(await fileExists(app, storedPath)).toBe(false);
  });

  it('leaves rows and other users entirely alone, only ever touching files', async () => {
    const { app, a, b } = await boot();
    const oppA = await createOpportunity(a);
    const kept = await withAttachment(app, a.userId, oppA);
    const oppB = await createOpportunity(b);
    const { id: orphanId, storedPath: orphanPath } = await withAttachment(app, b.userId, oppB);
    await app.db.delete(attachments).where(eq(attachments.id, orphanId)).run();

    const result = await sweepOrphanedAttachments(app.db, app.storage, PAST_GRACE);

    expect(result.deleted).toBe(1);
    expect(await fileExists(app, kept.storedPath)).toBe(true);
    expect(await fileExists(app, orphanPath)).toBe(false);
  });
});

describe('attachmentSweepJob: reports what it did (issue #4, design principle 6)', () => {
  it('records the result on the job row and writes an audit entry with the same counts', async () => {
    const { app, a } = await boot();
    const oppId = await createOpportunity(a);
    const { id, storedPath } = await withAttachment(app, a.userId, oppId, '0123456789');
    await app.db.delete(attachments).where(eq(attachments.id, id)).run();
    // A sweep job always runs with the production default grace period; age the file past it
    // the same way the real clock would, by inserting it with an already-old mtime.
    const { utimes } = await import('node:fs/promises');
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(app.storage.resolveInsideRoot(storedPath), longAgo, longAgo);

    const jobId = await enqueue(app.db, ATTACHMENT_SWEEP_JOB_KIND, {});
    await app.jobs.drain();

    const row = await app.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(row?.status).toBe('done');
    expect(row?.result).toMatchObject({ deleted: 1, bytesReclaimed: 10 });
    expect(await fileExists(app, storedPath)).toBe(false);

    const entries = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'attachments.swept'))
      .all();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toMatchObject({ deleted: 1, bytesReclaimed: 10 });
  });
});
