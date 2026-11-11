// The HTTP boundary gates a request's attributes once per route, method and status, not once per
// request (https://github.com/bgoleno/opportun/issues/374, tl's 2a): the same handful of values
// came through gateAttributes and isRouteShape on every request. The prepared values are kept in
// a bounded cache and reused, as obs/database.ts does for statements. A 5xx, whose error.type
// varies, is gated each time and never cached. What is recorded is unchanged (obsHttp.test.ts).
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { obsMetricPoints } from '../src/db/schema';
import { flushNow, setCollecting } from '../src/obs';
import { MINUTE_MS } from '../src/obs/metrics';
import {
  clearHttpPrepared,
  HTTP_PREPARED_MAX,
  httpPreparedCount,
  obsHttpPlugin,
} from '../src/plugins/obsHttp';
import { useApi } from './api';

const boot = useApi();
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await setCollecting(false);
  await Promise.all(servers.splice(0).map((s) => s.close()));
  clearHttpPrepared();
});

const MANY = HTTP_PREPARED_MAX + 44;

async function server(): Promise<FastifyInstance> {
  const s = Fastify();
  servers.push(s);
  await s.register(obsHttpPlugin);
  s.get('/api/v1/things/:id', async () => ({ ok: true }));
  s.get('/api/v1/boom', async () => {
    throw new TypeError('boom');
  });
  for (let i = 0; i < MANY; i += 1) s.get(`/api/v1/route${i}`, async () => ({ ok: true }));
  await s.ready();
  return s;
}

describe('the HTTP boundary prepares its attributes (#374)', () => {
  it('one prepared entry per route, method and status, however many requests', async () => {
    await boot();
    await setCollecting(true);
    const s = await server();
    clearHttpPrepared();
    for (let i = 0; i < 20; i += 1) await s.inject({ method: 'GET', url: `/api/v1/things/${i}` });
    expect(httpPreparedCount()).toBe(1);
    await s.inject({ method: 'POST', url: '/api/v1/things/1' }); // 404: another route and status
    expect(httpPreparedCount()).toBe(2);
  });

  it('a 5xx is gated each time and never cached: its error.type varies', async () => {
    await boot();
    await setCollecting(true);
    const s = await server();
    clearHttpPrepared();
    await s.inject({ method: 'GET', url: '/api/v1/boom' });
    await s.inject({ method: 'GET', url: '/api/v1/boom' });
    expect(httpPreparedCount()).toBe(0);
  });

  it('the cache is bounded; past it, requests are still recorded', async () => {
    const { app } = await boot();
    await setCollecting(true);
    const s = await server();
    clearHttpPrepared();
    for (let i = 0; i < MANY; i += 1) await s.inject({ method: 'GET', url: `/api/v1/route${i}` });
    expect(httpPreparedCount()).toBe(HTTP_PREPARED_MAX);
    await flushNow();
    const routes = new Set(
      (
        await app.db
          .select()
          .from(obsMetricPoints)
          .where(eq(obsMetricPoints.metric, 'http.server.request.duration'))
          .all()
      )
        .filter((p) => p.resolution === MINUTE_MS)
        .map((p) => p.attributes['http.route']),
    );
    expect(routes.has(`/api/v1/route${MANY - 1}`)).toBe(true);
    expect(routes.size).toBe(MANY);
  });
});
