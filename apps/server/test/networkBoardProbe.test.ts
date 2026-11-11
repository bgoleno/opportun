// The nightly network probe (https://github.com/bgoleno/opportun/issues/296): tl's criteria 1 to 14
// on the issue, sec's conditions folded in. Every request goes through the real safeFetch over a
// scripted DNS table and transport, as in atsDetect.test.ts, and every call the probe makes is
// counted before safeFetch sees it, so a refused request to a private address counts too.
import { runStructured } from '@opportun/ai';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSources, type SourceContext } from '../src/adapters/discoverySource';
import { companies, jobs } from '../src/db/schema';
import { slugCandidates } from '../src/jobs/atsDetect';
import {
  NETWORK_BOARD_CHECK_SETTING,
  NETWORK_PROBE_FAILED_NIGHTS,
  NETWORK_PROBE_KIND,
  NETWORK_PROBE_STOPPED,
  NETWORK_PROBES_PER_NIGHT,
  nightStart,
  sweepNetworkProbes,
} from '../src/jobs/networkBoardProbe';
import { createSafeFetch, type RawResponse } from '../src/lib/safeFetch';
import { listSources } from '../src/repos/discovery';
import { writeUserSetting } from '../src/repos/userSettings';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

/** 05:20 on a day, after the sweep's 05:15, in the server's own time. */
function at0520(day: number): number {
  return new Date(2026, 10, day, 5, 20).getTime();
}

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  // Only the clock: the night's count reads each job's createdAt, so the clock the sweep and the
  // queue read must be the night the test is in.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at0520(11));
});
afterEach(() => {
  vi.useRealTimers();
  resetSources();
});

const PUBLIC_IP = '93.184.216.34';
const BOARD_HOSTS = ['boards-api.greenhouse.io', 'api.lever.co', 'api.ashbyhq.com'];
const DNS: Record<string, string[]> = {
  ...Object.fromEntries(BOARD_HOSTS.map((h) => [h, [PUBLIC_IP]])),
  // Hosts the probe must never reach: a company's own site and a Workday site.
  'careers.initech.example': [PUBLIC_IP],
  'initech.wd5.myworkdayjobs.com': [PUBLIC_IP],
};

function respond(status: number, text = ''): RawResponse {
  return {
    status,
    headers: {},
    body: (async function* () {
      if (text.length > 0) yield Buffer.from(text);
    })(),
  };
}

/**
 * A safeFetch over the DNS table and a URL -> response map (anything unmapped is a 404), with every
 * call counted before safeFetch's own checks: `called` holds each URL the probe asked for.
 */
function net(routes: Record<string, () => RawResponse> = {}) {
  const called: string[] = [];
  const table = new Map(Object.entries(DNS));
  const safe = createSafeFetch({
    now: () => 0,
    sleep: async () => undefined,
    resolve: async (host) => {
      const ips = table.get(host);
      if (ips === undefined) throw new Error(`no dns entry for ${host}`);
      return ips;
    },
    request: async (target) => {
      const route = new Map(Object.entries(routes)).get(target.url.href);
      return route === undefined ? respond(404, '{}') : route();
    },
  });
  const fetch: SourceContext['fetch'] = async (url, opts) => {
    called.push(url);
    return await safe(url, opts);
  };
  return { fetch, called, hosts: () => called.map((u) => new URL(u).host) };
}

const greenhouse = (slug: string) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
const jobList = (slug: string, ...titles: string[]) =>
  JSON.stringify({
    jobs: titles.map((title, i) => ({
      id: i + 1,
      title,
      location: { name: 'Remote' },
      absolute_url: `https://boards.greenhouse.io/${slug}/jobs/${i + 1}`,
    })),
  });
/** A Greenhouse board for `slug`, serving `titles`. */
const boardFor = (slug: string, ...titles: string[]) => ({
  [greenhouse(slug)]: () => respond(200, jobList(slug, ...titles)),
  [`${greenhouse(slug)}?content=true`]: () => respond(200, jobList(slug, ...titles)),
});

/** A company the user knows `contacts` people at, through the API a contact is added by. */
async function inNetwork(c: TestClient, company: string, contacts = 1): Promise<string> {
  for (let i = 0; i < contacts; i++) {
    const res = await c.request({
      method: 'POST',
      url: '/api/v1/network',
      payload: { name: `Contact ${i} at ${company}`, company },
    });
    expect(res.statusCode, res.body).toBe(201);
  }
  const companiesRes = await c.request({ method: 'GET', url: '/api/v1/companies?limit=200' });
  const all = (companiesRes.json() as { items: { id: string; name: string }[] }).items;
  return all.find((x) => x.name === company)!.id;
}

const turnOn = (app: FastifyInstance, c: TestClient, on = true) =>
  writeUserSetting(app.db, ctxOf(c), NETWORK_BOARD_CHECK_SETTING, on);

const rowOf = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(companies).where(eq(companies.id, id)).get())!;

const probeJobs = (app: FastifyInstance, c: TestClient) =>
  app.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, NETWORK_PROBE_KIND), eq(jobs.userId, c.userId)))
    .all();

/** One night: the sweep at `now`, then every job it queued, run with `fetch`. */
async function night(app: FastifyInstance, now: number, fetch: SourceContext['fetch']) {
  vi.setSystemTime(now);
  app.jobs.services.sourceFetch = fetch;
  const queued = await sweepNetworkProbes(app.db, now);
  await app.jobs.drain();
  return queued;
}

describe('the nightly network probe (#296)', () => {
  describe('the setting', () => {
    it('is off by default, and then the job makes no request at all', async () => {
      const { app, a } = await boot();
      await inNetwork(a, 'Initech');
      const res = await a.request({ method: 'GET', url: '/api/v1/settings/network-board-check' });
      expect(res.json()).toEqual({ enabled: false });
      const n = net(boardFor('initech', 'Platform Engineer'));
      expect(await night(app, at0520(12), n.fetch)).toBe(0);
      expect(n.called).toEqual([]);
      expect(await probeJobs(app, a)).toEqual([]);
    });

    it('is turned on and off through its route, for that user only', async () => {
      const { a, b } = await boot();
      const put = await a.request({
        method: 'PUT',
        url: '/api/v1/settings/network-board-check',
        payload: { enabled: true },
      });
      expect(put.statusCode, put.body).toBe(200);
      const get = (c: TestClient) =>
        c.request({ method: 'GET', url: '/api/v1/settings/network-board-check' });
      expect((await get(a)).json()).toEqual({ enabled: true });
      expect((await get(b)).json()).toEqual({ enabled: false });
    });

    it('with two users and the setting on for one, the other user’s network gets no request', async () => {
      const { app, a, b } = await boot();
      await inNetwork(a, 'Initech');
      await inNetwork(b, 'Hooli');
      await turnOn(app, a);
      const n = net({ ...boardFor('initech', 'Platform Engineer'), ...boardFor('hooli', 'Sales') });
      await night(app, at0520(12), n.fetch);
      expect(n.called.some((u) => u.includes('hooli'))).toBe(false);
      expect(n.called.some((u) => u.includes('initech'))).toBe(true);
      expect(await probeJobs(app, b)).toEqual([]);
    });

    it('turned off after the pick, the probe makes no request', async () => {
      const { app, a } = await boot();
      await inNetwork(a, 'Initech');
      await turnOn(app, a);
      const n = net(boardFor('initech', 'Platform Engineer'));
      vi.setSystemTime(at0520(12));
      app.jobs.services.sourceFetch = n.fetch;
      expect(await sweepNetworkProbes(app.db, at0520(12))).toBe(1);
      await turnOn(app, a, false);
      await app.jobs.drain();
      expect(n.called).toEqual([]);
    });
  });

  describe('one probe', () => {
    it('stores the board, the counts and the titles; the source stays disabled; no AI call', async () => {
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      await turnOn(app, a);
      const n = net(boardFor('initech', 'Platform Engineer', 'Account Executive'));
      await night(app, at0520(12), n.fetch);
      const row = await rowOf(app, id);
      expect(row).toMatchObject({
        atsKind: 'ats_greenhouse',
        atsRef: 'initech',
        boardOpenJobs: 2,
        boardTitles: ['Platform Engineer', 'Account Executive'],
        status: 'none',
      });
      expect(row.boardProbedAt).not.toBeNull();
      const sources = (await listSources(app.db, ctxOf(a), { limit: 50, offset: 0 })).items;
      expect(sources.map((s) => [s.companyId, s.enabled])).toEqual([[id, false]]);
      expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
      // Through the vendor queue, as its own kind.
      expect((await probeJobs(app, a)).map((j) => j.status)).toEqual(['done']);
    });

    it('reaches only the three board hosts: never a careers page, never a Workday site', async () => {
      const { app, a } = await boot();
      const ids = [
        await inNetwork(a, 'Initech'),
        await inNetwork(a, 'Workday Co'),
        await inNetwork(a, 'Private Co'),
      ];
      const careers = [
        'https://careers.initech.example/jobs',
        'https://initech.wd5.myworkdayjobs.com/External',
        'https://10.0.0.5/careers',
      ];
      for (const [i, id] of ids.entries()) {
        await app.db
          .update(companies)
          .set({ careersUrl: careers[i] })
          .where(eq(companies.id, id))
          .run();
      }
      await turnOn(app, a);
      const n = net();
      await night(app, at0520(12), n.fetch);
      expect(n.called.length).toBeGreaterThan(0);
      for (const host of n.hosts()) expect(BOARD_HOSTS).toContain(host);
      for (const url of careers) expect(n.called).not.toContain(url);
      // No board on any of the three hosts: recorded once, with no careers URL asked for.
      for (const id of ids) expect(await rowOf(app, id)).toMatchObject({ atsKind: 'none' });
    });

    it('no board found is recorded once, and not tried again on a later night', async () => {
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      await turnOn(app, a);
      await night(app, at0520(12), net().fetch);
      expect(await rowOf(app, id)).toMatchObject({ atsKind: 'none', boardOpenJobs: null });
      expect((await rowOf(app, id)).boardProbedAt).not.toBeNull();
      const later = net();
      expect(await night(app, at0520(13), later.fetch)).toBe(0);
      expect(later.called).toEqual([]);
    });

    it('a vendor error records nothing, and the company is tried again on a later night', async () => {
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      await turnOn(app, a);
      // The vendor's host does not resolve: an error, not an answer, and not a slow-down.
      const failing = net();
      const broken: SourceContext['fetch'] = async (url, opts) => {
        if (url.startsWith('https://api.lever.co/')) {
          failing.called.push(url);
          throw new Error('getaddrinfo ENOTFOUND api.lever.co');
        }
        return await failing.fetch(url, opts);
      };
      await night(app, at0520(12), broken);
      expect(await rowOf(app, id)).toMatchObject({
        atsKind: null,
        boardProbedAt: null,
        boardProbeFailedNights: 1,
      });
      const next = net(boardFor('initech', 'Platform Engineer'));
      expect(await night(app, at0520(13), next.fetch)).toBe(1);
      expect(await rowOf(app, id)).toMatchObject({ atsKind: 'ats_greenhouse' });
    });

    it(`a provider failing on ${NETWORK_PROBE_FAILED_NIGHTS} nights is recorded as no board`, async () => {
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      await turnOn(app, a);
      for (let day = 12; day < 12 + NETWORK_PROBE_FAILED_NIGHTS; day++) {
        await night(app, at0520(day), net({ [greenhouse('initech')]: () => respond(503) }).fetch);
      }
      expect(await rowOf(app, id)).toMatchObject({
        atsKind: 'none',
        boardProbeFailedNights: NETWORK_PROBE_FAILED_NIGHTS,
      });
      expect((await rowOf(app, id)).boardProbedAt).not.toBeNull();
      const after = net();
      expect(await night(app, at0520(20), after.fetch)).toBe(0);
      expect(after.called).toEqual([]);
    });
  });

  describe('the night', () => {
    it(`at most ${NETWORK_PROBES_PER_NIGHT} companies, most contacts first; a second run adds none`, async () => {
      const { app, a } = await boot();
      // 22 companies: one with three contacts, one with two, the rest with one.
      const most = await inNetwork(a, 'Zeta Most', 3);
      const second = await inNetwork(a, 'Yotta Second', 2);
      const ones: string[] = [];
      for (let i = 0; i < 20; i++)
        ones.push(await inNetwork(a, `Company ${String(i).padStart(2, '0')}`));
      await turnOn(app, a);
      const n = net();
      expect(await night(app, at0520(12), n.fetch)).toBe(NETWORK_PROBES_PER_NIGHT);
      const probed = async (id: string) => (await rowOf(app, id)).boardProbedAt !== null;
      expect(await probed(most)).toBe(true);
      expect(await probed(second)).toBe(true);
      // By name among the ones: the last two wait.
      expect(await probed(ones[17]!)).toBe(true);
      expect(await probed(ones[18]!)).toBe(false);
      expect(await probed(ones[19]!)).toBe(false);
      // Later the same night: nothing more.
      expect(await night(app, at0520(12) + 3 * 60 * 60_000, n.fetch)).toBe(0);
      // The next night: the two that waited.
      expect(await night(app, at0520(13), n.fetch)).toBe(2);
    });

    it('a vendor that says slow down ends the night: the next probe makes no request', async () => {
      const { app, a } = await boot();
      const first = await inNetwork(a, 'Initech', 2);
      const second = await inNetwork(a, 'Hooli');
      await turnOn(app, a);
      const n = net({ [greenhouse('initech')]: () => respond(429) });
      expect(await night(app, at0520(12), n.fetch)).toBe(2);
      // The 429 was the first request, and nothing followed it.
      expect(n.called).toEqual([greenhouse('initech')]);
      expect(await rowOf(app, first)).toMatchObject({ atsKind: null, boardProbedAt: null });
      expect(await rowOf(app, second)).toMatchObject({ atsKind: null, boardProbedAt: null });
      const [, cancelled] = (await probeJobs(app, a)).sort((x, y) => x.createdAt - y.createdAt);
      expect(cancelled).toMatchObject({ status: 'dead', lastError: NETWORK_PROBE_STOPPED });
      // The rest wait for the next night.
      expect(await night(app, at0520(12) + 60 * 60_000, n.fetch)).toBe(0);
      const next = net(boardFor('hooli', 'Sales'));
      expect(await night(app, at0520(13), next.fetch)).toBe(2);
      expect(await rowOf(app, second)).toMatchObject({ atsKind: 'ats_greenhouse' });
    });

    it('a 5xx ends the night as a 429 does', async () => {
      const { app, a } = await boot();
      await inNetwork(a, 'Initech', 2);
      await inNetwork(a, 'Hooli');
      await turnOn(app, a);
      const n = net({ [greenhouse('initech')]: () => respond(502) });
      await night(app, at0520(12), n.fetch);
      expect(n.called).toEqual([greenhouse('initech')]);
    });
  });

  describe('a company that changed between the pick and the probe', () => {
    it('denied: no request at all, and nothing stored', async () => {
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      await turnOn(app, a);
      const n = net(boardFor('initech', 'Platform Engineer'));
      vi.setSystemTime(at0520(12));
      app.jobs.services.sourceFetch = n.fetch;
      await sweepNetworkProbes(app.db, at0520(12));
      const res = await a.request({
        method: 'PATCH',
        url: `/api/v1/companies/${id}`,
        payload: { status: 'denied' },
      });
      expect(res.statusCode, res.body).toBe(200);
      await app.jobs.drain();
      expect(n.called).toEqual([]);
      expect((await rowOf(app, id)).boardProbedAt).toBeNull();
    });

    it('followed: this job makes no request, and Follow’s own detection ends with the source enabled', async () => {
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      await turnOn(app, a);
      const n = net(boardFor('initech', 'Platform Engineer'));
      vi.setSystemTime(at0520(12));
      app.jobs.services.sourceFetch = n.fetch;
      await sweepNetworkProbes(app.db, at0520(12));
      const res = await a.request({
        method: 'PATCH',
        url: `/api/v1/companies/${id}`,
        payload: { status: 'followed' },
      });
      expect(res.statusCode, res.body).toBe(200);
      await app.jobs.drain();
      const [probe] = await probeJobs(app, a);
      expect(probe?.result).toEqual({ status: 'skipped', reason: 'followed' });
      const sources = (await listSources(app.db, ctxOf(a), { limit: 50, offset: 0 })).items;
      expect(sources.map((s) => [s.companyId, s.enabled])).toEqual([[id, true]]);
    });
  });

  it('a board name guessed from a company name stays one path segment', () => {
    const SLUG = /^[a-z0-9-]{1,100}$/;
    for (const name of [
      'Acme/../admin',
      'Acme?x=1',
      'Acme#frag',
      '..',
      'Acme%2fadmin',
      'Ünïcödé GmbH',
      '株式会社テスト',
      'Ελληνική Εταιρεία',
      '/',
    ]) {
      for (const guess of slugCandidates(name, null)) expect(guess, name).toMatch(SLUG);
    }
    expect(slugCandidates('株式会社テスト', null)).toEqual([]);
  });

  it('tonight starts at the latest 05:15, in the server’s own time', () => {
    expect(nightStart(new Date(2026, 10, 12, 5, 20).getTime())).toBe(
      new Date(2026, 10, 12, 5, 15).getTime(),
    );
    expect(nightStart(new Date(2026, 10, 12, 5, 15).getTime())).toBe(
      new Date(2026, 10, 12, 5, 15).getTime(),
    );
    expect(nightStart(new Date(2026, 10, 12, 5, 10).getTime())).toBe(
      new Date(2026, 10, 11, 5, 15).getTime(),
    );
  });
});
