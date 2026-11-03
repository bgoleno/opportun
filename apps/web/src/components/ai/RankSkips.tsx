// How many postings discovery did not rank because the task's daily AI budget was spent
// (https://github.com/bgoleno/opportun/issues/210): counts only, read from the AI run ledger.
// The budget itself and whether a skipped posting is ranked later are not changed here.
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

const postings = (n: number): string => (n === 1 ? '1 posting' : `${n} postings`);

export function RankSkipsLine() {
  const { data } = useRankSkips();
  if (data === undefined) return null;
  return (
    <p className="text-sm text-muted-foreground" data-testid="rank-skips">
      Discovery ranking skipped because the daily budget was spent: {postings(data.today)} today,{' '}
      {postings(data.last7Days)} in the last 7 days. Days are UTC, as the budget&apos;s are.
    </p>
  );
}
