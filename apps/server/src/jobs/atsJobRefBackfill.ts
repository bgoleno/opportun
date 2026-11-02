// One-shot backfill of opportunities.ats_job_ref (issue #137). Before #137 the ref an opportunity
// carried could disagree with its confirmed posting in three ways:
// - attaching a found, chosen or pasted posting confirmed it without recording a ref at all, so
//   assisted apply refuses it (`no_ats_identity`);
// - attaching posting B over one that reconcile had confirmed as A kept ref A, so a draft would
//   hand the user off to the wrong job (tl on #140): worse than refusing;
// - reconcile read refs from career pages (`gh_jid`), which no handoff can pass.
// This re-derives the ref of every confirmed posting with a URL, once, by the rule every posting
// writer now uses (lib/atsJobRef postingAtsJobRef), and writes only where the result differs
// (null included). A row whose ref already matches its URL is never written.
//
// Safe to run twice: a second run derives the same refs and finds nothing to change. Each write
// is conditional on the row being as it was read (the same posting URL and updated_at), so an
// attach, reconcile or URL edit landing meanwhile wins. Same one-shot-per-deployment shape as
// companyMatchKeyRepair.ts.
import type { AtsJobRef } from '@opportun/core';
import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { opportunities, settings, users } from '../db/schema';
import { postingAtsJobRef } from '../lib/atsJobRef';
import { racePoint } from '../lib/racePoints';
import type { UserCtx } from '../repos/base';
import type { JobHandler } from './registry';
import { enqueue } from './runner';

export const BACKFILL_ATS_JOB_REFS_KIND = 'opportunities.backfill_ats_job_refs';
/** Global marker (user_id NULL): the backfill has been queued for this deployment. */
export const BACKFILL_ATS_JOB_REFS_MARKER_KEY = 'backfill_ats_job_refs:done';

export interface AtsJobRefBackfillOutcome {
  /** Confirmed postings with a URL. */
  read: number;
  /** Had no ref; now carry their URL's. */
  set: number;
  /** Carried another posting's ref; now carry their URL's. */
  changed: number;
  /** Carried a ref their URL does not give (a career page, say); now carry none. */
  cleared: number;
}

/** The same identity, field by field (the JSON column's key order is not reliable). */
function sameRef(a: AtsJobRef | null | undefined, b: AtsJobRef | null): boolean {
  if (a == null || b === null) return (a ?? null) === b;
  return (
    a.kind === b.kind &&
    a.org === b.org &&
    a.externalId === b.externalId &&
    a.url === b.url &&
    (a.host ?? null) === (b.host ?? null) &&
    (a.externalPath ?? null) === (b.externalPath ?? null)
  );
}

/** Re-derives the ref of every confirmed posting of this user's that has a URL. */
export async function backfillAtsJobRefs(db: Db, ctx: UserCtx): Promise<AtsJobRefBackfillOutcome> {
  const rows = await db
    .select({
      id: opportunities.id,
      postingUrl: opportunities.postingUrl,
      atsJobRef: opportunities.atsJobRef,
      updatedAt: opportunities.updatedAt,
    })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.userId, ctx.userId),
        eq(opportunities.postingState, 'confirmed'),
        isNotNull(opportunities.postingUrl),
      ),
    )
    .all();
  const outcome: AtsJobRefBackfillOutcome = { read: rows.length, set: 0, changed: 0, cleared: 0 };
  for (const row of rows) {
    const ref = postingAtsJobRef(row.postingUrl);
    if (sameRef(row.atsJobRef, ref)) continue;
    // Between the read above and this write, an attach, reconcile or URL edit may land.
    await racePoint('opportunities.backfillAtsJobRef.beforeWrite');
    const changed = await db
      .update(opportunities)
      .set({ atsJobRef: ref, updatedAt: Date.now() })
      .where(
        and(
          eq(opportunities.userId, ctx.userId),
          eq(opportunities.id, row.id),
          // The row as it was read: any write since (a ref, a new posting) wins.
          eq(opportunities.postingUrl, row.postingUrl as string),
          eq(opportunities.updatedAt, row.updatedAt),
        ),
      )
      .returning({ id: opportunities.id });
    if (changed.length === 0) continue;
    if (ref === null) outcome.cleared += 1;
    else if (row.atsJobRef == null) outcome.set += 1;
    else outcome.changed += 1;
  }
  return outcome;
}

/**
 * Queues the backfill for every user, once per deployment. As in companyMatchKeyRepair.ts, the
 * marker is not written on a fresh install with no users: there is nothing to backfill, and a
 * later first user's rows are written by the fixed code.
 */
export async function enqueueBackfillAtsJobRefsOnce(db: Db): Promise<number> {
  const marker = await db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, BACKFILL_ATS_JOB_REFS_MARKER_KEY))
    .get();
  if (marker !== undefined) return 0;
  const all = await db.select({ id: users.id }).from(users).all();
  if (all.length === 0) return 0;
  for (const { id } of all) {
    await enqueue(
      db,
      BACKFILL_ATS_JOB_REFS_KIND,
      {},
      { dedupeKey: `${BACKFILL_ATS_JOB_REFS_KIND}:${id}`, userId: id },
    );
  }
  await db
    .insert(settings)
    .values({
      key: BACKFILL_ATS_JOB_REFS_MARKER_KEY,
      userId: null,
      value: Date.now(),
      updatedAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
  return all.length;
}

const PayloadSchema = z.object({}).strict();

export const backfillAtsJobRefsJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: BACKFILL_ATS_JOB_REFS_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 2,
  async run(db, _payload, ctx) {
    if (ctx.userId === null) throw new Error(`${BACKFILL_ATS_JOB_REFS_KIND} needs a user`);
    const outcome = await backfillAtsJobRefs(db, { userId: ctx.userId, isAdmin: false });
    // Counts only (the EM on #140): no ids, URLs or company names leave the database this way.
    ctx.services.log?.info({ ...outcome }, 'ats job ref backfill');
    await ctx.setResult(outcome);
  },
};
