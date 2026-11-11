// The HTTP boundary's follow-ups (https://github.com/bgoleno/opportun/issues/371, tl's points on
// https://github.com/bgoleno/opportun/pull/368):
// - the SPA's built files are one route each (routes/spa.ts registers them with wildcard: false),
//   so every hashed asset was a series of its own and each deploy added more; they share one
//   http.route label now;
// - a request the client aborts recorded no metric and never ended its span; onRequestAbort ends
//   both, with no status code (none was sent) and error.type `aborted`.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { obsMetricPoints } from '../src/db/schema';
import { flushNow, setCollecting } from '../src/obs';
import { MINUTE_MS } from '../src/obs/metrics';
import { obsHttpPlugin, SPA_ASSET_ROUTE } from '../src/plugins/obsHttp';
import { spaRoutes } from '../src/routes/spa';
import { useApi } from './api';
import { useInMemoryTracing } from './otelProvider';

const boot = useApi();
const exporter = useInMemoryTracing();
const servers: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await setCollecting(false);
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function serverPoints(app: Awaited<ReturnType<typeof boot>>['app']) {
  await flushNow();
  return (
    await app.db
      .select()
      .from(obsMetricPoints)
      .where(eq(obsMetricPoints.metric, 'http.server.request.duration'))
      .all()
  )
    .filter((p) => p.resolution === MINUTE_MS)
    .map((p): Record<string, unknown> => ({ ...p.attributes, count: p.count }));
}

describe("the SPA's built files share one route label (#371)", () => {
  it('two hashed assets are one series, under /assets/*', async () => {
    const { app } = await boot();
    await setCollecting(true);
    const root = await mkdtemp(join(tmpdir(), 'obs-spa-'));
    dirs.push(root);
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html>');
    await writeFile(join(root, 'assets', 'index-3f9a1c0d.js'), 'x');
    await writeFile(join(root, 'assets', 'index-8b7e2a11.css'), 'y');
    const s = Fastify();
    servers.push(s);
    await s.register(obsHttpPlugin);
    await s.register(spaRoutes, { root });
    await s.ready();
    expect((await s.inject({ method: 'GET', url: '/assets/index-3f9a1c0d.js' })).statusCode).toBe(
      200,
    );
    expect((await s.inject({ method: 'GET', url: '/assets/index-8b7e2a11.css' })).statusCode).toBe(
      200,
    );
    const points = await serverPoints(app);
    expect(SPA_ASSET_ROUTE).toBe('/assets/*');
    expect(points.filter((p) => String(p['http.route']).startsWith('/assets'))).toEqual([
      {
        'http.request.method': 'GET',
        'http.route': '/assets/*',
        'http.response.status_code': 200,
        count: 2,
      },
    ]);
  });
});

describe('a request the client aborts is recorded and its span ended (#371)', () => {
  it('onRequestAbort: the metric with error.type aborted and no status, and the span ends', async () => {
    const { app } = await boot();
    await setCollecting(true);
    exporter.reset();
    let release: () => void = () => undefined;
    let arrived: () => void = () => undefined;
    const inHandler = new Promise<void>((r) => {
      arrived = r;
    });
    const s = Fastify();
    servers.push(s);
    await s.register(obsHttpPlugin);
    s.get('/api/v1/slow/:id', async () => {
      arrived();
      await new Promise<void>((r) => {
        release = r;
      });
      return { ok: true };
    });
    await s.listen({ port: 0, host: '127.0.0.1' });
    const port = (s.server.address() as AddressInfo).port;
    const client = httpRequest({ host: '127.0.0.1', port, path: '/api/v1/slow/1', method: 'GET' });
    client.on('error', () => undefined);
    client.end();
    await inHandler;
    client.destroy();
    for (let i = 0; i < 100 && exporter.getFinishedSpans().length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    release();
    const [span] = exporter.getFinishedSpans().filter((x) => x.name === 'GET /api/v1/slow/:id');
    expect(span).toBeDefined();
    expect(span?.attributes['error.type']).toBe('aborted');
    expect(span?.attributes['http.response.status_code']).toBeUndefined();
    const points = (await serverPoints(app)).filter((p) => p['http.route'] === '/api/v1/slow/:id');
    expect(points).toEqual([
      {
        'http.request.method': 'GET',
        'http.route': '/api/v1/slow/:id',
        'error.type': 'aborted',
        count: 1,
      },
    ]);
  });
});
