// The waterfall's layout (FR-T7, https://github.com/bgoleno/opportun/issues/347): every span on
// one time axis, nested by parent, children in start order.
import { describe, expect, it } from 'vitest';
import type { SpanView } from './api';
import { buildWaterfall } from './waterfall';

const T0 = 1_000_000;

function span(
  spanId: string,
  parentSpanId: string | null,
  startedAt: number,
  durationMs: number,
): SpanView {
  return {
    spanId,
    parentSpanId,
    name: spanId,
    kind: 'internal',
    startedAt,
    durationMs,
    status: 'ok',
    errorType: null,
    task: null,
    model: null,
    provider: null,
    attributes: {},
    prompt: null,
  };
}

const shape = (rows: ReturnType<typeof buildWaterfall>) =>
  rows.map((r) => [r.span.spanId, r.depth]);

describe('buildWaterfall', () => {
  it('nests each span under its parent, depth first, children in start order', () => {
    const rows = buildWaterfall(
      [
        span('c2', 'root', T0 + 600, 100),
        span('g1', 'c1', T0 + 20, 50),
        span('root', null, T0, 1000),
        span('c1', 'root', T0 + 10, 500),
      ],
      T0,
      1000,
    );
    expect(shape(rows)).toEqual([
      ['root', 0],
      ['c1', 1],
      ['g1', 2],
      ['c2', 1],
    ]);
  });

  it('places each span on the trace’s time axis, as a share of the whole', () => {
    const rows = buildWaterfall(
      [span('root', null, T0, 1000), span('c', 'root', T0 + 250, 500)],
      T0,
      1000,
    );
    expect(rows[1]).toMatchObject({ offsetPct: 25, widthPct: 50, offsetMs: 250 });
    expect(rows[0]).toMatchObject({ offsetPct: 0, widthPct: 100, offsetMs: 0 });
  });

  it('treats a span whose parent was not kept as a root', () => {
    // The route or job that started a trace is its origin, not a span (14.7), so the first Gen
    // AI span's parent is not in the store.
    const rows = buildWaterfall([span('a', 'not-kept', T0, 10), span('b', 'a', T0 + 1, 5)], T0, 10);
    expect(shape(rows)).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('shows every span once even when parents form a loop', () => {
    const rows = buildWaterfall([span('x', 'y', T0, 10), span('y', 'x', T0 + 1, 5)], T0, 10);
    expect(rows.map((r) => r.span.spanId).sort()).toEqual(['x', 'y']);
  });

  it('keeps bars on the axis for a zero-length trace and a span that overruns it', () => {
    const zero = buildWaterfall([span('a', null, T0, 0)], T0, 0);
    expect(zero[0]).toMatchObject({ offsetPct: 0, widthPct: 100 });
    const over = buildWaterfall([span('a', null, T0, 10), span('b', 'a', T0 + 8, 10)], T0, 10);
    expect(over[1]!.offsetPct + over[1]!.widthPct).toBeLessThanOrEqual(100);
  });
});
