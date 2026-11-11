// The HTTP route boundary (design.md 14.2, 14.4, 14.9; https://github.com/bgoleno/opportun/issues/343):
// plugins/obsHttp.ts records http.server.request.duration for every request, by route template
// (never the URL), method and status, with error.type on a 5xx; a SERVER span for /api/v1 only,
// whose context survives body parsing; and one `error` event per 5xx, linked to the trace.
import { context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { obsMetricPoints } from '../src/db/schema';
import { flushNow, obs, setCollecting } from '../src/obs';
import { MINUTE_MS } from '../src/obs/metrics';
import { obsHttpPlugin } from '../src/plugins/obsHttp';
import { useApi } from './api';
import { useInMemoryTracing } from './otelProvider';

const boot = useApi();
const exporter = useInMemoryTracing();
type App = Awaited<ReturnType<typeof boot>>['app'];

const bare: FastifyInstance[] = [];
afterEach(async () => {
  await setCollecting(false);
  await Promise.all(bare.splice(0).map((s) => s.close()));
});

async function serverPoints(app: App) {
  await flushNow();
  return (
    await app.db
      .select()
      .from(obsMetricPoints)
      .where(eq(obsMetricPoints.metric, 'http.server.request.duration'))
      .all()
  ).filter((p) => p.resolution === MINUTE_MS);
}

/** A bare Fastify with only the plugin and routes that fail on purpose. */
async function bareServer(): Promise<FastifyInstance> {
  const s = Fastify();
  bare.push(s);
  await s.register(obsHttpPlugin);
  s.get('/api/v1/boom/:id', async () => {
    throw new TypeError('could not reach jane.doe@example.com');
  });
  s.get('/api/v1/unavailable', async (_req, reply) => reply.code(503).send({ ok: false }));
  s.post('/api/v1/echo', async () => {
    // The handler's own span must be a child of the request's, after the body was parsed.
    await obs.span('http.client', { 'http.request.method': 'GET' }, async () => undefined);
    return { ok: true };
  });
  await s.ready();
  return s;
}

describe('the HTTP metric (#343)', () => {
  it('names the route template, never the URL, its ids or its query', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    const id = '0193f3c2-7b1a-7c3e-9a2b-1c2d3e4f5a6b';
    await a.request({ method: 'GET', url: `/api/v1/opportunities/${id}` });
    await a.request({ method: 'GET', url: '/api/v1/opportunities?q=jane.doe@example.com' });
    const points = await serverPoints(app);
    const routes = points.map((p) => p.attributes['http.route']).sort();
    expect(routes).toEqual(['/api/v1/opportunities', '/api/v1/opportunities/:id']);
    const text = JSON.stringify(points);
    expect(text).not.toContain(id);
    expect(text).not.toContain('jane');
    expect(points.every((p) => p.attributes['http.request.method'] === 'GET')).toBe(true);
  });

  it('records every request, a span only under /api/v1, and _OTHER for no route', async () => {
    const { app } = await boot();
    await setCollecting(true);
    await app.inject({ method: 'GET', url: '/healthz' });
    await app.inject({ method: 'GET', url: '/api/v1/no/such/route/123' });
    const points = await serverPoints(app);
    expect(
      points
        .map((p) => [p.attributes['http.route'], p.attributes['http.response.status_code']])
        .sort(),
    ).toEqual([
      ['/healthz', 200],
      ['_OTHER', 404],
    ]);
    // A 4xx is the client's error, not the server's: no error.type (the HTTP conventions).
    expect(points.some((p) => 'error.type' in p.attributes)).toBe(false);
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toEqual(['GET _OTHER']);
  });

  it('a thrown error is a 5xx with its class as error.type, a failed span, and one error event in its trace', async () => {
    const { app } = await boot();
    await setCollecting(true);
    const s = await bareServer();
    const info = vi.spyOn(app.log, 'info');
    const res = await s.inject({ method: 'GET', url: '/api/v1/boom/42' });
    expect(res.statusCode).toBe(500);

    const [point] = await serverPoints(app);
    expect(point?.attributes).toEqual({
      'http.request.method': 'GET',
      'http.route': '/api/v1/boom/:id',
      'http.response.status_code': 500,
      'error.type': 'TypeError',
    });
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('GET /api/v1/boom/:id');
    expect(span?.kind).toBe(SpanKind.SERVER);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes['error.type']).toBe('TypeError');

    const events = info.mock.calls.filter(([rec]) => (rec as { event?: string }).event === 'error');
    expect(events).toHaveLength(1);
    expect(events[0]?.[0]).toEqual({
      event: 'error',
      'error.type': 'TypeError',
      'http.route': '/api/v1/boom/:id',
      trace_id: span?.spanContext().traceId,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('jane');
  });

  it('a 5xx sent without a throw gets its status as error.type', async () => {
    const { app } = await boot();
    await setCollecting(true);
    const s = await bareServer();
    await s.inject({ method: 'GET', url: '/api/v1/unavailable' });
    const [point] = await serverPoints(app);
    expect(point?.attributes['error.type']).toBe('503');
  });

  it("keeps the request's context through body parsing, so the handler's spans are its children", async () => {
    await boot();
    await setCollecting(true);
    const s = await bareServer();
    const res = await s.inject({ method: 'POST', url: '/api/v1/echo', payload: { a: 1 } });
    expect(res.statusCode).toBe(200);
    const spans = exporter.getFinishedSpans();
    const server = spans.find((x) => x.kind === SpanKind.SERVER);
    const client = spans.find((x) => x.kind === SpanKind.CLIENT);
    expect(client?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId);
    expect(client?.spanContext().traceId).toBe(server?.spanContext().traceId);
    // Nothing leaks into the next request: outside it, no span is active.
    expect(context.active()).toBeDefined();
  });

  it('with collection off: no point, no span, no event', async () => {
    const { app } = await boot();
    const s = await bareServer();
    const info = vi.spyOn(app.log, 'info');
    await s.inject({ method: 'GET', url: '/api/v1/boom/1' });
    await app.inject({ method: 'GET', url: '/healthz' });
    expect(await serverPoints(app)).toEqual([]);
    expect(exporter.getFinishedSpans()).toEqual([]);
    expect(info.mock.calls.some(([rec]) => (rec as { event?: string }).event === 'error')).toBe(
      false,
    );
  });
});
