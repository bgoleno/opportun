// The outbound boundary as FR-T3 wires it (design.md 14.2, 14.4, 14.8;
// https://github.com/bgoleno/opportun/issues/343): every safeFetch hop, the MCP transport's
// fetch and the Google API seam record http.client.request.duration under a named target. The
// target is derived from a literal host map when the caller names none (tl on #343); server.address
// still comes from the catalog's fixed list alone, so a Workday tenant's host never appears.
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { obsMetricPoints } from '../src/db/schema';
import { observedGoogleApi, type GoogleApi } from '../src/lib/google';
import { guardedMcpFetch } from '../src/lib/mcpClient';
import {
  createSafeFetch,
  OFFICIAL_API_URLS,
  type RawResponse,
  type SafeFetchDeps,
} from '../src/lib/safeFetch';
import { flushNow, setCollecting } from '../src/obs';
import { MINUTE_MS } from '../src/obs/metrics';
import { outboundTargetFor } from '../src/obs/outbound';
import { useApi } from './api';

const boot = useApi();
type App = Awaited<ReturnType<typeof boot>>['app'];

afterEach(async () => {
  await setCollecting(false);
});

async function clientPoints(app: App) {
  await flushNow();
  return (
    await app.db
      .select()
      .from(obsMetricPoints)
      .where(eq(obsMetricPoints.metric, 'http.client.request.duration'))
      .all()
  )
    .filter((p) => p.resolution === MINUTE_MS)
    .map((p): Record<string, unknown> => ({ ...p.attributes, count: p.count }));
}

function raw(status: number, headers: Record<string, string> = {}): RawResponse {
  return {
    status,
    headers,
    body: (async function* () {
      yield Buffer.from('ok');
    })(),
  };
}

/** A safeFetch whose DNS answers a public address and whose transport answers `reply`. */
function fakeFetch(reply: (url: URL) => RawResponse | Error) {
  const seen: string[] = [];
  const deps: SafeFetchDeps = {
    resolve: async () => ['93.184.216.34'],
    request: async (target) => {
      seen.push(target.url.href);
      const r = reply(target.url);
      if (r instanceof Error) throw r;
      return r;
    },
    now: () => 0,
    sleep: async () => undefined,
  };
  return { fetch: createSafeFetch(deps), seen };
}

describe('outboundTargetFor: a literal map, tested per host (#343)', () => {
  it('names each ATS, Workday by its one wildcard, Google, and OAuth for the official URL', () => {
    const cases: [string, string][] = [
      ['boards-api.greenhouse.io', 'ats_greenhouse'],
      ['api.lever.co', 'ats_lever'],
      ['api.ashbyhq.com', 'ats_ashby'],
      ['api.smartrecruiters.com', 'ats_smartrecruiters'],
      ['apply.workable.com', 'ats_workable'],
      ['acme.wd5.myworkdayjobs.com', 'ats_workday'],
      ['oauth2.googleapis.com', 'google'],
      ['www.googleapis.com', 'google'],
      ['gmail.googleapis.com', 'google'],
      ['docs.googleapis.com', 'google'],
      ['accounts.google.com', 'google'],
      ['openidconnect.googleapis.com', 'google'],
      // Never a suffix or prefix match on any other host.
      ['boards-api.greenhouse.io.evil.example', 'public_site'],
      ['evil-api.lever.co', 'public_site'],
      ['myworkdayjobs.com.evil.example', 'public_site'],
      ['myworkdayjobs.com', 'public_site'],
      ['example.com', 'public_site'],
    ];
    for (const [host, target] of cases) {
      expect(outboundTargetFor({ url: new URL(`https://${host}/x`) }), host).toBe(target);
    }
    expect(
      outboundTargetFor({
        url: new URL(OFFICIAL_API_URLS.linkedinToken),
        officialApiUrl: OFFICIAL_API_URLS.linkedinToken,
      }),
    ).toBe('oauth');
    // The caller's own target wins.
    expect(
      outboundTargetFor({ url: new URL('https://rr.example.net/api'), target: 'reactive_resume' }),
    ).toBe('reactive_resume');
  });
});

describe('safeFetch (#343)', () => {
  it('records each request under its target, server.address only for a fixed host', async () => {
    const { app } = await boot();
    await setCollecting(true);
    const { fetch } = fakeFetch(() => raw(200));
    await fetch('https://boards-api.greenhouse.io/v1/boards/acme/jobs', {
      allowHosts: ['boards-api.greenhouse.io'],
    });
    await fetch('https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs', {
      allowHosts: ['myworkdayjobs.com'],
    });
    await fetch('https://jane-doe.example/about', { allowHosts: [], allowPublic: true });
    const points = await clientPoints(app);
    expect(points).toEqual(
      expect.arrayContaining([
        {
          'http.request.method': 'GET',
          'opportun.outbound.target': 'ats_greenhouse',
          'server.address': 'boards-api.greenhouse.io',
          'http.response.status_code': 200,
          count: 1,
        },
        {
          'http.request.method': 'GET',
          'opportun.outbound.target': 'ats_workday',
          'http.response.status_code': 200,
          count: 1,
        },
        {
          'http.request.method': 'GET',
          'opportun.outbound.target': 'public_site',
          'http.response.status_code': 200,
          count: 1,
        },
      ]),
    );
    expect(points).toHaveLength(3);
    const text = JSON.stringify(points);
    for (const leak of ['acme', 'jane-doe', 'myworkdayjobs', '/v1/boards'])
      expect(text).not.toContain(leak);
  });

  it('counts a followed redirect as two requests, one per hop', async () => {
    const { app } = await boot();
    await setCollecting(true);
    const { fetch, seen } = fakeFetch((url) =>
      url.pathname === '/old' ? raw(302, { location: 'https://example.com/new' }) : raw(200),
    );
    await fetch('https://example.com/old', { allowHosts: [], allowPublic: true });
    expect(seen).toHaveLength(2);
    const points = await clientPoints(app);
    expect(points.map((p) => [p['http.response.status_code'], p.count]).sort()).toEqual([
      [200, 1],
      [302, 1],
    ]);
  });

  it("records a transport error's code, and nothing for a request refused before it was sent", async () => {
    const { app } = await boot();
    await setCollecting(true);
    const reset = Object.assign(new Error('socket hang up at https://example.com/?email=jane'), {
      code: 'ECONNRESET',
    });
    const { fetch } = fakeFetch(() => reset);
    await expect(
      fetch('https://example.com/a', { allowHosts: [], allowPublic: true }),
    ).rejects.toBe(reset);
    await expect(
      fetch('https://not-allowed.example/a', { allowHosts: ['example.com'] }),
    ).rejects.toThrow();
    const points = await clientPoints(app);
    expect(points).toEqual([
      {
        'http.request.method': 'GET',
        'opportun.outbound.target': 'public_site',
        'error.type': 'ECONNRESET',
        count: 1,
      },
    ]);
  });

  it('uses the request method for a body request, and the caller target', async () => {
    const { app } = await boot();
    await setCollecting(true);
    const { fetch } = fakeFetch(() => raw(201));
    await fetch('https://rr.example.net/api/resume', {
      allowHosts: ['rr.example.net'],
      target: 'reactive_resume',
      post: { contentType: 'application/json', body: '{}', method: 'PATCH' },
    });
    const [p] = await clientPoints(app);
    expect(p).toMatchObject({
      'http.request.method': 'PATCH',
      'opportun.outbound.target': 'reactive_resume',
    });
  });

  it('with collection off: the request goes out and nothing is recorded', async () => {
    const { app } = await boot();
    const { fetch, seen } = fakeFetch(() => raw(200));
    await fetch('https://example.com/a', { allowHosts: [], allowPublic: true });
    expect(seen).toHaveLength(1);
    expect(await clientPoints(app)).toEqual([]);
  });
});

describe('the MCP transport (#343)', () => {
  it('records its POSTs as target mcp, with no host', async () => {
    const { app } = await boot();
    await setCollecting(true);
    const guarded = guardedMcpFetch({
      resolve: async () => ['93.184.216.34'],
      fetch: async () => new Response('{}', { status: 200 }),
    });
    await guarded('https://mcp.jane-doe.example/mcp', { method: 'POST' });
    // The declined GET stream is never sent, so it is not a request.
    await guarded('https://mcp.jane-doe.example/mcp', { method: 'GET' });
    expect(await clientPoints(app)).toEqual([
      {
        'http.request.method': 'POST',
        'opportun.outbound.target': 'mcp',
        'http.response.status_code': 200,
        count: 1,
      },
    ]);
  });
});

describe('the Google API seam (#343)', () => {
  it("records each call as target google, with a failed call's status as error.type", async () => {
    const { app } = await boot();
    await setCollecting(true);
    const fake = {
      gmailProfile: async () => ({ historyId: '1', emailAddress: 'jane.doe@example.com' }),
      getFile: async () => {
        throw Object.assign(new Error('File not found: jane.doc'), { status: 404 });
      },
    } as unknown as GoogleApi;
    const api = observedGoogleApi(fake);
    await api.gmailProfile({} as never);
    await expect(api.getFile({} as never, 'id')).rejects.toThrow('File not found');
    const points = await clientPoints(app);
    expect(points).toEqual(
      expect.arrayContaining([
        { 'http.request.method': 'GET', 'opportun.outbound.target': 'google', count: 1 },
        {
          'http.request.method': 'GET',
          'opportun.outbound.target': 'google',
          'http.response.status_code': 404,
          'error.type': '404',
          count: 1,
        },
      ]),
    );
    expect(JSON.stringify(points)).not.toContain('jane');
  });
});
