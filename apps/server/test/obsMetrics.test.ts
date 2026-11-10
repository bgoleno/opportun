// Metric aggregation and its flush (design.md 14.7, 14.11; https://github.com/bgoleno/opportun/issues/353).
// A flush writes each series' 1-minute row and adds the same figures to its 1-hour row, so there
// is no rollup job; rows already stored are added to, not replaced; at most 2,000 series wait
// between flushes, and the value of a new series past that is dropped and counted; a flush
// writes in transactions of at most 2,000 rows.
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { obsMetricPoints } from '../src/db/schema';
import { flushNow, obs, setCollecting } from '../src/obs';
import {
  flushPoints,
  HOUR_MS,
  MAX_LIVE_SERIES,
  MAX_ROWS_PER_TRANSACTION,
  MetricAggregator,
  MINUTE_MS,
  type PendingPoint,
  seriesId,
} from '../src/obs/metrics';
import { useApi } from './api';
import { countRows } from './db';

const boot = useApi();
type App = Awaited<ReturnType<typeof boot>>['app'];

afterEach(async () => {
  await setCollecting(false);
});

/** An hour start, and minutes inside it. */
const H = 1_780_000_000_000 - (1_780_000_000_000 % HOUR_MS);
const DONE = { 'opportun.job.outcome': 'done' } as const;

async function rowsAt(app: App, resolution: number) {
  return (
    await app.db
      .select()
      .from(obsMetricPoints)
      .where(
        and(
          eq(obsMetricPoints.metric, 'opportun.job.duration'),
          eq(obsMetricPoints.resolution, resolution),
        ),
      )
      .all()
  ).sort((x, y) => x.bucketStart - y.bucketStart);
}

describe('seriesId (#353)', () => {
  it('is the same for the same attributes in any order, and differs by owner and metric', () => {
    const a = seriesId('opportun.job.duration', null, {
      'opportun.job.outcome': 'done',
      'error.type': 'X',
    });
    const b = seriesId('opportun.job.duration', null, {
      'error.type': 'X',
      'opportun.job.outcome': 'done',
    });
    expect(a).toBe(b);
    expect(seriesId('opportun.job.duration', 'u1', DONE)).not.toBe(
      seriesId('opportun.job.duration', null, DONE),
    );
    expect(seriesId('http.server.request.duration', null, DONE)).not.toBe(
      seriesId('opportun.job.duration', null, DONE),
    );
  });
});

describe('a flush (#353)', () => {
  it('writes a 1-minute row and a 1-hour row with the same figures and histogram counts', async () => {
    const { app } = await boot();
    const agg = new MetricAggregator();
    // Job buckets (seconds): 0.01 falls in the first, 1.5 in the one bounded by 5, 1000 overflows.
    agg.add('opportun.job.duration', 0.01, DONE, null, H + 5 * MINUTE_MS + 1);
    agg.add('opportun.job.duration', 1.5, DONE, null, H + 5 * MINUTE_MS + 2);
    agg.add('opportun.job.duration', 1000, DONE, null, H + 5 * MINUTE_MS + 3);
    await flushPoints(app.db, agg.drain());

    const [minute] = await rowsAt(app, MINUTE_MS);
    const [hour] = await rowsAt(app, HOUR_MS);
    const counts = new Array<number>(14).fill(0);
    counts[0] = 1;
    counts[5] = 1;
    counts[13] = 1;
    const figures = { count: 3, min: 0.01, max: 1000, bucketCounts: counts };
    expect(minute?.sum).toBeCloseTo(1001.51, 9);
    expect(hour?.sum).toBeCloseTo(1001.51, 9);
    expect(minute).toMatchObject({
      bucketStart: H + 5 * MINUTE_MS,
      userId: null,
      attributes: DONE,
      ...figures,
    });
    expect(hour).toMatchObject({ bucketStart: H, ...figures });
    expect(minute?.series).toBe(hour?.series);
    expect(await countRows(app, obsMetricPoints)).toBe(2);
  });

  it('adds to rows already stored: a later flush in the same minute and hour merges, another hour stays apart', async () => {
    const { app } = await boot();
    const first = new MetricAggregator();
    first.add('opportun.job.duration', 1, DONE, null, H + MINUTE_MS);
    first.add('opportun.job.duration', 7, DONE, null, H - HOUR_MS + MINUTE_MS); // the hour before
    await flushPoints(app.db, first.drain());

    const second = new MetricAggregator();
    second.add('opportun.job.duration', 3, DONE, null, H + MINUTE_MS + 30_000); // same minute
    second.add('opportun.job.duration', 2, DONE, null, H + 2 * MINUTE_MS); // same hour
    await flushPoints(app.db, second.drain());

    const minutes = await rowsAt(app, MINUTE_MS);
    expect(minutes.map((m) => [m.bucketStart, m.count, m.sum, m.min, m.max])).toEqual([
      [H - HOUR_MS + MINUTE_MS, 1, 7, 7, 7],
      [H + MINUTE_MS, 2, 4, 1, 3],
      [H + 2 * MINUTE_MS, 1, 2, 2, 2],
    ]);
    const hours = await rowsAt(app, HOUR_MS);
    expect(hours.map((h) => [h.bucketStart, h.count, h.sum, h.min, h.max])).toEqual([
      [H - HOUR_MS, 1, 7, 7, 7],
      [H, 3, 6, 1, 3],
    ]);
    // Each hour row's histogram is the sum of its minutes'.
    expect(hours[1]?.bucketCounts?.reduce((s, n) => s + n, 0)).toBe(3);
  });

  it('writes in transactions of at most 2,000 rows: a failure in one leaves the one before it', async () => {
    const { app } = await boot();
    expect(MAX_ROWS_PER_TRANSACTION).toBe(2_000);
    const pointFor = (i: number, userId: string | null): PendingPoint => ({
      metric: 'opportun.job.duration',
      attributes: { 'opportun.job.outcome': 'done', 'error.type': `E${i}` },
      userId,
      bucketStart: H,
      count: 1,
      sum: 1,
      min: 1,
      max: 1,
      bucketCounts: new Array<number>(14).fill(0),
    });
    // 1,000 points are 2,000 rows: the first transaction. The 1,001st names no user that
    // exists, so its transaction fails on the foreign key.
    const points = Array.from({ length: 1_000 }, (_, i) => pointFor(i, null));
    points.push(pointFor(1_000, 'no-such-user'));
    await expect(flushPoints(app.db, points)).rejects.toThrow();
    expect(await countRows(app, obsMetricPoints)).toBe(2_000);
  });
});

describe('the series cap (#353)', () => {
  it('refuses a new series past the cap, keeps adding to known ones, and admits the drop counter', () => {
    const agg = new MetricAggregator(2);
    expect(agg.add('opportun.job.duration', 1, DONE, null, H)).toBe(true);
    expect(agg.add('opportun.job.duration', 1, { 'opportun.job.outcome': 'dead' }, null, H)).toBe(
      true,
    );
    expect(agg.add('opportun.job.duration', 1, { 'opportun.job.outcome': 'retry' }, null, H)).toBe(
      false,
    );
    expect(agg.add('opportun.job.duration', 2, DONE, null, H)).toBe(true);
    expect(
      agg.add(
        'opportun.obs.dropped',
        1,
        { 'opportun.obs.signal': 'metrics', 'opportun.obs.reason': 'series_cap' },
        null,
        H,
        true,
      ),
    ).toBe(true);
    expect(agg.size).toBe(3);
    const drained = agg.drain();
    expect(drained).toHaveLength(3);
    expect(drained.find((p) => p.attributes['opportun.job.outcome'] === 'done')?.count).toBe(2);
    // A drain starts the count again.
    expect(agg.size).toBe(0);
    expect(agg.add('opportun.job.duration', 1, { 'opportun.job.outcome': 'retry' }, null, H)).toBe(
      true,
    );
  });

  it('through obs.record: the 2,001st series is dropped and counted as series_cap', async () => {
    const { app } = await boot();
    await setCollecting(true);
    expect(MAX_LIVE_SERIES).toBe(2_000);
    for (let i = 0; i <= MAX_LIVE_SERIES; i += 1) {
      obs.record('http.server.request.duration', 0.01, {
        'http.request.method': 'GET',
        'http.route': `/api/v1/r${i}`,
        'http.response.status_code': 200,
      });
    }
    await flushNow();
    const server = await app.db
      .select()
      .from(obsMetricPoints)
      .where(eq(obsMetricPoints.metric, 'http.server.request.duration'))
      .all();
    expect(server).toHaveLength(2 * MAX_LIVE_SERIES);
    expect(server.some((p) => p.attributes['http.route'] === `/api/v1/r${MAX_LIVE_SERIES}`)).toBe(
      false,
    );
    const dropped = await app.db
      .select()
      .from(obsMetricPoints)
      .where(eq(obsMetricPoints.metric, 'opportun.obs.dropped'))
      .all();
    expect(dropped.map((d) => [d.resolution, d.sum, d.attributes])).toEqual(
      expect.arrayContaining([
        [MINUTE_MS, 1, { 'opportun.obs.signal': 'metrics', 'opportun.obs.reason': 'series_cap' }],
        [HOUR_MS, 1, { 'opportun.obs.signal': 'metrics', 'opportun.obs.reason': 'series_cap' }],
      ]),
    );
    expect(dropped).toHaveLength(2);
  });

  it('a value that is not a finite number is dropped and counted as invalid_value', async () => {
    const { app } = await boot();
    await setCollecting(true);
    obs.record('opportun.job.duration', Number.NaN, DONE);
    await flushNow();
    expect(await rowsAt(app, MINUTE_MS)).toEqual([]);
    const dropped = await app.db
      .select()
      .from(obsMetricPoints)
      .where(
        and(
          eq(obsMetricPoints.metric, 'opportun.obs.dropped'),
          eq(obsMetricPoints.resolution, MINUTE_MS),
        ),
      )
      .all();
    expect(dropped.map((d) => d.attributes['opportun.obs.reason'])).toEqual(['invalid_value']);
  });
});
