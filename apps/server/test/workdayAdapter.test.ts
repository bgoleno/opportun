// Workday board adapter (FR-D10): the CXS listing and detail endpoints of one tenant's career
// site, mapped to NormalizedPosting from recorded-shape fixtures and fetched only through
// safeFetch with exactly the board's own host allowed. Workday's weekly service window answers
// with redirects, 406/422 and 5xx; every one of those signals is transient (the run retries),
// never a SourceConfigError that would mark the board as wrong.
import { readFileSync } from 'node:fs';
import type { NormalizedPosting } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ATS_SOURCE_KINDS,
  getSource,
  resetSources,
  SourceConfigError,
  type SourceContext,
} from '../src/adapters/discoverySource';
import {
  WORKDAY_DETAIL_FAILURES_IN_A_ROW,
  WORKDAY_MAX_DETAILS_PER_RUN,
  WORKDAY_PAGE_SIZE,
  workdayDetailUrl,
  workdayJobsUrl,
  workdaySource,
  WorkdayUnavailableError,
} from '../src/adapters/sources/workday';
import { discoveryRuns } from '../src/db/schema';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import { enqueue } from '../src/jobs/runner';
import {
  createSafeFetch,
  FetchBlockedError,
  type RawResponse,
  type safeFetch,
  type SafeFetchOptions,
} from '../src/lib/safeFetch';
import { createSource, getSourceRow, listResults } from '../src/repos/discovery';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
afterEach(() => resetSources());

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/ats/${name}`, import.meta.url), 'utf8');

const HOST = 'globexnetworks.wd5.myworkdayjobs.com';
const CONFIG = { host: HOST, tenant: 'globexnetworks', site: 'globexexternalcareers' };
const JOBS = `https://${HOST}/wday/cxs/globexnetworks/globexexternalcareers/jobs`;
const DETAIL_PAN = `https://${HOST}/wday/cxs/globexnetworks/globexexternalcareers/job/Santa-Clara-CA/Principal-Product-Manager---AURL---Web-Protection--CDSS-_JR-000001`;
const DETAIL_REMOTE = `https://${HOST}/wday/cxs/globexnetworks/globexexternalcareers/job/Remote-USA/Senior-Product-Manager--Remote_1000002-1`;

interface Call {
  url: string;
  opts: SafeFetchOptions;
}

type Reply = { status: number; body: string };

/** A fake Workday server: `respond(url, opts)` answers each request; every call is recorded. */
function fakeWorkday(respond: (url: string, opts: SafeFetchOptions) => Reply) {
  const calls: Call[] = [];
  const fetch = (async (url, opts) => {
    calls.push({ url, opts });
    const r = respond(url, opts);
    return { status: r.status, headers: new Headers(), body: Buffer.from(r.body) };
  }) as typeof safeFetch;
  return { calls, fetch };
}

/** The fixture board: the listing page, the PAN detail, and a bare detail for the other req. */
function fixtureBoard(url: string): Reply {
  if (url === JOBS) return { status: 200, body: fixture('workday-jobs.json') };
  if (url === DETAIL_PAN) return { status: 200, body: fixture('workday-job.json') };
  if (url === DETAIL_REMOTE) {
    return {
      status: 200,
      body: JSON.stringify({
        jobPostingInfo: {
          title: 'Senior Product Manager, Remote',
          jobDescription: '<p>Remote role.</p>',
          location: 'Remote - USA',
          remoteType: 'Remote',
          jobReqId: '1000002-1',
        },
      }),
    };
  }
  return { status: 404, body: '' };
}

const silentLog = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as SourceContext['log'];

async function collect(
  fetch: typeof safeFetch,
  config: unknown = CONFIG,
): Promise<NormalizedPosting[]> {
  const out: NormalizedPosting[] = [];
  for await (const item of workdaySource.fetchPostings({ fetch, log: silentLog }, config, null)) {
    expect(item.nextCursor).toBeNull();
    out.push(item.posting);
  }
  return out;
}

/** A listing page of `count` synthetic postings starting at `from`. */
function page(from: number, count: number, total: number): string {
  return JSON.stringify({
    total,
    jobPostings: Array.from({ length: count }, (_, i) => ({
      title: `Role ${from + i}`,
      externalPath: `/job/Remote/Role-${from + i}_R-${from + i}`,
      locationsText: 'Remote',
      bulletFields: [`R-${from + i}`],
    })),
  });
}

describe('workday adapter: the CXS contract (probed 2026-10-17)', () => {
  it('builds the listing and detail URLs from the board config and externalPath', () => {
    expect(workdayJobsUrl(CONFIG)).toBe(JOBS);
    expect(
      workdayDetailUrl(
        CONFIG,
        '/job/Santa-Clara-CA/Principal-Product-Manager---AURL---Web-Protection--CDSS-_JR-000001',
      ),
    ).toBe(DETAIL_PAN);
    expect(workdayDetailUrl(CONFIG, '/job/../../admin')).toBeNull();
    expect(workdayDetailUrl(CONFIG, '/elsewhere/x_1')).toBeNull();
    expect(workdayDetailUrl(CONFIG, '/job/a?b=1')).toBeNull();
    // Percent-encoded dots are dot segments to a URL parser: they must not re-aim the GET.
    expect(
      workdayDetailUrl(CONFIG, '/job/%2e%2e/%2e%2e/%2e%2e/%2e%2e/wday/cxs/other/site/jobs'),
    ).toBeNull();
    expect(workdayDetailUrl(CONFIG, '/job/%2E%2E/x_1')).toBeNull();
    expect(workdayDetailUrl(CONFIG, '/job/a%2Fb/x_1')).toBeNull();
  });

  it('POSTs the listing as JSON and GETs each detail, only on the board host', async () => {
    const { calls, fetch } = fakeWorkday(fixtureBoard);
    const postings = await collect(fetch);

    expect(calls.map((c) => c.url)).toEqual([JOBS, DETAIL_PAN, DETAIL_REMOTE]);
    for (const c of calls) {
      expect(c.opts.allowHosts).toEqual([HOST]);
      expect(c.opts.headers).toEqual({ accept: 'application/json' });
      expect(c.opts.allowPublic).toBeUndefined();
    }
    expect(calls[0]!.opts.post?.contentType).toBe('application/json');
    expect(JSON.parse(calls[0]!.opts.post!.body)).toEqual({
      appliedFacets: {},
      limit: WORKDAY_PAGE_SIZE,
      offset: 0,
      searchText: '',
    });
    // The site's own default: some tenants reportedly refuse a larger limit.
    expect(WORKDAY_PAGE_SIZE).toBe(20);
    expect(calls[1]!.opts.post).toBeUndefined();

    expect(postings).toHaveLength(2);
    expect(postings[0]).toEqual({
      company: 'Globex Networks',
      title: 'Principal Product Manager - AURL - Web Protection (CDSS)',
      // Raw HTML: the engine's sanitizePosting turns it into text like every source's.
      descriptionMd:
        '<p><b>Our Mission</b></p><p>Own the <strong>web protection</strong> roadmap.</p><ul><li>Security</li><li>SaaS</li></ul><p>Salary &amp; equity.</p>',
      postingUrl:
        'https://globexnetworks.wd5.myworkdayjobs.com/globexexternalcareers/job/Santa-Clara-CA/Principal-Product-Manager---AURL---Web-Protection--CDSS-_JR-000001',
      location: 'Santa Clara, CA',
      remote: null,
      compNote: null,
      externalId: 'JR-000001',
      postedAt: Date.parse('2026-10-01'),
    });
    // No hiring organization or external URL in the detail: the tenant and a URL built from the
    // listing's externalPath stand in.
    expect(postings[1]).toMatchObject({
      company: 'globexnetworks',
      remote: true,
      externalId: '1000002-1',
      postingUrl: `https://${HOST}/globexexternalcareers/job/Remote-USA/Senior-Product-Manager--Remote_1000002-1`,
    });
  });

  it('pages by offset/limit until the first page total is reached (later pages report 0)', async () => {
    const { calls, fetch } = fakeWorkday((url, opts) => {
      if (url !== JOBS) return { status: 200, body: '{"jobPostingInfo":{}}' };
      const { offset } = JSON.parse(opts.post!.body) as { offset: number };
      // Workday reports the total on the first page only.
      const total = offset === 0 ? 120 : 0;
      return { status: 200, body: page(offset, WORKDAY_PAGE_SIZE, total) };
    });
    const postings = await collect(fetch);
    expect(postings).toHaveLength(120);
    const offsets = calls
      .filter((c) => c.url === JOBS)
      .map((c) => (JSON.parse(c.opts.post!.body) as { offset: number }).offset);
    expect(offsets).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('stops on a short page even when the total says more', async () => {
    const { calls, fetch } = fakeWorkday((url, opts) => {
      if (url !== JOBS) return { status: 200, body: '{}' };
      const { offset } = JSON.parse(opts.post!.body) as { offset: number };
      return { status: 200, body: page(offset, offset === 0 ? WORKDAY_PAGE_SIZE : 3, 500) };
    });
    expect(await collect(fetch)).toHaveLength(WORKDAY_PAGE_SIZE + 3);
    expect(calls.filter((c) => c.url === JOBS)).toHaveLength(2);
  });

  it('yields one posting once, even when paging shows it twice (externalPath dedupe)', async () => {
    const { calls, fetch } = fakeWorkday((url, opts) => {
      if (url !== JOBS) return { status: 200, body: '{}' };
      const { offset } = JSON.parse(opts.post!.body) as { offset: number };
      // A posting shifted between pages while we read: Role-19 appears at the top of page two.
      return {
        status: 200,
        body: offset === 0 ? page(0, WORKDAY_PAGE_SIZE, 23) : page(19, 4, 0),
      };
    });
    const postings = await collect(fetch);
    const ids = postings.map((p) => p.externalId);
    expect(ids).toHaveLength(23);
    expect(new Set(ids).size).toBe(23);
    expect(calls.filter((c) => c.url.includes('/job/Remote/Role-19_R-19'))).toHaveLength(1);
  });

  it('keys postings by externalPath and reads the requisition from it, not from bulletFields', async () => {
    // bulletFields is tenant-configured: here it carries the location, shared by both postings.
    const { fetch } = fakeWorkday((url) =>
      url === JOBS
        ? {
            status: 200,
            body: JSON.stringify({
              total: 2,
              jobPostings: [
                {
                  title: 'PM',
                  externalPath: '/job/Santa-Clara-CA/PM_JR-1',
                  bulletFields: ['Santa Clara, CA'],
                },
                {
                  title: 'Designer',
                  externalPath: '/job/Santa-Clara-CA/Designer_JR-2',
                  bulletFields: ['Santa Clara, CA'],
                },
              ],
            }),
          }
        : { status: 404, body: '' },
    );
    const postings = await collect(fetch);
    expect(postings.map((p) => p.externalId)).toEqual(['JR-1', 'JR-2']);
  });

  it('keeps a posting without a description when its externalPath is unusable', async () => {
    const { calls, fetch } = fakeWorkday((url) =>
      url === JOBS
        ? {
            status: 200,
            body: JSON.stringify({
              total: 1,
              jobPostings: [
                { title: 'Odd', externalPath: '/job/../../wday/x', bulletFields: ['R-9'] },
              ],
            }),
          }
        : { status: 500, body: '' },
    );
    const postings = await collect(fetch);
    expect(calls).toHaveLength(1);
    expect(postings).toEqual([
      expect.objectContaining({ title: 'Odd', descriptionMd: null, externalId: 'R-9' }),
    ]);
  });

  it('keeps the listing row when one detail is gone (404) between listing and detail', async () => {
    const { fetch } = fakeWorkday((url) =>
      url === JOBS
        ? { status: 200, body: fixture('workday-jobs.json') }
        : { status: 404, body: '' },
    );
    const postings = await collect(fetch);
    expect(postings.map((p) => [p.externalId, p.descriptionMd, p.location])).toEqual([
      ['JR-000001', null, 'Santa Clara, CA'],
      ['1000002-1', null, 'Remote - USA'],
    ]);
  });
});

describe('workday adapter: configuration', () => {
  it('is registered as a built-in that survives resetSources', () => {
    resetSources();
    expect(getSource('ats_workday')).toBe(workdaySource);
    expect(ATS_SOURCE_KINDS).toContain('ats_workday');
  });

  it('throws SourceConfigError for an invalid config, before any fetch', async () => {
    for (const bad of [
      { org: 'globexnetworks' },
      { ...CONFIG, host: 'evil.example' },
      // The tenant must be the host's own first label: no fetching one tenant's host for another.
      { ...CONFIG, tenant: 'initech' },
      { ...CONFIG, site: '../admin' },
    ]) {
      const { calls, fetch } = fakeWorkday(() => ({ status: 200, body: '{}' }));
      await expect(collect(fetch, bad)).rejects.toBeInstanceOf(SourceConfigError);
      expect(calls).toEqual([]);
    }
  });

  it('a 404 listing is a site Workday does not know: SourceConfigError', async () => {
    const { fetch } = fakeWorkday(() => ({ status: 404, body: '' }));
    await expect(collect(fetch)).rejects.toBeInstanceOf(SourceConfigError);
  });
});

/** The real safeFetch over one scripted response, so redirects meet the real redirect rules. */
function scripted(status: number, headers: Record<string, string>, body = '') {
  const requested: string[] = [];
  const fetch = createSafeFetch({
    now: () => 0,
    sleep: async () => undefined,
    resolve: async () => ['93.184.216.34'],
    request: async (target): Promise<RawResponse> => {
      requested.push(target.url.href);
      return {
        status,
        headers,
        body: (async function* () {
          if (body.length > 0) yield Buffer.from(body);
        })(),
      };
    },
  });
  return { fetch, requested };
}

const OUTAGE_JS =
  '<html><head><script>window.location.href="https://community.workday.com/maintenance-page";</script></head></html>';

describe('workday adapter: the weekly service window is transient (observed 2026-10-17)', () => {
  it.each([
    // [signal, status, headers, body]
    [
      '302 to <dc>.myworkday.com/wday/drs/outage',
      302,
      {
        location:
          'https://wd5.myworkday.com/wday/drs/outage?t=globexnetworks&s=globexexternalcareers',
      },
      '',
    ],
    [
      '303 to community.workday.com/maintenance-page',
      303,
      { location: 'https://community.workday.com/maintenance-page' },
      '',
    ],
    ['406 (a bare host root answers this in or out of the window)', 406, {}, ''],
    ['422 with an empty message', 422, {}, ''],
    ['500 serving a JavaScript redirect to the maintenance page', 500, {}, OUTAGE_JS],
    ['503', 503, {}, ''],
    ['502', 502, {}, '<html>Bad gateway</html>'],
  ] as const)('%s', async (_signal, status, headers, body) => {
    const { fetch, requested } = scripted(status, { ...headers }, body);
    const err = await collect(fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkdayUnavailableError);
    expect(err).not.toBeInstanceOf(SourceConfigError);
    // Never followed: only the board host was contacted.
    expect(requested).toEqual([JOBS]);
  });

  it('a window that opens mid-run (a detail redirects) is transient too', async () => {
    const { fetch } = fakeWorkday((url) => {
      if (url === JOBS) return { status: 200, body: fixture('workday-jobs.json') };
      // A request with headers never follows a redirect: safeFetch refuses it.
      throw new FetchBlockedError('redirect_blocked', 'redirect of a credentialed request');
    });
    const err = await collect(fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkdayUnavailableError);
  });

  it('one detail that fails without a proven outage is yielded bare and the run goes on', async () => {
    const { fetch } = fakeWorkday((url, opts) => {
      if (url === JOBS) {
        const { offset } = JSON.parse(opts.post!.body) as { offset: number };
        return { status: 200, body: page(offset, 5, 5) };
      }
      // Role-1's detail answers the 500 whose body is a JavaScript redirect to the maintenance
      // page: an unknown posting looks the same, so it is not proof of an outage.
      if (url.includes('Role-1_R-1')) return { status: 500, body: OUTAGE_JS };
      return {
        status: 200,
        body: JSON.stringify({ jobPostingInfo: { jobDescription: '<p>Described.</p>' } }),
      };
    });
    const postings = await collect(fetch);
    expect(postings.map((p) => [p.externalId, p.descriptionMd])).toEqual([
      ['R-0', '<p>Described.</p>'],
      ['R-1', null],
      ['R-2', '<p>Described.</p>'],
      ['R-3', '<p>Described.</p>'],
      ['R-4', '<p>Described.</p>'],
    ]);
  });

  it('details that keep failing in a row stop the run as transient', async () => {
    const { calls, fetch } = fakeWorkday((url, opts) => {
      if (url === JOBS) {
        const { offset } = JSON.parse(opts.post!.body) as { offset: number };
        return { status: 200, body: page(offset, 10, 10) };
      }
      return { status: 503, body: '' };
    });
    const err = await collect(fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkdayUnavailableError);
    expect(calls.filter((c) => c.url !== JOBS)).toHaveLength(WORKDAY_DETAIL_FAILURES_IN_A_ROW);
  });
});

describe('discovery.run with the Workday adapter', () => {
  it('stores sanitized results for the owner only (source isolation)', async () => {
    const { app, a, b } = await boot();
    const ctx = ctxOf(a);
    const { fetch } = fakeWorkday(fixtureBoard);
    app.jobs.services.sourceFetch = fetch;
    const src = await createSource(app.db, ctx, { kind: 'ats_workday', config: CONFIG });
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();

    const results = (await listResults(app.db, ctx, { limit: 50, offset: 0, sourceId: src.id }))
      .items;
    expect(results).toHaveLength(2);
    const pan = results.find((r) => r.posting.externalId === 'JR-000001')!;
    expect(pan.posting.descriptionMd).not.toMatch(/[<>]/);
    expect(pan.posting.descriptionMd).toContain('web protection');
    expect(pan.posting.descriptionMd).toContain('Salary & equity.');
    expect((await getSourceRow(app.db, ctx, src.id)).status).toBe('ok');
    expect((await listResults(app.db, ctxOf(b), { limit: 50, offset: 0 })).items).toEqual([]);
  });

  it('a posting whose detail fails is stored bare and the run still completes', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    app.jobs.services.sourceFetch = fakeWorkday((url) =>
      url === DETAIL_PAN ? { status: 500, body: OUTAGE_JS } : fixtureBoard(url),
    ).fetch;
    const src = await createSource(app.db, ctx, { kind: 'ats_workday', config: CONFIG });
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();
    const results = (await listResults(app.db, ctx, { limit: 50, offset: 0, sourceId: src.id }))
      .items;
    expect(results.map((r) => [r.posting.externalId, r.posting.descriptionMd == null])).toEqual(
      expect.arrayContaining([
        ['JR-000001', true],
        ['1000002-1', false],
      ]),
    );
    expect(results.find((r) => r.posting.externalId === 'JR-000001')!.resolution).toBe(
      'needs_capture',
    );
    expect((await getSourceRow(app.db, ctx, src.id)).status).toBe('ok');
  });

  it('a rerun of an unchanged board costs its listing only: no detail is fetched again', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const { calls, fetch } = fakeWorkday(fixtureBoard);
    app.jobs.services.sourceFetch = fetch;
    const src = await createSource(app.db, ctx, { kind: 'ats_workday', config: CONFIG });
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();
    expect(calls.map((c) => c.url)).toEqual([JOBS, DETAIL_PAN, DETAIL_REMOTE]);

    calls.length = 0;
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();
    expect(calls.map((c) => c.url)).toEqual([JOBS]);
    // The known rows were still yielded, bare, and the engine counted them as duplicates.
    const runs = await app.db
      .select()
      .from(discoveryRuns)
      .where(eq(discoveryRuns.sourceId, src.id))
      .all();
    expect(runs.map((r) => r.stats)).toEqual([
      expect.objectContaining({ fetched: 2, inserted: 2 }),
      expect.objectContaining({ fetched: 2, inserted: 0, duplicates: 2 }),
    ]);
    const results = (await listResults(app.db, ctx, { limit: 50, offset: 0, sourceId: src.id }))
      .items;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.posting.descriptionMd != null)).toBe(true);
  });

  it('caps detail fetches per run; the trimmed postings are described on the next run', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const size = WORKDAY_MAX_DETAILS_PER_RUN + 30;
    const infos: unknown[] = [];
    const { calls, fetch } = fakeWorkday((url, opts) => {
      if (url === JOBS) {
        const { offset } = JSON.parse(opts.post!.body) as { offset: number };
        const count = Math.max(0, Math.min(WORKDAY_PAGE_SIZE, size - offset));
        return { status: 200, body: page(offset, count, size) };
      }
      return {
        status: 200,
        body: JSON.stringify({ jobPostingInfo: { jobDescription: '<p>Described.</p>' } }),
      };
    });
    const details = () => calls.filter((c) => c.url !== JOBS).length;

    // The adapter alone: 200 details, the rest left for later, and a log line saying so.
    const log = { ...silentLog, info: (o: unknown) => infos.push(o) } as typeof silentLog;
    const out: NormalizedPosting[] = [];
    for await (const item of workdaySource.fetchPostings({ fetch, log }, CONFIG, null)) {
      out.push(item.posting);
    }
    expect(details()).toBe(WORKDAY_MAX_DETAILS_PER_RUN);
    expect(out).toHaveLength(WORKDAY_MAX_DETAILS_PER_RUN);
    expect(infos).toEqual([expect.objectContaining({ deferred: 30 })]);

    // Through the engine: the second run describes only the 30 the first one left.
    app.jobs.services.sourceFetch = fetch;
    const src = await createSource(app.db, ctx, { kind: 'ats_workday', config: CONFIG });
    calls.length = 0;
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();
    expect(details()).toBe(WORKDAY_MAX_DETAILS_PER_RUN);
    calls.length = 0;
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();
    expect(details()).toBe(30);
    expect(
      (await listResults(app.db, ctx, { limit: 500, offset: 0, sourceId: src.id })).total,
    ).toBe(size);
  }, 60_000); // issue #72: 230 postings over two full runs, each row a real DB round trip (worse
  // on the Postgres CI leg); the test itself does nothing slow, but 30_000 — the same as the
  // suite's global default, so this override was adding no headroom at all — timed out
  // reproducibly under full-suite contention. The guarantee here is the cap-then-defer count
  // (WORKDAY_MAX_DETAILS_PER_RUN, then the remainder), not timing, so the fix is real headroom
  // for real I/O, not a faster or smaller test.

  it('a maintenance window leaves the source retryable, not misconfigured', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    app.jobs.services.sourceFetch = fakeWorkday(() => ({ status: 503, body: '' })).fetch;
    const src = await createSource(app.db, ctx, { kind: 'ats_workday', config: CONFIG });
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();
    const row = await getSourceRow(app.db, ctx, src.id);
    expect(row.status).toBe('error');
    expect(row.statusDetail).not.toMatch(/SourceConfigError/);
    expect(row.statusDetail).toMatch(/WorkdayUnavailableError/);
    // A failure that persists may be a wrong board, not a window: the message says both.
    expect(row.statusDetail).toContain(
      'unreachable (service window or unknown tenant/site); check the careers URL if this persists',
    );
    expect(row.statusDetail).toContain('HTTP 503');
  });
});
