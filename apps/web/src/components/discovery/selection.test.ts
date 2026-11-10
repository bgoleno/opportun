// The selection bar's totals and the confirm before a large follow on the Recommended companies
// list (https://github.com/bgoleno/opportun/issues/302, N5b-d of #222, with tl's answers there).
// Pure functions over the estimates the rows already have. The estimates are summed unrounded and
// rounded only for display; each threshold has a test at its edge. Every name is made up.
import { describe, expect, it } from 'vitest';
import type { CompanyView } from './companiesApi';
import type { Estimate } from './estimate';
import {
  CONFIRM_FIRST_RUN_USD,
  CONFIRM_NEW_PER_DAY,
  confirmReasons,
  selectionTotals,
  type SelectionRow,
} from './selection';

const company = (id: string, name = id): CompanyView =>
  ({ id, name, status: 'none' }) as unknown as CompanyView;

const est = (over: Partial<Estimate> = {}): Estimate => ({
  newPerDay: 4,
  rankedPerDay: 0.8,
  costPerDayUsd: 0.016,
  firstRun: { count: 25, usd: 0.5 },
  ...over,
});

const row = (id: string, estimate: Estimate | null): SelectionRow => ({
  company: company(id),
  estimate,
});

describe('the totals of a selection', () => {
  it('sums new a day, ranked a day, first-run calls and dollars, unrounded', () => {
    const t = selectionTotals([
      row('a', est({ newPerDay: 0.1, rankedPerDay: 0.2, costPerDayUsd: 0.3 })),
      row(
        'b',
        est({
          newPerDay: 0.2,
          rankedPerDay: 0.4,
          costPerDayUsd: 0.6,
          firstRun: { count: 10, usd: 0.2 },
        }),
      ),
    ]);
    // 0.1 + 0.2 is not 0.3 in a float, and is not rounded here: only the display rounds.
    expect(t.newPerDay).toBe(0.1 + 0.2);
    expect(t.rankedPerDay).toBe(0.2 + 0.4);
    expect(t.costPerDayUsd).toBe(0.3 + 0.6);
    expect(t.firstRunCalls).toBe(35);
    expect(t.firstRunUsd).toBe(0.5 + 0.2);
    expect(t.rows).toBe(2);
    expect(t.counted).toBe(2);
  });

  it('a row with no estimate is counted as selected and named, and adds nothing', () => {
    const t = selectionTotals([row('a', est()), row('b', null), row('c', null)]);
    expect(t.rows).toBe(3);
    expect(t.counted).toBe(1);
    expect(t.withoutEstimate.map((c) => c.id)).toEqual(['b', 'c']);
    expect(t.newPerDay).toBe(4);
    expect(t.firstRunCalls).toBe(25);
  });

  it('with no cost known, the counts are there and the dollars are not', () => {
    const t = selectionTotals([
      row('a', est({ costPerDayUsd: null, firstRun: { count: 25, usd: null } })),
    ]);
    expect(t).toMatchObject({ firstRunCalls: 25, costPerDayUsd: null, firstRunUsd: null });
  });

  it('an empty selection and one of rows with no estimate have no figures', () => {
    expect(selectionTotals([])).toMatchObject({
      rows: 0,
      counted: 0,
      newPerDay: 0,
      firstRunCalls: 0,
      firstRunUsd: null,
    });
    expect(selectionTotals([row('a', null)])).toMatchObject({
      rows: 1,
      counted: 0,
      firstRunUsd: null,
    });
  });
});

describe('when a follow asks first', () => {
  const total = (over: Partial<Estimate>) => selectionTotals([row('a', est(over))]);
  const BUDGET = { dailyUsd: 1, spentTodayUsd: 0 };

  it('the thresholds are $1.00 for a first run and 20 new postings a day', () => {
    expect(CONFIRM_FIRST_RUN_USD).toBe(1);
    expect(CONFIRM_NEW_PER_DAY).toBe(20);
  });

  it('a first run of exactly $1.00 does not ask, one over does', () => {
    const at = total({ firstRun: { count: 25, usd: 1 } });
    const over = total({ firstRun: { count: 25, usd: 1.01 } });
    expect(confirmReasons(at, null)).toEqual([]);
    expect(confirmReasons(over, null)).toEqual(['first_run_cost']);
  });

  it('exactly 20 new a day does not ask, just over does', () => {
    expect(confirmReasons(total({ newPerDay: 20 }), null)).toEqual([]);
    expect(confirmReasons(total({ newPerDay: 20.1 }), null)).toEqual(['new_per_day']);
  });

  it('a first day that reaches the budget exactly does not ask, one cent over does', () => {
    const first = total({ firstRun: { count: 25, usd: 0.5 } });
    // 0.5 spent and 0.5 to come is exactly the 1.00 budget: not over it.
    expect(confirmReasons(first, { dailyUsd: 1, spentTodayUsd: 0.5 })).toEqual([]);
    expect(confirmReasons(first, { dailyUsd: 1, spentTodayUsd: 0.51 })).toEqual(['budget']);
    // The budget of a user who set another one.
    expect(confirmReasons(first, { dailyUsd: 0.75, spentTodayUsd: 0.25 })).toEqual([]);
    expect(confirmReasons(first, { dailyUsd: 0.74, spentTodayUsd: 0.25 })).toEqual(['budget']);
  });

  it('every reason that applies is given, in a fixed order', () => {
    const t = total({ newPerDay: 30, firstRun: { count: 25, usd: 1.5 } });
    expect(confirmReasons(t, { dailyUsd: 1, spentTodayUsd: 0.2 })).toEqual([
      'first_run_cost',
      'new_per_day',
      'budget',
    ]);
  });

  it('the dollar tests cannot run with no cost known: only the count of new postings can ask', () => {
    const t = total({ newPerDay: 30, costPerDayUsd: null, firstRun: { count: 25, usd: null } });
    expect(confirmReasons(t, BUDGET)).toEqual(['new_per_day']);
    expect(
      confirmReasons(total({ costPerDayUsd: null, firstRun: { count: 25, usd: null } }), BUDGET),
    ).toEqual([]);
  });

  it('no budget read means no budget test, and rows with no estimate never ask', () => {
    expect(confirmReasons(total({ firstRun: { count: 25, usd: 0.5 } }), null)).toEqual([]);
    expect(confirmReasons(selectionTotals([row('a', null)]), BUDGET)).toEqual([]);
  });

  it('the dollar tests compare in whole cents: a sum that shows as $1.00 does not ask (tl on #302)', () => {
    const usdRow = (id: string, usd: number) => row(id, est({ firstRun: { count: 25, usd } }));
    // $0.33 + $0.56 + $0.11 is exactly $1.00, and is 1.0000000000000002 in a float: over one.
    const sum = selectionTotals([usdRow('a', 0.33), usdRow('b', 0.56), usdRow('c', 0.11)]);
    expect(sum.firstRunUsd).toBeGreaterThan(1);
    // The bar and the dialog say $1.00, so a first run of $1.00 does not ask.
    expect(confirmReasons(sum, null)).toEqual([]);
    // Nor does a first day that reaches the $1.00 budget exactly.
    expect(confirmReasons(sum, { dailyUsd: 1, spentTodayUsd: 0 })).toEqual([]);
    // A cent over still asks, and so does a sum that shows as a cent over.
    expect(confirmReasons(selectionTotals([usdRow('a', 1.006)]), null)).toEqual(['first_run_cost']);
    expect(confirmReasons(selectionTotals([usdRow('a', 1.004)]), null)).toEqual([]);
    expect(confirmReasons(sum, { dailyUsd: 1, spentTodayUsd: 0.01 })).toEqual(['budget']);
  });

  it('a selection is asked about on its sum, not row by row', () => {
    // Each first run is $0.60: under $1.00 alone, $1.20 together.
    const each = { firstRun: { count: 25, usd: 0.6 } };
    expect(confirmReasons(selectionTotals([row('a', est(each))]), null)).toEqual([]);
    expect(
      confirmReasons(selectionTotals([row('a', est(each)), row('b', est(each))]), null),
    ).toEqual(['first_run_cost']);
  });
});
