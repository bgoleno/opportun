// One-shot repair of dedupe keys computed before the non-Latin location fallback existed
// (issue #13). orFallback (packages/core/src/dedupe.ts) now covers location the same way it
// already covered company and title: a location that normalizes to empty (Japanese, Cyrillic
// and similar) gets a hash segment instead of collapsing every such location into the same key.
//
// Unlike issue #14's LinkedIn message ids, these keys CAN be recomputed from what is already
// stored: company (via companies.name), title and location are ordinary persisted fields, never
// purged the way a LinkedIn message's body is (#53). So this corrects existing rows in place
// rather than matching an old and a new formula forever.
//
// Only a row whose dedupeKey is already set is touched. A NULL key means the user force-created
// past a duplicate (createOpportunity's `force`), which is a sticky, intentional opt-out the
// same way an ordinary edit already respects it: updateOpportunity never reclaims a null key
// either. This repair must not silently undo that choice.
import { dedupeKey } from '@opportun/core';
import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { companies, discoveryResults, opportunities, settings, users } from '../db/schema';
import type { UserCtx } from '../repos/base';
import type { JobHandler } from './registry';
import { enqueue } from './runner';

export const REPAIR_DEDUPE_KEYS_KIND = 'discovery.repair_dedupe_keys';
/** Global marker (user_id NULL): the repair has been queued for this deployment. */
export const REPAIR_DEDUPE_KEYS_MARKER_KEY = 'repair_dedupe_keys:done';

export interface DedupeKeyRepairOutcome {
  opportunities: { scanned: number; corrected: number };
  discoveryResults: { scanned: number; corrected: number };
}

/** Recomputes every dedupe key the caller already has one for, correcting it only if it changed. */
export async function repairDedupeKeys(db: Db, ctx: UserCtx): Promise<DedupeKeyRepairOutcome> {
  const oppRows = await db
    .select({
      id: opportunities.id,
      title: opportunities.title,
      location: opportunities.location,
      dedupeKey: opportunities.dedupeKey,
      companyName: companies.name,
    })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(and(eq(opportunities.userId, ctx.userId), isNotNull(opportunities.dedupeKey)))
    .all();
  let oppCorrected = 0;
  for (const row of oppRows) {
    const fixed = dedupeKey(row.companyName, row.title, row.location);
    if (fixed === row.dedupeKey) continue;
    try {
      await db
        .update(opportunities)
        .set({ dedupeKey: fixed, updatedAt: Date.now() })
        .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, row.id)))
        .run();
      oppCorrected += 1;
    } catch {
      // The unique (userId, dedupeKey) index refusing this write would mean something else
      // changed concurrently with the repair; leave this one row as it was rather than fail
      // the whole pass over it. (Not expected: the fallback can only separate keys that were
      // already collapsed into one, and the index already forbids two live rows sharing one.)
    }
  }

  const discRows = await db
    .select({
      id: discoveryResults.id,
      posting: discoveryResults.posting,
      dedupeKey: discoveryResults.dedupeKey,
    })
    .from(discoveryResults)
    .where(and(eq(discoveryResults.userId, ctx.userId), isNotNull(discoveryResults.dedupeKey)))
    .all();
  let discCorrected = 0;
  for (const row of discRows) {
    const company = row.posting['company'];
    const title = row.posting['title'];
    const location = row.posting['location'];
    if (typeof company !== 'string' || typeof title !== 'string') continue;
    const fixed = dedupeKey(company, title, typeof location === 'string' ? location : null);
    if (fixed === row.dedupeKey) continue;
    await db
      .update(discoveryResults)
      .set({ dedupeKey: fixed, updatedAt: Date.now() })
      .where(and(eq(discoveryResults.userId, ctx.userId), eq(discoveryResults.id, row.id)))
      .run();
    discCorrected += 1;
  }

  return {
    opportunities: { scanned: oppRows.length, corrected: oppCorrected },
    discoveryResults: { scanned: discRows.length, corrected: discCorrected },
  };
}

/**
 * Queues the repair for every user, once per deployment. See enqueueRepairAlertLeadsOnce
 * (repairAlertLeads.ts) for why the marker is skipped rather than written on a fresh install
 * with no users yet: the same reasoning applies here unchanged.
 */
export async function enqueueRepairDedupeKeysOnce(db: Db): Promise<number> {
  const marker = await db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, REPAIR_DEDUPE_KEYS_MARKER_KEY))
    .get();
  if (marker !== undefined) return 0;
  const all = await db.select({ id: users.id }).from(users).all();
  if (all.length === 0) return 0;
  for (const { id } of all) {
    await enqueue(
      db,
      REPAIR_DEDUPE_KEYS_KIND,
      {},
      { dedupeKey: `${REPAIR_DEDUPE_KEYS_KIND}:${id}`, userId: id },
    );
  }
  await db
    .insert(settings)
    .values({
      key: REPAIR_DEDUPE_KEYS_MARKER_KEY,
      userId: null,
      value: Date.now(),
      updatedAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
  return all.length;
}

const PayloadSchema = z.object({}).strict();

export const repairDedupeKeysJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: REPAIR_DEDUPE_KEYS_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 2,
  async run(db, _payload, ctx) {
    if (ctx.userId === null) throw new Error(`${REPAIR_DEDUPE_KEYS_KIND} needs a user`);
    const outcome = await repairDedupeKeys(db, { userId: ctx.userId, isAdmin: false });
    await ctx.setResult(outcome);
  },
};
