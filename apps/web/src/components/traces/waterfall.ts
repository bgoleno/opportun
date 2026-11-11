// The waterfall's layout (FR-T7): one row per span, depth first under its parent, children in
// start order, each placed on the trace's own time axis as a share of the whole. Plain data for
// plain markup: the design adds no chart library for this view (14.12).
import type { SpanView } from './api';

export interface WaterfallRow {
  span: SpanView;
  /** 0 for a root: a span with no parent, or whose parent the store did not keep. */
  depth: number;
  /** Milliseconds from the trace's start. */
  offsetMs: number;
  /** Where the bar starts and how wide it is, in percent of the trace's duration. */
  offsetPct: number;
  widthPct: number;
}

/** A bar never narrower than this, so a 1 ms span inside a minute still shows. */
const MIN_WIDTH_PCT = 0.5;

const byStart = (a: SpanView, b: SpanView) =>
  a.startedAt - b.startedAt || (a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0);

export function buildWaterfall(
  spans: readonly SpanView[],
  traceStart: number,
  traceDurationMs: number,
): WaterfallRow[] {
  const ids = new Set(spans.map((s) => s.spanId));
  const children = new Map<string, SpanView[]>();
  const roots: SpanView[] = [];
  for (const s of spans) {
    // The route or job that started the trace is its origin, not a span (14.7): the first Gen AI
    // span's parent is not in the store, and that span is a root here.
    if (s.parentSpanId === null || !ids.has(s.parentSpanId)) roots.push(s);
    else children.set(s.parentSpanId, [...(children.get(s.parentSpanId) ?? []), s]);
  }

  // The axis covers the trace and any span that runs past its recorded end.
  const end = Math.max(
    traceStart + traceDurationMs,
    ...spans.map((s) => s.startedAt + s.durationMs),
  );
  const total = end - traceStart;
  const place = (s: SpanView, depth: number): WaterfallRow => {
    const offsetMs = Math.max(0, s.startedAt - traceStart);
    if (total <= 0) return { span: s, depth, offsetMs, offsetPct: 0, widthPct: 100 };
    const offsetPct = Math.min(100 - MIN_WIDTH_PCT, (offsetMs / total) * 100);
    const widthPct = Math.min(
      100 - offsetPct,
      Math.max(MIN_WIDTH_PCT, (s.durationMs / total) * 100),
    );
    return { span: s, depth, offsetMs, offsetPct, widthPct };
  };

  const rows: WaterfallRow[] = [];
  const seen = new Set<string>();
  const walk = (s: SpanView, depth: number) => {
    if (seen.has(s.spanId)) return;
    seen.add(s.spanId);
    rows.push(place(s, depth));
    for (const c of [...(children.get(s.spanId) ?? [])].sort(byStart)) walk(c, depth + 1);
  };
  for (const r of [...roots].sort(byStart)) walk(r, 0);
  // Spans whose parents form a loop have no root above them: shown at the top level, once.
  for (const s of [...spans].sort(byStart)) walk(s, 0);
  return rows;
}
