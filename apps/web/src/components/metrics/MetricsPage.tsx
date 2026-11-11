// Settings > Metrics (FR-T6, https://github.com/bgoleno/opportun/issues/346): every metric the
// caller may see, from the catalog, filterable by name and by the attributes it carries. Picking
// one charts it from the app's own store, so it works with export off: a time range (presets or
// custom), zoom, the value under the cursor, a statistic, filters, and a breakdown by one
// attribute, with a table of the same numbers beside the chart.
//
// The list's filters and the chosen metric live in the URL (the route owns them), so a view can
// be linked to. The chart's own controls start fresh for each metric.
import { useId, useState } from 'react';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { type MetricInfo, type Stat, useMetricCatalog, useSeries } from './api';
import {
  formatStatValue,
  MAX_SPAN_MS,
  MIN_SPAN_MS,
  statLabel,
  type TimeRange,
  zoom,
} from './chartModel';
import { formatTime, LineChart, seriesName } from './LineChart';

export interface MetricsSearch {
  /** Text the metric list is narrowed to. */
  q?: string;
  /** An attribute a listed metric must carry. */
  attr?: string;
  /** The metric charted. */
  metric?: string;
}

export interface MetricsPageProps {
  isAdmin: boolean;
  search: MetricsSearch;
  onSearchChange: (next: MetricsSearch) => void;
}

/** Units as words, for the list. */
function unitWord(unit: string): string {
  const words = new Map([
    ['s', 'seconds'],
    ['{item}', 'items'],
    ['{token}', 'tokens'],
    ['{USD}', 'US dollars'],
  ]);
  return words.get(unit) ?? unit;
}

export function MetricsPage({ isAdmin, search, onSearchChange }: MetricsPageProps) {
  const catalog = useMetricCatalog();
  const id = useId();
  const metrics = catalog.data?.metrics ?? [];
  const attrs = [...new Set(metrics.flatMap((m) => m.attributes))].sort();
  const q = (search.q ?? '').trim().toLowerCase();
  const shown = metrics.filter(
    (m) =>
      (q === '' || m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q)) &&
      (search.attr === undefined || m.attributes.includes(search.attr)),
  );
  const selected = metrics.find((m) => m.name === search.metric);
  const set = (patch: MetricsSearch) => onSearchChange({ ...search, ...patch });

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Metrics</CardTitle>
          <CardDescription>
            {isAdmin
              ? 'Your own AI usage, and how this instance is running: requests, jobs, the database and outbound calls.'
              : 'Your own AI usage.'}{' '}
            Read from this instance's own store, so nothing needs to be exported. Points are kept 30
            days, minute by minute for the last 48 hours.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {catalog.data?.collect === false ? <CollectOff isAdmin={isAdmin} /> : null}
          {catalog.isError ? <FormError message={errorMessage(catalog.error)} /> : null}
          {catalog.isPending ? (
            <p className="text-sm text-muted-foreground">Loading metrics...</p>
          ) : null}
          {catalog.isSuccess && metrics.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No metrics are available to you yet. Your AI usage metrics are listed here once
              Opportun records them.
            </p>
          ) : null}
          {metrics.length > 0 ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-q`}>Search metrics</Label>
                  <Input
                    id={`${id}-q`}
                    type="search"
                    value={search.q ?? ''}
                    onChange={(e) => set({ q: e.target.value === '' ? undefined : e.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-attr`}>Carries attribute</Label>
                  <Select
                    id={`${id}-attr`}
                    value={search.attr ?? ''}
                    onChange={(e) =>
                      set({ attr: e.target.value === '' ? undefined : e.target.value })
                    }
                  >
                    <option value="">Any</option>
                    {attrs.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              {shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">No metric matches.</p>
              ) : (
                <ul aria-label="Metrics" className="grid gap-2">
                  {shown.map((m) => (
                    <li key={m.name}>
                      <MetricButton
                        metric={m}
                        selected={m.name === search.metric}
                        onSelect={() => set({ metric: m.name })}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>
      {selected !== undefined ? <MetricView key={selected.name} metric={selected} /> : null}
    </div>
  );
}

/**
 * While collection is off nothing new is recorded (design.md 14.1). The switch has no Settings
 * card until FR-T2 (https://github.com/bgoleno/opportun/issues/342), so an admin gets the words
 * and no link, as on the traces page (tl on https://github.com/bgoleno/opportun/issues/347).
 */
function CollectOff({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div role="status" className="rounded-md border bg-muted/50 p-3 text-sm">
      <p className="font-medium">Collection is off, so no new points are being recorded.</p>
      <p className="text-muted-foreground">
        {isAdmin
          ? 'An admin can turn it on in Settings once telemetry settings are available.'
          : 'Ask an admin to turn it on.'}{' '}
        Points collected earlier are still shown.
      </p>
    </div>
  );
}

function MetricButton({
  metric: m,
  selected,
  onSelect,
}: {
  metric: MetricInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'grid w-full gap-1 rounded-md border p-3 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'border-primary bg-accent',
      )}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 font-mono text-xs font-medium [overflow-wrap:anywhere]">
          {m.name}
        </span>
        <Badge variant="secondary">{m.scope === 'instance' ? 'Instance' : 'Yours'}</Badge>
      </span>
      <span className="text-muted-foreground">{m.description}</span>
      <span className="text-xs text-muted-foreground">
        In {unitWord(m.unit)}. Attributes: {m.attributes.join(', ')}.
      </span>
    </button>
  );
}

const HOUR = 3_600_000;
const PRESETS = [
  { value: '1h', label: 'Last hour', ms: HOUR },
  { value: '6h', label: 'Last 6 hours', ms: 6 * HOUR },
  { value: '24h', label: 'Last 24 hours', ms: 24 * HOUR },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * HOUR },
  { value: '30d', label: 'Last 30 days', ms: MAX_SPAN_MS },
] as const;
type Preset = (typeof PRESETS)[number]['value'];

/** A preset is read against the time it was chosen, so the query does not change every render. */
type RangeState = { kind: 'preset'; preset: Preset; at: number } | ({ kind: 'custom' } & TimeRange);

function rangeOf(r: RangeState): TimeRange {
  if (r.kind === 'custom') return { from: r.from, to: r.to };
  const ms = PRESETS.find((p) => p.value === r.preset)?.ms ?? 24 * HOUR;
  return { from: r.at - ms, to: r.at };
}

/** A time as a datetime-local input's value, in the browser's own zone. */
function toLocalInput(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function MetricView({ metric: m }: { metric: MetricInfo }) {
  const id = useId();
  const [stat, setStat] = useState<Stat>(m.stats[0] ?? 'count');
  const [range, setRange] = useState<RangeState>(() => ({
    kind: 'preset',
    preset: '24h',
    at: Date.now(),
  }));
  const [filters, setFilters] = useState<Map<string, string>>(new Map());
  const [by, setBy] = useState<string | undefined>(undefined);
  const { from, to } = rangeOf(range);
  const [draft, setDraft] = useState({ from: toLocalInput(from), to: toLocalInput(to) });
  const [rangeError, setRangeError] = useState<string | null>(null);

  const series = useSeries({
    metric: m.name,
    stat,
    from,
    to,
    ...(by === undefined ? {} : { by }),
    filters: [...filters.entries()].map(([key, value]) => ({ key, value })),
  });
  const data = series.data;

  const setCustom = (next: TimeRange) => {
    setRange({ kind: 'custom', ...next });
    setDraft({ from: toLocalInput(next.from), to: toLocalInput(next.to) });
    setRangeError(null);
  };
  const doZoom = (direction: 'in' | 'out', center?: number) =>
    setCustom(zoom({ from, to }, direction, Date.now(), center));

  const applyCustom = () => {
    const f = new Date(draft.from).getTime();
    const t = new Date(draft.to).getTime();
    const now = Date.now();
    if (!Number.isFinite(f) || !Number.isFinite(t)) return setRangeError('Enter both times.');
    if (t <= f) return setRangeError('That range ends before it starts.');
    if (t - f > MAX_SPAN_MS || f < now - MAX_SPAN_MS) {
      return setRangeError('Points are kept 30 days: choose a range inside the last 30 days.');
    }
    setCustom({ from: f, to: Math.min(t, now) });
  };

  const label = statLabel(stat, m.unit);
  const rows = data?.series[0]?.points.map((p, i) => ({ t: p.t, i })) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-base [overflow-wrap:anywhere]">{m.name}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-stat`}>Statistic</Label>
            <Select
              id={`${id}-stat`}
              value={stat}
              onChange={(e) => setStat(e.target.value as Stat)}
            >
              {m.stats.map((s) => (
                <option key={s} value={s}>
                  {statLabel(s, m.unit)}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-range`}>Time range</Label>
            <Select
              id={`${id}-range`}
              value={range.kind === 'custom' ? 'custom' : range.preset}
              onChange={(e) => {
                const v = e.target.value;
                const preset = PRESETS.find((p) => p.value === v);
                if (preset !== undefined) {
                  setRange({ kind: 'preset', preset: preset.value, at: Date.now() });
                  setRangeError(null);
                } else setCustom({ from, to });
              }}
            >
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom range</option>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-by`}>Break down by</Label>
            <Select
              id={`${id}-by`}
              value={by ?? ''}
              onChange={(e) => setBy(e.target.value === '' ? undefined : e.target.value)}
            >
              <option value="">Nothing</option>
              {m.attributes.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {range.kind === 'custom' ? (
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-from`}>From</Label>
              <Input
                id={`${id}-from`}
                type="datetime-local"
                value={draft.from}
                onChange={(e) => setDraft({ ...draft, from: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-to`}>To</Label>
              <Input
                id={`${id}-to`}
                type="datetime-local"
                value={draft.to}
                onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              />
            </div>
            <Button variant="outline" className="w-fit" onClick={applyCustom}>
              Apply
            </Button>
          </div>
        ) : null}
        {rangeError !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {rangeError}
          </p>
        ) : null}

        <fieldset className="grid gap-3">
          <legend className="mb-2 text-sm font-medium">Filters</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {m.attributes.map((a) => {
              const current = filters.get(a);
              const known = new Map(Object.entries(data?.values ?? {})).get(a) ?? [];
              const options =
                current === undefined || known.includes(current) ? known : [current, ...known];
              return (
                <div key={a} className="grid min-w-0 gap-1.5">
                  <Label
                    htmlFor={`${id}-f-${a}`}
                    className="font-mono text-xs [overflow-wrap:anywhere]"
                  >
                    {a}
                  </Label>
                  <Select
                    id={`${id}-f-${a}`}
                    value={current ?? ''}
                    onChange={(e) => {
                      const next = new Map(filters);
                      if (e.target.value === '') next.delete(a);
                      else next.set(a, e.target.value);
                      setFilters(next);
                    }}
                  >
                    <option value="">Any</option>
                    {options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            })}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => doZoom('in')}
            disabled={to - from <= MIN_SPAN_MS}
          >
            Zoom in
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => doZoom('out')}
            disabled={to - from >= MAX_SPAN_MS}
          >
            Zoom out
          </Button>
          <span className="text-sm text-muted-foreground">
            {formatTime(from)} to {formatTime(to)}
          </span>
        </div>

        {series.isError ? <FormError message={errorMessage(series.error)} /> : null}
        {series.isPending ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
        {data !== undefined ? (
          <>
            <LineChart series={data.series} stat={stat} unit={m.unit} onZoom={doZoom} />
            {data.truncated ? (
              <p className="text-sm text-muted-foreground">
                This range holds more points than one chart reads: choose a shorter range or a
                filter to see all of them.
              </p>
            ) : null}
            <div
              role="region"
              aria-label="The chart's numbers"
              tabIndex={0}
              className="max-h-80 overflow-auto rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Table>
                <caption className="sr-only">
                  {label} of {m.name}, per step
                </caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    {data.series.map((s) => (
                      <TableHead key={s.label ?? '_'} className="text-right">
                        {seriesName(s.label, stat, m.unit)}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.t}>
                      <TableCell className="whitespace-nowrap">{formatTime(r.t)}</TableCell>
                      {data.series.map((s) => (
                        <TableCell key={s.label ?? '_'} className="text-right tabular-nums">
                          {formatStatValue(s.points.at(r.i)?.v ?? null, stat, m.unit)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
