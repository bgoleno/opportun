// The observability store's leaks (https://github.com/bgoleno/opportun/issues/594, tl's backlog pass):
// the span store's map of kept spans only ever lost its oldest entry at 10,000, so a long
// workflow's root could be pushed out before it ended and was then never stored; a metric flush
// that failed after draining lost its points with nothing counted; and the point cap sorted the
// whole points table by bucket_start with no index leading on it.
import { withUser } from '@opportun/ai';
import { context, SpanKind, trace } from '@opentelemetry/api';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { rawAll } from '../src/db/client';
import { obsMetricPoints } from '../src/db/schema';
import { pointCapQuery } from '../src/jobs/obsPrune';
import { flushNow, obs, setCollecting } from '../src/obs';
import { flushSpans, store } from '../src/obs/tracing';
import { useApi } from './api';
import { testDialect, withFailingInsert } from './db';

const boot = useApi();
afterEach(async () => {
  await setCollecting(false);
});

const MODEL = 'claude-haiku-5-5';

describe("the span store's map of kept spans (#594)", () => {
  it('a span leaves the map when it ends, so a workflow with over 10,000 spans inside keeps its root', async () => {
    const { a } = await boot();
    await setCollecting(true);
    const tracer = trace.getTracer('test');
    const root = withUser(a.userId, () =>
      tracer.startSpan('gen_ai.workflow', {
        attributes: {
          'gen_ai.operation.name': 'invoke_workflow',
          'gen_ai.agent.name': 'test.long',
          'user.id': a.userId,
        },
      }),
    );
    const rootId = root.spanContext().spanId;
    expect(store.isKept(rootId)).toBe(true);
    const under = trace.setSpan(context.active(), root);
    // 10,001 shorter kept spans, each ended before the next starts, flushed as they go.
    for (let batch = 0; batch < 11; batch++) {
      withUser(a.userId, () => {
        for (let i = 0; i < (batch === 10 ? 1 : 1_000); i++) {
          const child = tracer.startSpan(
            `chat ${MODEL}`,
            {
              kind: SpanKind.CLIENT,
              attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': MODEL },
            },
            under,
          );
          expect(store.isKept(child.spanContext().spanId)).toBe(true);
          child.end();
          expect(store.isKept(child.spanContext().spanId), 'gone once ended').toBe(false);
        }
      });
      await flushSpans();
    }
    // Still kept when it ends: before #594 it was the oldest entry and was pushed out.
    expect(store.isKept(rootId)).toBe(true);
    root.end();
    expect(store.isKept(rootId)).toBe(false);
  });
});

describe('a metric flush that fails (#594)', () => {
  it('counts the points it lost as dropped, as the span store counts its own', async () => {
    const { app } = await boot();
    await setCollecting(true);
    obs.record('opportun.job.duration', 0.5, { 'opportun.job.outcome': 'done' });
    const undo = await withFailingInsert(app, 'obs_metric_points');
    await expect(flushNow()).rejects.toThrow();
    await undo();
    await flushNow();
    const dropped = (
      await app.db
        .select()
        .from(obsMetricPoints)
        .where(eq(obsMetricPoints.metric, 'opportun.obs.dropped'))
        .all()
    ).filter((p) => p.attributes['opportun.obs.signal'] === 'metrics' && p.resolution === 60_000);
    expect(dropped.reduce((n, p) => n + p.sum, 0)).toBeGreaterThan(0);
  });
});

describe("the point cap's query (#594)", () => {
  it.skipIf(testDialect !== 'sqlite')(
    'reads the oldest points by an index: no sort of the whole table',
    async () => {
      const { app } = await boot();
      const q = pointCapQuery(app.db, 500).toSQL();
      const params = [...q.params] as number[];
      const inlined = q.sql.replace(/\?/g, () => String(params.shift()));
      const plan = await rawAll<{ detail: string }>(
        app.db,
        sql.raw(`EXPLAIN QUERY PLAN ${inlined}`),
      );
      const text = plan.map((r) => r.detail).join('\n');
      expect(text).toMatch(/USING (COVERING )?INDEX obs_metric_points_bucket_idx/);
      expect(text).not.toMatch(/TEMP B-TREE/);
    },
  );
});
