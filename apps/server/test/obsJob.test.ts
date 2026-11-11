// The background job boundary (design.md 14.2, 14.6, 14.9; https://github.com/bgoleno/opportun/issues/343):
// the whole of processJob records opportun.job.duration by kind and outcome, including a job
// that dies before its handler runs, inside a `job {kind}` span that continues the trace in
// jobs.trace_context (CONSUMER) or starts a new one (INTERNAL); a failure writes one `error`
// event with the job's kind and trace id, never the error's message.
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { jobs, obsMetricPoints } from '../src/db/schema';
import { registerJob, unregisterJob } from '../src/jobs/registry';
import { enqueue, runDueJobs } from '../src/jobs/runner';
import { flushNow, setCollecting } from '../src/obs';
import { MINUTE_MS } from '../src/obs/metrics';
import { useApi } from './api';
import { useInMemoryTracing } from './otelProvider';

const boot = useApi();
const exporter = useInMemoryTracing();
type App = Awaited<ReturnType<typeof boot>>['app'];

const OK = 'test.obs-job-ok';
const FAIL = 'test.obs-job-fail';
let failWith: Error = new TypeError('could not reach jane.doe@example.com');

registerJob({
  kind: OK,
  payloadSchema: z.object({ n: z.number() }),
  maxAttempts: 3,
  run: async () => undefined,
});
registerJob({
  kind: FAIL,
  payloadSchema: z.object({}),
  maxAttempts: 2,
  run: async () => {
    throw failWith;
  },
});

afterEach(async () => {
  await setCollecting(false);
});

async function jobPoints(app: App) {
  await flushNow();
  return (
    await app.db
      .select()
      .from(obsMetricPoints)
      .where(eq(obsMetricPoints.metric, 'opportun.job.duration'))
      .all()
  )
    .filter((p) => p.resolution === MINUTE_MS)
    .map((p) => ({ ...p.attributes, count: p.count }));
}

describe('the job metric and span (#343)', () => {
  it('a job that succeeds: outcome done, a new INTERNAL trace named by its kind', async () => {
    const { app } = await boot();
    await setCollecting(true);
    await enqueue(app.db, OK, { n: 1 });
    await runDueJobs(app.db);
    expect(await jobPoints(app)).toEqual([
      { 'opportun.job.kind': OK, 'opportun.job.outcome': 'done', count: 1 },
    ]);
    const [span] = exporter.getFinishedSpans().filter((s) => s.name.startsWith('job '));
    expect(span?.name).toBe(`job ${OK}`);
    expect(span?.kind).toBe(SpanKind.INTERNAL);
    expect(span?.parentSpanContext).toBeUndefined();
    expect(span?.attributes['opportun.job.outcome']).toBe('done');
  });

  it('a failing job: retry, then dead, with its class as error.type and one error event per failure', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    failWith = new TypeError('could not reach jane.doe@example.com');
    const info = vi.spyOn(app.log, 'info');
    await enqueue(app.db, FAIL, {}, { userId: a.userId });
    await runDueJobs(app.db);
    // Retried later: run the second attempt now.
    await app.db.update(jobs).set({ runAt: 0 }).where(eq(jobs.kind, FAIL)).run();
    await runDueJobs(app.db);

    const points = await jobPoints(app);
    expect(points).toEqual(
      expect.arrayContaining([
        {
          'opportun.job.kind': FAIL,
          'opportun.job.outcome': 'retry',
          'error.type': 'TypeError',
          count: 1,
        },
        {
          'opportun.job.kind': FAIL,
          'opportun.job.outcome': 'dead',
          'error.type': 'TypeError',
          count: 1,
        },
      ]),
    );
    expect(points).toHaveLength(2);
    const spans = exporter.getFinishedSpans().filter((s) => s.name === `job ${FAIL}`);
    expect(spans.map((s) => s.status.code)).toEqual([SpanStatusCode.ERROR, SpanStatusCode.ERROR]);

    const events = info.mock.calls
      .map(([rec]) => rec as Record<string, unknown>)
      .filter((r) => r.event === 'error');
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      event: 'error',
      'error.type': 'TypeError',
      'opportun.job.kind': FAIL,
      'user.id': a.userId,
      trace_id: spans[0]?.spanContext().traceId,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('jane');
  });

  it('a job that dies before its handler runs is counted: no handler, or a payload that no longer validates', async () => {
    const { app } = await boot();
    await setCollecting(true);
    await enqueue(app.db, 'test.obs-job-unregistered', {});
    const bad = await enqueue(app.db, OK, { n: 1 });
    await app.db
      .update(jobs)
      .set({ payload: { n: 'not a number' } })
      .where(eq(jobs.id, bad))
      .run();
    await runDueJobs(app.db);
    expect(await jobPoints(app)).toEqual(
      expect.arrayContaining([
        // An unregistered kind is not on the list: _OTHER, so a stray row adds no series.
        {
          'opportun.job.kind': '_OTHER',
          'opportun.job.outcome': 'dead',
          'error.type': 'no_handler',
          count: 1,
        },
        {
          'opportun.job.kind': OK,
          'opportun.job.outcome': 'dead',
          'error.type': 'invalid_payload',
          count: 1,
        },
      ]),
    );
  });

  it('continues the trace in jobs.trace_context as a CONSUMER child; a malformed one starts a new trace', async () => {
    const { app } = await boot();
    await setCollecting(true);
    const TRACE = '0af7651916cd43dd8448eb211c80319c';
    const SPAN = 'b7ad6b7169203331';
    const kept = await enqueue(app.db, OK, { n: 1 });
    await app.db
      .update(jobs)
      .set({ traceContext: `00-${TRACE}-${SPAN}-01` })
      .where(eq(jobs.id, kept))
      .run();
    await runDueJobs(app.db);
    const [child] = exporter.getFinishedSpans().filter((s) => s.name === `job ${OK}`);
    expect(child?.kind).toBe(SpanKind.CONSUMER);
    expect(child?.spanContext().traceId).toBe(TRACE);
    expect(child?.parentSpanContext?.spanId).toBe(SPAN);
    exporter.reset();

    const odd = await enqueue(app.db, OK, { n: 2 });
    await app.db
      .update(jobs)
      .set({ traceContext: `00-${TRACE}-${SPAN}-01; drop table` })
      .where(eq(jobs.id, odd))
      .run();
    await runDueJobs(app.db);
    const [fresh] = exporter.getFinishedSpans().filter((s) => s.name === `job ${OK}`);
    expect(fresh?.kind).toBe(SpanKind.INTERNAL);
    expect(fresh?.spanContext().traceId).not.toBe(TRACE);
  });

  it('with collection off: the job runs, and no point, span or event is made', async () => {
    const { app } = await boot();
    const info = vi.spyOn(app.log, 'info');
    failWith = new TypeError('x');
    await enqueue(app.db, OK, { n: 1 });
    await enqueue(app.db, FAIL, {});
    expect(await runDueJobs(app.db)).toBe(2);
    expect(await jobPoints(app)).toEqual([]);
    expect(exporter.getFinishedSpans()).toEqual([]);
    expect(info.mock.calls.some(([rec]) => (rec as { event?: string }).event === 'error')).toBe(
      false,
    );
  });
});

afterEach(() => {
  failWith = new TypeError('could not reach jane.doe@example.com');
});

// Keep the registry as other files expect it.
afterAll(() => {
  unregisterJob(OK);
  unregisterJob(FAIL);
});
