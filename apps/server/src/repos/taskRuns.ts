// The AI run ledger (FR-A5): one task_runs row per router call, success or failure. It
// stores token counts and cost only, never prompt text or keys.
import { newId } from '@opportun/core';
import { FEATURES, TASK_FEATURE, tasksOfFeature } from '@opportun/ai';
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

/**
 * How often a ranking call was refused because the task's daily hard stop was reached (#210): the
 * router records each refusal as a task_runs error `budget_exceeded`, so this counts those rows
 * for discovery.rank, today (the budget's own UTC day) and over the last 7 UTC days, today
 * included. It counts refusals, not postings: a posting that waits and is refused again counts
 * again (#214), and the discovery budget's own deferrals make no router call, so no row.
 */
export async function rankBudgetSkips(
  db: Db,
  ctx: UserCtx,
  now = Date.now(),
): Promise<{ today: number; last7Days: number }> {
  const today = startOfUtcDay(now);
  const since = today - 6 * DAY_MS;
  const row = await db
    .select({
      today: sql<number>`coalesce(sum(case when ${taskRuns.createdAt} >= ${today} then 1 else 0 end), 0)`,
      last7Days: countAll(),
    })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.userId, ctx.userId),
        eq(taskRuns.taskKey, 'discovery.rank'),
        eq(taskRuns.status, 'error'),
        eq(taskRuns.error, 'budget_exceeded'),
        gte(taskRuns.createdAt, since),
      ),
    )
    .get();
  return { today: Number(row?.today ?? 0), last7Days: Number(row?.last7Days ?? 0) };
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

type UsageMetrics = Omit<UsageRow, 'taskKey'>;

/** One model a task used in the window. */
export interface ModelUsage extends UsageMetrics {
  provider: string;
  model: string;
}

export interface TaskUsage extends UsageRow {
  /** One row per provider and model the task ran on, by model name; empty when it never ran. */
  models: ModelUsage[];
}

export interface FeatureUsage extends UsageMetrics {
  /** A FEATURES key, or OTHER_FEATURE for task keys no longer registered. */
  feature: string;
  label: string;
  tasks: TaskUsage[];
}

/**
 * Runs whose task key is no longer in TASK_KEYS (a task renamed or retired since): counted here so
 * the features still add up to the ledger, and listed only when there are any.
 */
export const OTHER_FEATURE = { key: 'other', label: 'Other' } as const;

export interface UsageRollup {
  days: number;
  /** Per task per UTC day (YYYY-MM-DD), newest day first. */
  items: (UsageRow & { day: string })[];
  /** Per task over the whole window. */
  totals: UsageRow[];
  /**
   * Per feature over the whole window (#341): every feature in FEATURES order, each with every
   * one of its tasks, zero where nothing ran, then OTHER_FEATURE if any run has an unknown key.
   */
  features: FeatureUsage[];
}

const zeroMetrics = (): UsageMetrics => ({
  runs: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  estCostUsd: 0,
  estimated: false,
});

function addMetrics(into: UsageMetrics, row: UsageMetrics): void {
  into.runs += row.runs;
  into.errors += row.errors;
  into.inputTokens += row.inputTokens;
  into.outputTokens += row.outputTokens;
  into.estCostUsd += row.estCostUsd;
  into.estimated ||= row.estimated;
}

/**
 * Groups per-task-and-model rows by feature. Sums what each call cost when it ran (est_cost is
 * written by the router at call time), so a price changed since does not change an old call's
 * cost (#341, criterion 2): nothing here reads a price.
 */
export function groupByFeature(
  rows: (UsageRow & { provider: string; model: string })[],
): FeatureUsage[] {
  const tasks = new Map<string, TaskUsage>();
  const taskUsage = (taskKey: string): TaskUsage => {
    let t = tasks.get(taskKey);
    if (t === undefined) {
      t = { taskKey, ...zeroMetrics(), models: [] };
      tasks.set(taskKey, t);
    }
    return t;
  };
  for (const row of rows) {
    const { taskKey, provider, model, ...metrics } = row;
    const t = taskUsage(taskKey);
    addMetrics(t, metrics);
    t.models.push({ provider, model, ...metrics });
  }
  const feature = (key: string, label: string, keys: string[]): FeatureUsage => {
    const f: FeatureUsage = { feature: key, label, ...zeroMetrics(), tasks: [] };
    for (const k of keys) {
      const t = taskUsage(k);
      t.models.sort((x, y) =>
        x.model === y.model ? x.provider.localeCompare(y.provider) : x.model.localeCompare(y.model),
      );
      addMetrics(f, t);
      f.tasks.push(t);
    }
    return f;
  };
  const out = FEATURES.map((f) => feature(f.key, f.label, tasksOfFeature(f.key)));
  const unknown = [...tasks.keys()].filter((k) => !Object.hasOwn(TASK_FEATURE, k)).sort();
  if (unknown.length > 0) out.push(feature(OTHER_FEATURE.key, OTHER_FEATURE.label, unknown));
  return out;
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
  const perModel = await db
    .select({ ...metrics, provider: taskRuns.provider, model: taskRuns.model })
    .from(taskRuns)
    .where(where)
    .groupBy(taskRuns.taskKey, taskRuns.provider, taskRuns.model)
    .all();
  // SQLite returns max() of a boolean column as 0/1.
  return {
    days,
    items: items.map((r) => ({ ...r, estimated: Boolean(r.estimated) })),
    totals: totals.map((r) => ({ ...r, estimated: Boolean(r.estimated) })),
    features: groupByFeature(perModel.map((r) => ({ ...r, estimated: Boolean(r.estimated) }))),
  };
}
