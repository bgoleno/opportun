// Discovery's ranking cost and each board's posting volume (#209): GET /discovery/cost-figures,
// read-only figures from the app's own records (see apps/server/src/repos/discoveryFigures.ts).
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface TokenSpread {
  median: number;
  p90: number;
}

export interface RankWindow {
  days: number;
  calls: number;
  errors: number;
  inputTokens: TokenSpread | null;
  outputTokens: TokenSpread | null;
  avgCostUsd: number | null;
  totalCostUsd: number;
}

export interface SourceVolumeFigures {
  sourceId: string;
  kind: string;
  openJobs: number | null;
  newPerDay: number | null;
  days: number;
  rankCallsPerDay: number | null;
  costPerDayUsd: number | null;
  /** Postings waiting below the first-run cut for the user to send (#215). */
  belowCut: number;
  /** What sending them would cost at the 30-day average cost per call; null with no average. */
  belowCutCostUsd: number | null;
}

export interface CostFigures {
  rank: RankWindow[];
  sources: SourceVolumeFigures[];
}

export const costFiguresKey = ['discovery', 'cost-figures'] as const;

export function useCostFigures() {
  return useQuery({
    queryKey: costFiguresKey,
    queryFn: () => api<CostFigures>('/discovery/cost-figures'),
  });
}

/** A cost in USD to four places at most, as the AI usage table shows one. */
export const usd = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export const whole = new Intl.NumberFormat();

/** A rate a day, to one decimal. */
export const perDay = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
