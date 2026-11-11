// The metric chart (FR-T6): plain SVG and markup, no chart library (design.md 14.12). It works
// under the Content-Security-Policy as it is: no <style> element and no style attribute in the
// markup; colours come from theme tokens set through React's style prop, which uses the CSSOM.
//
// Operable by keyboard: the chart is one tab stop; the arrow keys move a cursor from step to
// step, Home and End jump to the first and last, + and - zoom around the cursor. What is under
// the cursor is read out below the chart, for the mouse and the keyboard alike, and the page
// puts a table of the same numbers beside it.
import { type KeyboardEvent, type PointerEvent, useState } from 'react';
import { cn } from '@/lib/utils';
import type { SeriesPoint, Stat } from './api';
import { formatStatValue, indexAt, linePath, niceMax, statLabel } from './chartModel';

/** The SVG's own coordinate box. It stretches to the chart's size; strokes do not. */
const W = 1000;
const H = 300;
const Y_TICKS = 4;

export interface ChartSeries {
  label: string | null;
  points: SeriesPoint[];
}

/** A series' colour: the eight chart tokens in turn, and the muted foreground for the rest. */
export function seriesColor(label: string | null, index: number): string {
  if (label === '_OTHER' || index >= 8) return 'var(--muted-foreground)';
  return `var(--chart-${index + 1})`;
}

/** A series' name for the legend, the table and the readout. */
export function seriesName(label: string | null, stat: Stat, unit: string): string {
  if (label === null) return statLabel(stat, unit);
  if (label === '_OTHER') return 'Other';
  return label;
}

const timeFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
export const formatTime = (t: number): string => timeFmt.format(t);

export function LineChart({
  series,
  stat,
  unit,
  onZoom,
}: {
  series: ChartSeries[];
  stat: Stat;
  unit: string;
  /** Zoom in or out, around the cursor's time when there is one. */
  onZoom: (direction: 'in' | 'out', center?: number) => void;
}) {
  const times = series[0]?.points.map((p) => p.t) ?? [];
  const n = times.length;
  const [cursor, setCursor] = useState<number | null>(null);
  const at = cursor === null ? null : Math.min(cursor, n - 1);
  const yMax = niceMax(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.v ?? 0))));
  const label = statLabel(stat, unit);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (n === 0) return;
    const here = at ?? -1;
    const moves = new Map<string, number>([
      ['ArrowRight', Math.min(n - 1, here + 1)],
      ['ArrowLeft', Math.max(0, here === -1 ? n - 1 : here - 1)],
      ['Home', 0],
      ['End', n - 1],
    ]);
    const move = moves.get(e.key);
    if (move !== undefined) {
      e.preventDefault();
      setCursor(move);
      return;
    }
    const center = at === null ? undefined : times.at(at);
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      onZoom('in', center);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      onZoom('out', center);
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || n === 0) return;
    setCursor(indexAt((e.clientX - box.left) / box.width, n));
  };

  const xOf = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * 100);
  const yOf = (v: number) => 100 - (v / yMax) * 100;
  const ticks = Array.from({ length: Y_TICKS + 1 }, (_, i) => (yMax * (Y_TICKS - i)) / Y_TICKS);

  // A point with no neighbour draws no line, so it gets a dot of its own.
  const lonely = series.flatMap((s, si) =>
    s.points.flatMap((p, i) =>
      p.v !== null &&
      s.points.at(i - 1)?.v == null &&
      (i === n - 1 || s.points.at(i + 1)?.v == null)
        ? [{ si, i, v: p.v, label: s.label }]
        : [],
    ),
  );

  const readout =
    at === null
      ? 'Move along the chart, or focus it and use the arrow keys, to read a value.'
      : `${formatTime(times.at(at) ?? 0)} · ${series
          .map(
            (s) =>
              `${seriesName(s.label, stat, unit)}: ${formatStatValue(s.points.at(at)?.v ?? null, stat, unit)}`,
          )
          .join('; ')}`;

  return (
    <div className="grid gap-2">
      <div
        role="group"
        aria-label={`Chart of ${label}, ${n} steps. Use the arrow keys to move along it, plus and minus to zoom.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex gap-2">
          <div
            aria-hidden="true"
            className="relative w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums"
          >
            {ticks.map((t, i) => (
              <span
                key={t}
                className="absolute right-0 -translate-y-1/2"
                style={{ top: `${(i / Y_TICKS) * 100}%` }}
              >
                {formatStatValue(t, stat, unit)}
              </span>
            ))}
          </div>
          <div
            className="relative h-48 min-w-0 flex-1 sm:h-64"
            onPointerMove={onPointerMove}
            onPointerLeave={() => setCursor(null)}
          >
            <svg
              aria-hidden="true"
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full overflow-visible"
            >
              {ticks.map((t, i) => (
                <line
                  key={t}
                  x1={0}
                  x2={W}
                  y1={(i / Y_TICKS) * H}
                  y2={(i / Y_TICKS) * H}
                  vectorEffect="non-scaling-stroke"
                  className="stroke-border"
                  strokeWidth={1}
                />
              ))}
              {series.map((s, si) => (
                <path
                  key={s.label ?? '_'}
                  d={linePath(
                    s.points.map((p) => p.v),
                    yMax,
                    W,
                    H,
                  )}
                  fill="none"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  style={{ stroke: seriesColor(s.label, si) }}
                />
              ))}
              {at !== null ? (
                <line
                  x1={(xOf(at) / 100) * W}
                  x2={(xOf(at) / 100) * W}
                  y1={0}
                  y2={H}
                  vectorEffect="non-scaling-stroke"
                  className="stroke-foreground"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
              ) : null}
            </svg>
            {/* Dots are markup over the SVG, so the stretched box does not squash them. */}
            {lonely.map((d) => (
              <Dot
                key={`l-${d.si}-${d.i}`}
                x={xOf(d.i)}
                y={yOf(d.v)}
                color={seriesColor(d.label, d.si)}
              />
            ))}
            {at !== null
              ? series.map((s, si) => {
                  const v = s.points.at(at)?.v ?? null;
                  return v === null ? null : (
                    <Dot
                      key={`c-${si}`}
                      x={xOf(at)}
                      y={yOf(v)}
                      color={seriesColor(s.label, si)}
                      ring
                    />
                  );
                })
              : null}
          </div>
        </div>
        <div
          aria-hidden="true"
          className="ml-14 flex justify-between gap-2 pt-1 text-xs text-muted-foreground"
        >
          <span>{n > 0 ? formatTime(times.at(0) ?? 0) : ''}</span>
          <span className="hidden sm:inline">
            {n > 2 ? formatTime(times.at(Math.floor(n / 2)) ?? 0) : ''}
          </span>
          <span>{n > 1 ? formatTime(times.at(-1) ?? 0) : ''}</span>
        </div>
      </div>
      <p
        data-testid="chart-readout"
        aria-live="polite"
        className="min-h-5 text-sm [overflow-wrap:anywhere]"
      >
        {readout}
      </p>
      {series.length > 1 || series.some((s) => s.label !== null) ? (
        <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {series.map((s, si) => (
            <li key={s.label ?? '_'} className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: seriesColor(s.label, si) }}
              />
              <span className="[overflow-wrap:anywhere]">{seriesName(s.label, stat, unit)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Dot({
  x,
  y,
  color,
  ring = false,
}: {
  x: number;
  y: number;
  color: string;
  ring?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full',
        ring && 'size-2.5 ring-2 ring-card',
      )}
      style={{ left: `${x}%`, top: `${y}%`, backgroundColor: color }}
    />
  );
}
