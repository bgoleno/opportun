// The discovery budget in Settings > AI (https://github.com/bgoleno/opportun/issues/214, the
// owner's decision 2 on #190): dollars a day, default $1.00. When it runs out, postings wait and
// are ranked on the next budget day; nothing is skipped. Under AI usage, today's spend against it
// and how many postings wait. Days are UTC, as the budget's are.
import { useState, type FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/api';
import { useDiscoveryBudget, useSetDiscoveryBudget } from './api';

const MIN_USD = 0.01;
const MAX_USD = 10_000;

const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const postings = (n: number): string => (n === 1 ? '1 posting' : `${n} postings`);

export function DiscoveryBudgetLine() {
  const { data } = useDiscoveryBudget();
  if (data === undefined) return null;
  return (
    <p className="max-w-prose text-sm text-muted-foreground" data-testid="discovery-budget-usage">
      Discovery budget today: {dollars.format(data.spentTodayUsd)} of{' '}
      {dollars.format(data.dailyUsd)} spent. {postings(data.waiting)} waiting for budget.
    </p>
  );
}

function BudgetForm(props: { dailyUsd: number; perTaskDailyUsd: number }) {
  const save = useSetDiscoveryBudget();
  const [value, setValue] = useState(props.dailyUsd.toFixed(2));
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const dailyUsd = Number(value);
    if (
      value.trim() === '' ||
      !Number.isFinite(dailyUsd) ||
      dailyUsd < MIN_USD ||
      dailyUsd > MAX_USD
    ) {
      setError(`Enter an amount from ${dollars.format(MIN_USD)} to ${dollars.format(MAX_USD)}.`);
      return;
    }
    setError(null);
    save.mutate(dailyUsd, { onError: (err) => setError(errorMessage(err)) });
  }

  return (
    <form className="grid gap-2" onSubmit={submit} noValidate>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-0 gap-1">
          <Label htmlFor="discovery-budget">Dollars a day</Label>
          <Input
            id="discovery-budget"
            inputMode="decimal"
            value={value}
            aria-invalid={error !== null}
            onChange={(e) => setValue(e.currentTarget.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={save.isPending}>
          Save
        </Button>
      </div>
      <FormError message={error} />
      <p className="max-w-prose text-xs text-muted-foreground">
        Covers ranking discovered postings. When it runs out, postings wait and are ranked on the
        next budget day, oldest first: nothing is skipped. Days are UTC. The{' '}
        {dollars.format(props.perTaskDailyUsd)} per task per day stays as a hard stop behind it.
      </p>
    </form>
  );
}

export function DiscoveryBudgetCard() {
  const { data, error } = useDiscoveryBudget();
  return (
    // min-w-0: a grid item is as wide as its content by default (as RankCostCard).
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Discovery budget</CardTitle>
        <CardDescription>How much discovery may spend on AI each day.</CardDescription>
      </CardHeader>
      <CardContent>
        {error ? <FormError message={errorMessage(error)} /> : null}
        {data === undefined ? null : (
          <BudgetForm dailyUsd={data.dailyUsd} perTaskDailyUsd={data.perTaskDailyUsd} />
        )}
      </CardContent>
    </Card>
  );
}
