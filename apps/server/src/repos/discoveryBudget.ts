// The discovery budget (https://github.com/bgoleno/opportun/issues/214, the owner's decision 2 on
// #190): dollars a day the user sets, default $1.00, on the same UTC day as the per-task budget.
// It covers DISCOVERY_BUDGET_TASKS; the tagging and suggest calls join the list as they land. Over
// it a posting waits for a later budget day (jobs/discoveryRankWaiting.ts). The $5 per task per day
// in @opportun/ai's router stays as the hard stop behind it.
import type { TaskKey } from '@opportun/ai';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Exec } from '../db/client';
import { taskRuns } from '../db/schema';
import { readSetting, writeSetting } from '../lib/ai';
import type { Db, UserCtx } from './base';
import { startOfUtcDay } from './taskRuns';

export const DEFAULT_DISCOVERY_DAILY_USD = 1;
export const MIN_DISCOVERY_DAILY_USD = 0.01;
export const MAX_DISCOVERY_DAILY_USD = 10_000;

export const DISCOVERY_BUDGET_TASKS = [
  'discovery.rank',
  'discovery.industry_profile',
] as const satisfies readonly TaskKey[];

const settingKey = (userId: string): string => `discovery_budget:${userId}`;
const keyChangedKey = (userId: string): string => `discovery_key_changed:${userId}`;

/**
 * Serializes noting a key change and clearing the marks with checking for one and marking, so a 401
 * landing during a way back is either cleared by it or sees it, and never marks after it.
 */
export const keyChangeScope = (ctx: UserCtx): string => `discovery.key:${ctx.userId}`;

/** When the caller's key last changed, for telling a stale 401 (#261); 0 if it never has. */
export async function readKeyChangedAt(exec: Exec, ctx: UserCtx): Promise<number> {
  const parsed = z.number().safeParse(await readSetting(exec, ctx, keyChangedKey(ctx.userId)));
  return parsed.success ? parsed.data : 0;
}

export async function writeKeyChangedAt(exec: Exec, ctx: UserCtx, at: number): Promise<void> {
  await writeSetting(exec, ctx, keyChangedKey(ctx.userId), at);
}

const StoredBudget = z.object({
  dailyUsd: z.number().min(MIN_DISCOVERY_DAILY_USD).max(MAX_DISCOVERY_DAILY_USD),
});

/** The caller's budget in dollars a day: the stored one, else the default. */
export async function readDiscoveryBudget(db: Db, ctx: UserCtx): Promise<number> {
  const parsed = StoredBudget.safeParse(await readSetting(db, ctx, settingKey(ctx.userId)));
  return parsed.success ? parsed.data.dailyUsd : DEFAULT_DISCOVERY_DAILY_USD;
}

export async function writeDiscoveryBudget(
  db: Exec,
  ctx: UserCtx,
  dailyUsd: number,
): Promise<void> {
  await writeSetting(db, ctx, settingKey(ctx.userId), { dailyUsd });
}

/** Today's (UTC) recorded est cost over the tasks the budget covers. */
export async function discoverySpentTodayUsd(
  db: Db,
  ctx: UserCtx,
  now: number = Date.now(),
): Promise<number> {
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${taskRuns.estCost}), 0)` })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.userId, ctx.userId),
        inArray(taskRuns.taskKey, [...DISCOVERY_BUDGET_TASKS]),
        gte(taskRuns.createdAt, startOfUtcDay(now)),
      ),
    )
    .get();
  return Number(row?.total ?? 0);
}

/** Whether a call covered by the budget may start: today's spend is still under it. */
export async function discoveryBudgetHasRoom(
  db: Db,
  ctx: UserCtx,
  now: number = Date.now(),
): Promise<boolean> {
  return (await discoverySpentTodayUsd(db, ctx, now)) < (await readDiscoveryBudget(db, ctx));
}
