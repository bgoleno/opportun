// How much of the discovery budget ranking may use (https://github.com/bgoleno/opportun/issues/299).
// While a company waits for an industry tag, ranking starts a call only while today's spend is under
// 90% of the budget, so a backlog of postings cannot spend the whole day before the nightly tagging
// runs (the tagging sweep is at 05:45 local; the drain starts on each new UTC budget day). The other
// covered tasks (tagging, the industry profile, company.suggest) keep the whole budget:
// discoveryBudgetHasRoom, as before. With no company waiting, ranking may use it all.
//
// A fixed share, not an order between jobs: an order would depend on the server's time zone, the
// cron and which job is claimed first. A company the model keeps failing on stays untagged (its
// failed mark, #292), so it keeps the share held; that costs ranking at most a tenth, and is accepted.
import { and, avg, eq, gte } from 'drizzle-orm';
import { taskRuns } from '../db/schema';
import type { Db, UserCtx } from '../repos/base';
import { discoverySpentTodayUsd, readDiscoveryBudget } from '../repos/discoveryBudget';
import { startOfUtcDay } from '../repos/taskRuns';
import { hasUntaggedCandidates } from './companyTags';
import { DISCOVERY_RANK_KIND } from './discoveryKinds';

/** The share of the budget ranking may use while a company waits for a tag. */
export const RANK_BUDGET_SHARE = 0.9;

/**
 * The least the reserve holds, in ranking calls (https://github.com/bgoleno/opportun/issues/317).
 * discovery.rank has no concurrency cap of its own, so on a first run the default pool of 4 rank
 * calls can pass the check together, and a reserve smaller than those calls is spent by them: qa saw
 * no room for tagging at a $0.20 budget (on #315). Five is those 4 and the tagging call. A floor, not
 * a cap on discovery.rank, which would slow every user's first runs (tl on #315). At the $1.00
 * default and a usual call (about $0.007) the floor is under a tenth, so nothing changes there.
 */
export const RESERVE_FLOOR_CALLS = 5;

/**
 * However dear the calls, ranking keeps at least this share of the budget while a company waits.
 * With calls so dear that five cost more than the budget, the floor alone would put the line below
 * nothing, and ranking would never start; a company the model keeps failing on stays untagged for
 * good, so it would never start again (tl on https://github.com/bgoleno/opportun/pull/333).
 */
export const RANK_BUDGET_MIN_SHARE = 0.5;

/**
 * What one of today's ranking calls cost, on average, from the ledger: the day's own price, so the
 * floor follows the model in use. Null before the day's first one, when there is nothing to go by.
 */
async function rankCallUsdToday(db: Db, ctx: UserCtx, now: number): Promise<number | null> {
  const row = await db
    .select({ usd: avg(taskRuns.estCost) })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.userId, ctx.userId),
        eq(taskRuns.taskKey, DISCOVERY_RANK_KIND),
        eq(taskRuns.status, 'ok'),
        gte(taskRuns.createdAt, startOfUtcDay(now)),
      ),
    )
    .get();
  return row?.usd == null ? null : Number(row.usd);
}

/**
 * The line ranking stays under while a company waits for a tag. It is 90%, or lower when a few of
 * today's calls are worth more than a tenth: min, so the 90% line is the same number as before
 * wherever the floor is not the larger. Never under half.
 */
async function rankLineUsd(db: Db, ctx: UserCtx, budget: number, now: number): Promise<number> {
  const call = await rankCallUsdToday(db, ctx, now);
  return Math.max(
    budget * RANK_BUDGET_MIN_SHARE,
    Math.min(
      budget * RANK_BUDGET_SHARE,
      call === null ? budget : budget - RESERVE_FLOOR_CALLS * call,
    ),
  );
}

/**
 * Whether a ranking call may start: today's spend is under the budget, or under its 90% while a
 * company waits for a tag (or under the budget less RESERVE_FLOOR_CALLS of today's calls, if lower). Every path that checks for room before a rank call, or before queueing
 * the drain of postings waiting for the budget, asks this and not discoveryBudgetHasRoom.
 * Spend is on the ledger when a call ends, so calls that passed together can pass the line by the
 * calls in flight, and no further, as with the budget itself.
 */
export async function rankBudgetHasRoom(
  db: Db,
  ctx: UserCtx,
  now: number = Date.now(),
): Promise<boolean> {
  const budget = await readDiscoveryBudget(db, ctx);
  const spent = await discoverySpentTodayUsd(db, ctx, now);
  if (spent >= budget) return false;
  if (spent < (await rankLineUsd(db, ctx, budget, now))) return true;
  return !(await hasUntaggedCandidates(db, ctx.userId));
}

/**
 * How many dollars a ranking batch may hold today (#441): up to the line rankBudgetHasRoom uses,
 * the whole budget with no company waiting for a tag, never below 0. rankBudgetHasRoom is left as
 * it is, so the live path asks exactly what it asked before.
 */
export async function rankBudgetRoomUsd(
  db: Db,
  ctx: UserCtx,
  now: number = Date.now(),
): Promise<number> {
  const budget = await readDiscoveryBudget(db, ctx);
  const spent = await discoverySpentTodayUsd(db, ctx, now);
  if (spent >= budget) return 0;
  if (!(await hasUntaggedCandidates(db, ctx.userId))) return budget - spent;
  return Math.max(0, (await rankLineUsd(db, ctx, budget, now)) - spent);
}
