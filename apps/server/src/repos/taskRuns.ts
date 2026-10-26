// The AI run ledger (FR-A5): one task_runs row per router call, success or failure. It
// stores token counts and cost only, never prompt text or keys.
import { newId } from '@opportun/core';
import type { TaskKey, TaskRunRecord } from '@opportun/ai';
import { and, eq, gte, sql } from 'drizzle-orm';
import { countAll, maxBoolAsInt, utcDay } from '../db/dialect';
import { taskRuns } from '../db/schema';
import type { Db, UserCtx } from './base';

const DAY_MS = 86_400_000;

export function startOfUtcDay(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

/** Appends one run and returns its id (tailoring sessions keep references to their runs). */
export async function recordTaskRun(db: Db, ctx: UserCtx, run: TaskRunRecord): Promise<string> {
  const id = newId();
  await db
    .insert(taskRuns)
    .values({
      id,
      userId: ctx.userId,
      taskKey: run.taskKey,
      provider: run.provider,
      model: run.model,
      promptId: run.promptId ?? null,
      inputTokens: Math.max(0, Math.round(run.inputTokens)),
      outputTokens: Math.max(0, Math.round(run.outputTokens)),
      estCost: Number.isFinite(run.estCostUsd) ? Math.max(0, run.estCostUsd) : 0,
      fallbackPricing: run.fallbackPricing === true,
      durationMs: Math.max(0, Math.round(run.durationMs)),
      status: run.status,
      error: run.error ?? null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

/** Today's (UTC) recorded est cost for one task, the input to the per-task daily budget. */
export async function spentTodayUsd(
  db: Db,
  ctx: UserCtx,
  task: TaskKey,
  now = Date.now(),
): Promise<number> {
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${taskRuns.estCost}), 0)` })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.userId, ctx.userId),
        eq(taskRuns.taskKey, task),
        gte(taskRuns.createdAt, startOfUtcDay(now)),
      ),
    )
    .get();
  return row?.total ?? 0;
}

export interface UsageRow {
  taskKey: string;
  runs: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  /** Some runs in this bucket used the fallback price (model not in the price table). */
  estimated: boolean;
}

export interface UsageRollup {
  days: number;
  /** Per task per UTC day (YYYY-MM-DD), newest day first. */
  items: (UsageRow & { day: string })[];
  /** Per task over the whole window. */
  totals: UsageRow[];
}

/** The caller's usage over the last `days` UTC days, today included. */
export async function usageRollup(
  db: Db,
  ctx: UserCtx,
  days: number,
  now = Date.now(),
): Promise<UsageRollup> {
  const since = startOfUtcDay(now) - (days - 1) * DAY_MS;
  const day = utcDay(taskRuns.createdAt);
  const metrics = {
    taskKey: taskRuns.taskKey,
    runs: countAll(),
    errors: sql<number>`sum(case when ${taskRuns.status} = 'error' then 1 else 0 end)`,
    inputTokens: sql<number>`coalesce(sum(${taskRuns.inputTokens}), 0)`,
    outputTokens: sql<number>`coalesce(sum(${taskRuns.outputTokens}), 0)`,
    estCostUsd: sql<number>`coalesce(sum(${taskRuns.estCost}), 0)`,
    estimated: maxBoolAsInt(taskRuns.fallbackPricing),
  };
  const where = and(eq(taskRuns.userId, ctx.userId), gte(taskRuns.createdAt, since));
  const items = await db
    .select({ day, ...metrics })
    .from(taskRuns)
    .where(where)
    .groupBy(day, taskRuns.taskKey)
    .orderBy(sql`1 desc`, taskRuns.taskKey)
    .all();
  const totals = await db
    .select(metrics)
    .from(taskRuns)
    .where(where)
    .groupBy(taskRuns.taskKey)
    .orderBy(taskRuns.taskKey)
    .all();
  // SQLite returns max() of a boolean column as 0/1.
  return {
    days,
    items: items.map((r) => ({ ...r, estimated: Boolean(r.estimated) })),
    totals: totals.map((r) => ({ ...r, estimated: Boolean(r.estimated) })),
  };
}
