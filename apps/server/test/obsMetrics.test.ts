// The metric dashboards' API (FR-T6; design.md 14.4, 14.7, 14.12;
// https://github.com/bgoleno/opportun/issues/346). Every test inserts its own rows into
// obs_metric_points: the dashboards read the table, not the instrumentation (14.12).
import { afterEach, describe, expect, it } from 'vitest';
import { obsMetricPoints } from '../src/db/schema';
import type { MetricDef } from '../src/obs/catalog';
import { writeCollect } from '../src/obs/config';
import { setCollecting } from '../src/obs';
import { HOUR_MS, MINUTE_MS, seriesId } from '../src/obs/metrics';
import { readSeries } from '../src/routes/obsMetrics';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
type App = Awaited<ReturnType<typeof boot>>['app'];

afterEach(async () => {
  await setCollecting(false);
});

const HTTP = 'http.server.request.duration';
/** A fixed "now", on an hour boundary, well inside every retention window. */
const NOW = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;

interface PointIn {
  metric?: string;
  attributes?: Record<string, unknown>;
  userId?: string | null;
  resolution?: number;
  bucketStart: number;
  count?: number;
  sum?: number;
  min?: number;
  max?: number;
}

async function insertPoint(app: App, p: PointIn): Promise<void> {
  const metric = p.metric ?? HTTP;
  const attributes = p.attributes ?? { 'http.request.method': 'GET', 'http.route': '/api/v1/a' };
  const userId = p.userId ?? null;
  const count = p.count ?? 1;
  const sum = p.sum ?? 0.1 * count;
  await app.db
    .insert(obsMetricPoints)
    .values({
      series: seriesId(metric, userId, attributes as never),
      metric,
      attributes,
      userId,
      resolution: p.resolution ?? MINUTE_MS,
      bucketStart: p.bucketStart,
      count,
      sum,
      min: p.min ?? sum / count,
      max: p.max ?? sum / count,
      bucketCounts: null,
    })
    .run();
}

interface SeriesBody {
  metric: string;
  stat: string;
  from: number;
  to: number;
  step: number;
  resolution: number;
  series: { label: string | null; points: { t: number; v: number | null }[] }[];
  values: Record<string, string[]>;
  truncated: boolean;
}

async function series(c: TestClient, query: string): Promise<SeriesBody> {
  const res = await c.request({ method: 'GET', url: `/api/v1/obs/metrics/series?${query}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const total = (b: SeriesBody) =>
  b.series.flatMap((s) => s.points).reduce((acc, p) => acc + (p.v ?? 0), 0);

const lastHour = `from=${NOW - HOUR_MS}&to=${NOW}`;

describe('GET /obs/metrics (FR-T6)', () => {
  it('lists every metric the caller may see, from the catalog, with its statistics', async () => {
    const { a } = await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/obs/metrics' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.collect).toBe(false);
    const http = body.metrics.find((m: { name: string }) => m.name === HTTP);
    expect(http).toEqual({
      name: HTTP,
      instrument: 'histogram',
      unit: 's',
      description: 'Duration of HTTP server requests.',
      scope: 'instance',
      attributes: ['http.request.method', 'http.route', 'http.response.status_code', 'error.type'],
      stats: ['count', 'errors', 'mean', 'max'],
    });
    const dropped = body.metrics.find((m: { name: string }) => m.name === 'opportun.obs.dropped');
    expect(dropped).toMatchObject({ instrument: 'counter', stats: ['sum'] });
  });

  it('shows a user no instance metric: those are the admin’s (14.7)', async () => {
    const { b } = await boot();
    const body = (await b.request({ method: 'GET', url: '/api/v1/obs/metrics' })).json();
    expect(body.metrics.filter((m: { scope: string }) => m.scope === 'instance')).toEqual([]);
  });

  it('says whether collection is on', async () => {
    const { app, a, b } = await boot();
    await writeCollect(app.db, true, { userId: a.userId });
    expect((await b.request({ method: 'GET', url: '/api/v1/obs/metrics' })).json().collect).toBe(
      true,
    );
  });

  it('needs a signed-in user', async () => {
    const { app } = await boot();
    expect((await app.inject({ method: 'GET', url: '/api/v1/obs/metrics' })).statusCode).toBe(401);
  });
});

describe('GET /obs/metrics/series (FR-T6)', () => {
  it('gives an admin the instance’s points, in steps over the range', async () => {
    const { app, a } = await boot();
    await insertPoint(app, { bucketStart: NOW - 50 * MINUTE_MS, count: 3 });
    await insertPoint(app, { bucketStart: NOW - 10 * MINUTE_MS, count: 2 });
    // Outside the range: not counted.
    await insertPoint(app, { bucketStart: NOW - 2 * HOUR_MS, count: 100 });
    const body = await series(a, `metric=${HTTP}&stat=count&${lastHour}`);
    expect(body).toMatchObject({
      metric: HTTP,
      stat: 'count',
      resolution: MINUTE_MS,
      truncated: false,
    });
    expect(body.series).toHaveLength(1);
    expect(body.series[0]!.label).toBeNull();
    expect(total(body)).toBe(5);
    // Steps are contiguous and cover the range, each starting on a step boundary.
    const ts = body.series[0]!.points.map((p) => p.t);
    expect(ts[0]).toBeLessThanOrEqual(NOW - HOUR_MS);
    expect(ts.at(-1)).toBeLessThan(NOW);
    expect(ts.slice(1).map((t, i) => t - (ts.at(i) ?? 0))).toEqual(
      ts.slice(1).map(() => body.step),
    );
    expect(ts.every((t) => t % body.step === 0)).toBe(true);
    // A step with nothing recorded counts zero calls.
    expect(body.series[0]!.points.filter((p) => p.v === 0).length).toBeGreaterThan(0);
  });

  it('never shows a user’s point in the instance’s view, nor another user’s anywhere', async () => {
    const { app, a, b } = await boot();
    await insertPoint(app, { bucketStart: NOW - 5 * MINUTE_MS, count: 1 });
    // Rows the span store would never write for an instance metric, kept out all the same.
    await insertPoint(app, { bucketStart: NOW - 5 * MINUTE_MS, count: 40, userId: a.userId });
    await insertPoint(app, { bucketStart: NOW - 5 * MINUTE_MS, count: 500, userId: b.userId });
    expect(total(await series(a, `metric=${HTTP}&stat=count&${lastHour}`))).toBe(1);
  });

  it('refuses a user an instance metric', async () => {
    const { app, b } = await boot();
    await insertPoint(app, { bucketStart: NOW - 5 * MINUTE_MS });
    const res = await b.request({
      method: 'GET',
      url: `/api/v1/obs/metrics/series?metric=${HTTP}&stat=count&${lastHour}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('derives errors, mean and max from a histogram’s points', async () => {
    const { app, a } = await boot();
    const at = NOW - 5 * MINUTE_MS;
    await insertPoint(app, { bucketStart: at, count: 4, sum: 0.4, max: 0.2 });
    await insertPoint(app, {
      bucketStart: at,
      count: 1,
      sum: 1.6,
      max: 1.6,
      attributes: { 'http.request.method': 'GET', 'http.route': '/api/v1/a', 'error.type': '500' },
    });
    const value = async (stat: string) => {
      const pts = (await series(a, `metric=${HTTP}&stat=${stat}&${lastHour}`)).series[0]!.points;
      return pts.filter((p) => p.v !== null && p.v !== 0);
    };
    expect((await value('errors')).map((p) => p.v)).toEqual([1]);
    expect((await value('count')).map((p) => p.v)).toEqual([5]);
    expect((await value('mean')).map((p) => p.v)).toEqual([0.4]);
    expect((await value('max')).map((p) => p.v)).toEqual([1.6]);
    // A step with no calls has no mean and no max, rather than a zero.
    const mean = (await series(a, `metric=${HTTP}&stat=mean&${lastHour}`)).series[0]!.points;
    expect(mean.some((p) => p.v === null)).toBe(true);
  });

  it('sums a counter', async () => {
    const { app, a } = await boot();
    const metric = 'opportun.obs.dropped';
    const attributes = { 'opportun.obs.signal': 'spans', 'opportun.obs.reason': 'buffer_full' };
    await insertPoint(app, {
      metric,
      attributes,
      bucketStart: NOW - 5 * MINUTE_MS,
      count: 2,
      sum: 7,
    });
    await insertPoint(app, {
      metric,
      attributes,
      bucketStart: NOW - 4 * MINUTE_MS,
      count: 1,
      sum: 3,
    });
    expect(total(await series(a, `metric=${metric}&stat=sum&${lastHour}`))).toBe(10);
  });

  it('breaks a metric down by one catalogued attribute', async () => {
    const { app, a } = await boot();
    const at = NOW - 5 * MINUTE_MS;
    await insertPoint(app, {
      bucketStart: at,
      count: 3,
      attributes: { 'http.route': '/api/v1/a' },
    });
    await insertPoint(app, {
      bucketStart: at,
      count: 2,
      attributes: { 'http.route': '/api/v1/b' },
    });
    await insertPoint(app, {
      bucketStart: at,
      count: 1,
      attributes: { 'http.request.method': 'GET' },
    });
    const body = await series(a, `metric=${HTTP}&stat=count&by=http.route&${lastHour}`);
    const sums = Object.fromEntries(
      body.series.map((s) => [s.label ?? '(none)', s.points.reduce((n, p) => n + (p.v ?? 0), 0)]),
    );
    expect(sums).toEqual({ '/api/v1/a': 3, '/api/v1/b': 2, '(none)': 1 });
    // The largest first.
    expect(body.series[0]!.label).toBe('/api/v1/a');
  });

  it('keeps the eight largest groups of a breakdown and adds up the rest', async () => {
    const { app, a } = await boot();
    for (let i = 0; i < 11; i++) {
      await insertPoint(app, {
        bucketStart: NOW - 5 * MINUTE_MS,
        count: 20 - i,
        attributes: { 'http.response.status_code': 200 + i },
      });
    }
    const body = await series(
      a,
      `metric=${HTTP}&stat=count&by=http.response.status_code&${lastHour}`,
    );
    expect(body.series.map((s) => s.label)).toEqual([
      '200',
      '201',
      '202',
      '203',
      '204',
      '205',
      '206',
      '207',
      '_OTHER',
    ]);
    expect(total(body)).toBe([...Array(11).keys()].reduce((n, i) => n + 20 - i, 0));
  });

  it('filters by catalogued attributes, matching values exactly', async () => {
    const { app, a } = await boot();
    const at = NOW - 5 * MINUTE_MS;
    await insertPoint(app, {
      bucketStart: at,
      count: 3,
      attributes: { 'http.request.method': 'GET', 'http.route': '/x/:id' },
    });
    await insertPoint(app, {
      bucketStart: at,
      count: 2,
      attributes: { 'http.request.method': 'POST', 'http.route': '/x/:id' },
    });
    await insertPoint(app, {
      bucketStart: at,
      count: 1,
      attributes: { 'http.request.method': 'GET', 'http.route': '/y' },
    });
    const q = (f: string[]) =>
      series(
        a,
        `metric=${HTTP}&stat=count&${lastHour}&${f.map((x) => `filter=${encodeURIComponent(x)}`).join('&')}`,
      );
    expect(total(await q(['http.request.method=GET']))).toBe(4);
    expect(total(await q(['http.request.method=GET', 'http.route=/x/:id']))).toBe(3);
    expect(total(await q(["http.route=/x/:id' OR '1'='1"]))).toBe(0);
    // The values each attribute takes in the range, for the filter and breakdown choices.
    const body = await q([]);
    expect(body.values['http.request.method']).toEqual(['GET', 'POST']);
    expect(body.values['http.route']).toEqual(['/x/:id', '/y']);
  });

  it('refuses a filter or breakdown on an attribute the metric does not carry', async () => {
    const { a } = await boot();
    for (const q of [
      'filter=user.id%3Dx',
      'filter=opportun.job.kind%3Dx',
      'by=user.id',
      'by=nonsense',
      'filter=no-equals-sign',
    ]) {
      const res = await a.request({
        method: 'GET',
        url: `/api/v1/obs/metrics/series?metric=${HTTP}&stat=count&${lastHour}&${q}`,
      });
      expect(res.statusCode, q).toBe(400);
    }
  });

  it('reads 1-minute points for a short range and 1-hour points for a long one', async () => {
    const { app, a } = await boot();
    // The same calls, told apart by count: 1 in the minute rows, 1000 in the hour rows.
    await insertPoint(app, { bucketStart: NOW - 3 * HOUR_MS, count: 1 });
    await insertPoint(app, { bucketStart: NOW - 3 * HOUR_MS, count: 1000, resolution: HOUR_MS });
    const short = await series(a, `metric=${HTTP}&stat=count&from=${NOW - 4 * HOUR_MS}&to=${NOW}`);
    expect(short.resolution).toBe(MINUTE_MS);
    expect(total(short)).toBe(1);
    const long = await series(
      a,
      `metric=${HTTP}&stat=count&from=${NOW - 7 * 24 * HOUR_MS}&to=${NOW}`,
    );
    expect(long.resolution).toBe(HOUR_MS);
    expect(total(long)).toBe(1000);
    // Older than the 48 hours minute points are kept: hour points, however short the range.
    const old = await series(
      a,
      `metric=${HTTP}&stat=count&from=${NOW - 72 * HOUR_MS}&to=${NOW - 71 * HOUR_MS}`,
    );
    expect(old.resolution).toBe(HOUR_MS);
    // At most a few hundred steps, whatever the range.
    expect(long.series[0]!.points.length).toBeLessThanOrEqual(200);
  });

  it('refuses an unknown metric, a statistic the metric has not, and a bad range', async () => {
    const { a } = await boot();
    for (const q of [
      `metric=nope&stat=count&${lastHour}`,
      `metric=${HTTP}&stat=sum&${lastHour}`,
      `metric=opportun.obs.dropped&stat=mean&${lastHour}`,
      `metric=${HTTP}&stat=count&from=${NOW}&to=${NOW - 1}`,
      `metric=${HTTP}&stat=count&from=${NOW - 40 * 24 * HOUR_MS}&to=${NOW}`,
      `metric=${HTTP}&stat=count&from=yesterday&to=${NOW}`,
    ]) {
      const res = await a.request({ method: 'GET', url: `/api/v1/obs/metrics/series?${q}` });
      expect(res.statusCode, q).toBe(400);
    }
  });
});

describe('readSeries for a user-scoped metric (14.7)', () => {
  // No user-scoped metric is in the catalog until the Gen AI metrics land (FR-T4 part 2), so this
  // reads one defined here, with the same rule the route applies to every metric.
  const GENAI = 'gen_ai.client.inference.usage.input_tokens';
  const def: MetricDef = {
    instrument: 'counter',
    unit: '{token}',
    description: 'Input tokens.',
    attributes: ['error.type'],
    scope: 'user',
  };

  it('gives each user their own points only, an admin included', async () => {
    const { app, a, b } = await boot();
    const at = NOW - 5 * MINUTE_MS;
    await insertPoint(app, {
      metric: GENAI,
      attributes: {},
      userId: a.userId,
      bucketStart: at,
      sum: 100,
    });
    await insertPoint(app, {
      metric: GENAI,
      attributes: {},
      userId: b.userId,
      bucketStart: at,
      sum: 7,
    });
    await insertPoint(app, {
      metric: GENAI,
      attributes: {},
      userId: null,
      bucketStart: at,
      sum: 9000,
    });
    const read = async (viewer: { userId: string; isAdmin: boolean }) => {
      const out = await readSeries(app.db, viewer, GENAI, def, {
        stat: 'sum',
        from: NOW - HOUR_MS,
        to: NOW,
        filters: [],
        now: NOW,
      });
      return out.series.flatMap((s) => s.points).reduce((n, p) => n + (p.v ?? 0), 0);
    };
    expect(await read({ userId: a.userId, isAdmin: true })).toBe(100);
    expect(await read({ userId: b.userId, isAdmin: false })).toBe(7);
  });
});
