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
import type { Db, UserCtx } from '../repos/base';
import { discoverySpentTodayUsd, readDiscoveryBudget } from '../repos/discoveryBudget';
import { hasUntaggedCandidates } from './companyTags';

/** The share of the budget ranking may use while a company waits for a tag. */
export const RANK_BUDGET_SHARE = 0.9;

/**
 * Whether a ranking call may start: today's spend is under the budget, or under its 90% while a
 * company waits for a tag. Every path that checks for room before a rank call, or before queueing
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
  if (spent < budget * RANK_BUDGET_SHARE) return true;
  return !(await hasUntaggedCandidates(db, ctx.userId));
}
