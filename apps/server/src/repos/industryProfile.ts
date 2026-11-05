// The user's industry profile (https://github.com/bgoleno/opportun/issues/219, #190 N4a): NAICS 2022
// codes, each with a tier, proposed by the discovery.industry_profile task or added by the user.
// Every function is scoped to the caller. A code is checked against the table where it comes in
// (routes/industryProfile.ts, lib/industryProfile.ts), and only a confirmed row counts.
import { newId, type IndustrySource, type NaicsTier } from '@opportun/core';
import { and, asc, eq } from 'drizzle-orm';
import { runCount, withTransaction } from '../db/client';
import { industryProfile } from '../db/schema';
import { HttpError } from '../lib/errors';
import type { Db, Exec, UserCtx } from './base';

export type IndustryProfileRow = typeof industryProfile.$inferSelect;

export interface IndustrySuggestion {
  code: string;
  tier: NaicsTier;
  source: Extract<IndustrySource, 'resume' | 'target'>;
  reason: string;
}

const owned = (ctx: UserCtx, code: string) =>
  and(eq(industryProfile.userId, ctx.userId), eq(industryProfile.naicsCode, code));

export async function listIndustryProfile(exec: Exec, ctx: UserCtx): Promise<IndustryProfileRow[]> {
  return await exec
    .select()
    .from(industryProfile)
    .where(eq(industryProfile.userId, ctx.userId))
    .orderBy(asc(industryProfile.createdAt), asc(industryProfile.naicsCode))
    .all();
}

/** What counts as the user's profile: only the rows they confirmed. #221 reads this. */
export async function confirmedIndustryRows(
  exec: Exec,
  ctx: UserCtx,
): Promise<IndustryProfileRow[]> {
  return (await listIndustryProfile(exec, ctx)).filter((r) => r.confirmed);
}

/**
 * A new set of suggestions takes the place of those not yet confirmed. A confirmed row stays as the
 * user agreed to it, whatever the model says now. Returns how many new rows were stored.
 */
export async function replaceSuggestions(
  db: Db,
  ctx: UserCtx,
  suggestions: readonly IndustrySuggestion[],
): Promise<number> {
  return await withTransaction(db, async (tx) => {
    await tx
      .delete(industryProfile)
      .where(and(eq(industryProfile.userId, ctx.userId), eq(industryProfile.confirmed, false)))
      .run();
    const kept = new Set((await listIndustryProfile(tx, ctx)).map((r) => r.naicsCode));
    const fresh = suggestions.filter((s) => !kept.has(s.code));
    const now = Date.now();
    for (const s of fresh) {
      await tx
        .insert(industryProfile)
        .values({
          id: newId(),
          userId: ctx.userId,
          naicsCode: s.code,
          tier: s.tier,
          source: s.source,
          reason: s.reason,
          confirmed: false,
          createdAt: now,
          updatedAt: now,
        })
        // Two overlapping requests: the row the other one stored is as good as this one.
        .onConflictDoNothing({ target: [industryProfile.userId, industryProfile.naicsCode] })
        .run();
    }
    return fresh.length;
  });
}

/** Adds a row the user chose, confirmed. If it was a suggestion, it keeps its source and reason. */
export async function addIndustry(
  db: Db,
  ctx: UserCtx,
  code: string,
  tier: NaicsTier,
): Promise<IndustryProfileRow> {
  const now = Date.now();
  await db
    .insert(industryProfile)
    .values({
      id: newId(),
      userId: ctx.userId,
      naicsCode: code,
      tier,
      source: 'user',
      reason: null,
      confirmed: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [industryProfile.userId, industryProfile.naicsCode],
      set: { tier, confirmed: true, updatedAt: now },
    })
    .run();
  return (await db
    .select()
    .from(industryProfile)
    .where(owned(ctx, code))
    .get()) as IndustryProfileRow;
}

export async function confirmIndustry(
  db: Db,
  ctx: UserCtx,
  code: string,
): Promise<IndustryProfileRow> {
  const changes = await runCount(
    db
      .update(industryProfile)
      .set({ confirmed: true, updatedAt: Date.now() })
      .where(owned(ctx, code)),
  );
  if (changes === 0) throw new HttpError(404, 'not_found');
  return (await db
    .select()
    .from(industryProfile)
    .where(owned(ctx, code))
    .get()) as IndustryProfileRow;
}

export async function removeIndustry(db: Db, ctx: UserCtx, code: string): Promise<void> {
  const changes = await runCount(db.delete(industryProfile).where(owned(ctx, code)));
  if (changes === 0) throw new HttpError(404, 'not_found');
}
