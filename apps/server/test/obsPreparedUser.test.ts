// Prepared records for a user's metrics (https://github.com/bgoleno/opportun/issues/374, tl's 2b):
// recordGenAiMetrics records four Gen AI metrics per call whose attributes repeat per user, task,
// model and provider, so it gates them once and reuses them, as the HTTP and database boundaries
// do. A prepared user record keeps its owner: the point is the user's, in the same series an
// ordinary obs.record() would write, and export still never sees the user.
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { obsMetricPoints } from '../src/db/schema';
import {
  clearGenAiPrepared,
  GEN_AI_PREPARED_MAX,
  genAiPreparedCount,
  recordGenAiMetrics,
} from '../src/lib/ai';
import { flushNow, obs, prepareRecord, recordPrepared, setCollecting } from '../src/obs';
import { MINUTE_MS } from '../src/obs/metrics';
import { useApi } from './api';

const boot = useApi();
afterEach(async () => {
  await setCollecting(false);
  clearGenAiPrepared();
});

const ATTRS = {
  'gen_ai.operation.name': 'chat',
  'gen_ai.provider.name': 'anthropic',
  'opportun.ai.provider': 'anthropic',
  'gen_ai.request.model': 'claude-sonnet-5-5',
  'opportun.ai.task': 'resume.tailor',
  'opportun.ai.feature': 'resume_tailoring',
  'gen_ai.token.modality': 'text',
};

async function points(app: Awaited<ReturnType<typeof boot>>['app'], metric: string) {
  await flushNow();
  return (
    await app.db.select().from(obsMetricPoints).where(eq(obsMetricPoints.metric, metric)).all()
  ).filter((p) => p.resolution === MINUTE_MS);
}

describe('a prepared record for a user metric (#374)', () => {
  it("records into the user's own series, the same one obs.record writes", async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    const metric = 'gen_ai.client.inference.usage.input_tokens';
    const prepared = prepareRecord(metric, ATTRS, { userId: a.userId });
    recordPrepared(prepared, 100);
    obs.record(metric, 50, ATTRS, { userId: a.userId });
    const rows = await points(app, metric);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(a.userId);
    expect(rows[0]?.count).toBe(2);
    expect(rows[0]?.sum).toBe(150);
  });

  it("a user metric prepared without its user is refused: a user's point always has one", () => {
    expect(() => prepareRecord('gen_ai.client.inference.usage.input_tokens', ATTRS)).toThrow();
  });
});

describe('recordGenAiMetrics prepares its records (#374)', () => {
  const run = {
    taskKey: 'resume.tailor',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    inputTokens: 100,
    outputTokens: 20,
    estCostUsd: 0.001,
    durationMs: 5,
    status: 'ok',
    error: null,
    fallbackPricing: false,
  } as unknown as Parameters<typeof recordGenAiMetrics>[1];

  it('one entry per user, task, model and provider, however many calls; the points as before', async () => {
    const { app, a, b } = await boot();
    await setCollecting(true);
    clearGenAiPrepared();
    for (let i = 0; i < 10; i += 1) recordGenAiMetrics(a.userId, run);
    expect(genAiPreparedCount()).toBe(1);
    recordGenAiMetrics(b.userId, run);
    expect(genAiPreparedCount()).toBe(2);
    const input = await points(app, 'gen_ai.client.inference.usage.input_tokens');
    expect(input.map((p) => [p.userId, p.count, p.sum]).sort()).toEqual(
      [
        [a.userId, 10, 1000],
        [b.userId, 1, 100],
      ].sort(),
    );
    expect((await points(app, 'opportun.gen_ai.usage.cost')).map((p) => p.count).sort()).toEqual([
      1, 10,
    ]);
  });

  it('a failed call, whose error.type varies, is recorded without the cache', async () => {
    await boot();
    await setCollecting(true);
    clearGenAiPrepared();
    const failed = { ...run, status: 'error', error: 'timeout: the provider did not answer' };
    recordGenAiMetrics('01a1c881-cef3-7b31-86a2-501450372158', failed as typeof run);
    expect(genAiPreparedCount()).toBe(0);
  });

  it('the cache is bounded', () => {
    expect(GEN_AI_PREPARED_MAX).toBeGreaterThanOrEqual(256);
    expect(GEN_AI_PREPARED_MAX).toBeLessThanOrEqual(10_000);
  });
});
