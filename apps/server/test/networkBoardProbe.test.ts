// The nightly network probe (https://github.com/bgoleno/opportun/issues/296): tl's criteria 1 to 17
// on the issue, on by default as the owner decided, sec's conditions folded in. Every request goes through the real safeFetch over a
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
  queueNightForUser,
  sweepNetworkProbes,
} from '../src/jobs/networkBoardProbe';
import { createSafeFetch, FetchBlockedError, type RawResponse } from '../src/lib/safeFetch';
import { listSources } from '../src/repos/discovery';
import { userSettingExists, writeUserSetting } from '../src/repos/userSettings';
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

/** A 200 that declares a body over any cap: the vendor answered, and the answer cannot be used. */
function tooLarge(): RawResponse {
  return {
    status: 200,
    headers: { 'content-length': String(1024 * 1024 * 1024) },
    body: (async function* () {})(),
  };
}

/** `net`, except that every request is rejected with `err` before any answer, counted all the same. */
function unreachable(err: () => Error) {
  const n = net();
  const fetch: SourceContext['fetch'] = async (url) => {
    n.called.push(url);
    throw err();
  };
  return { ...n, fetch };
}

const greenhouse = (slug: string) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
const lever = (slug: string) => `https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`;
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
    it('is on by default, existing users included: nothing stored reads on, and the job probes', async () => {
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      // No migration writes a value: a user who never changed it has no row at all.
      expect(await userSettingExists(app.db, ctxOf(a), NETWORK_BOARD_CHECK_SETTING)).toBe(false);
      const res = await a.request({ method: 'GET', url: '/api/v1/settings/network-board-check' });
      expect(res.json()).toEqual({ enabled: true });
      const n = net(boardFor('initech', 'Platform Engineer'));
      expect(await night(app, at0520(12), n.fetch)).toBe(1);
      expect(await rowOf(app, id)).toMatchObject({ atsKind: 'ats_greenhouse' });
    });

    it('turned off, the job makes no request at all for that user', async () => {
      const { app, a } = await boot();
      await inNetwork(a, 'Initech');
      await turnOn(app, a, false);
      const n = net(boardFor('initech', 'Platform Engineer'));
      expect(await night(app, at0520(12), n.fetch)).toBe(0);
      expect(n.called).toEqual([]);
      expect(await probeJobs(app, a)).toEqual([]);
    });

    it('a stored value that is neither on nor off reads as off: no request, and the page shows off', async () => {
      const { app, a } = await boot();
      await inNetwork(a, 'Initech');
      // A damaged row: the generic reader would give its fallback, which is now on.
      await writeUserSetting(app.db, ctxOf(a), NETWORK_BOARD_CHECK_SETTING, 'yes');
      const res = await a.request({ method: 'GET', url: '/api/v1/settings/network-board-check' });
      expect(res.json()).toEqual({ enabled: false });
      const n = net(boardFor('initech', 'Platform Engineer'));
      expect(await night(app, at0520(12), n.fetch)).toBe(0);
      expect(n.called).toEqual([]);
    });

    it('is turned off and on through its route, for that user only', async () => {
      const { a, b } = await boot();
      const put = (enabled: boolean) =>
        a.request({
          method: 'PUT',
          url: '/api/v1/settings/network-board-check',
          payload: { enabled },
        });
      const get = (c: TestClient) =>
        c.request({ method: 'GET', url: '/api/v1/settings/network-board-check' });
      const off = await put(false);
      expect(off.statusCode, off.body).toBe(200);
      expect((await get(a)).json()).toEqual({ enabled: false });
      expect((await get(b)).json()).toEqual({ enabled: true });
      expect((await put(true)).statusCode).toBe(200);
      expect((await get(a)).json()).toEqual({ enabled: true });
    });

    it('with two users and the setting off for one, that user’s network gets no request', async () => {
      const { app, a, b } = await boot();
      await inNetwork(a, 'Initech');
      await inNetwork(b, 'Hooli');
      await turnOn(app, b, false);
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
      const withCareers: [string, string][] = [
        [await inNetwork(a, 'Initech'), 'https://careers.initech.example/jobs'],
        [await inNetwork(a, 'Workday Co'), 'https://initech.wd5.myworkdayjobs.com/External'],
        [await inNetwork(a, 'Private Co'), 'https://10.0.0.5/careers'],
      ];
      for (const [id, careersUrl] of withCareers) {
        await app.db.update(companies).set({ careersUrl }).where(eq(companies.id, id)).run();
      }
      const ids = withCareers.map(([id]) => id);
      const careers = withCareers.map(([, url]) => url);
      await turnOn(app, a);
      const n = net();
      await night(app, at0520(12), n.fetch);
      expect(n.called.length).toBeGreaterThan(0);
      for (const host of n.hosts()) expect(BOARD_HOSTS).toContain(host);
      for (const url of careers) expect(n.called).not.toContain(url);
      // No board on any of the three hosts: recorded once, with no careers URL asked for.
      for (const id of ids) expect(await rowOf(app, id)).toMatchObject({ atsKind: 'none' });
    });

    it('a company with a Workday board on record is not this job’s: not picked, no request, the board kept', async () => {
      // tl's blocking 1 on #462: followed, its board found from the careers URL, then unfollowed.
      // This job may not check a Workday board, and its guesses missing must not erase it.
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      await app.db
        .update(companies)
        .set({
          atsKind: 'ats_workday',
          atsRef: 'initech/External',
          careersUrl: 'https://initech.wd5.myworkdayjobs.com/External',
        })
        .where(eq(companies.id, id))
        .run();
      await turnOn(app, a);
      const n = net();
      expect(await night(app, at0520(12), n.fetch)).toBe(0);
      expect(n.called).toEqual([]);
      expect(await rowOf(app, id)).toMatchObject({
        atsKind: 'ats_workday',
        atsRef: 'initech/External',
        boardProbedAt: null,
      });
    });

    it('a Workday board recorded after the pick: the probe makes no request and keeps it', async () => {
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      await turnOn(app, a);
      const n = net();
      vi.setSystemTime(at0520(12));
      app.jobs.services.sourceFetch = n.fetch;
      expect(await sweepNetworkProbes(app.db, at0520(12))).toBe(1);
      await app.db
        .update(companies)
        .set({ atsKind: 'ats_workday', atsRef: 'initech/External' })
        .where(eq(companies.id, id))
        .run();
      await app.jobs.drain();
      expect(n.called).toEqual([]);
      expect(await rowOf(app, id)).toMatchObject({ atsKind: 'ats_workday', boardProbedAt: null });
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

    it('an answer that cannot be used records nothing, and the company is tried again on a later night', async () => {
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      await turnOn(app, a);
      // Lever answers with a body too large to read: an answer, so a failed night, not a slow-down.
      const n = net({ [lever('initech')]: tooLarge });
      await night(app, at0520(12), n.fetch);
      expect(n.hosts()).toContain('api.ashbyhq.com');
      expect(await rowOf(app, id)).toMatchObject({
        atsKind: null,
        boardProbedAt: null,
        boardProbeFailedNights: 1,
      });
      const next = net(boardFor('initech', 'Platform Engineer'));
      expect(await night(app, at0520(13), next.fetch)).toBe(1);
      expect(await rowOf(app, id)).toMatchObject({ atsKind: 'ats_greenhouse' });
    });

    it(`a vendor whose answers cannot be used on ${NETWORK_PROBE_FAILED_NIGHTS} nights is recorded as no board`, async () => {
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      await turnOn(app, a);
      for (let day = 12; day < 12 + NETWORK_PROBE_FAILED_NIGHTS; day++) {
        await night(app, at0520(day), net({ [greenhouse('initech')]: tooLarge }).fetch);
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

    it(`a board found, whose listing cannot be read on ${NETWORK_PROBE_FAILED_NIGHTS} nights, is kept, not "no board"`, async () => {
      // tl's blocking 2 on #462: detection records the board, then the listing read that follows
      // gets an answer it cannot use. Giving up stops the company holding a slot; it keeps the board.
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      await turnOn(app, a);
      const routes = {
        ...boardFor('initech', 'Platform Engineer'),
        [`${greenhouse('initech')}?content=true`]: tooLarge,
      };
      for (let day = 12; day < 12 + NETWORK_PROBE_FAILED_NIGHTS; day++) {
        await night(app, at0520(day), net(routes).fetch);
        expect(await rowOf(app, id)).toMatchObject({
          atsKind: 'ats_greenhouse',
          atsRef: 'initech',
          boardProbeFailedNights: day - 11,
        });
      }
      expect(await rowOf(app, id)).toMatchObject({
        atsKind: 'ats_greenhouse',
        boardOpenJobs: null,
      });
      expect((await rowOf(app, id)).boardProbedAt).not.toBeNull();
      const after = net();
      expect(await night(app, at0520(20), after.fetch)).toBe(0);
      expect(after.called).toEqual([]);
    });

    it('a redirect safeFetch refuses is an answer: a failed night, and the night goes on', async () => {
      // ANSWERED_REFUSALS: the vendor answered, with something that cannot be used.
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      await turnOn(app, a);
      const n = net({ [greenhouse('initech')]: () => ({ ...respond(302), headers: {} }) });
      await night(app, at0520(12), n.fetch);
      // Not a slow-down: Lever and Ashby were still asked.
      expect(n.hosts()).toContain('api.lever.co');
      expect(n.hosts()).toContain('api.ashbyhq.com');
      expect(await rowOf(app, id)).toMatchObject({
        atsKind: null,
        boardProbedAt: null,
        boardProbeFailedNights: 1,
      });
    });

    it('a 200 whose body does not parse is a miss: with no other board, "no board" on the first night', async () => {
      const { app, a } = await boot();
      const id = await inNetwork(a, 'Initech');
      await turnOn(app, a);
      await night(
        app,
        at0520(12),
        net({ [greenhouse('initech')]: () => respond(200, '<html>') }).fetch,
      );
      expect(await rowOf(app, id)).toMatchObject({ atsKind: 'none', boardProbeFailedNights: 0 });
      expect((await rowOf(app, id)).boardProbedAt).not.toBeNull();
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
      // The two probes are queued in the same millisecond (the clock is frozen), so their run_at and
      // created_at tie. The claim breaks the tie by id, which is enqueue order (#465), so the pick
      // order holds on both dialects: Initech, with more contacts, runs first.
      const n = net({
        [greenhouse('initech')]: () => respond(429),
        [greenhouse('hooli')]: () => respond(429),
      });
      expect(await night(app, at0520(12), n.fetch)).toBe(2);
      // The 429 was the first request, and nothing followed it.
      expect(n.called).toEqual([greenhouse('initech')]);
      expect(await rowOf(app, first)).toMatchObject({ atsKind: null, boardProbedAt: null });
      expect(await rowOf(app, second)).toMatchObject({ atsKind: null, boardProbedAt: null });
      const jobsTonight = await probeJobs(app, a);
      expect(jobsTonight).toHaveLength(2);
      const ran = jobsTonight.find((j) => (j.payload as { companyId: string }).companyId === first);
      const cancelled = jobsTonight.find((j) => j !== ran);
      expect(ran).toMatchObject({
        status: 'done',
        result: { status: 'failed', reason: 'slow_down' },
      });
      expect(cancelled).toMatchObject({ status: 'dead', lastError: NETWORK_PROBE_STOPPED });
      // The rest wait for the next night.
      expect(await night(app, at0520(12) + 60 * 60_000, n.fetch)).toBe(0);
      const next = net(boardFor('hooli', 'Sales'));
      expect(await night(app, at0520(13), next.fetch)).toBe(2);
      expect(await rowOf(app, second)).toMatchObject({ atsKind: 'ats_greenhouse' });
    });

    for (const status of [429, 503]) {
      it(`a ${status} from one vendor stops that vendor for every user tonight, and the other two go on`, async () => {
        const { app, a, b } = await boot();
        await inNetwork(a, 'Initech');
        const hooli = await inNetwork(b, 'Hooli');
        const globex = await inNetwork(b, 'Globex');
        await turnOn(app, a);
        await turnOn(app, b);
        // The first user's probe: Greenhouse has no such board, then Lever says slow down.
        const first = net({ [lever('initech')]: () => respond(status) });
        vi.setSystemTime(at0520(12));
        app.jobs.services.sourceFetch = first.fetch;
        expect(await queueNightForUser(app.db, ctxOf(a), at0520(12))).toBe(1);
        await app.jobs.drain();
        expect(first.called).toEqual([greenhouse('initech'), lever('initech')]);
        // The second user's run, later the same night. Globex's board is on Greenhouse; Hooli's
        // only match would be on Lever.
        const later = at0520(12) + 30 * 60_000;
        const second = net(boardFor('globex', 'Platform Engineer'));
        vi.setSystemTime(later);
        app.jobs.services.sourceFetch = second.fetch;
        expect(await queueNightForUser(app.db, ctxOf(b), later)).toBe(2);
        await app.jobs.drain();
        expect(second.hosts()).not.toContain('api.lever.co');
        expect(second.hosts()).toContain('boards-api.greenhouse.io');
        expect(second.hosts()).toContain('api.ashbyhq.com');
        expect(await rowOf(app, globex)).toMatchObject({ atsKind: 'ats_greenhouse' });
        // Not "no board", and not a failed night: it waits for a later night.
        expect(await rowOf(app, hooli)).toMatchObject({
          atsKind: null,
          boardProbedAt: null,
          boardProbeFailedNights: 0,
        });
        // The next night, Lever is asked again.
        const next = net();
        await night(app, at0520(13), next.fetch);
        expect(next.called).toContain(lever('hooli'));
        expect(await rowOf(app, hooli)).toMatchObject({ atsKind: 'none' });
      });
    }

    // https://github.com/bgoleno/opportun/issues/514: the stopped vendor's guess was skipped, so a
    // board with the same name on another vendor can be a decoy of the company's real one.
    it('Greenhouse stopped tonight and a Lever hit for the same slug: nothing recorded, and the company waits', async () => {
      const { app, a, b } = await boot();
      await inNetwork(a, 'Initech');
      const hooli = await inNetwork(b, 'Hooli');
      await turnOn(app, a);
      await turnOn(app, b);
      // The first user's probe: Greenhouse says slow down, so it is stopped for the instance.
      const first = net({ [greenhouse('initech')]: () => respond(429) });
      vi.setSystemTime(at0520(12));
      app.jobs.services.sourceFetch = first.fetch;
      expect(await queueNightForUser(app.db, ctxOf(a), at0520(12))).toBe(1);
      await app.jobs.drain();
      expect(first.called).toEqual([greenhouse('initech')]);
      // Later the same night: the second user's company has a board named hooli on Lever.
      const later = at0520(12) + 30 * 60_000;
      const second = net({
        [lever('hooli')]: () => respond(200, '[{"id":"l1","text":"Staff Platform Engineer"}]'),
      });
      vi.setSystemTime(later);
      app.jobs.services.sourceFetch = second.fetch;
      expect(await queueNightForUser(app.db, ctxOf(b), later)).toBe(1);
      await app.jobs.drain();
      expect(second.hosts()).not.toContain('boards-api.greenhouse.io');
      expect(second.called).toContain(lever('hooli'));
      expect(await rowOf(app, hooli)).toMatchObject({
        atsKind: null,
        boardProbedAt: null,
        boardProbeFailedNights: 0,
      });
      const [probe] = await probeJobs(app, b);
      expect(probe).toMatchObject({
        status: 'done',
        result: { status: 'skipped', reason: 'vendor_stopped' },
      });
    });

    it('a 5xx ends the night as a 429 does', async () => {
      const { app, a } = await boot();
      await inNetwork(a, 'Initech', 2);
      await inNetwork(a, 'Hooli');
      await turnOn(app, a);
      // Either probe can run first (see the 429 test above), so both are told 502.
      const n = net({
        [greenhouse('initech')]: () => respond(502),
        [greenhouse('hooli')]: () => respond(502),
      });
      await night(app, at0520(12), n.fetch);
      expect(n.called).toHaveLength(1);
      expect([greenhouse('initech'), greenhouse('hooli')]).toContain(n.called[0]);
    });

    // tl's ruling on #462 (F1, https://github.com/bgoleno/opportun/pull/462#issuecomment-6841000369):
    // a slow-down, and a request that got no answer at all, say nothing about the company's board.
    for (const status of [429, 503]) {
      it(`a ${status} on ${NETWORK_PROBE_FAILED_NIGHTS} nights records nothing for the company: no failed night, no "no board"`, async () => {
        const { app, a } = await boot();
        const id = await inNetwork(a, 'Initech');
        await turnOn(app, a);
        for (let day = 12; day < 12 + NETWORK_PROBE_FAILED_NIGHTS; day++) {
          const n = net({ [greenhouse('initech')]: () => respond(status) });
          expect(await night(app, at0520(day), n.fetch)).toBe(1);
          expect(n.called).toEqual([greenhouse('initech')]);
          expect(await rowOf(app, id)).toMatchObject({
            atsKind: null,
            boardProbedAt: null,
            boardProbeFailedNights: 0,
          });
        }
        const next = net(boardFor('initech', 'Platform Engineer'));
        expect(await night(app, at0520(12 + NETWORK_PROBE_FAILED_NIGHTS), next.fetch)).toBe(1);
        expect(await rowOf(app, id)).toMatchObject({
          atsKind: 'ats_greenhouse',
          boardProbeFailedNights: 0,
        });
      });
    }

    const NO_ANSWER: [string, () => Error][] = [
      ['a failed DNS lookup', () => new Error('getaddrinfo ENOTFOUND boards-api.greenhouse.io')],
      ['a refused connection', () => new Error('connect ECONNREFUSED 93.184.216.34:443')],
      ['a timeout', () => new FetchBlockedError('timeout', '10000 ms')],
      [
        'a board host resolving to a private address',
        () => new FetchBlockedError('private_address'),
      ],
    ];
    for (const [what, err] of NO_ANSWER) {
      it(`no answer (${what}) on ${NETWORK_PROBE_FAILED_NIGHTS} nights: the night stops after the first request, and nothing is recorded`, async () => {
        const { app, a } = await boot();
        const first = await inNetwork(a, 'Initech', 2);
        const second = await inNetwork(a, 'Hooli');
        await turnOn(app, a);
        for (let day = 12; day < 12 + NETWORK_PROBE_FAILED_NIGHTS; day++) {
          const n = unreachable(err);
          expect(await night(app, at0520(day), n.fetch)).toBe(2);
          // Whichever probe runs first (see the slow-down test) asks once, and nothing follows.
          expect(n.called).toHaveLength(1);
          for (const id of [first, second]) {
            expect(await rowOf(app, id)).toMatchObject({
              atsKind: null,
              boardProbedAt: null,
              boardProbeFailedNights: 0,
            });
          }
        }
        const next = net(boardFor('initech', 'Platform Engineer'));
        expect(await night(app, at0520(12 + NETWORK_PROBE_FAILED_NIGHTS), next.fetch)).toBe(2);
        expect(await rowOf(app, first)).toMatchObject({ atsKind: 'ats_greenhouse' });
        expect(await rowOf(app, second)).toMatchObject({ atsKind: 'none' });
      });
    }

    it('no answer from one vendor stops that vendor for every user tonight, as a 429 does', async () => {
      // sec's P8b on #462: the instance-wide stop holds for a request that got no answer.
      const { app, a, b } = await boot();
      await inNetwork(a, 'Initech');
      const hooli = await inNetwork(b, 'Hooli');
      await turnOn(app, a);
      await turnOn(app, b);
      const first = net();
      const leverDown: SourceContext['fetch'] = async (url, opts) => {
        if (url.startsWith('https://api.lever.co/')) {
          first.called.push(url);
          throw new Error('getaddrinfo ENOTFOUND api.lever.co');
        }
        return await first.fetch(url, opts);
      };
      vi.setSystemTime(at0520(12));
      app.jobs.services.sourceFetch = leverDown;
      expect(await queueNightForUser(app.db, ctxOf(a), at0520(12))).toBe(1);
      await app.jobs.drain();
      expect(first.called).toEqual([greenhouse('initech'), lever('initech')]);
      const later = at0520(12) + 30 * 60_000;
      const second = net();
      vi.setSystemTime(later);
      app.jobs.services.sourceFetch = second.fetch;
      expect(await queueNightForUser(app.db, ctxOf(b), later)).toBe(1);
      await app.jobs.drain();
      expect(second.hosts()).not.toContain('api.lever.co');
      expect(second.hosts()).toContain('api.ashbyhq.com');
      expect(await rowOf(app, hooli)).toMatchObject({
        atsKind: null,
        boardProbedAt: null,
        boardProbeFailedNights: 0,
      });
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
