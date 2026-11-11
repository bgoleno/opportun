// AI trace data (FR-T7, https://github.com/bgoleno/opportun/issues/347): the caller's own traces
// from the local store, the values they can be filtered by, and one trace with its spans. The
// server scopes all of it to the signed-in user; nothing here carries prompt or response text.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';

export type TraceStatus = 'ok' | 'error';

export interface TraceView {
  traceId: string;
  startedAt: number;
  durationMs: number;
  /** The route template or `job {kind}` that started the trace (14.7). */
  origin: string;
  workflow: string | null;
  feature: string | null;
  /** The tailoring session a chat turn belongs to; null outside a chat. */
  conversationId: string | null;
  tasks: string[];
  models: string[];
  providers: string[];
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  spanCount: number;
  errorCount: number;
  status: TraceStatus;
  truncated: boolean;
}

export type AttrValue = string | number | boolean | string[];

export interface SpanView {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: 'server' | 'client' | 'internal' | 'producer' | 'consumer';
  startedAt: number;
  durationMs: number;
  status: TraceStatus;
  errorType: string | null;
  task: string | null;
  model: string | null;
  provider: string | null;
  attributes: Record<string, AttrValue>;
  /** The prompt the span used, by task key and version. */
  prompt: { name: string; version: number | null } | null;
}

export interface TraceList {
  /** Whether collection is on now. Traces collected earlier are listed either way. */
  collect: boolean;
  items: TraceView[];
  next: string | null;
}

export interface TraceDetail {
  trace: TraceView;
  spans: SpanView[];
  conversation: { id: string; resumeId: string } | null;
}

export interface TraceFilterValues {
  tasks: string[];
  models: string[];
  providers: string[];
}

/** The time ranges offered, in hours. Traces are kept 30 days (14.7). */
export const RANGES = [
  { value: '1h', label: 'Last hour', hours: 1 },
  { value: '24h', label: 'Last 24 hours', hours: 24 },
  { value: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { value: '30d', label: 'Last 30 days', hours: 24 * 30 },
] as const;
export type RangeValue = (typeof RANGES)[number]['value'];

export interface TraceFilters {
  task?: string;
  model?: string;
  provider?: string;
  status?: TraceStatus;
  range?: RangeValue;
  conversation?: string;
}

/** The list's query string. The range becomes a start time, read when the query runs. */
export function traceQuery(f: TraceFilters, now: number, cursor?: string): string {
  const p = new URLSearchParams();
  if (f.task) p.set('task', f.task);
  if (f.model) p.set('model', f.model);
  if (f.provider) p.set('provider', f.provider);
  if (f.status) p.set('status', f.status);
  const range = RANGES.find((r) => r.value === f.range);
  if (range) p.set('from', String(now - range.hours * 3_600_000));
  if (f.conversation) p.set('conversation', f.conversation);
  if (cursor) p.set('cursor', cursor);
  const s = p.toString();
  return s === '' ? '' : `?${s}`;
}

export const tracesKey = ['obs', 'traces'] as const;

/**
 * The caller's traces, a page at a time. A time range is read against one "now", taken when the
 * filters are set: every page of one list shares that window. Taking "now" again for Load more
 * would move the window forward and skip the traces between its two starts (tl on
 * https://github.com/bgoleno/opportun/pull/361). Changing the filters reads a fresh
 * window.
 */
export function useTraces(filters: TraceFilters) {
  const key = JSON.stringify(filters);
  const [readAt, setReadAt] = useState(() => ({ key, now: Date.now() }));
  let now = readAt.now;
  if (readAt.key !== key) {
    // New filters: a new window, stored during render (React's pattern for state derived from
    // props), so this render's query already uses it.
    now = Date.now();
    setReadAt({ key, now });
  }
  return useInfiniteQuery({
    queryKey: [...tracesKey, 'list', filters, now],
    queryFn: ({ pageParam }) => api<TraceList>(`/obs/traces${traceQuery(filters, now, pageParam)}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
}

export function useTraceFilterValues() {
  return useQuery({
    queryKey: [...tracesKey, 'filters'],
    queryFn: () => api<TraceFilterValues>('/obs/traces/filters'),
  });
}

export function useTrace(traceId: string) {
  return useQuery({
    queryKey: [...tracesKey, 'one', traceId],
    queryFn: () => api<TraceDetail>(`/obs/traces/${encodeURIComponent(traceId)}`),
    // A 404 is an answer, not a failure to get one: asking again cannot change it, and the
    // retry only kept "Trace not found" off the screen for a second
    // (https://github.com/bgoleno/opportun/issues/365). Anything else is retried once, as the
    // app's client does everywhere.
    retry: (failures, error) =>
      !(error instanceof ApiError && error.status === 404) && failures < 1,
  });
}
