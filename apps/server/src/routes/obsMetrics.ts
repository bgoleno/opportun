// The metric dashboards' API (FR-T6; design.md 14.4, 14.7, 14.12;
// https://github.com/bgoleno/opportun/issues/346). It reads the local store (obs_metric_points)
// and the catalog, nothing else, so it works with export off.
//
// - The metric list is the catalog (obs/catalog.ts): name, description, unit, attributes, and
//   the statistics each instrument gives. A histogram's count is its call count and its count
//   with `error.type` set its error count (14.4), so those are derived here, not stored.
// - Who sees what (14.7): a user-scoped metric shows the caller's own points, an admin's
//   included; an instance metric shows only the points the instance owns, and only to an admin.
//   Nobody sees another user's points.
// - A filter or breakdown names an attribute the metric's catalog entry lists, or it is refused.
//   Values are compared here, in code, after the rows are read: no value from the request goes
//   into SQL at all, and the only values the rows can hold are the ones the gate let through.
// - The resolution follows the range: 1-minute points for a range of up to 6 hours inside the
//   48 hours they are kept, 1-hour points otherwise (14.7). Steps are whole multiples of it,
//   aligned to the step, so a range has MAX_STEPS of them, or one more when it does not start
//   on a step: a chart never has more points than it can draw.
import { and, desc, eq, gte, isNull, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/client';
import { obsMetricPoints } from '../db/schema';
import { forbidden, HttpError } from '../lib/errors';
import { type MetricDef, METRICS, OTHER } from '../obs/catalog';
import { collectAvailable, collectInEffect } from '../obs/config';
import { HOUR_MS, MINUTE_MS } from '../obs/metrics';
import { requireUser, type UserCtx } from '../repos/base';

/** The longest range: 1-hour points are kept 30 days (14.7). A minute's slack for the clock. */
export const MAX_RANGE_MS = 30 * 24 * HOUR_MS + MINUTE_MS;
/** 1-minute points are kept 48 hours (14.7). */
const MINUTE_POINTS_KEPT_MS = 48 * HOUR_MS;
/** The longest range read at 1-minute resolution: past it, hour points draw as well. */
const MINUTE_RANGE_MS = 6 * HOUR_MS;
/** The most steps a series has. */
export const MAX_STEPS = 180;
/** A breakdown's largest groups each get a series; the rest are added up as one. */
export const MAX_GROUPS = 8;
/** The most point rows one query reads. Past it the answer says it is truncated. */
export const MAX_ROWS = 100_000;
/** The most distinct values offered per attribute. */
const MAX_VALUES = 100;

export const STATS = ['count', 'errors', 'mean', 'max', 'sum'] as const;
export type Stat = (typeof STATS)[number];

/** The statistics an instrument gives (14.4): a histogram's derived series, a counter's sum. */
export function statsOf(def: MetricDef): Stat[] {
  return def.instrument === 'histogram' ? ['count', 'errors', 'mean', 'max'] : ['sum'];
}

const METRIC_DEFS: ReadonlyMap<string, MetricDef> = new Map(Object.entries(METRICS));

/** Whether the viewer may read this metric at all: instance metrics are the admin's (14.7). */
function mayRead(viewer: UserCtx, def: MetricDef): boolean {
  return def.scope === 'user' || viewer.isAdmin;
}

const MetricInfo = z.object({
  name: z.string(),
  instrument: z.enum(['histogram', 'counter']),
  unit: z.string(),
  description: z.string(),
  scope: z.enum(['user', 'instance']),
  attributes: z.array(z.string()),
  stats: z.array(z.enum(STATS)),
});

const CatalogView = z.object({
  /** Whether collection is on now. Points collected earlier are shown either way (14.1). */
  collect: z.boolean(),
  /** Whether collection can be turned on here at all: false on the demo (#364). */
  collectAvailable: z.boolean(),
  metrics: z.array(MetricInfo),
});

const TIME = z.coerce.number().int().min(0);

const SeriesQuery = z.object({
  metric: z.string().max(128),
  stat: z.enum(STATS),
  from: TIME.optional(),
  to: TIME.optional(),
  by: z.string().max(128).optional(),
  // `key=value`, repeatable: a value may hold `:` and `/` (a route template, a model id).
  filter: z
    .union([z.string().max(512), z.array(z.string().max(512)).max(16)])
    .optional()
    .transform((f) => (f === undefined ? [] : Array.isArray(f) ? f : [f])),
});

const Point = z.object({ t: z.number(), v: z.number().nullable() });

const SeriesView = z.object({
  metric: z.string(),
  stat: z.enum(STATS),
  from: z.number(),
  to: z.number(),
  step: z.number(),
  resolution: z.number(),
  /** One series, or one per group of a breakdown (largest first, the rest as `_OTHER`). */
  series: z.array(z.object({ label: z.string().nullable(), points: z.array(Point) })),
  /** The values each attribute takes among the caller's points in the range, before filters. */
  values: z.record(z.string(), z.array(z.string())),
  truncated: z.boolean(),
});
export type SeriesResult = z.infer<typeof SeriesView>;

export interface SeriesRequest {
  stat: Stat;
  from: number;
  to: number;
  by?: string;
  filters: readonly { key: string; value: string }[];
  now: number;
  /** The most rows read; MAX_ROWS unless a test sets a smaller one. */
  maxRows?: number;
}

/** An attribute's value as the dashboards show and compare it: absent is null. */
function attrText(attributes: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(attributes, key)) return null;
  const v = new Map(Object.entries(attributes)).get(key);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** The resolution and step for a range (see the header). */
export function stepFor(
  from: number,
  to: number,
  now: number,
): { resolution: number; step: number } {
  const range = to - from;
  const resolution =
    range <= MINUTE_RANGE_MS && from >= now - MINUTE_POINTS_KEPT_MS ? MINUTE_MS : HOUR_MS;
  const step = resolution * Math.max(1, Math.ceil(range / resolution / MAX_STEPS));
  return { resolution, step };
}

interface Acc {
  count: number;
  sum: number;
  errors: number;
  max: number | null;
}

const emptyAcc = (): Acc => ({ count: 0, sum: 0, errors: 0, max: null });

/**
 * What ranks a breakdown's groups: the statistic shown, so a chart of errors keeps the groups
 * with errors on their own lines (tl on #363). Mean and max rank by calls, as an average of a
 * handful of calls is not what a reader looks for first.
 */
function rankWeight(
  stat: Stat,
  r: { attributes: Record<string, unknown>; count: number; sum: number },
): number {
  if (stat === 'sum') return r.sum;
  if (stat === 'errors') return attrText(r.attributes, 'error.type') === null ? 0 : r.count;
  return r.count;
}

function valueOf(stat: Stat, acc: Acc | undefined): number | null {
  const a = acc ?? emptyAcc();
  switch (stat) {
    case 'count':
      return a.count;
    case 'errors':
      return a.errors;
    case 'sum':
      return a.sum;
    case 'mean':
      return a.count === 0 ? null : a.sum / a.count;
    case 'max':
      return a.max;
  }
}

/**
 * One metric's series for a viewer. Exported so a test can read a user-scoped metric before
 * the catalog has one (FR-T4 part 2 adds the Gen AI metrics): the route calls it for every metric.
 */
export async function readSeries(
  db: Db,
  viewer: UserCtx,
  name: string,
  def: MetricDef,
  req: SeriesRequest,
): Promise<SeriesResult> {
  if (!mayRead(viewer, def)) throw forbidden();
  const { resolution, step } = stepFor(req.from, req.to, req.now);
  const maxRows = req.maxRows ?? MAX_ROWS;
  const firstStep = Math.floor(req.from / step) * step;

  // The owner rule of 14.7, and nothing from the request but bound numbers and the metric's
  // catalogued name.
  const owner =
    def.scope === 'user'
      ? eq(obsMetricPoints.userId, viewer.userId)
      : isNull(obsMetricPoints.userId);
  const rows = await db
    .select({
      attributes: obsMetricPoints.attributes,
      bucketStart: obsMetricPoints.bucketStart,
      count: obsMetricPoints.count,
      sum: obsMetricPoints.sum,
      max: obsMetricPoints.max,
    })
    .from(obsMetricPoints)
    .where(
      and(
        eq(obsMetricPoints.metric, name),
        eq(obsMetricPoints.resolution, resolution),
        // From the first step's start, so the first point counts its whole step, not only the
        // part after the range's own start (tl on #363). firstStep is a multiple of resolution.
        gte(obsMetricPoints.bucketStart, firstStep),
        lt(obsMetricPoints.bucketStart, req.to),
        owner,
      ),
    )
    // Newest first: past the row limit, the oldest points are the ones left out, not whichever
    // the database happened to return first (tl on #363).
    .orderBy(desc(obsMetricPoints.bucketStart))
    .limit(maxRows + 1)
    .all();
  const truncated = rows.length > maxRows;
  const kept = rows.slice(0, maxRows);

  const values = Object.fromEntries(
    def.attributes.map((key) => {
      const seen = new Set<string>();
      for (const r of kept) {
        const v = attrText(r.attributes, key);
        if (v !== null && seen.size < MAX_VALUES) seen.add(v);
      }
      return [key, [...seen].sort()];
    }),
  );

  // Group, then step, then add up.
  const groups = new Map<string | null, Map<number, Acc>>();
  const totals = new Map<string | null, number>();
  for (const r of kept) {
    if (!req.filters.every((f) => attrText(r.attributes, f.key) === f.value)) continue;
    const group = req.by === undefined ? null : attrText(r.attributes, req.by);
    const t = Math.floor(r.bucketStart / step) * step;
    let steps = groups.get(group);
    if (steps === undefined) {
      steps = new Map();
      groups.set(group, steps);
    }
    const acc = steps.get(t) ?? emptyAcc();
    acc.count += r.count;
    acc.sum += r.sum;
    if (attrText(r.attributes, 'error.type') !== null) acc.errors += r.count;
    acc.max = acc.max === null ? r.max : Math.max(acc.max, r.max);
    steps.set(t, acc);
    totals.set(group, (totals.get(group) ?? 0) + rankWeight(req.stat, r));
  }

  // The largest groups keep their own series; the rest are added up under OTHER (a literal
  // OTHER value among the largest takes them in).
  const ranked = [...totals.entries()].sort((x, y) => y[1] - x[1]).map(([g]) => g);
  const top = new Set(ranked.slice(0, MAX_GROUPS));
  const merged = new Map<string | null, Map<number, Acc>>();
  for (const g of ranked) {
    const target = top.has(g) ? g : OTHER;
    const into = merged.get(target) ?? new Map<number, Acc>();
    for (const [t, a] of groups.get(g) ?? []) {
      const b = into.get(t) ?? emptyAcc();
      into.set(t, {
        count: a.count + b.count,
        sum: a.sum + b.sum,
        errors: a.errors + b.errors,
        max: a.max === null ? b.max : b.max === null ? a.max : Math.max(a.max, b.max),
      });
    }
    merged.set(target, into);
  }
  // Without a breakdown there is always one series, empty or not.
  if (req.by === undefined && merged.size === 0) merged.set(null, new Map());

  const times: number[] = [];
  for (let t = firstStep; t < req.to; t += step) times.push(t);
  return {
    metric: name,
    stat: req.stat,
    from: req.from,
    to: req.to,
    step,
    resolution,
    series: [...merged.entries()].map(([label, steps]) => ({
      label,
      points: times.map((t) => ({ t, v: valueOf(req.stat, steps.get(t)) })),
    })),
    values,
    truncated,
  };
}

const badQuery = (code: string) => new HttpError(400, code);

export async function obsMetricRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get('/obs/metrics', { schema: { response: { 200: CatalogView } } }, async (req) => {
    const viewer = requireUser(req);
    const metrics = [...METRIC_DEFS.entries()]
      .filter(([, def]) => mayRead(viewer, def))
      .map(([name, def]) => ({
        name,
        instrument: def.instrument,
        unit: def.unit,
        description: def.description,
        scope: def.scope,
        attributes: [...def.attributes],
        stats: statsOf(def),
      }));
    // The switch in effect: off on the demo whatever is stored (#360).
    return {
      collect: await collectInEffect(db, app.config),
      collectAvailable: collectAvailable(app.config),
      metrics,
    };
  });

  api.get(
    '/obs/metrics/series',
    { schema: { querystring: SeriesQuery, response: { 200: SeriesView } } },
    async (req) => {
      const viewer = requireUser(req);
      const q = req.query;
      const def = METRIC_DEFS.get(q.metric);
      if (def === undefined) throw badQuery('unknown_metric');
      if (!statsOf(def).includes(q.stat)) throw badQuery('unknown_stat');
      const now = Date.now();
      const to = q.to ?? now;
      const from = q.from ?? to - 24 * HOUR_MS;
      if (from >= to || to - from > MAX_RANGE_MS) throw badQuery('invalid_range');
      const carried = new Set<string>(def.attributes);
      if (q.by !== undefined && !carried.has(q.by)) throw badQuery('unknown_attribute');
      const filters = q.filter.map((f) => {
        const eq = f.indexOf('=');
        const key = eq === -1 ? '' : f.slice(0, eq);
        if (!carried.has(key)) throw badQuery('unknown_attribute');
        return { key, value: f.slice(eq + 1) };
      });
      return await readSeries(db, viewer, q.metric, def, {
        stat: q.stat,
        from,
        to,
        ...(q.by === undefined ? {} : { by: q.by }),
        filters,
        now,
      });
    },
  );
}
