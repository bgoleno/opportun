// One-shot backfill of opportunities.ats_job_ref (issue #137). Before #137, attaching a found,
// chosen or pasted posting confirmed it without recording its ATS identity; only reconcile did.
// So an opportunity whose posting was attached by hand has a confirmed posting on a recognised
// board and no ref, and assisted apply refuses it (`no_ats_identity`). This derives the ref
// once, by the same rule every posting writer now uses (lib/atsJobRef postingAtsJobRef).
//
// Safe to run twice: it reads only confirmed rows with a posting URL and no ref, and writes only
// where the row still has no ref (a conditional update), so a row with a ref, however it got
// one, is never touched, and a second run finds nothing it can change. A URL that is not a
// recognised board gives no ref and the row stays as it is. Same one-shot-per-deployment shape
// as companyMatchKeyRepair.ts.
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
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
  /** Confirmed postings with a URL and no ref. */
  scanned: number;
  /** Those given a ref (their URL is a recognised board posting). */
  filled: number;
}

/** Derives the ref for every confirmed posting of this user's that has a URL and no ref. */
export async function backfillAtsJobRefs(db: Db, ctx: UserCtx): Promise<AtsJobRefBackfillOutcome> {
  const rows = await db
    .select({ id: opportunities.id, postingUrl: opportunities.postingUrl })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.userId, ctx.userId),
        eq(opportunities.postingState, 'confirmed'),
        isNotNull(opportunities.postingUrl),
        isNull(opportunities.atsJobRef),
      ),
    )
    .all();
  let filled = 0;
  for (const row of rows) {
    const ref = postingAtsJobRef(row.postingUrl);
    if (ref === null) continue;
    // Between the read above and this write, an attach, reconcile or URL edit may land.
    await racePoint('opportunities.backfillAtsJobRef.beforeWrite');
    const changed = await db
      .update(opportunities)
      .set({ atsJobRef: ref, updatedAt: Date.now() })
      .where(
        and(
          eq(opportunities.userId, ctx.userId),
          eq(opportunities.id, row.id),
          // Still no ref, and still this URL: a ref or a new posting written since wins.
          isNull(opportunities.atsJobRef),
          eq(opportunities.postingUrl, row.postingUrl as string),
        ),
      )
      .returning({ id: opportunities.id });
    filled += changed.length;
  }
  return { scanned: rows.length, filled };
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
    await ctx.setResult(await backfillAtsJobRefs(db, { userId: ctx.userId, isAdmin: false }));
  },
};
