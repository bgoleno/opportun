// The metric chart's model (FR-T6): plain functions the chart component draws with. The chart is
// plain SVG and markup, with no chart library (design.md 14.12 allows one at most; none was
// needed, so the Content-Security-Policy and the dependencies stay as they are).
import type { Stat } from './api';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** The narrowest zoom: a few 1-minute points. */
export const MIN_SPAN_MS = 10 * MINUTE;
/** The widest range: 1-hour points are kept 30 days (design.md 14.7). */
export const MAX_SPAN_MS = 30 * DAY;

/** The top of the y axis: the maximum rounded up to 1, 2 or 5 times a power of ten. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const scaled = max / magnitude;
  // A small tolerance, so 10 stays 10 rather than rounding up through float error.
  const nice = [1, 2, 5, 10].find((n) => scaled <= n * (1 + 1e-9)) ?? 10;
  return Number((nice * magnitude).toPrecision(12));
}

/** The y axis has this many steps (five labels, the bottom one zero). */
export const Y_TICKS = 4;

/**
 * The top of the y axis. For a statistic in whole numbers (calls, errors, a count), it is a
 * multiple of Y_TICKS, so every tick is a whole number and no two labels read the same: at a
 * maximum of 1 the axis reads 4, 3, 2, 1, 0 rather than 1, 1, 1, 0, 0 (tl on #363).
 */
export function axisMax(max: number, wholeNumbers: boolean): number {
  const top = niceMax(max);
  return wholeNumbers ? Y_TICKS * Math.ceil(top / Y_TICKS) : top;
}

/**
 * An SVG path through the values, spread evenly across `width`, scaled so `yMax` is the top.
 * A missing value breaks the line: a step with no data is a gap, not a zero.
 */
export function linePath(
  values: readonly (number | null)[],
  yMax: number,
  width: number,
  height: number,
): string {
  const n = values.length;
  let d = '';
  let drawing = false;
  values.forEach((v, i) => {
    if (v === null) {
      drawing = false;
      return;
    }
    const x = n <= 1 ? 0 : (i / (n - 1)) * width;
    const y = height - (v / yMax) * height;
    d += `${drawing ? 'L' : 'M'}${round(x)},${round(y)}`;
    drawing = true;
  });
  return d;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The step nearest a position across the chart (0 at the left edge, 1 at the right). */
export function indexAt(fraction: number, count: number): number {
  if (count <= 1) return 0;
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.round(clamped * (count - 1));
}

export interface TimeRange {
  from: number;
  to: number;
}

/**
 * Zooms in (half the range) or out (twice), around `center` when given (the cursor's time),
 * else the range's middle. The result never reaches past now, never spans more than the 30
 * days points are kept, and never less than MIN_SPAN_MS.
 */
export function zoom(
  range: TimeRange,
  direction: 'in' | 'out',
  now: number,
  center?: number,
): TimeRange {
  const span = range.to - range.from;
  // No cap here: the clamps below keep the range inside the last MAX_SPAN_MS, which caps it.
  const next = Math.max(MIN_SPAN_MS, direction === 'in' ? span / 2 : span * 2);
  const mid = center ?? range.from + span / 2;
  let from = Math.round(mid - next / 2);
  let to = from + next;
  if (to > now) {
    to = now;
    from = now - next;
  }
  if (from < now - MAX_SPAN_MS) {
    from = now - MAX_SPAN_MS;
    to = Math.min(now, from + next);
  }
  return { from, to };
}

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** A value as the reader takes it in: calls and errors as counts, durations in ms or s. */
export function formatStatValue(v: number | null, stat: Stat, unit: string): string {
  if (v === null) return 'no data';
  if (stat === 'count' || stat === 'errors') return integer.format(v);
  if (unit === 's') return v < 1 ? `${Number((v * 1000).toPrecision(3))} ms` : `${v.toFixed(2)} s`;
  if (unit === '{USD}') return usd.format(v);
  return integer.format(v);
}

/** What a statistic measures, for the axis and the table's heading. */
export function statLabel(stat: Stat, unit: string): string {
  switch (stat) {
    case 'count':
      return 'Calls';
    case 'errors':
      return 'Errors';
    case 'mean':
      return 'Mean duration';
    case 'max':
      return 'Longest';
    case 'sum':
      return unit === '{USD}' ? 'Total (USD)' : 'Total';
  }
}
