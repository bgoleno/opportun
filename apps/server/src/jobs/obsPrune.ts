// Pruning the observability store (design.md 14.7, 14.11; issue
// https://github.com/bgoleno/opportun/issues/353). Hourly, it deletes by age and then enforces the
// row caps:
//
//   1-minute metric points: kept 48 hours;   1-hour metric points: kept 30 days;
//   traces, with their spans: kept 30 days;
//   at most 250,000 metric point rows and 100,000 span rows.
//
// Age is "strictly older than": a row whose bucket or trace started exactly at the cutoff stays
// one more hour. Points are aged by their bucket's start, traces by their start; a trace's spans
// go with it (obs_spans.trace_id cascades), and spans are also aged on their own start, so a span
// whose trace row was lost cannot outlive the window.
//
// The caps delete the oldest first: the oldest points, and the oldest whole traces (never part
// of one), until the count is under the cap. Batched like jobs.prune (jobs/jobPrune.ts), so a
// large first run does not hold the SQLite write gate for the whole backlog.
//
// It runs whether or not collection is on: rows written while it was on still age out after it
// is turned off (14.1). With nothing to delete it deletes nothing, but the scheduler still writes
// its hourly `jobs` row, as for every scheduled job, and jobs.prune removes those later. So with
// collection off the instance writes no telemetry, not nothing at all (NFR-OPS7).
import { and, asc, count, eq, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { obsMetricPoints, obsSpans, obsTraces } from '../db/schema';
import { HOUR_MS, MINUTE_MS } from '../obs/metrics';
import { runSuppressed } from '../obs';
import type { JobHandler } from './registry';

export const OBS_PRUNE_JOB_KIND = 'obs.prune';
/** Hourly, off the hour so it does not land with the nightly jobs' 03:00 and 04:00 starts. */
export const OBS_PRUNE_CRON = '23 * * * *';

const DAY_MS = 24 * HOUR_MS;
export const OBS_RETENTION = {
  minutePointsMs: 48 * HOUR_MS,
  hourPointsMs: 30 * DAY_MS,
  tracesMs: 30 * DAY_MS,
} as const;
export const OBS_CAPS = { metricPoints: 250_000, spans: 100_000 } as const;
const BATCH_SIZE = 500;

export interface ObsPruneResult {
  points: number;
  traces: number;
  spans: number;
}

export interface ObsPruneOptions {
  now?: number;
  /** Overrides for tests; production uses OBS_CAPS and BATCH_SIZE. */
  caps?: { metricPoints: number; spans: number };
  batchSize?: number;
}

/** Deletes points of one resolution whose bucket started before `cutoff`, a batch at a time. */
async function prunePoints(db: Db, resolution: number, cutoff: number, batch: number) {
  let total = 0;
  for (;;) {
    const rows = await db
      .select({ series: obsMetricPoints.series, bucketStart: obsMetricPoints.bucketStart })
      .from(obsMetricPoints)
      .where(
        and(eq(obsMetricPoints.resolution, resolution), lt(obsMetricPoints.bucketStart, cutoff)),
      )
      .limit(batch)
      .all();
    if (rows.length === 0) break;
    total += await deletePoints(db, resolution, rows);
    if (rows.length < batch) break;
  }
  return total;
}

async function deletePoints(
  db: Db,
  resolution: number,
  rows: { series: string; bucketStart: number }[],
): Promise<number> {
  let n = 0;
  // Grouped by bucket start: one delete per start, by its series ids.
  const byStart = new Map<number, string[]>();
  for (const r of rows)
    byStart.set(r.bucketStart, [...(byStart.get(r.bucketStart) ?? []), r.series]);
  for (const [start, series] of byStart) {
    const gone = await db
      .delete(obsMetricPoints)
      .where(
        and(
          eq(obsMetricPoints.resolution, resolution),
          eq(obsMetricPoints.bucketStart, start),
          inArray(obsMetricPoints.series, series),
        ),
      )
      .returning({ series: obsMetricPoints.series })
      .all();
    n += gone.length;
  }
  return n;
}

async function deleteTraces(db: Db, ids: string[]): Promise<{ traces: number; spans: number }> {
  if (ids.length === 0) return { traces: 0, spans: 0 };
  // Spans first, explicitly: the cascade would do it, but the count is part of the result.
  const spans = await db
    .delete(obsSpans)
    .where(inArray(obsSpans.traceId, ids))
    .returning({ spanId: obsSpans.spanId })
    .all();
  const traces = await db
    .delete(obsTraces)
    .where(inArray(obsTraces.traceId, ids))
    .returning({ traceId: obsTraces.traceId })
    .all();
  return { traces: traces.length, spans: spans.length };
}

async function pruneOldTraces(db: Db, cutoff: number, batch: number) {
  const out = { traces: 0, spans: 0 };
  for (;;) {
    const ids = (
      await db
        .select({ id: obsTraces.traceId })
        .from(obsTraces)
        .where(lt(obsTraces.startedAt, cutoff))
        .limit(batch)
        .all()
    ).map((r) => r.id);
    const gone = await deleteTraces(db, ids);
    out.traces += gone.traces;
    out.spans += gone.spans;
    if (ids.length < batch) break;
  }
  // Spans past the window whose trace row is already gone.
  const strays = await db
    .delete(obsSpans)
    .where(lt(obsSpans.startedAt, cutoff))
    .returning({ spanId: obsSpans.spanId })
    .all();
  out.spans += strays.length;
  return out;
}

async function enforcePointCap(db: Db, cap: number, batch: number): Promise<number> {
  let total = 0;
  for (;;) {
    const n = (await db.select({ n: count() }).from(obsMetricPoints).get())?.n ?? 0;
    const over = Number(n) - cap;
    if (over <= 0) break;
    const rows = await db
      .select({
        series: obsMetricPoints.series,
        bucketStart: obsMetricPoints.bucketStart,
        resolution: obsMetricPoints.resolution,
      })
      .from(obsMetricPoints)
      .orderBy(asc(obsMetricPoints.bucketStart), asc(obsMetricPoints.series))
      .limit(Math.min(over, batch))
      .all();
    for (const resolution of [MINUTE_MS, HOUR_MS]) {
      total += await deletePoints(
        db,
        resolution,
        rows.filter((r) => r.resolution === resolution),
      );
    }
  }
  return total;
}

async function enforceSpanCap(db: Db, cap: number, batch: number) {
  const out = { traces: 0, spans: 0 };
  for (;;) {
    const n = Number((await db.select({ n: count() }).from(obsSpans).get())?.n ?? 0);
    if (n <= cap) break;
    // The oldest trace goes whole, even if that takes the count further under the cap than
    // needed: a trace with part of its spans would draw a wrong waterfall.
    const ids = (
      await db
        .select({ id: obsTraces.traceId })
        .from(obsTraces)
        .orderBy(asc(obsTraces.startedAt), asc(obsTraces.traceId))
        .limit(Math.min(batch, 50))
        .all()
    ).map((r) => r.id);
    if (ids.length === 0) break;
    // One trace at a time, so no more is deleted than the cap asks for.
    for (const id of ids) {
      const gone = await deleteTraces(db, [id]);
      out.traces += gone.traces;
      out.spans += gone.spans;
      const left = Number((await db.select({ n: count() }).from(obsSpans).get())?.n ?? 0);
      if (left <= cap) return out;
    }
  }
  return out;
}

export async function pruneObservability(
  db: Db,
  opts: ObsPruneOptions = {},
): Promise<ObsPruneResult> {
  const now = opts.now ?? Date.now();
  const caps = opts.caps ?? OBS_CAPS;
  const batch = opts.batchSize ?? BATCH_SIZE;
  return runSuppressed(async () => {
    let points = await prunePoints(db, MINUTE_MS, now - OBS_RETENTION.minutePointsMs, batch);
    points += await prunePoints(db, HOUR_MS, now - OBS_RETENTION.hourPointsMs, batch);
    const aged = await pruneOldTraces(db, now - OBS_RETENTION.tracesMs, batch);
    points += await enforcePointCap(db, caps.metricPoints, batch);
    const capped = await enforceSpanCap(db, caps.spans, batch);
    return {
      points,
      traces: aged.traces + capped.traces,
      spans: aged.spans + capped.spans,
    };
  });
}

export const obsPruneJob: JobHandler<Record<string, never>> = {
  kind: OBS_PRUNE_JOB_KIND,
  payloadSchema: z.object({}).strict() as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    await ctx.setResult(await pruneObservability(db));
  },
};
