// Finding and removing attachment files no row points at (https://github.com/bgoleno/opportun/issues/788):
// in lib/ so the demo seed (lib/demo/seed.ts) removes the files it replaced without importing the
// nightly sweep job (jobs/attachmentSweep.ts), which runs the same check.
import { eq, isNotNull } from 'drizzle-orm';
import { attachments, communications } from '../db/schema';
import type { Db } from '../db/client';
import { racePoint } from './racePoints';
import type { Storage } from './storage';

/** Default window a file must sit unreferenced for before the sweep will consider it an orphan. */
export const ATTACHMENT_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

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

/**
 * Removes one stored file now, with no grace period, when nothing in either table references it
 * (the demo reset, #544: a visitor's files go with the visitor's rows, the same night). The same
 * guards as the sweep below, minus the age: the references are read fresh, and the file's mtime is
 * read before and again right before the unlink, so a concurrent upload reusing this exact path
 * (which bumps the mtime, storage.ts) and its new row stop the delete. Returns whether it removed.
 */
export async function removeIfUnreferenced(
  db: Db,
  storage: Storage,
  storedPath: string,
): Promise<boolean> {
  const before = await storage.attachmentMtime(storedPath);
  if (before === undefined) return false;
  if (await isStillReferenced(db, storedPath)) return false;
  await racePoint('attachments.removeNow.beforeDelete');
  const current = await storage.attachmentMtime(storedPath);
  if (current !== before || (await isStillReferenced(db, storedPath))) return false;
  await storage.removeAttachment(storedPath);
  return true;
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
