// Purging what is already stored (spec D5, Plan 3 Task 4).
//
// Plans 1 and 2 decide what Opportun may see; Task 1 decides what it keeps from now on. This is
// the answer to "what about everything you already have", and it is the user's own action: it is
// destructive and irreversible from inside the app, so every entry point previews counts first.
//
// Two rules shape all of it:
//
//   A purge removes CONTENT, never records. A discovery result keeps its company, its role and
//   its dedupe key, so the queue still reads and the next sync does not hand the lead back; a
//   message keeps its sender, date and identifiers, so the Blocked view still explains itself
//   and its deep link still works. What goes is the description, the model's words, and the body.
//
//   A purge never breaks something in flight. A body an unfinished classify job will read is
//   left alone, and a file two rows share is unlinked from one of them rather than deleted.
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { communications, discoveryResults, jobs } from '../db/schema';
import type { Db } from '../db/client';
import type { Storage } from '../lib/storage';
import type { UserCtx } from '../repos/base';
import { CLASSIFY_JOB_KIND, classifyDedupeKey } from './mailIngest';
import { cancelJob, type JobRow } from './runner';

/** Job states that still have a run ahead of them. */
const UNFINISHED = ['pending', 'running'] as const;

export interface PurgePreview {
  /** Discovery results whose content would go (everything not accepted or linked). */
  discoveryResults: number;
  /** Stored message bodies that would be cleared. */
  mailBodies: number;
  /** Bodies left alone because an unfinished classify job is still going to read them. */
  bodiesInUse: number;
}

/** The rows a discovery purge covers: not accepted, and not attached to an opportunity. */
const purgeableLeads = (ctx: UserCtx) =>
  and(
    eq(discoveryResults.userId, ctx.userId),
    ne(discoveryResults.disposition, 'accepted'),
    sql`${discoveryResults.opportunityId} IS NULL`,
  );

/** Communication ids with a classify job that has not run yet, by dedupe key. */
async function awaitingClassify(db: Db, ctx: UserCtx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const keys = ids.map((id) => classifyDedupeKey(id));
  const rows = await db
    .select({ dedupeKey: jobs.dedupeKey })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, CLASSIFY_JOB_KIND),
        inArray(jobs.status, [...UNFINISHED]),
        inArray(jobs.dedupeKey, keys),
      ),
    )
    .all();
  const held = new Set<string>();
  for (const row of rows) {
    const id = ids.find((candidate) => classifyDedupeKey(candidate) === row.dedupeKey);
    if (id !== undefined) held.add(id);
  }
  return held;
}

/** Rows of this user's that still point at a stored body. */
async function bodiedRows(db: Db, ctx: UserCtx) {
  return await db
    .select({ id: communications.id, bodyRef: communications.bodyRef })
    .from(communications)
    .where(and(eq(communications.userId, ctx.userId), isNotNull(communications.bodyRef)))
    .all();
}

/** What each purge would take. Reads only: a preview the user has not agreed to changes nothing. */
export async function previewPurge(db: Db, ctx: UserCtx): Promise<PurgePreview> {
  const leads = await db
    .select({ id: discoveryResults.id })
    .from(discoveryResults)
    .where(purgeableLeads(ctx))
    .all();
  const bodied = await bodiedRows(db, ctx);
  const held = await awaitingClassify(
    db,
    ctx,
    bodied.map((r) => r.id),
  );
  return {
    discoveryResults: leads.length,
    mailBodies: bodied.length - held.size,
    bodiesInUse: held.size,
  };
}

/**
 * Drops the content of every discovery result the user has not accepted, and returns how many
 * it changed. `posting` is NOT NULL, so this writes a pruned posting rather than nulling it: the
 * company and the role are what make a queue row recognizable, which is Brian's rule for a
 * discovery record, and they are also all that is left to recognize it by.
 */
export async function purgeDiscoveryContent(db: Db, ctx: UserCtx): Promise<number> {
  const rows = await db
    .select({ id: discoveryResults.id, posting: discoveryResults.posting })
    .from(discoveryResults)
    .where(purgeableLeads(ctx))
    .all();
  const now = Date.now();
  for (const row of rows) {
    const posting = row.posting as { company?: unknown; title?: unknown };
    const pruned: Record<string, unknown> = {};
    // Both are required by NormalizedPostingSchema, so they are copied rather than dropped; a
    // row that somehow lacks them keeps a readable placeholder instead of failing validation.
    pruned.company = typeof posting.company === 'string' ? posting.company : 'Unknown';
    pruned.title = typeof posting.title === 'string' ? posting.title : 'Unknown';
    await db
      .update(discoveryResults)
      .set({ posting: pruned, aiRationale: null, updatedAt: now })
      .where(and(eq(discoveryResults.userId, ctx.userId), eq(discoveryResults.id, row.id)))
      .run();
  }
  return rows.length;
}

export interface MailPurgeOutcome {
  /** Rows whose body pointer was cleared. */
  cleared: number;
  /** Files deleted from storage. */
  deleted: number;
  /** Files kept because another row still points at them (storage is content addressed). */
  shared: number;
  /** Rows left alone because an unfinished classify job will read the body. */
  skipped: number;
}

/**
 * Clears the stored bodies of this user's messages. The row stays, with its sender, its date and
 * the identifiers its deep link needs; only the body goes.
 *
 * A file is deleted only when no other row anywhere points at it, because `writeAttachment` is
 * content addressed: two copies of the same message are one file, and deleting it for one row
 * would leave the other pointing at nothing. The pointer is cleared first, so a crash between
 * the two leaves an unreferenced file (which a later run deletes) rather than a row pointing at
 * a file that is gone.
 */
export async function purgeMailBodies(
  db: Db,
  ctx: UserCtx,
  storage: Storage,
): Promise<MailPurgeOutcome> {
  const rows = await bodiedRows(db, ctx);
  const held = await awaitingClassify(
    db,
    ctx,
    rows.map((r) => r.id),
  );
  const out: MailPurgeOutcome = { cleared: 0, deleted: 0, shared: 0, skipped: 0 };
  const now = Date.now();
  for (const row of rows) {
    if (row.bodyRef === null) continue;
    if (held.has(row.id)) {
      out.skipped += 1;
      continue;
    }
    await db
      .update(communications)
      .set({ bodyRef: null, updatedAt: now })
      .where(and(eq(communications.userId, ctx.userId), eq(communications.id, row.id)))
      .run();
    out.cleared += 1;
    const others = await db
      .select({ id: communications.id })
      .from(communications)
      .where(eq(communications.bodyRef, row.bodyRef))
      .limit(1)
      .all();
    if (others.length > 0) {
      out.shared += 1;
      continue;
    }
    await storage.removeAttachment(row.bodyRef);
    out.deleted += 1;
  }
  return out;
}

export interface DrainOutcome {
  /** Pending classify jobs dead-lettered, each releasing the body its row was holding back. */
  cancelled: number;
  /**
   * Blocking jobs this call found but could not cancel, with the status a read-back right after
   * confirmed it was in, so a row that is still blocked says why rather than looking the same as
   * one that was never blocked. The only cause today is a job already `running`: cancelling it
   * would race the worker executing it, the same restraint `cancelJob` itself keeps.
   */
  stillBlocked: { id: string; status: JobRow['status'] }[];
}

/**
 * Dead-letters the pending classify jobs holding this user's mail-body purge back (issue #66).
 * This is the operator's own decision to stop waiting on them, not a verdict on whether those
 * messages should ever have been classified (that question is still open; nothing here answers
 * it). Every job still blocking a purge is looked at (pending or running, the same definition
 * purgeMailBodies itself uses), but only a `pending` one is actually touched — one already
 * `running` is left to finish on its own and reported in `stillBlocked` instead, never silently
 * dropped from the count.
 *
 * Purge itself is untouched: this runs before it, not inside it, so the one invariant that
 * matters here, that a purge never breaks something in flight, still holds exactly as it did
 * before this existed. Once a job is dead rather than pending, purgeMailBodies simply no longer
 * finds a reason to hold its row back.
 */
export async function drainBlockingClassifyJobs(db: Db, ctx: UserCtx): Promise<DrainOutcome> {
  const bodied = await bodiedRows(db, ctx);
  if (bodied.length === 0) return { cancelled: 0, stillBlocked: [] };
  const keys = bodied.map((r) => classifyDedupeKey(r.id));
  const blocking = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, CLASSIFY_JOB_KIND),
        inArray(jobs.status, [...UNFINISHED]),
        eq(jobs.userId, ctx.userId),
        inArray(jobs.dedupeKey, keys),
      ),
    )
    .all();
  let cancelled = 0;
  const stillBlocked: DrainOutcome['stillBlocked'] = [];
  for (const job of blocking) {
    const result = await cancelJob(db, job.id, 'cancelled: purge was waiting on it (issue #66)');
    if (result !== undefined) {
      cancelled += 1;
      continue;
    }
    // Read back rather than assume why: the job may have finished on its own between the select
    // above and the attempt just now, not only have been running the whole time.
    const now = await db
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, job.id))
      .get();
    if (now !== undefined && UNFINISHED.includes(now.status as (typeof UNFINISHED)[number])) {
      stillBlocked.push({ id: job.id, status: now.status });
    }
  }
  return { cancelled, stillBlocked };
}
