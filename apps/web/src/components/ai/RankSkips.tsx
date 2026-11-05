// How often the per-task daily hard stop refused a discovery ranking call
// (https://github.com/bgoleno/opportun/issues/210): counts only, read from the AI run ledger.
// These are refusals, not postings: a posting that waits for budget and is refused again counts
// again (tl on #213). The postings waiting are counted once each in DiscoveryBudget.tsx (#214).
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface RankSkips {
  today: number;
  last7Days: number;
}

export const rankSkipsKey = ['ai', 'usage', 'rank-skips'] as const;

export function useRankSkips() {
  return useQuery({
    queryKey: rankSkipsKey,
    queryFn: () => api<RankSkips>('/ai/usage/rank-skips'),
  });
}

const times = (n: number): string => (n === 1 ? '1 time' : `${n} times`);

export function RankSkipsLine() {
  const { data } = useRankSkips();
  if (data === undefined) return null;
  return (
    <p className="max-w-prose text-sm text-muted-foreground" data-testid="rank-skips">
      Ranking calls refused by the per-task daily limit: {times(data.today)} today,{' '}
      {times(data.last7Days)} in the last 7 days. One posting can be refused more than once. Days
      are UTC, as the budget&apos;s are.
    </p>
  );
}
