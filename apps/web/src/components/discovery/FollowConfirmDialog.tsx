// The question before a large follow (https://github.com/bgoleno/opportun/issues/302, N5b-d of #222;
// the thresholds are in selection.ts): a follow whose first run would cost over $1.00, that brings
// more than 20 new postings a day, or whose first day would take today's spend over the budget asks
// first, with the figures itemised. Every company name is third-party text, shown as a text node.
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { dollars, newText } from './estimate';
import {
  CONFIRM_FIRST_RUN_USD,
  CONFIRM_NEW_PER_DAY,
  type BudgetToday,
  type ConfirmReason,
  type SelectionRow,
  type SelectionTotals,
} from './selection';

const noun = (n: number): string => (n === 1 ? 'company' : 'companies');

function reasonText(
  reason: ConfirmReason,
  totals: SelectionTotals,
  budget: BudgetToday | null,
): string {
  const one = totals.rows === 1;
  const first = totals.firstRunUsd ?? 0;
  switch (reason) {
    case 'first_run_cost':
      return `${one ? 'Its first run would' : 'Their first runs would'} cost about ${dollars(first)} (over ${dollars(CONFIRM_FIRST_RUN_USD)}).`;
    case 'new_per_day':
      return `${one ? 'It' : 'They'} would bring ${newText(totals.newPerDay).replace(' new a day', '')} new postings a day (more than ${CONFIRM_NEW_PER_DAY}).`;
    case 'budget':
      return `${dollars(budget?.spentTodayUsd ?? 0)} spent today plus ${one ? 'this first run' : 'these first runs'} of ${dollars(first)} would pass your ${dollars(budget?.dailyUsd ?? 0)} budget.`;
  }
}

export function FollowConfirmDialog(props: {
  open: boolean;
  rows: readonly SelectionRow[];
  totals: SelectionTotals;
  reasons: readonly ConfirmReason[];
  budget: BudgetToday | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const n = props.rows.length;
  return (
    <Dialog open={props.open} onOpenChange={(o) => (o ? undefined : props.onCancel())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{`Follow ${n} ${noun(n)}?`}</DialogTitle>
          <DialogDescription>
            Following starts reading each company's job board and ranking its postings with your AI
            provider: the first run now, then the new ones every day.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1 text-sm" aria-label="Why it asks">
          {props.reasons.map((r) => (
            <li key={r}>{reasonText(r, props.totals, props.budget)}</li>
          ))}
        </ul>
        <ul className="grid gap-1 text-sm" aria-label="Companies to follow">
          {props.rows.map(({ company, estimate }) => (
            <li key={company.id} className="[overflow-wrap:anywhere]">
              {estimate === null || estimate.firstRun === null
                ? `${company.name}: no estimate`
                : `${company.name}: first run ${estimate.firstRun.count}${estimate.firstRun.usd === null ? ' calls' : `, ${dollars(estimate.firstRun.usd)}`}; ${newText(estimate.newPerDay)}`}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button onClick={props.onConfirm}>{`Follow ${n} ${noun(n)}`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
