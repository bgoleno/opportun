// One-shot backfill of companies.company_match_key (issue #193). The column did not exist
// before this migration, so no SQL default could fill it for rows already in the database:
// companyMatchKey's normalization (stripCorporateSuffix, NFKD, diacritic/seniority handling)
// only exists in JS, not as something a migration's DDL can compute per row. New and edited
// companies get it written synchronously by repos/companies.ts and jobs/companySuggest.ts;
// this repairs everything that existed before that code shipped, the same one-shot-per-
// deployment shape as repairDedupeKeys.ts.
//
// Until a user's repair has run, the near-miss dedupe scan (opportunityDedupe.ts's
// findMatches, which now filters on company_match_key in SQL) simply finds no match for that
// user's pre-existing companies, the same as it would for any company whose heuristic has
// never run. That is a narrower miss than the scan silently loading every active opportunity
// used to risk, and it closes itself out as soon as this job runs, which is immediately on
// the next boot after this ships.
import { companyMatchKey } from '@opportun/core';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { companies, settings, users } from '../db/schema';
import type { UserCtx } from '../repos/base';
import type { JobHandler } from './registry';
import { enqueue } from './runner';

export const REPAIR_COMPANY_MATCH_KEYS_KIND = 'companies.repair_match_keys';
/** Global marker (user_id NULL): the repair has been queued for this deployment. */
export const REPAIR_COMPANY_MATCH_KEYS_MARKER_KEY = 'repair_company_match_keys:done';

export interface CompanyMatchKeyRepairOutcome {
  companies: { scanned: number; corrected: number };
}

/** Fills in company_match_key for every row of this user's that is missing one. */
export async function repairCompanyMatchKeys(
  db: Db,
  ctx: UserCtx,
): Promise<CompanyMatchKeyRepairOutcome> {
  const rows = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.userId, ctx.userId), isNull(companies.companyMatchKey)))
    .all();
  let corrected = 0;
  for (const row of rows) {
    await db
      .update(companies)
      .set({ companyMatchKey: companyMatchKey(row.name), updatedAt: Date.now() })
      .where(and(eq(companies.userId, ctx.userId), eq(companies.id, row.id)))
      .run();
    corrected += 1;
  }
  return { companies: { scanned: rows.length, corrected } };
}

/**
 * Queues the repair for every user, once per deployment. See enqueueRepairAlertLeadsOnce
 * (repairAlertLeads.ts) for why the marker is skipped rather than written on a fresh install
 * with no users yet: the same reasoning applies here unchanged.
 */
export async function enqueueRepairCompanyMatchKeysOnce(db: Db): Promise<number> {
  const marker = await db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, REPAIR_COMPANY_MATCH_KEYS_MARKER_KEY))
    .get();
  if (marker !== undefined) return 0;
  const all = await db.select({ id: users.id }).from(users).all();
  if (all.length === 0) return 0;
  for (const { id } of all) {
    await enqueue(
      db,
      REPAIR_COMPANY_MATCH_KEYS_KIND,
      {},
      { dedupeKey: `${REPAIR_COMPANY_MATCH_KEYS_KIND}:${id}`, userId: id },
    );
  }
  await db
    .insert(settings)
    .values({
      key: REPAIR_COMPANY_MATCH_KEYS_MARKER_KEY,
      userId: null,
      value: Date.now(),
      updatedAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
  return all.length;
}

const PayloadSchema = z.object({}).strict();

export const repairCompanyMatchKeysJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: REPAIR_COMPANY_MATCH_KEYS_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 2,
  async run(db, _payload, ctx) {
    if (ctx.userId === null) throw new Error(`${REPAIR_COMPANY_MATCH_KEYS_KIND} needs a user`);
    const outcome = await repairCompanyMatchKeys(db, { userId: ctx.userId, isAdmin: false });
    await ctx.setResult(outcome);
  },
};
