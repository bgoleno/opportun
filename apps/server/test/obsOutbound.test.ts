// The observed outbound request (design.md 14.2, 14.4, 14.6, 14.8;
// https://github.com/bgoleno/opportun/issues/353). It only watches: the request goes out as the
// caller built it, with no traceparent, and the response comes back unread. It records the
// method, the named target, the status and an error's class or code: never the URL, and
// server.address only for a host on the catalog's literal list.
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { obsMetricPoints } from '../src/db/schema';
import { flushNow, setCollecting } from '../src/obs';
import { MINUTE_MS } from '../src/obs/metrics';
import { errorType, observedFetch, observeOutbound } from '../src/obs/outbound';
import { useApi } from './api';
import { countRows } from './db';

const boot = useApi();
type App = Awaited<ReturnType<typeof boot>>['app'];

afterEach(async () => {
  await setCollecting(false);
});

async function outboundPoints(app: App) {
  await flushNow();
  return app.db
    .select()
    .from(obsMetricPoints)
    .where(eq(obsMetricPoints.metric, 'http.client.request.duration'))
    .all()
    .then((rows) => rows.filter((r) => r.resolution === MINUTE_MS));
}

describe('observedFetch leaves the request alone (#353)', () => {
  it('passes the same input and init through, adds no header, and returns the response unread', async () => {
    const { app } = await boot();
    await setCollecting(true);
    const init: RequestInit = { method: 'POST', headers: { 'x-api-key': 'k' }, body: '{"a":1}' };
    const seen: { input: unknown; init: unknown }[] = [];
    const response = new Response('{"ok":true}', { status: 201 });
    const f = observedFetch('anthropic', async (input, i) => {
      seen.push({ input, init: i });
      return response;
    });
    const res = await f('https://api.anthropic.com/v1/messages', init);
    expect(res).toBe(response);
    expect(res.bodyUsed).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.input).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[0]?.init).toBe(init);
    expect(init.headers).toEqual({ 'x-api-key': 'k' });
    expect(JSON.stringify(init)).not.toContain('traceparent');
    expect(await outboundPoints(app)).toHaveLength(1);
  });

  it('with collection off it calls straight through and records nothing', async () => {
    const { app } = await boot();
    let calls = 0;
    const res = await observeOutbound(
      { target: 'public_site', method: 'GET', url: 'https://example.com/' },
      async () => {
        calls += 1;
        return new Response('x');
      },
    );
    expect(calls).toBe(1);
    expect(await res.text()).toBe('x');
    await flushNow();
    expect(await countRows(app, obsMetricPoints)).toBe(0);
  });
});

describe('what observeOutbound records (#353)', () => {
  it('names a fixed public host, but only the target for any other host', async () => {
    const { app } = await boot();
    await setCollecting(true);
    const ok = async () => new Response('', { status: 200 });
    await observeOutbound(
      {
        target: 'ats_greenhouse',
        method: 'get',
        url: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs',
      },
      ok,
    );
    await observeOutbound(
      {
        target: 'ats_workday',
        method: 'GET',
        url: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/jobs',
      },
      ok,
    );
    await observeOutbound(
      { target: 'public_site', method: 'GET', url: new URL('https://jane-doe.example/about') },
      ok,
    );
    const points = await outboundPoints(app);
    const attrs = points
      .map((p) => p.attributes)
      .sort((x, y) =>
        String(x['opportun.outbound.target']).localeCompare(String(y['opportun.outbound.target'])),
      );
    expect(attrs).toEqual([
      {
        'http.request.method': 'GET',
        'opportun.outbound.target': 'ats_greenhouse',
        'server.address': 'boards-api.greenhouse.io',
        'http.response.status_code': 200,
      },
      {
        'http.request.method': 'GET',
        'opportun.outbound.target': 'ats_workday',
        'http.response.status_code': 200,
      },
      {
        'http.request.method': 'GET',
        'opportun.outbound.target': 'public_site',
        'http.response.status_code': 200,
      },
    ]);
    const text = JSON.stringify(points);
    for (const leak of ['acme', 'jane-doe', '/v1/boards', 'myworkdayjobs'])
      expect(text).not.toContain(leak);
  });

  it('gives a 4xx or 5xx response its status code as error.type, and an unknown method _OTHER', async () => {
    const { app } = await boot();
    await setCollecting(true);
    await observeOutbound(
      { target: 'public_site', method: 'BREW', url: 'https://example.com/' },
      async () => new Response('', { status: 503 }),
    );
    const [p] = await outboundPoints(app);
    expect(p?.attributes).toEqual({
      'http.request.method': '_OTHER',
      'opportun.outbound.target': 'public_site',
      'http.response.status_code': 503,
      'error.type': '503',
    });
  });

  it("records a thrown error's code or class, never its message, and rethrows the same error", async () => {
    const { app } = await boot();
    await setCollecting(true);
    const url = 'https://example.com/jobs?email=jane.doe@example.com';
    const refused = Object.assign(new Error(`connect ECONNREFUSED for ${url}`), {
      code: 'ECONNREFUSED',
    });
    await expect(
      observeOutbound({ target: 'public_site', method: 'GET', url }, async () => {
        throw refused;
      }),
    ).rejects.toBe(refused);
    const wrapped = new TypeError(`fetch failed: ${url}`, {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
    await expect(
      observeOutbound({ target: 'public_site', method: 'GET', url }, async () => {
        throw wrapped;
      }),
    ).rejects.toBe(wrapped);
    const points = await outboundPoints(app);
    expect(points.map((p) => p.attributes['error.type']).sort()).toEqual([
      'ECONNREFUSED',
      'UND_ERR_CONNECT_TIMEOUT',
    ]);
    expect(JSON.stringify(points)).not.toContain('jane.doe');
  });
});

describe('errorType (#353)', () => {
  it('is a code or a class name, never text', () => {
    expect(errorType(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe('ENOTFOUND');
    expect(errorType(new TypeError('jane.doe@example.com'))).toBe('TypeError');
    expect(errorType(Object.assign(new Error('x'), { code: 'not a code: jane' }))).toBe('Error');
    expect(errorType('jane.doe@example.com')).toBe('Error');
    const named = new Error('x');
    named.name = 'Jane Doe <jane.doe@example.com>';
    expect(errorType(named)).toBe('Error');
  });
});
