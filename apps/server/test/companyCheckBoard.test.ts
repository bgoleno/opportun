// Check board (https://github.com/bgoleno/opportun/issues/301, N5b-c of #222): the user's click
// queues the board probe of #221 for that one company. Nothing else probes a company the user has
// not asked about. The route refuses anything that is not the user's own, not a candidate (status
// none or suggested), or already checked (tl's answers on #301), and is limited to 30 clicks per
// user per hour (sec's ruling on #301). Every company is made up.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { companies, jobs } from '../src/db/schema';
import { ATS_DETECT_KIND } from '../src/jobs/atsDetect';
import { BOARD_PROBE_KIND } from '../src/jobs/companyBoardProbe';
import { createCompany } from '../src/repos/companies';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

// The limit's clock is Date, so a pinned start makes "the next hour" exact.
const PINNED_NOW = Date.UTC(2026, 10, 12, 7);
beforeEach(() => {
  vi.useFakeTimers({ now: PINNED_NOW, toFake: ['Date'], shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

const company = (
  app: FastifyInstance,
  c: TestClient,
  name: string,
  over: Partial<Parameters<typeof createCompany>[2]> = {},
) => createCompany(app.db, ctxOf(c), { name, status: 'suggested', ...over });

const check = (c: TestClient, id: string) =>
  c.request({ method: 'POST', url: `/api/v1/companies/${id}/check-board` });

const probeJobs = async (app: FastifyInstance) =>
  await app.db.select().from(jobs).where(eq(jobs.kind, BOARD_PROBE_KIND)).all();

describe('#301: Check board queues the probe for one company', () => {
  it('queues the probe job for that company and answers 202 with its id', async () => {
    const { app, a } = await boot();
    const co = await company(app, a, 'Initech');
    const res = await check(a, co.id);
    expect(res.statusCode, res.body).toBe(202);
    const queued = await probeJobs(app);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      id: res.json().jobId,
      userId: a.userId,
      payload: { companyId: co.id },
      status: 'pending',
    });
  });

  it('works for a company in the network that nobody suggested (status none)', async () => {
    const { app, a } = await boot();
    const co = await company(app, a, 'Globex', { status: 'none' });
    expect((await check(a, co.id)).statusCode).toBe(202);
    expect(await probeJobs(app)).toHaveLength(1);
  });

  it('a second click while one is unfinished is the same job, not another', async () => {
    const { app, a } = await boot();
    const co = await company(app, a, 'Initech');
    const first = await check(a, co.id);
    const second = await check(a, co.id);
    expect(second.statusCode).toBe(202);
    expect(second.json().jobId).toBe(first.json().jobId);
    expect(await probeJobs(app)).toHaveLength(1);
  });
});

describe('#301: the route refuses what cannot be checked, and queues nothing', () => {
  it("another user's company is not found", async () => {
    const { app, a, b } = await boot();
    const theirs = await company(app, b, 'Theirs');
    const res = await check(a, theirs.id);
    expect(res.statusCode).toBe(404);
    expect(await probeJobs(app)).toEqual([]);
  });

  it('a followed or denied company is not a candidate (409 not_a_candidate)', async () => {
    const { app, a } = await boot();
    for (const status of ['followed', 'denied'] as const) {
      const co = await company(app, a, `${status} Co`, { status });
      const res = await check(a, co.id);
      expect(res.statusCode, status).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: 'not_a_candidate' } });
    }
    expect(await probeJobs(app)).toEqual([]);
  });

  it('a company already checked is refused (409 already_checked), a board found or none', async () => {
    const { app, a } = await boot();
    for (const [name, atsKind] of [
      ['Found Co', 'ats_greenhouse'],
      ['None Co', 'none'],
    ] as const) {
      const co = await company(app, a, name);
      await app.db.update(companies).set({ atsKind }).where(eq(companies.id, co.id)).run();
      const res = await check(a, co.id);
      expect(res.statusCode, name).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: 'already_checked' } });
    }
    expect(await probeJobs(app)).toEqual([]);
  });

  it('a company that does not exist is not found', async () => {
    const { a } = await boot();
    expect((await check(a, 'no-such-company')).statusCode).toBe(404);
  });

  it('needs a session', async () => {
    const { app, a } = await boot();
    const co = await company(app, a, 'Initech');
    // The CSRF token is right, the session is missing: the limiter and the lookup never run.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/companies/${co.id}/check-board`,
      cookies: { opportun_csrf: a.csrf },
      headers: { 'x-csrf-token': a.csrf },
    });
    expect(res.statusCode).toBe(401);
    expect(await probeJobs(app)).toEqual([]);
  });
});

describe('#301: nothing probes a company the user has not asked about', () => {
  it('reading the lists, the network and the suggestions queues no probe and no detection', async () => {
    const { app, a } = await boot();
    await company(app, a, 'Suggested Co');
    const network = await company(app, a, 'Network Co', { status: 'none' });
    await a.request({
      method: 'POST',
      url: '/api/v1/network',
      payload: { name: 'Sam Contact', company: network.name },
    });
    for (const url of [
      '/api/v1/discovery/network-companies',
      '/api/v1/discovery/network-companies?showDenied=true',
      '/api/v1/companies/suggestions',
      '/api/v1/companies?status=none',
      `/api/v1/companies/${network.id}`,
      '/api/v1/discovery/industry-profile',
      '/api/v1/discovery/cost-figures',
    ]) {
      const res = await a.request({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
    await app.jobs.drain();
    expect(await probeJobs(app)).toEqual([]);
    expect(await app.db.select().from(jobs).where(eq(jobs.kind, ATS_DETECT_KIND)).all()).toEqual(
      [],
    );
  });
});

describe('#301: the view says what the probe found, and whether it is running', () => {
  it('carries the counts and the probe time, and a pending flag while the job waits', async () => {
    const { app, a } = await boot();
    const co = await company(app, a, 'Initech');
    const before = (await a.request({ method: 'GET', url: `/api/v1/companies/${co.id}` })).json();
    expect(before).toMatchObject({
      boardProbedAt: null,
      boardOpenJobs: null,
      boardPrefilterMatches: null,
      boardProbePending: false,
    });

    await check(a, co.id);
    const waiting = (await a.request({ method: 'GET', url: `/api/v1/companies/${co.id}` })).json();
    expect(waiting.boardProbePending).toBe(true);

    await app.db
      .update(companies)
      .set({ boardProbedAt: 1234, boardOpenJobs: 210, boardPrefilterMatches: 12 })
      .where(eq(companies.id, co.id))
      .run();
    await app.db.update(jobs).set({ status: 'done' }).where(eq(jobs.kind, BOARD_PROBE_KIND)).run();
    const done = (await a.request({ method: 'GET', url: `/api/v1/companies/${co.id}` })).json();
    expect(done).toMatchObject({
      boardProbedAt: 1234,
      boardOpenJobs: 210,
      boardPrefilterMatches: 12,
      boardProbePending: false,
    });
  });
});

describe('#301: at most 30 clicks per user per hour (sec on #301)', () => {
  it('the 31st click is a 429 with the limiter body and a retry-after, and queues nothing', async () => {
    const { app, a } = await boot();
    const clicked = await company(app, a, 'Clicked');
    for (let i = 0; i < 30; i++) expect((await check(a, clicked.id)).statusCode).toBe(202);
    expect(await probeJobs(app)).toHaveLength(1);

    const other = await company(app, a, 'Never queued');
    const res = await check(a, other.id);
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json()).toEqual({
      error: { code: 'rate_limited', reason: 'per_user', max: 30, windowMinutes: 60 },
    });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // The limiter runs before the enqueue: the refused click left the queue as it was.
    expect(await probeJobs(app)).toHaveLength(1);
  });

  it("another user's click is not affected", async () => {
    const { app, a, b } = await boot();
    const mine = await company(app, a, 'Mine');
    for (let i = 0; i < 30; i++) await check(a, mine.id);
    expect((await check(a, mine.id)).statusCode).toBe(429);

    const theirs = await company(app, b, 'Theirs');
    expect((await check(b, theirs.id)).statusCode).toBe(202);
  });

  it('after the retry-after a click goes through', async () => {
    const { app, a } = await boot();
    const first = await company(app, a, 'First');
    for (let i = 0; i < 30; i++) await check(a, first.id);
    const second = await company(app, a, 'Second');
    const refused = await check(a, second.id);
    expect(refused.statusCode).toBe(429);
    const wait = Number(refused.headers['retry-after']);

    vi.setSystemTime(Date.now() + wait * 1000);
    expect((await check(a, second.id)).statusCode).toBe(202);
    expect(await probeJobs(app)).toHaveLength(2);
  });

  it('a refusal from the checks above (409) may spend a unit, and a refusal never queues', async () => {
    const { app, a } = await boot();
    const denied = await company(app, a, 'Denied Co', { status: 'denied' });
    for (let i = 0; i < 30; i++) expect((await check(a, denied.id)).statusCode).toBe(409);
    const fine = await company(app, a, 'Fine Co');
    expect((await check(a, fine.id)).statusCode).toBe(429);
    expect(await probeJobs(app)).toEqual([]);
  });
});
