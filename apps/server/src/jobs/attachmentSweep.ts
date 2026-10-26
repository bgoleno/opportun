// Garbage-collecting orphaned attachment files (issue #4). Content-addressed storage is
// shared between two tables (attachments.storedPath, communications.bodyRef), and rows are
// removed in ways no application code observes: an opportunity delete cascades its attachment
// rows at the database level, and a crash between writing a file and inserting its row can
// leave a file with no row at all. Neither has a deletion event to hook, so this runs as a
// periodic sweep instead: list every stored file, keep what either table still references or
// what is too young to judge yet, and for everything else, re-verify right before deleting it
// rather than trusting a scan taken moments earlier.
//
// The reuse race this guards against: row A references file F; A is deleted; a sweep decides F
// is an orphan; before it unlinks F, a fresh upload of identical content reuses F (bumping its
// mtime, storage.ts) and inserts row B. The grace period alone cannot catch this — F is old
// even though the reference to it is brand new — so every deletion re-checks both the specific
// reference count and the file's current mtime immediately before it happens, at race point
// `attachments.sweep.beforeDelete`.
import { eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { attachments, communications } from '../db/schema';
import type { Db } from '../db/client';
import { audit } from '../lib/audit';
import { racePoint } from '../lib/racePoints';
import type { Storage } from '../lib/storage';
import { requireService, type JobHandler } from './registry';

/** Default window a file must sit unreferenced for before the sweep will consider it an orphan. */
export const ATTACHMENT_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
export const ATTACHMENT_SWEEP_JOB_KIND = 'attachments.sweep';
/**
 * 03:30, after the 03:00 backup (jobs/backup.ts BACKUP_CRON) has finished reading the live
 * files. This ordering is a safety property, not a scheduling preference: a file this sweep
 * deletes at 03:30 is still present in that same night's backup, so a wrong deletion stays
 * recoverable for as long as backups are kept (BACKUP_RETENTION), rather than being gone from
 * both places at once. Keep the sweep after the backup if either schedule ever moves.
 */
export const ATTACHMENT_SWEEP_CRON = '30 3 * * *';

export interface SweepResult {
  /** Content-addressed files the sweep found on disk. */
  scanned: number;
  /** Deleted: unreferenced by either table, older than the grace period, and still so when
   * re-checked immediately before the unlink. */
  deleted: number;
  /** Bytes reclaimed by those deletions. */
  bytesReclaimed: number;
  /** Left alone: still referenced, too young, or no longer safe once re-checked. */
  skipped: number;
}

/** Every storedPath either table currently references, read once per sweep pass. */
async function referencedPaths(db: Db): Promise<Set<string>> {
  const [fromAttachments, fromCommunications] = await Promise.all([
    db.select({ path: attachments.storedPath }).from(attachments).all(),
    db
      .select({ path: communications.bodyRef })
      .from(communications)
      .where(isNotNull(communications.bodyRef))
      .all(),
  ]);
  const paths = new Set<string>();
  for (const row of fromAttachments) paths.add(row.path);
  for (const row of fromCommunications) if (row.path !== null) paths.add(row.path);
  return paths;
}

/** Whether anything in either table references this one path, read fresh (not from a cache). */
async function isStillReferenced(db: Db, storedPath: string): Promise<boolean> {
  const [fromAttachments, fromCommunications] = await Promise.all([
    db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.storedPath, storedPath))
      .limit(1)
      .all(),
    db
      .select({ id: communications.id })
      .from(communications)
      .where(eq(communications.bodyRef, storedPath))
      .limit(1)
      .all(),
  ]);
  return fromAttachments.length > 0 || fromCommunications.length > 0;
}

export async function sweepOrphanedAttachments(
  db: Db,
  storage: Storage,
  opts: { now?: number; graceMs?: number } = {},
): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? ATTACHMENT_SWEEP_GRACE_MS;

  const [referenced, files] = await Promise.all([
    referencedPaths(db),
    storage.listAttachmentFiles(),
  ]);

  let deleted = 0;
  let bytesReclaimed = 0;
  let skipped = 0;
  for (const file of files) {
    if (referenced.has(file.storedPath) || now - file.mtimeMs < graceMs) {
      skipped += 1;
      continue;
    }
    await racePoint('attachments.sweep.beforeDelete');
    // Re-verified as close to the unlink as this code gets, not trusting the scan above: a
    // concurrent upload reusing this exact path, between that scan and here, bumps the mtime
    // (storage.ts) and inserts a referencing row. Either signal catches it; checking both means
    // neither one by itself has to be perfectly timed to prevent the delete.
    const currentMtime = await storage.attachmentMtime(file.storedPath);
    if (currentMtime === undefined) {
      skipped += 1; // already gone; not this pass's doing
      continue;
    }
    if (now - currentMtime < graceMs || (await isStillReferenced(db, file.storedPath))) {
      skipped += 1;
      continue;
    }
    await storage.removeAttachment(file.storedPath);
    deleted += 1;
    bytesReclaimed += file.bytes;
  }
  return { scanned: files.length, deleted, bytesReclaimed, skipped };
}

export const attachmentSweepJob: JobHandler<Record<string, never>> = {
  kind: ATTACHMENT_SWEEP_JOB_KIND,
  payloadSchema: z.object({}).strict() as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    const result = await sweepOrphanedAttachments(db, requireService(ctx, 'storage'));
    await ctx.setResult(result);
    // A destructive background job whose only trace is files no longer being there is exactly
    // what design.md principle 6 exists to prevent: this is the durable, queryable record of
    // what it did, independent of ctx.setResult (which the generic /jobs API does not list).
    await audit(db, 'attachments.swept', { detail: { ...result } });
  },
};
