// Metric dashboard data (FR-T6, https://github.com/bgoleno/opportun/issues/346): the metrics the
// caller may see, from the catalog, and one metric's series from the app's own store. The server
// scopes both: a user's own AI metrics, and the instance's for an admin.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type Stat = 'count' | 'errors' | 'mean' | 'max' | 'sum';

export interface MetricInfo {
  name: string;
  instrument: 'histogram' | 'counter';
  unit: string;
  description: string;
  scope: 'user' | 'instance';
  attributes: string[];
  stats: Stat[];
}

export interface MetricCatalog {
  /** Whether collection is on now. Points collected earlier are shown either way. */
  collect: boolean;
  /** Whether collection can be turned on here at all: false on the demo (#364). */
  collectAvailable: boolean;
  metrics: MetricInfo[];
}

export interface SeriesPoint {
  t: number;
  v: number | null;
}

export interface MetricSeries {
  metric: string;
  stat: Stat;
  from: number;
  to: number;
  step: number;
  resolution: number;
  series: { label: string | null; points: SeriesPoint[] }[];
  /** The values each attribute takes in the range, for the filter and breakdown choices. */
  values: Record<string, string[]>;
  truncated: boolean;
}

export interface SeriesQuery {
  metric: string;
  stat: Stat;
  from: number;
  to: number;
  by?: string;
  filters: { key: string; value: string }[];
}

export function seriesSearch(q: SeriesQuery): string {
  const p = new URLSearchParams({
    metric: q.metric,
    stat: q.stat,
    from: String(q.from),
    to: String(q.to),
  });
  if (q.by) p.set('by', q.by);
  for (const f of q.filters) p.append('filter', `${f.key}=${f.value}`);
  return `?${p.toString()}`;
}

export const metricsKey = ['obs', 'metrics'] as const;

export function useMetricCatalog() {
  return useQuery({
    queryKey: [...metricsKey, 'catalog'],
    queryFn: () => api<MetricCatalog>('/obs/metrics'),
  });
}

export function useSeries(q: SeriesQuery) {
  return useQuery({
    queryKey: [...metricsKey, 'series', q],
    queryFn: () => api<MetricSeries>(`/obs/metrics/series${seriesSearch(q)}`),
    // Keep the old chart on screen while a new range loads, instead of flashing empty.
    placeholderData: keepPreviousData,
  });
}
