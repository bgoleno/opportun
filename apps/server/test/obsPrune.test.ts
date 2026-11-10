// Pruning the observability store (design.md 14.7, 14.11; https://github.com/bgoleno/opportun/issues/353).
// Hourly: 1-minute points older than 48 hours, 1-hour points older than 30 days, traces (with
// their spans) older than 30 days, then the row caps, oldest first and whole traces only. The
// boundary tests pin "strictly older than": a row at the cutoff stays, one a millisecond older goes.
import { describe, expect, it } from 'vitest';
import { obsMetricPoints, obsSpans, obsTraces } from '../src/db/schema';
import { getJobHandler } from '../src/jobs/registry';
import { readSchedules } from '../src/jobs/runner';
import {
  OBS_CAPS,
  OBS_PRUNE_CRON,
  OBS_PRUNE_JOB_KIND,
  OBS_RETENTION,
  pruneObservability,
} from '../src/jobs/obsPrune';
import { HOUR_MS, MINUTE_MS } from '../src/obs/metrics';
import { useApi } from './api';
import { countRows } from './db';

const boot = useApi();
type App = Awaited<ReturnType<typeof boot>>['app'];

const NOW = 1_780_000_000_000;
const DAY_MS = 24 * HOUR_MS;

let seq = 0;
async function point(
  app: App,
  resolution: number,
  bucketStart: number,
  userId: string | null = null,
) {
  seq += 1;
  const series = seq.toString(16).padStart(64, '0');
  await app.db
    .insert(obsMetricPoints)
    .values({
      series,
      metric: 'opportun.job.duration',
      attributes: { 'opportun.job.outcome': 'done' },
      userId,
      resolution,
      bucketStart,
      count: 1,
      sum: 1,
      min: 1,
      max: 1,
      bucketCounts: [1],
    })
    .run();
  return series;
}

async function traceWithSpans(app: App, userId: string, startedAt: number, spans = 1) {
  seq += 1;
  const traceId = seq.toString(16).padStart(32, '0');
  await app.db
    .insert(obsTraces)
    .values({
      traceId,
      userId,
      startedAt,
      durationMs: 1,
      origin: 'job test',
      status: 'ok',
      updatedAt: startedAt,
    })
    .run();
  for (let i = 0; i < spans; i += 1) {
    await app.db
      .insert(obsSpans)
      .values({
        traceId,
        spanId: (i + 1).toString(16).padStart(16, '0'),
        parentSpanId: null,
        userId,
        name: 'span',
        kind: 'internal',
        startedAt: startedAt + i,
        durationMs: 1,
        status: 'ok',
        attributes: {},
      })
      .run();
  }
  return traceId;
}

const seriesOf = async (app: App) =>
  (await app.db.select().from(obsMetricPoints).all()).map((r) => r.series).sort();
const tracesOf = async (app: App) =>
  (await app.db.select().from(obsTraces).all()).map((r) => r.traceId).sort();

describe('pruneObservability: age (#353)', () => {
  it('sets the retention the design sets', () => {
    expect(OBS_RETENTION).toEqual({
      minutePointsMs: 48 * HOUR_MS,
      hourPointsMs: 30 * DAY_MS,
      tracesMs: 30 * DAY_MS,
    });
    expect(OBS_CAPS).toEqual({ metricPoints: 250_000, spans: 100_000 });
  });

  it('keeps a 1-minute point at the 48-hour cutoff and deletes one a millisecond older', async () => {
    const { app } = await boot();
    const cutoff = NOW - OBS_RETENTION.minutePointsMs;
    const kept = await point(app, MINUTE_MS, cutoff);
    await point(app, MINUTE_MS, cutoff - 1);
    // An hour point as old is well inside its own 30 days.
    const hour = await point(app, HOUR_MS, cutoff - 1);
    const result = await pruneObservability(app.db, { now: NOW });
    expect(result).toEqual({ points: 1, traces: 0, spans: 0 });
    expect(await seriesOf(app)).toEqual([kept, hour].sort());
  });

  it('keeps a 1-hour point at the 30-day cutoff and deletes one a millisecond older', async () => {
    const { app, a } = await boot();
    const cutoff = NOW - OBS_RETENTION.hourPointsMs;
    const kept = await point(app, HOUR_MS, cutoff, a.userId);
    await point(app, HOUR_MS, cutoff - 1, a.userId);
    const result = await pruneObservability(app.db, { now: NOW });
    expect(result).toEqual({ points: 1, traces: 0, spans: 0 });
    expect(await seriesOf(app)).toEqual([kept]);
  });

  it('keeps a trace at the 30-day cutoff and deletes an older one with all its spans', async () => {
    const { app, a } = await boot();
    const cutoff = NOW - OBS_RETENTION.tracesMs;
    const kept = await traceWithSpans(app, a.userId, cutoff, 2);
    await traceWithSpans(app, a.userId, cutoff - 1, 3);
    const result = await pruneObservability(app.db, { now: NOW });
    expect(result).toEqual({ points: 0, traces: 1, spans: 3 });
    expect(await tracesOf(app)).toEqual([kept]);
    expect(await countRows(app, obsSpans)).toBe(2);
  });

  it('deletes past a single batch, and writes nothing when nothing is old', async () => {
    const { app } = await boot();
    for (let i = 0; i < 7; i += 1)
      await point(app, MINUTE_MS, NOW - OBS_RETENTION.minutePointsMs - 1 - i);
    const kept = await point(app, MINUTE_MS, NOW);
    expect(await pruneObservability(app.db, { now: NOW, batchSize: 3 })).toEqual({
      points: 7,
      traces: 0,
      spans: 0,
    });
    expect(await seriesOf(app)).toEqual([kept]);
    expect(await pruneObservability(app.db, { now: NOW, batchSize: 3 })).toEqual({
      points: 0,
      traces: 0,
      spans: 0,
    });
  });
});

describe('pruneObservability: caps (#353)', () => {
  it('deletes the oldest points until the count is at the cap', async () => {
    const { app } = await boot();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await point(app, MINUTE_MS, NOW - (5 - i) * MINUTE_MS));
    const result = await pruneObservability(app.db, {
      now: NOW,
      caps: { metricPoints: 3, spans: 100 },
      batchSize: 1,
    });
    expect(result.points).toBe(2);
    // The two oldest went: ids[0] and ids[1].
    expect(await seriesOf(app)).toEqual(ids.slice(2).sort());
  });

  it('deletes the oldest whole traces until the span count is at or under the cap, never part of one', async () => {
    const { app, a } = await boot();
    await traceWithSpans(app, a.userId, NOW - 3 * HOUR_MS, 3);
    await traceWithSpans(app, a.userId, NOW - 2 * HOUR_MS, 3);
    const newest = await traceWithSpans(app, a.userId, NOW - HOUR_MS, 3);
    // 9 spans, cap 5: the oldest trace (3) is not enough, the middle one goes too, and the
    // newest stays whole although that leaves 3, under the cap.
    const result = await pruneObservability(app.db, {
      now: NOW,
      caps: { metricPoints: 100, spans: 5 },
    });
    expect(result).toEqual({ points: 0, traces: 2, spans: 6 });
    expect(await tracesOf(app)).toEqual([newest]);
    expect(await countRows(app, obsSpans)).toBe(3);
  });

  it('leaves the store alone when it is under both caps', async () => {
    const { app, a } = await boot();
    await point(app, MINUTE_MS, NOW);
    await traceWithSpans(app, a.userId, NOW, 2);
    expect(
      await pruneObservability(app.db, { now: NOW, caps: { metricPoints: 1, spans: 2 } }),
    ).toEqual({ points: 0, traces: 0, spans: 0 });
  });
});

describe('the obs.prune job (#353)', () => {
  it('is registered and scheduled hourly, off the hour', async () => {
    const { app } = await boot();
    expect(OBS_PRUNE_JOB_KIND).toBe('obs.prune');
    expect(OBS_PRUNE_CRON).toBe('23 * * * *');
    expect(getJobHandler(OBS_PRUNE_JOB_KIND)).toBeDefined();
    const schedules = await readSchedules(app.db);
    expect(schedules.find((s) => s.kind === OBS_PRUNE_JOB_KIND)?.schedule).toMatchObject({
      cron: '23 * * * *',
      enabled: true,
    });
  });

  it('runs whether or not collection is on: old rows still age out with it off', async () => {
    const { app } = await boot();
    await point(app, MINUTE_MS, Date.now() - OBS_RETENTION.minutePointsMs - HOUR_MS);
    const handler = getJobHandler(OBS_PRUNE_JOB_KIND);
    let result: unknown;
    await handler?.run(app.db, {}, {
      setResult: async (r: unknown) => void (result = r),
    } as never);
    expect(result).toEqual({ points: 1, traces: 0, spans: 0 });
    expect(await countRows(app, obsMetricPoints)).toBe(0);
  });
});
