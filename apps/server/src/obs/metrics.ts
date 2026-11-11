// In-process metric aggregation, flushed to obs_metric_points (design.md 14.3, 14.7, 14.11;
// https://github.com/bgoleno/opportun/issues/353). obs.record() adds a gated value to one series
// (a metric, its owner and its attributes) in its 1-minute bucket. A flush, every 60 seconds,
// writes each series' 1-minute row and adds the same figures to its 1-hour row, so no rollup job
// is needed: the hour row is the sum of its minutes.
//
// Bounded (14.11): at most MAX_LIVE_SERIES series wait between flushes, and a value for a new
// series beyond that is dropped and counted. A flush writes at most MAX_ROWS_PER_TRANSACTION rows
// per transaction, so a full buffer is two transactions, never one long one.
//
// Nothing here runs with collection off: obs/index.ts creates the aggregator, and the timer
// that flushes it, only while collection is on.
import { createHash } from 'node:crypto';
import { and, inArray } from 'drizzle-orm';
import { withTransaction, type Db, type Exec } from '../db/client';
import { obsMetricPoints } from '../db/schema';
import { type Attributes, metricDef, type MetricName } from './catalog';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
/** The two resolutions a point row has (obs_metric_points.resolution), in milliseconds. */
export const RESOLUTIONS = [MINUTE_MS, HOUR_MS] as const;
export const MAX_LIVE_SERIES = 2_000;
export const MAX_ROWS_PER_TRANSACTION = 2_000;

/** One series in one 1-minute bucket, as it waits for the next flush. */
export interface PendingPoint {
  metric: MetricName;
  attributes: Attributes;
  /** The user the point belongs to, or null for the instance (14.7). */
  userId: string | null;
  /** Start of the 1-minute bucket, ms since the epoch. */
  bucketStart: number;
  count: number;
  sum: number;
  min: number;
  max: number;
  /** Per-bucket counts for a histogram (one more than its boundaries); null for a counter. */
  bucketCounts: number[] | null;
}

/** Attributes in key order, so the same set is the same series however the caller wrote it. */
function canonical(attributes: Attributes): string {
  return JSON.stringify(
    Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** A series' identity as text: the metric, the owner and the attributes in key order. */
export function seriesKey(metric: string, userId: string | null, attributes: Attributes): string {
  return `${metric}\n${userId ?? ''}\n${canonical(attributes)}`;
}

/** The stored series id: a hash of the metric, the owner and the attributes (no row id needed). */
export function seriesId(metric: string, userId: string | null, attributes: Attributes): string {
  return createHash('sha256')
    .update(seriesKey(metric, userId, attributes))
    .digest('hex');
}

function bucketIndex(bounds: readonly number[], value: number): number {
  const i = bounds.findIndex((b) => value <= b);
  return i === -1 ? bounds.length : i;
}

export class MetricAggregator {
  private points = new Map<string, PendingPoint>();
  private live = new Set<string>();

  constructor(private readonly maxSeries = MAX_LIVE_SERIES) {}

  /**
   * Adds one value. Returns false when a new series would pass the cap: the value is not kept,
   * and the caller counts the drop. `always` admits the value past the cap: the drop counter's
   * own few series must never be the ones dropped.
   */
  add(
    metric: MetricName,
    value: number,
    attributes: Attributes,
    userId: string | null,
    at: number,
    always = false,
    /** The series' key when the caller already has it (a repeated database statement). */
    knownSeries?: string,
  ): boolean {
    // The live key is the series' canonical text; its hash (seriesId, the stored key) is taken
    // once per point at flush, not on every value: hashing here cost about a microsecond a
    // statement, half the database budget of 14.11 (#343).
    const series = knownSeries ?? seriesKey(metric, userId, attributes);
    if (!this.live.has(series)) {
      if (!always && this.live.size >= this.maxSeries) return false;
      this.live.add(series);
    }
    const bucketStart = Math.floor(at / MINUTE_MS) * MINUTE_MS;
    const key = `${series}:${bucketStart}`;
    const def = metricDef(metric);
    const bounds = 'buckets' in def ? def.buckets : undefined;
    let p = this.points.get(key);
    if (p === undefined) {
      p = {
        metric,
        attributes,
        userId,
        bucketStart,
        count: 0,
        sum: 0,
        min: value,
        max: value,
        bucketCounts: bounds === undefined ? null : new Array<number>(bounds.length + 1).fill(0),
      };
      this.points.set(key, p);
    }
    p.count += 1;
    p.sum += value;
    p.min = Math.min(p.min, value);
    p.max = Math.max(p.max, value);
    if (bounds !== undefined && p.bucketCounts !== null) {
      const i = bucketIndex(bounds, value);
      p.bucketCounts.splice(i, 1, (p.bucketCounts.at(i) ?? 0) + 1);
    }
    return true;
  }

  /** The waiting points, which leave the aggregator; the series count starts again. */
  drain(): PendingPoint[] {
    const out = [...this.points.values()];
    this.points = new Map();
    this.live = new Set();
    return out;
  }

  get size(): number {
    return this.live.size;
  }
}

type PointRow = typeof obsMetricPoints.$inferInsert;

function addCounts(a: number[] | null, b: number[] | null): number[] | null {
  if (a === null || b === null) return a ?? b;
  return a.map((n, i) => n + (b.at(i) ?? 0));
}

function merge(row: PointRow, p: PendingPoint): PointRow {
  return {
    ...row,
    count: row.count + p.count,
    sum: row.sum + p.sum,
    min: Math.min(row.min, p.min),
    max: Math.max(row.max, p.max),
    bucketCounts: addCounts(row.bucketCounts ?? null, p.bucketCounts),
  };
}

const rowKey = (series: string, resolution: number, bucketStart: number) =>
  `${series}:${resolution}:${bucketStart}`;

/** Writes one chunk of points, each to its minute row and its hour row, in one transaction. */
async function writeChunk(tx: Exec, points: PendingPoint[]): Promise<void> {
  // The same series can fall into one hour row from two minutes of one flush: merge those first.
  const rows = new Map<string, PointRow>();
  for (const p of points) {
    const series = seriesId(p.metric, p.userId, p.attributes);
    for (const resolution of RESOLUTIONS) {
      const bucketStart = Math.floor(p.bucketStart / resolution) * resolution;
      const key = rowKey(series, resolution, bucketStart);
      const prior = rows.get(key);
      rows.set(
        key,
        prior === undefined
          ? {
              series,
              metric: p.metric,
              attributes: p.attributes,
              userId: p.userId,
              resolution,
              bucketStart,
              count: p.count,
              sum: p.sum,
              min: p.min,
              max: p.max,
              bucketCounts: p.bucketCounts,
            }
          : merge(prior, p),
      );
    }
  }
  // Rows already stored for these keys (an hour row from an earlier flush, or a minute row a
  // flush split across): read them back and add, so the write below replaces each whole row.
  const all = [...rows.values()];
  const seriesIds = [...new Set(all.map((r) => r.series))];
  const starts = [...new Set(all.map((r) => r.bucketStart))];
  // By series and bucket start, so an hour's flush reads back this hour's rows and its minutes,
  // not every bucket the series ever had.
  const stored = await tx
    .select()
    .from(obsMetricPoints)
    .where(
      and(inArray(obsMetricPoints.series, seriesIds), inArray(obsMetricPoints.bucketStart, starts)),
    )
    .all();
  for (const s of stored) {
    const key = rowKey(s.series, s.resolution, s.bucketStart);
    const fresh = rows.get(key);
    if (fresh === undefined) continue;
    rows.set(key, {
      ...fresh,
      count: fresh.count + s.count,
      sum: fresh.sum + s.sum,
      min: Math.min(fresh.min, s.min),
      max: Math.max(fresh.max, s.max),
      bucketCounts: addCounts(fresh.bucketCounts ?? null, s.bucketCounts),
    });
  }
  for (const row of rows.values()) {
    await tx
      .insert(obsMetricPoints)
      .values(row)
      .onConflictDoUpdate({
        target: [obsMetricPoints.series, obsMetricPoints.resolution, obsMetricPoints.bucketStart],
        set: {
          count: row.count,
          sum: row.sum,
          min: row.min,
          max: row.max,
          bucketCounts: row.bucketCounts,
        },
      })
      .run();
  }
}

/**
 * Writes drained points: each to its 1-minute row and, added, to its 1-hour row. Two rows a
 * point, so a transaction holds at most MAX_ROWS_PER_TRANSACTION / 2 points.
 */
export async function flushPoints(db: Db, points: PendingPoint[]): Promise<number> {
  const perTx = Math.floor(MAX_ROWS_PER_TRANSACTION / RESOLUTIONS.length);
  for (let i = 0; i < points.length; i += perTx) {
    const chunk = points.slice(i, i + perTx);
    await withTransaction(db, (tx) => writeChunk(tx, chunk));
  }
  return points.length;
}
