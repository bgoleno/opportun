// The Collect switch (design.md 14.1, 14.11; https://github.com/bgoleno/opportun/issues/353). Off
// by default (the owner's spec): with it off nothing reaches the telemetry tables and no
// exporter attaches, which these tests show by counting rows before and after driving every
// base entry point. Turned on by an admin, collection starts at once, with no restart.
import { context, trace, TraceFlags } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditLog, jobs, obsMetricPoints, obsSpans, obsTraces, settings } from '../src/db/schema';
import { enqueue } from '../src/jobs/runner';
import {
  attachedExporters,
  attachExporter,
  flushNow,
  isCollecting,
  obs,
  setCollecting,
  type MetricExportSink,
} from '../src/obs';
import { OBS_COLLECT_KEY, readCollect, startObsFromSettings } from '../src/obs/config';
import { observeOutbound } from '../src/obs/outbound';
import { useApi } from './api';
import { countRows } from './db';
import { useTestContextManager } from './otelContext';

const boot = useApi();
useTestContextManager();
type App = Awaited<ReturnType<typeof boot>>['app'];

afterEach(async () => {
  await setCollecting(false);
});

const TABLES = [obsMetricPoints, obsTraces, obsSpans] as const;

async function telemetryRows(app: App): Promise<number[]> {
  return Promise.all(TABLES.map((t) => countRows(app, t)));
}

function sink(): MetricExportSink & { values: number[] } {
  const values: number[] = [];
  return { values, record: (_m, v) => values.push(v), shutdown: async () => undefined };
}

/** Every entry point the base has, each called as a later slice will call it. */
async function driveEverything(app: App, userId: string) {
  obs.record('http.server.request.duration', 0.02, {
    'http.request.method': 'GET',
    'http.route': '/api/v1/opportunities',
    'http.response.status_code': 200,
  });
  obs.record('opportun.job.duration', 1.5, { 'opportun.job.outcome': 'done' });
  await obs.span('http.client', { 'http.request.method': 'GET' }, async (s) => {
    s.set({ 'http.response.status_code': 200 });
  });
  obs.event('error', { 'error.type': 'TypeError' }, { userId });
  await observeOutbound(
    { target: 'public_site', method: 'GET', url: 'https://example.com/jobs/1' },
    async () => new Response('ok', { status: 200 }),
  );
  const parent = trace.setSpanContext(context.active(), {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    traceFlags: TraceFlags.SAMPLED,
  });
  await context.with(parent, () =>
    enqueue(app.db, 'test.obs-collect', {}, { continueTrace: true, runAt: Date.now() + 3600_000 }),
  );
  await flushNow();
}

describe('Collect off, the default (#353)', () => {
  it('is off on a new instance: no setting row, and nothing collecting', async () => {
    const { app } = await boot();
    expect(isCollecting()).toBe(false);
    expect(await readCollect(app.db)).toBe(false);
    const row = await app.db.select().from(settings).all();
    expect(row.map((r) => r.key)).not.toContain(OBS_COLLECT_KEY);
  });

  it('writes no telemetry row, whatever is driven, and makes no trace context', async () => {
    const { app, a } = await boot();
    expect(await telemetryRows(app)).toEqual([0, 0, 0]);
    await driveEverything(app, a.userId);
    expect(await telemetryRows(app)).toEqual([0, 0, 0]);
    const job = (await app.db.select().from(jobs).all()).find((j) => j.kind === 'test.obs-collect');
    expect(job?.traceContext).toBeNull();
  });

  it('attaches no exporter', async () => {
    await boot();
    const s = sink();
    expect(attachExporter('metrics', s)).toBe(false);
    obs.record('opportun.job.duration', 1, { 'opportun.job.outcome': 'done' });
    expect(attachedExporters()).toEqual([]);
    expect(s.values).toEqual([]);
  });

  it('costs one check per call: 100,000 disabled calls stay under a wide bound (14.11)', async () => {
    await boot();
    const attrs = { 'opportun.job.outcome': 'done' } as const;
    const started = performance.now();
    for (let i = 0; i < 100_000; i += 1) {
      obs.record('opportun.job.duration', 1, attrs);
      obs.event('error', { 'error.type': 'TypeError' });
    }
    const elapsed = performance.now() - started;
    // About a microsecond a call is the budget; 2 seconds for 200,000 is a wide margin that
    // still fails if a disabled call starts gating, aggregating or logging.
    expect(elapsed).toBeLessThan(2_000);
    let ran = 0;
    for (let i = 0; i < 1_000; i += 1)
      await obs.span('http.client', {}, async () => void (ran += 1));
    expect(ran).toBe(1_000);
  });

  it('writes no event to the log', async () => {
    const { app } = await boot();
    const info = vi.spyOn(app.log, 'info');
    obs.event('error', { 'error.type': 'TypeError' });
    expect(info).not.toHaveBeenCalled();
  });
});

describe('turning Collect on and off (#353)', () => {
  it('an admin turns it on with no restart, and points are written from then on', async () => {
    const { app, a } = await boot();
    const put = await a.request({
      method: 'PUT',
      url: '/api/v1/obs/settings',
      payload: { collect: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ collect: true });
    expect(isCollecting()).toBe(true);

    await driveEverything(app, a.userId);
    // Points for the server metric, the job metric and the outbound request: each a minute row
    // and an hour row. Spans are not stored until FR-T4 part 2 registers a provider.
    const points = await app.db.select().from(obsMetricPoints).all();
    expect(new Set(points.map((p) => p.metric))).toEqual(
      new Set([
        'http.server.request.duration',
        'opportun.job.duration',
        'http.client.request.duration',
      ]),
    );
    expect(points).toHaveLength(6);
    expect(await countRows(app, obsTraces)).toBe(0);

    const audits = await app.db.select().from(auditLog).all();
    // sec's O6 on #352: audited, the acting admin recorded; no re-confirmation (nothing leaves).
    expect(audits.filter((r) => r.event === 'telemetry.collect.updated')).toEqual([
      expect.objectContaining({ userId: a.userId, detail: { enabled: true } }),
    ]);
  });

  it('turning it off stops collection at once and shuts every exporter down', async () => {
    const { app, a } = await boot();
    await a.request({ method: 'PUT', url: '/api/v1/obs/settings', payload: { collect: true } });
    let shut = false;
    const s = { ...sink(), shutdown: async () => void (shut = true) };
    expect(attachExporter('metrics', s)).toBe(true);
    obs.record('opportun.job.duration', 1, { 'opportun.job.outcome': 'done' });
    expect(s.values).toEqual([1]);

    const off = await a.request({
      method: 'PUT',
      url: '/api/v1/obs/settings',
      payload: { collect: false },
    });
    expect(off.json()).toEqual({ collect: false });
    expect(isCollecting()).toBe(false);
    expect(shut).toBe(true);
    expect(attachedExporters()).toEqual([]);
    // What waited unflushed when it went off is not written, and nothing after.
    obs.record('opportun.job.duration', 2, { 'opportun.job.outcome': 'done' });
    await flushNow();
    expect(await telemetryRows(app)).toEqual([0, 0, 0]);
  });

  it('only an admin may change it; anyone signed in may read it', async () => {
    const { app, b } = await boot();
    const put = await b.request({
      method: 'PUT',
      url: '/api/v1/obs/settings',
      payload: { collect: true },
    });
    expect(put.statusCode).toBe(403);
    expect(isCollecting()).toBe(false);
    expect(await readCollect(app.db)).toBe(false);
    const get = await b.request({ method: 'GET', url: '/api/v1/obs/settings' });
    expect(get.json()).toEqual({ collect: false });
    const anon = await app.inject({ method: 'GET', url: '/api/v1/obs/settings' });
    expect(anon.statusCode).toBe(401);
  });

  it('a stored Collect on is applied at boot (the call app.ts makes)', async () => {
    const { app } = await boot();
    await app.db
      .insert(settings)
      .values({ key: OBS_COLLECT_KEY, userId: null, value: true, updatedAt: Date.now() })
      .run();
    expect(isCollecting()).toBe(false);
    await startObsFromSettings(app.db, app.log, { demo: false });
    expect(isCollecting()).toBe(true);
  });
});

describe('Collect on the demo deployment (#353, sec O2 on #359)', () => {
  it('cannot be changed by anyone, either way: 403 unavailable_on_demo, no row, no audit; GET answers', async () => {
    // The demo's admin account is public, so any visitor could otherwise turn collection on.
    const { app, a, b } = await boot({ demo: true });
    for (const client of [a, b]) {
      for (const collect of [true, false]) {
        const res = await client.request({
          method: 'PUT',
          url: '/api/v1/obs/settings',
          payload: { collect },
        });
        expect(res.statusCode, `collect ${collect}`).toBe(403);
        expect(res.json()).toMatchObject({ error: { code: 'unavailable_on_demo' } });
      }
    }
    expect(isCollecting()).toBe(false);
    const keys = (await app.db.select().from(settings).all()).map((r) => r.key);
    expect(keys).not.toContain(OBS_COLLECT_KEY);
    const audits = await app.db.select().from(auditLog).all();
    expect(audits.filter((r) => r.event === 'telemetry.collect.updated')).toEqual([]);
    const get = await a.request({ method: 'GET', url: '/api/v1/obs/settings' });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ collect: false });
  });
});
