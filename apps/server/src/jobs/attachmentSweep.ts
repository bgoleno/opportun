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
import { z } from 'zod';
import { audit } from '../lib/audit';
import { requireService, type JobHandler } from './registry';
import { sweepOrphanedAttachments } from '../lib/attachmentSweep';

export const ATTACHMENT_SWEEP_JOB_KIND = 'attachments.sweep';
/**
 * 03:30, after the 03:00 backup (jobs/backup.ts BACKUP_CRON) has finished reading the live
 * files. This ordering is a safety property, not a scheduling preference: a file this sweep
 * deletes at 03:30 is still present in that same night's backup, so a wrong deletion stays
 * recoverable for as long as backups are kept (BACKUP_RETENTION), rather than being gone from
 * both places at once. Keep the sweep after the backup if either schedule ever moves.
 */
export const ATTACHMENT_SWEEP_CRON = '30 3 * * *';

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
