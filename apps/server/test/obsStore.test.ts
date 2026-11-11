// The observability store (design.md 14.6, 14.7; https://github.com/bgoleno/opportun/issues/353):
// the three tables and jobs.trace_context exist on both engines, rows go with their user, the
// data export leaves them out, the job claim returns trace_context, and enqueue writes it only
// when asked to continue the caller's trace.
import { newId } from '@opportun/core';
import { context, trace, TraceFlags } from '@opentelemetry/api';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { claimNextJob } from '../src/db/dialect';
import { jobs, obsMetricPoints, obsSpans, obsTraces, users } from '../src/db/schema';
import { enqueue } from '../src/jobs/runner';
import { EXPORT_EXCLUDED_TABLES } from '../src/lib/exporter';
import { setCollecting } from '../src/obs';
import { useApi } from './api';
import { countRows } from './db';
import { useTestContextManager } from './otelContext';

const boot = useApi();
useTestContextManager();
type App = Awaited<ReturnType<typeof boot>>['app'];

afterEach(async () => {
  await setCollecting(false);
});

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';

async function insertTrace(app: App, userId: string, traceId = TRACE) {
  const now = Date.now();
  await app.db
    .insert(obsTraces)
    .values({
      traceId,
      userId,
      startedAt: now,
      durationMs: 12.5,
      origin: 'POST /api/v1/tailoring/:id/messages',
      status: 'ok',
      updatedAt: now,
    })
    .run();
  await app.db
    .insert(obsSpans)
    .values({
      traceId,
      spanId: SPAN,
      parentSpanId: null,
      userId,
      name: 'chat claude-opus-5-5',
      kind: 'client',
      startedAt: now,
      durationMs: 12.5,
      status: 'ok',
      attributes: { 'gen_ai.operation.name': 'chat' },
      task: 'resume.tailor',
      model: 'claude-opus-5-5',
      provider: 'anthropic',
    })
    .run();
}

async function insertPoint(app: App, userId: string | null) {
  await app.db
    .insert(obsMetricPoints)
    .values({
      series: newId().replace(/-/g, ''),
      metric: 'http.server.request.duration',
      attributes: { 'http.request.method': 'GET' },
      userId,
      resolution: 60_000,
      bucketStart: 0,
      count: 1,
      sum: 0.01,
      min: 0.01,
      max: 0.01,
      bucketCounts: [1, 0],
    })
    .run();
}

describe('the observability tables (#353)', () => {
  it('hold a trace, its span and a point, and give them up with their user', async () => {
    const { app, a, b } = await boot();
    await insertTrace(app, a.userId);
    await insertPoint(app, a.userId);
    await insertPoint(app, null);
    await insertTrace(app, b.userId, '1af7651916cd43dd8448eb211c80319c');
    expect(await countRows(app, obsTraces)).toBe(2);
    expect(await countRows(app, obsSpans)).toBe(2);
    expect(await countRows(app, obsMetricPoints)).toBe(2);

    await app.db.delete(users).where(eq(users.id, a.userId)).run();
    // a's trace, span and point are gone; b's trace and the instance's point stay.
    expect(await countRows(app, obsTraces)).toBe(1);
    expect(await countRows(app, obsSpans)).toBe(1);
    const left = await app.db.select().from(obsMetricPoints).all();
    expect(left.map((p) => p.userId)).toEqual([null]);
  });

  it("a trace's spans go with it", async () => {
    const { app, a } = await boot();
    await insertTrace(app, a.userId);
    await app.db.delete(obsTraces).where(eq(obsTraces.traceId, TRACE)).run();
    expect(await countRows(app, obsSpans)).toBe(0);
  });

  it('are left out of the data export', () => {
    for (const t of ['obs_metric_points', 'obs_traces', 'obs_spans']) {
      expect(EXPORT_EXCLUDED_TABLES, t).toContain(t);
    }
  });
});

describe('jobs.trace_context (#353)', () => {
  it('is returned by the claim', async () => {
    const { app } = await boot();
    const id = await enqueue(app.db, 'test.obs-claim', {}, { runAt: 0 });
    const parent = `00-${TRACE}-${SPAN}-01`;
    await app.db.update(jobs).set({ traceContext: parent }).where(eq(jobs.id, id)).run();
    const claimed = await claimNextJob(app.db, 'w1', Date.now());
    expect(claimed).toMatchObject({ id, traceContext: parent });
  });

  it('is empty unless the caller asks to continue its trace, and collection is on', async () => {
    const { app } = await boot();
    const parent = trace.setSpanContext(context.active(), {
      traceId: TRACE,
      spanId: SPAN,
      traceFlags: TraceFlags.SAMPLED,
    });
    const traceOf = async (id: string) =>
      (await app.db.select().from(jobs).where(eq(jobs.id, id)).get())?.traceContext;

    // Collection off: never, even when asked.
    const off = await context.with(parent, () =>
      enqueue(app.db, 'test.obs-continue', {}, { continueTrace: true }),
    );
    expect(await traceOf(off)).toBeNull();

    await setCollecting(true);
    const notAsked = await context.with(parent, () => enqueue(app.db, 'test.obs-continue', {}));
    expect(await traceOf(notAsked)).toBeNull();
    const asked = await context.with(parent, () =>
      enqueue(app.db, 'test.obs-continue', {}, { continueTrace: true }),
    );
    expect(await traceOf(asked)).toBe(`00-${TRACE}-${SPAN}-01`);
    // No active span: nothing to continue.
    const none = await enqueue(app.db, 'test.obs-continue', {}, { continueTrace: true });
    expect(await traceOf(none)).toBeNull();
  });

  it('a deduped enqueue leaves the queued job its own context', async () => {
    const { app } = await boot();
    await setCollecting(true);
    const first = trace.setSpanContext(context.active(), {
      traceId: TRACE,
      spanId: SPAN,
      traceFlags: TraceFlags.SAMPLED,
    });
    const second = trace.setSpanContext(context.active(), {
      traceId: '2af7651916cd43dd8448eb211c80319c',
      spanId: 'c7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
    });
    const opts = { dedupeKey: 'k', continueTrace: true };
    const id = await context.with(first, () => enqueue(app.db, 'test.obs-dedupe', {}, opts));
    const again = await context.with(second, () => enqueue(app.db, 'test.obs-dedupe', {}, opts));
    expect(again).toBe(id);
    const row = await app.db.select().from(jobs).where(eq(jobs.id, id)).get();
    expect(row?.traceContext).toBe(`00-${TRACE}-${SPAN}-01`);
  });
});
