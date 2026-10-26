// ATS board detection (Task 10, FR-D9). Every request goes through the real safeFetch logic
// (createSafeFetch over a scripted DNS table and transport), so the SSRF rules that guard the
// careers-page fetch are exercised as they run in production (Review Focus 2).
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { resetSources, type SourceContext } from '../src/adapters/discoverySource';
import { companies, jobs, settings } from '../src/db/schema';
import {
  ATS_DETECT_KIND,
  ATS_REVERIFY_CRON,
  ATS_REVERIFY_KIND,
  boardFromUrl,
  DEFAULT_DISCOVERY_CRON,
  detectAts,
  domainLabel,
  queueReverification,
  REVERIFY_AFTER_MS,
  scanCareersHtml,
  slugCandidates,
} from '../src/jobs/atsDetect';
import { createSafeFetch, type RawResponse } from '../src/lib/safeFetch';
import { createCompany, getCompany } from '../src/repos/companies';
import { listSources } from '../src/repos/discovery';
import { writeUserSetting } from '../src/repos/userSettings';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
afterEach(() => resetSources());

const PUBLIC_IP = '93.184.216.34';
const ATS_DNS: Record<string, string[]> = {
  'boards-api.greenhouse.io': [PUBLIC_IP],
  'api.lever.co': [PUBLIC_IP],
  'api.ashbyhq.com': [PUBLIC_IP],
};

function respond(status: number, text = '', headers: Record<string, string> = {}): RawResponse {
  return {
    status,
    headers,
    body: (async function* () {
      if (text.length > 0) yield Buffer.from(text);
    })(),
  };
}

/**
 * A safeFetch over a DNS table and a URL -> response map (anything unmapped is a 404). Records
 * every URL that reached the transport, i.e. passed every safeFetch check.
 */
function net(dns: Record<string, string[]>, routes: Record<string, () => RawResponse>) {
  const requested: string[] = [];
  const table = new Map(Object.entries({ ...ATS_DNS, ...dns }));
  const fetch = createSafeFetch({
    now: () => 0,
    sleep: async () => undefined,
    resolve: async (host) => {
      const ips = table.get(host);
      if (ips === undefined) throw new Error(`no dns entry for ${host}`);
      return ips;
    },
    request: async (target) => {
      requested.push(target.url.href);
      const route = new Map(Object.entries(routes)).get(target.url.href);
      return route === undefined ? respond(404, '{}') : route();
    },
  });
  return { fetch, requested };
}

const log = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
} as unknown as SourceContext['log'];

const LEVER_HIT = 'https://api.lever.co/v0/postings/initech?mode=json&limit=1';
/** A board that is serving something: an empty board is not a verified board. */
const LEVER_JOBS = '[{"id":"abc-1","text":"Staff Platform Engineer"}]';
const GREENHOUSE_JOBS = '{"jobs":[{"id":1,"title":"Staff Platform Engineer"}]}';

describe('slug candidates and careers links (pure)', () => {
  it('derives alnum, hyphenated and domain-label slugs in that order', () => {
    expect(slugCandidates('Initech Labs', 'initech.io')).toEqual([
      'initechlabs',
      'initech-labs',
      'initech',
    ]);
    expect(slugCandidates('Initech', 'https://www.initech.com/about')).toEqual(['initech']);
    expect(slugCandidates('Café & Co.', null)).toEqual(['cafeco', 'cafe-co']);
    expect(domainLabel('careers.initech.co.uk')).toBe('initech');
    expect(domainLabel('')).toBeNull();
  });

  it('recognizes board links for each provider and ignores everything else', () => {
    expect(boardFromUrl('https://boards.greenhouse.io/initech/jobs/1')).toEqual({
      kind: 'ats_greenhouse',
      slug: 'initech',
    });
    expect(
      boardFromUrl('https://boards.greenhouse.io/embed/job_board?for=initech&amp;b=x'),
    ).toEqual({ kind: 'ats_greenhouse', slug: 'initech' });
    expect(boardFromUrl('https://jobs.lever.co/Initech/abc')).toEqual({
      kind: 'ats_lever',
      slug: 'initech',
    });
    expect(boardFromUrl('https://jobs.ashbyhq.com/initech')).toEqual({
      kind: 'ats_ashby',
      slug: 'initech',
    });
    expect(boardFromUrl('https://jobs.lever.co.evil.example/initech')).toBeNull();
    expect(boardFromUrl('/careers')).toBeNull();
  });

  it('scans href and src attributes, deduplicated in page order', () => {
    const html = `<a href="https://jobs.ashbyhq.com/initech">a</a>
      <iframe src='https://boards.greenhouse.io/embed/job_board?for=initech'></iframe>
      <a href=https://jobs.ashbyhq.com/initech/123>dup</a><p>https://jobs.lever.co/textonly</p>`;
    expect(scanCareersHtml(html)).toEqual([
      { kind: 'ats_ashby', slug: 'initech' },
      { kind: 'ats_greenhouse', slug: 'initech' },
    ]);
  });
});

describe('detectAts', () => {
  // An empty board is a decoy: a tracked company had an empty Ashby board while its postings
  // lived on Paylocity, and recording the empty one hid the real ATS and answered "no postings" forever.
  it('does not verify a board that is serving nothing', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await createCompany(app.db, ctx, { name: 'Initech', status: 'followed' });
    const ashbyHit = 'https://api.ashbyhq.com/posting-api/job-board/initech';

    const outcome = await detectAts(app.db, ctx, company.id, {
      fetch: net({}, { [ashbyHit]: () => respond(200, '{"jobs":[]}') }).fetch,
      log,
    });

    expect(outcome).toMatchObject({ status: 'none' });
    expect((await getCompany(app.db, ctx, company.id)).atsKind).toBe('none');
    expect((await listSources(app.db, ctx, { limit: 50, offset: 0 })).items).toHaveLength(0);
  });

  it('verifies a greenhouse board from its postings', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await createCompany(app.db, ctx, { name: 'Initech', status: 'followed' });
    const hit = 'https://boards-api.greenhouse.io/v1/boards/initech/jobs';

    const outcome = await detectAts(app.db, ctx, company.id, {
      fetch: net({}, { [hit]: () => respond(200, GREENHOUSE_JOBS) }).fetch,
      log,
    });

    expect(outcome).toMatchObject({ status: 'found', kind: 'ats_greenhouse', org: 'initech' });
  });

  it('"Initech Labs" probes initechlabs, initech-labs, then the domain label, and registers the first hit', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await createCompany(app.db, ctx, {
      name: 'Initech Labs',
      domain: 'initech.io',
      status: 'followed',
    });
    const { fetch, requested } = net({}, { [LEVER_HIT]: () => respond(200, LEVER_JOBS) });

    const outcome = await detectAts(app.db, ctx, company.id, { fetch, log });

    expect(requested).toEqual([
      'https://boards-api.greenhouse.io/v1/boards/initechlabs/jobs',
      'https://api.lever.co/v0/postings/initechlabs?mode=json&limit=1',
      'https://api.ashbyhq.com/posting-api/job-board/initechlabs',
      'https://boards-api.greenhouse.io/v1/boards/initech-labs/jobs',
      'https://api.lever.co/v0/postings/initech-labs?mode=json&limit=1',
      'https://api.ashbyhq.com/posting-api/job-board/initech-labs',
      'https://boards-api.greenhouse.io/v1/boards/initech/jobs',
      LEVER_HIT,
    ]);
    expect(outcome).toMatchObject({
      status: 'found',
      kind: 'ats_lever',
      org: 'initech',
      via: 'slug',
    });
    const row = await getCompany(app.db, ctx, company.id);
    expect(row).toMatchObject({ atsKind: 'ats_lever', atsRef: 'initech' });
    expect(row.atsVerifiedAt).toBeGreaterThan(0);
    const sources = (await listSources(app.db, ctx, { limit: 50, offset: 0 })).items;
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      kind: 'ats_lever',
      config: { org: 'initech' },
      enabled: true,
      scheduleCron: DEFAULT_DISCOVERY_CRON,
      companyId: company.id,
    });
    expect(DEFAULT_DISCOVERY_CRON).toBe('0 7 * * *');
    const schedule = await app.db
      .select()
      .from(settings)
      .where(eq(settings.key, `schedule:discovery.run:${sources[0]!.id}`))
      .get();
    expect(schedule?.userId).toBe(a.userId);

    // Detecting again re-verifies the current board first and creates no second source.
    requested.length = 0;
    const again = await detectAts(app.db, ctx, company.id, { fetch, log });
    expect(again).toMatchObject({ status: 'found', via: 'current' });
    expect(requested).toEqual([LEVER_HIT]);
    expect((await listSources(app.db, ctx, { limit: 50, offset: 0 })).total).toBe(1);
  });

  it("uses the user's discovery_default_cron setting for the new source", async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await writeUserSetting(app.db, ctx, 'discovery_default_cron', '30 6 * * 1-5');
    const company = await createCompany(app.db, ctx, { name: 'Initech', status: 'followed' });
    const { fetch } = net({}, { [LEVER_HIT]: () => respond(200, LEVER_JOBS) });
    await detectAts(app.db, ctx, company.id, { fetch, log });
    expect((await listSources(app.db, ctx, { limit: 50, offset: 0 })).items[0]!.scheduleCron).toBe(
      '30 6 * * 1-5',
    );
  });

  it('finds a lever link on the careers page when no slug matches', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await createCompany(app.db, ctx, {
      name: 'Umbrella Holdings',
      careersUrl: 'https://umbrella.example/careers',
      status: 'followed',
    });
    const html = `<html><body><a href="/about">About</a>
      <a class="btn" href='https://jobs.lever.co/umbrella-corp'>Open roles</a>
      <script src="https://cdn.example/x.js"></script></body></html>`;
    const hit = 'https://api.lever.co/v0/postings/umbrella-corp?mode=json&limit=1';
    const { fetch, requested } = net(
      { 'umbrella.example': [PUBLIC_IP] },
      {
        'https://umbrella.example/careers': () => respond(200, html),
        [hit]: () => respond(200, '[{"id":"1"}]'),
      },
    );
    const outcome = await detectAts(app.db, ctx, company.id, { fetch, log });
    expect(outcome).toMatchObject({
      status: 'found',
      kind: 'ats_lever',
      org: 'umbrella-corp',
      via: 'careers_page',
    });
    expect(requested.slice(-2)).toEqual(['https://umbrella.example/careers', hit]);
    expect((await getCompany(app.db, ctx, company.id)).atsRef).toBe('umbrella-corp');
  });

  it('Review Focus 2: a careers_url resolving to 10.x is blocked before any request', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await createCompany(app.db, ctx, {
      name: 'Umbrella Holdings',
      careersUrl: 'https://careers.umbrella.example/',
      status: 'followed',
    });
    const { fetch, requested } = net({ 'careers.umbrella.example': ['10.0.0.12'] }, {});
    const outcome = await detectAts(app.db, ctx, company.id, { fetch, log });
    expect(outcome).toMatchObject({ status: 'none', careersPage: 'blocked' });
    expect((outcome as { detail: string }).detail).toMatch(/private_address/);
    expect(requested.some((u) => u.includes('umbrella.example'))).toBe(false);
  });

  it('Review Focus 2: a linkedin.com careers_url is refused without a request', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await createCompany(app.db, ctx, {
      name: 'Umbrella Holdings',
      careersUrl: 'https://www.linkedin.com/company/x',
      status: 'followed',
    });
    const { fetch, requested } = net({ 'www.linkedin.com': [PUBLIC_IP] }, {});
    const outcome = await detectAts(app.db, ctx, company.id, { fetch, log });
    expect(outcome).toMatchObject({ status: 'none', careersPage: 'blocked' });
    expect((outcome as { detail: string }).detail).toMatch(/host_not_allowed/);
    expect(requested.some((u) => /linkedin/i.test(u))).toBe(false);
    // A URL is present, so the user is not asked for one again.
    const res = await a.request({ method: 'GET', url: `/api/v1/companies/${company.id}` });
    expect(res.json()).toMatchObject({ atsKind: 'none', needsCareersUrl: false });
  });

  it('Review Focus 2: a redirect from the careers page into private space is blocked', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await createCompany(app.db, ctx, {
      name: 'Umbrella Holdings',
      careersUrl: 'https://umbrella.example/careers',
      status: 'followed',
    });
    const { fetch, requested } = net(
      { 'umbrella.example': [PUBLIC_IP], 'intranet.umbrella.example': ['192.168.10.4'] },
      {
        'https://umbrella.example/careers': () =>
          respond(302, '', { location: 'https://intranet.umbrella.example/jobs' }),
      },
    );
    const outcome = await detectAts(app.db, ctx, company.id, { fetch, log });
    expect(outcome).toMatchObject({ status: 'none', careersPage: 'blocked' });
    expect((outcome as { detail: string }).detail).toMatch(/private_address/);
    expect(requested.filter((u) => u.includes('umbrella.example'))).toEqual([
      'https://umbrella.example/careers',
    ]);
  });

  it('no hit and no careers URL: ats_kind none and the company asks for a careers URL', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await createCompany(app.db, ctx, { name: 'Globex', status: 'followed' });
    const { fetch } = net({}, {});
    const outcome = await detectAts(app.db, ctx, company.id, { fetch, log });
    expect(outcome).toEqual({ status: 'none', careersPage: 'absent' });
    expect((await listSources(app.db, ctx, { limit: 50, offset: 0 })).total).toBe(0);
    const res = await a.request({ method: 'GET', url: `/api/v1/companies/${company.id}` });
    expect(res.json()).toMatchObject({
      atsKind: 'none',
      needsCareersUrl: true,
      atsDetectPending: false,
    });
  });

  it('a failing probe (5xx) retries instead of concluding none', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await createCompany(app.db, ctx, { name: 'Globex', status: 'followed' });
    const { fetch } = net(
      {},
      { 'https://boards-api.greenhouse.io/v1/boards/globex/jobs': () => respond(503) },
    );
    await expect(detectAts(app.db, ctx, company.id, { fetch, log })).rejects.toThrow(/retrying/);
    expect((await getCompany(app.db, ctx, company.id)).atsKind).toBeNull();
  });

  it('a migrated board disables the old source and adds the new one', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await createCompany(app.db, ctx, { name: 'Initech', status: 'followed' });
    await detectAts(app.db, ctx, company.id, {
      fetch: net({}, { [LEVER_HIT]: () => respond(200, LEVER_JOBS) }).fetch,
      log,
    });
    const ashbyHit = 'https://api.ashbyhq.com/posting-api/job-board/initech';
    await detectAts(app.db, ctx, company.id, {
      fetch: net({}, { [ashbyHit]: () => respond(200, '{"jobs":[{"id":"a1","title":"PM"}]}') })
        .fetch,
      log,
    });
    const sources = (await listSources(app.db, ctx, { limit: 50, offset: 0 })).items;
    expect(sources.map((s) => [s.kind, s.enabled])).toEqual([
      ['ats_lever', false],
      ['ats_ashby', true],
    ]);
    expect((await getCompany(app.db, ctx, company.id)).atsKind).toBe('ats_ashby');
  });
});

describe('POST /companies/:id/detect-ats and re-verification', () => {
  it('queues one detection job (deduped) and the company reports it pending', async () => {
    const { app, a } = await boot();
    const company = (
      await a.request({ method: 'POST', url: '/api/v1/companies', payload: { name: 'Initech' } })
    ).json();
    const first = await a.request({
      method: 'POST',
      url: `/api/v1/companies/${company.id}/detect-ats`,
    });
    expect(first.statusCode).toBe(202);
    const second = await a.request({
      method: 'POST',
      url: `/api/v1/companies/${company.id}/detect-ats`,
    });
    expect(second.json().jobId).toBe(first.json().jobId);
    const list = await a.request({ method: 'GET', url: '/api/v1/companies' });
    expect(list.json().items[0]).toMatchObject({ atsDetectPending: true, needsCareersUrl: false });

    app.jobs.services.sourceFetch = net({}, { [LEVER_HIT]: () => respond(200, LEVER_JOBS) }).fetch;
    await app.jobs.drain();
    const job = (await app.db.select().from(jobs).where(eq(jobs.id, first.json().jobId)).get())!;
    expect(job.kind).toBe(ATS_DETECT_KIND);
    expect(job.status).toBe('done');
    const after = await a.request({ method: 'GET', url: `/api/v1/companies/${company.id}` });
    expect(after.json()).toMatchObject({ atsKind: 'ats_lever', atsDetectPending: false });
  });

  it('re-verification queues followed companies unchecked or older than 30 days only', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const now = Date.now();
    const make = async (name: string, status: 'followed' | 'none', verifiedAt: number | null) => {
      const c = await createCompany(app.db, ctx, { name, status });
      await app.db
        .update(companies)
        .set({ atsVerifiedAt: verifiedAt })
        .where(eq(companies.id, c.id))
        .run();
      return c.id;
    };
    const stale = await make('Stale', 'followed', now - REVERIFY_AFTER_MS - 1000);
    const never = await make('Never', 'followed', null);
    await make('Fresh', 'followed', now - 1000);
    await make('NotFollowed', 'none', null);
    expect(await queueReverification(app.db, now)).toBe(2);
    const queued = (
      await app.db.select().from(jobs).where(eq(jobs.kind, ATS_DETECT_KIND)).all()
    ).map((j) => (j.payload as { companyId: string }).companyId);
    expect(queued.sort()).toEqual([stale, never].sort());
    const row = await app.db
      .select()
      .from(settings)
      .where(eq(settings.key, `schedule:${ATS_REVERIFY_KIND}`))
      .get();
    expect(row?.value).toEqual({ cron: ATS_REVERIFY_CRON, enabled: true });
  });

  assertIsolated({
    name: 'POST /companies/:id/detect-ats',
    create: async (c) =>
      (
        await c.request({ method: 'POST', url: '/api/v1/companies', payload: { name: 'Initech' } })
      ).json().id,
    read: (c, id) => c.request({ method: 'POST', url: `/api/v1/companies/${id}/detect-ats` }),
  });
});
