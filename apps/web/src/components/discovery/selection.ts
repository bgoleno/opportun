// The selection bar's totals and the confirm before a large follow on the Recommended companies
// list (https://github.com/bgoleno/opportun/issues/302, N5b-d of #222; tl's note, and his answers
// there). Pure functions over the estimates each row already has (estimate.ts), so a selection costs
// no request. The estimates are summed unrounded and rounded only when shown.
import type { CompanyView } from './companiesApi';
import type { Estimate } from './estimate';

/** A follow whose first run would cost more than this many dollars asks first. */
export const CONFIRM_FIRST_RUN_USD = 1;
/** A follow that would bring more than this many new postings a day asks first. */
export const CONFIRM_NEW_PER_DAY = 20;

export interface SelectionRow {
  company: CompanyView;
  /** The row's estimate line's figures, or null where it has none. */
  estimate: Estimate | null;
}

export interface SelectionTotals {
  /** Rows selected. */
  rows: number;
  /** The ones with an estimate: only they add to the figures below. */
  counted: number;
  /** The ones with none (not checked, no board found, a probe still running), to be named. */
  withoutEstimate: CompanyView[];
  newPerDay: number;
  rankedPerDay: number;
  /** Null when the cost of a call is not known, or no row has an estimate. */
  costPerDayUsd: number | null;
  firstRunCalls: number;
  firstRunUsd: number | null;
}

export function selectionTotals(rows: readonly SelectionRow[]): SelectionTotals {
  const totals: SelectionTotals = {
    rows: rows.length,
    counted: 0,
    withoutEstimate: [],
    newPerDay: 0,
    rankedPerDay: 0,
    costPerDayUsd: null,
    firstRunCalls: 0,
    firstRunUsd: null,
  };
  for (const { company, estimate } of rows) {
    if (estimate === null) {
      totals.withoutEstimate.push(company);
      continue;
    }
    totals.counted += 1;
    totals.newPerDay += estimate.newPerDay;
    totals.rankedPerDay += estimate.rankedPerDay;
    // The cost of a call is one figure for every row: known for all of them or for none.
    if (estimate.costPerDayUsd !== null) {
      totals.costPerDayUsd = (totals.costPerDayUsd ?? 0) + estimate.costPerDayUsd;
    }
    if (estimate.firstRun !== null) {
      totals.firstRunCalls += estimate.firstRun.count;
      if (estimate.firstRun.usd !== null) {
        totals.firstRunUsd = (totals.firstRunUsd ?? 0) + estimate.firstRun.usd;
      }
    }
  }
  return totals;
}

/** Today's discovery budget, as GET /ai/discovery-budget gives it. */
export interface BudgetToday {
  dailyUsd: number;
  spentTodayUsd: number;
}

export type ConfirmReason = 'first_run_cost' | 'new_per_day' | 'budget';

/**
 * Why a follow of these rows asks first, in a fixed order; empty when it acts at once. The sum of
 * the rows is what is asked about, not each row. The dollar tests need a known cost, and the budget
 * test a budget that was read: without them only the number of new postings can ask. A row with no
 * estimate adds nothing, so it never asks.
 */
export function confirmReasons(
  totals: SelectionTotals,
  budget: BudgetToday | null,
): ConfirmReason[] {
  const reasons: ConfirmReason[] = [];
  if (totals.firstRunUsd !== null && totals.firstRunUsd > CONFIRM_FIRST_RUN_USD) {
    reasons.push('first_run_cost');
  }
  if (totals.newPerDay > CONFIRM_NEW_PER_DAY) reasons.push('new_per_day');
  if (
    budget !== null &&
    totals.firstRunUsd !== null &&
    budget.spentTodayUsd + totals.firstRunUsd > budget.dailyUsd
  ) {
    reasons.push('budget');
  }
  return reasons;
}
