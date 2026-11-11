// The metric chart's model (FR-T6, https://github.com/bgoleno/opportun/issues/346): the y scale,
// the line paths with gaps, the cursor's step, zooming, and how values read.
import { describe, expect, it } from 'vitest';
import {
  axisMax,
  MAX_SPAN_MS,
  MIN_SPAN_MS,
  formatStatValue,
  indexAt,
  linePath,
  niceMax,
  zoom,
} from './chartModel';

const H = 3_600_000;

describe('niceMax', () => {
  it('rounds the top of the axis up to a readable number', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(10)).toBe(10);
    expect(niceMax(11)).toBe(20);
    expect(niceMax(0.034)).toBe(0.05);
    expect(niceMax(420)).toBe(500);
  });
});

describe('axisMax', () => {
  it('for whole numbers, gives four whole, distinct ticks, so no label repeats (tl on #363)', () => {
    const ticks = (top: number) => [4, 3, 2, 1, 0].map((i) => (top * i) / 4);
    for (const max of [0, 1, 2, 3, 5, 7, 10, 20, 420]) {
      const top = axisMax(max, true);
      expect(top, String(max)).toBeGreaterThanOrEqual(max);
      expect(ticks(top).every(Number.isInteger), String(max)).toBe(true);
      expect(new Set(ticks(top)).size, String(max)).toBe(5);
    }
    expect(axisMax(1, true)).toBe(4);
    expect(axisMax(500, true)).toBe(500);
  });

  it('for fractions, is the nice maximum', () => {
    expect(axisMax(0.034, false)).toBe(0.05);
  });
});

describe('linePath', () => {
  it('draws through each value, scaled to the box, y growing downward', () => {
    expect(linePath([0, 5, 10], 10, 100, 50)).toBe('M0,50L50,25L100,0');
  });

  it('breaks the line where a step has no value, rather than drawing it as zero', () => {
    expect(linePath([1, null, 1, 1], 1, 30, 10)).toBe('M0,0M20,0L30,0');
  });

  it('draws nothing for no values', () => {
    expect(linePath([null, null], 1, 10, 10)).toBe('');
  });
});

describe('indexAt', () => {
  it('maps a position across the chart to the nearest step', () => {
    expect(indexAt(0, 5)).toBe(0);
    expect(indexAt(0.49, 5)).toBe(2);
    expect(indexAt(1, 5)).toBe(4);
    expect(indexAt(-0.2, 5)).toBe(0);
    expect(indexAt(1.3, 5)).toBe(4);
  });
});

describe('zoom', () => {
  const now = 1000 * H;

  it('zooming in halves the range around its middle, or around the cursor', () => {
    expect(zoom({ from: now - 4 * H, to: now }, 'in', now)).toEqual({
      from: now - 3 * H,
      to: now - H,
    });
    expect(zoom({ from: now - 4 * H, to: now }, 'in', now, now - 3 * H)).toEqual({
      from: now - 4 * H,
      to: now - 2 * H,
    });
  });

  it('zooming out doubles it, never past now or the 30 days points are kept', () => {
    expect(zoom({ from: now - 4 * H, to: now - 2 * H }, 'out', now)).toEqual({
      from: now - 5 * H,
      to: now - H,
    });
    expect(zoom({ from: now - 2 * H, to: now }, 'out', now)).toEqual({
      from: now - 4 * H,
      to: now,
    });
    const wide = zoom({ from: now - 20 * 24 * H, to: now }, 'out', now);
    expect(wide).toEqual({ from: now - MAX_SPAN_MS, to: now });
  });

  it('stops zooming in at a few minutes', () => {
    const r = zoom({ from: now - MIN_SPAN_MS, to: now }, 'in', now);
    expect(r.to - r.from).toBe(MIN_SPAN_MS);
  });
});

describe('formatStatValue', () => {
  it('reads seconds as ms or s, counts as whole numbers, and a counter in its unit', () => {
    expect(formatStatValue(0.0123, 'mean', 's')).toBe('12.3 ms');
    expect(formatStatValue(2.5, 'max', 's')).toBe('2.50 s');
    expect(formatStatValue(1234, 'count', 's')).toBe('1,234');
    expect(formatStatValue(3, 'errors', 's')).toBe('3');
    expect(formatStatValue(42, 'sum', '{item}')).toBe('42');
    expect(formatStatValue(0.5, 'sum', '{USD}')).toBe('$0.50');
    expect(formatStatValue(null, 'mean', 's')).toBe('no data');
  });
});
