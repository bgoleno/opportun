// The board probe after a company suggestion (https://github.com/bgoleno/opportun/issues/221, #190
// N5a): one public request to the company's job board, with no AI call, stores how many jobs it has
// open and how many of them the pre-filter passes for the user's role targets. Every request goes
// through the real safeFetch logic over a scripted DNS table and transport, as in atsDetect.test.ts.
import { runStructured } from '@opportun/ai';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSources, type SourceContext } from '../src/adapters/discoverySource';
import type { NormalizedPosting } from '@opportun/core';
import { companies, jobs } from '../src/db/schema';
import { AtsDetectTransientError, detectAts } from '../src/jobs/atsDetect';
import {
  BOARD_PROBE_KIND,
  boardProbeDedupeKey,
  listingTitles,
  probeCompanyBoard,
} from '../src/jobs/companyBoardProbe';
import { createSafeFetch, type RawResponse } from '../src/lib/safeFetch';
import { createCompany } from '../src/repos/companies';
import { listSources } from '../src/repos/discovery';
import { createRoleTarget } from '../src/repos/profile';
import { enqueue } from '../src/jobs/runner';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
beforeEach(() => vi.mocked(runStructured).mockReset());
afterEach(() => {
  vi.useRealTimers();
  resetSources();
});

const PUBLIC_IP = '93.184.216.34';
const DNS: Record<string, string[]> = {
  'boards-api.greenhouse.io': [PUBLIC_IP],
  'api.lever.co': [PUBLIC_IP],
  'api.ashbyhq.com': [PUBLIC_IP],
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

/** A safeFetch over a DNS table and a URL -> response map; anything unmapped is a 404. */
function net(routes: Record<string, () => RawResponse>) {
  const requested: string[] = [];
  const table = new Map(Object.entries(DNS));
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

const DETECT_URL = 'https://boards-api.greenhouse.io/v1/boards/piedpiper/jobs';
const LIST_URL = 'https://boards-api.greenhouse.io/v1/boards/piedpiper/jobs?content=true';
const jobList = (...titles: string[]) =>
  JSON.stringify({
    jobs: titles.map((title, i) => ({
      id: i + 1,
      title,
      location: { name: 'Remote' },
      absolute_url: `https://boards.greenhouse.io/piedpiper/jobs/${i + 1}`,
    })),
  });
/** A board serving 3 jobs: 2 a platform engineer would take, and a sales job. */
const board = () =>
  net({
    [DETECT_URL]: () => respond(200, jobList('Platform Engineer', 'Account Executive')),
    [LIST_URL]: () =>
      respond(200, jobList('Platform Engineer', 'Staff Platform Engineer', 'Account Executive')),
  });

async function suggestion(app: FastifyInstance, c: TestClient, name = 'Pied Piper') {
  return await createCompany(app.db, ctxOf(c), {
    name,
    status: 'suggested',
    domain: 'piedpiper.example',
  });
}

const rowOf = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(companies).where(eq(companies.id, id)).get())!;

describe('company board probe', () => {
  it('stores the open jobs and the pre-filter matches of the board it found, with no AI call', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createRoleTarget(app.db, ctx, { name: 'Platform', titleFamily: 'Platform Engineer' });
    const company = await suggestion(app, a);
    const { fetch } = board();

    const outcome = await probeCompanyBoard(app.db, ctx, company.id, { fetch, log });
    expect(outcome).toEqual({
      status: 'probed',
      kind: 'ats_greenhouse',
      openJobs: 3,
      prefilterMatches: 2,
    });
    const row = await rowOf(app, company.id);
    expect(row).toMatchObject({
      atsKind: 'ats_greenhouse',
      atsRef: 'piedpiper',
      boardOpenJobs: 3,
      boardPrefilterMatches: 2,
    });
    expect(row.boardProbedAt).not.toBeNull();
    // The board is a candidate's: its source exists and is disabled, so it polls nothing.
    const sources = (await listSources(app.db, ctx, { limit: 50, offset: 0 })).items;
    expect(sources.map((s) => [s.kind, s.enabled, s.companyId])).toEqual([
      ['ats_greenhouse', false, company.id],
    ]);
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
  });

  it('keeps the titles it read, in the listing order, for the tagging (#301)', async () => {
    const { app, a } = await boot();
    const company = await suggestion(app, a);
    const { fetch } = board();
    await probeCompanyBoard(app.db, ctxOf(a), company.id, { fetch, log });
    expect((await rowOf(app, company.id)).boardTitles).toEqual([
      'Platform Engineer',
      'Staff Platform Engineer',
      'Account Executive',
    ]);
  });

  it('keeps no titles for a company with no board', async () => {
    const { app, a } = await boot();
    const company = await suggestion(app, a);
    const { fetch } = net({});
    await probeCompanyBoard(app.db, ctxOf(a), company.id, { fetch, log });
    expect((await rowOf(app, company.id)).boardTitles).toBeNull();
  });

  it("judges against this user's active role targets only, not another user's", async () => {
    const { app, a, b } = await boot();
    await createRoleTarget(app.db, ctxOf(a), {
      name: 'Platform',
      titleFamily: 'Platform Engineer',
    });
    // Another user's target would pass the sales job as well.
    await createRoleTarget(app.db, ctxOf(b), { name: 'Sales', titleFamily: 'Account Executive' });
    const company = await suggestion(app, a);
    const { fetch } = board();
    expect(await probeCompanyBoard(app.db, ctxOf(a), company.id, { fetch, log })).toMatchObject({
      openJobs: 3,
      prefilterMatches: 2,
    });
  });

  it("is not the user's edit: the probe's write leaves updatedAt where detection put it", async () => {
    const { app, a } = await boot();
    const company = await suggestion(app, a);
    // Only Date is faked. The listing is read after detection has written, and 5 s pass in it, so a
    // probe write that moved updatedAt would show.
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    const { fetch } = net({
      [DETECT_URL]: () => respond(200, jobList('Platform Engineer')),
      [LIST_URL]: () => {
        vi.setSystemTime(Date.now() + 5_000);
        return respond(200, jobList('Platform Engineer'));
      },
    });
    await probeCompanyBoard(app.db, ctxOf(a), company.id, { fetch, log });
    const row = await rowOf(app, company.id);
    expect(row.boardProbedAt).toBeGreaterThanOrEqual(row.atsVerifiedAt! + 5_000);
    expect(row.updatedAt).toBe(row.atsVerifiedAt);
  });

  // tl on https://github.com/bgoleno/opportun/pull/295: the probe reads the company as suggested, and
  // while it waits on the board the user presses Follow, whose own detection creates the source
  // enabled. The probe then wrote its source from the stale status and switched it off.
  it("a Follow while the probe is in flight leaves the followed company's board switched on", async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await suggestion(app, a);
    const { fetch: plain } = board();
    let followed = false;
    const racing = (async (url: string, opts: unknown) => {
      const res = await (plain as (u: string, o: unknown) => Promise<unknown>)(url, opts);
      if (!followed && url === DETECT_URL) {
        followed = true;
        await app.db
          .update(companies)
          .set({ status: 'followed' })
          .where(eq(companies.id, company.id))
          .run();
        // The Follow's own detection, on another worker: the board source is made enabled.
        await detectAts(app.db, ctx, company.id, { fetch: plain, log });
        const mid = (await listSources(app.db, ctx, { limit: 50, offset: 0 })).items;
        expect(mid.map((x) => x.enabled)).toEqual([true]);
      }
      return res;
    }) as unknown as typeof plain;

    await probeCompanyBoard(app.db, ctx, company.id, { fetch: racing, log });
    expect(followed).toBe(true);
    expect((await rowOf(app, company.id)).status).toBe('followed');
    const after = (await listSources(app.db, ctx, { limit: 50, offset: 0 })).items;
    expect(after.map((x) => [x.kind, x.enabled])).toEqual([['ats_greenhouse', true]]);
  });

  // A Workday listing is read in part: its total is the board's, and the matches are among the rows
  // read (tl on #295: replacing the total with the rows read passed every test).
  it("counts a Workday board's own total as its open jobs, though fewer rows were read", async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createRoleTarget(app.db, ctx, { name: 'PM', titleFamily: 'Product Manager' });
    const HOST = 'globexnetworks.wd5.myworkdayjobs.com';
    const company = await createCompany(app.db, ctx, {
      name: 'Globex Networks',
      status: 'suggested',
      careersUrl: `https://${HOST}/globexexternalcareers`,
    });
    const rowsRead = JSON.parse(
      readFileSync(new URL('./fixtures/ats/workday-jobs.json', import.meta.url), 'utf8'),
    ) as { jobPostings: unknown[] };
    const body = JSON.stringify({ ...rowsRead, total: 40 });
    const jobs = `https://${HOST}/wday/cxs/globexnetworks/globexexternalcareers/jobs`;
    const fetch = (async (url: string) => ({
      status: url === jobs ? 200 : 404,
      headers: new Headers(),
      url,
      body: Buffer.from(url === jobs ? body : '{}'),
    })) as never;
    const outcome = await probeCompanyBoard(app.db, ctx, company.id, { fetch, log });
    expect(outcome).toMatchObject({ status: 'probed', kind: 'ats_workday', openJobs: 40 });
    // Matches are among the rows read: the two product manager postings of the fixture.
    expect(outcome).toMatchObject({ prefilterMatches: 2 });
    expect(await rowOf(app, company.id)).toMatchObject({ boardOpenJobs: 40 });
  });

  it('makes only public board requests, to the providers detection already uses', async () => {
    const { app, a } = await boot();
    const company = await suggestion(app, a);
    const { fetch, requested } = board();
    await probeCompanyBoard(app.db, ctxOf(a), company.id, { fetch, log });
    expect(requested.length).toBeGreaterThan(0);
    for (const url of requested) {
      expect(new URL(url).host).toMatch(
        /^(boards-api\.greenhouse\.io|api\.lever\.co|api\.ashbyhq\.com)$/,
      );
    }
    // The board's listing is read once.
    expect(requested.filter((u) => u === LIST_URL)).toHaveLength(1);
  });

  it('counts the open jobs but not the matches when the user has no active role target', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createRoleTarget(app.db, ctx, {
      name: 'Off',
      titleFamily: 'Platform Engineer',
      active: false,
    });
    const company = await suggestion(app, a);
    const { fetch } = board();
    expect(await probeCompanyBoard(app.db, ctx, company.id, { fetch, log })).toMatchObject({
      status: 'probed',
      openJobs: 3,
      prefilterMatches: null,
    });
    expect(await rowOf(app, company.id)).toMatchObject({
      boardOpenJobs: 3,
      boardPrefilterMatches: null,
    });
  });

  it('records a company with no board as probed, with no counts', async () => {
    const { app, a } = await boot();
    const company = await suggestion(app, a);
    const { fetch } = net({});
    expect(await probeCompanyBoard(app.db, ctxOf(a), company.id, { fetch, log })).toEqual({
      status: 'probed',
      kind: null,
      openJobs: null,
      prefilterMatches: null,
    });
    const row = await rowOf(app, company.id);
    expect(row).toMatchObject({
      atsKind: 'none',
      boardOpenJobs: null,
      boardPrefilterMatches: null,
    });
    expect(row.boardProbedAt).not.toBeNull();
  });

  it('a board that stops answering after it was found is probed with no counts, not retried for good', async () => {
    const { app, a } = await boot();
    const company = await suggestion(app, a);
    const { fetch } = net({ [DETECT_URL]: () => respond(200, jobList('Platform Engineer')) });
    // The listing answers 404 (the board went): no counts, and nothing thrown.
    expect(await probeCompanyBoard(app.db, ctxOf(a), company.id, { fetch, log })).toMatchObject({
      status: 'probed',
      kind: 'ats_greenhouse',
      openJobs: null,
      prefilterMatches: null,
    });
    expect((await rowOf(app, company.id)).boardProbedAt).not.toBeNull();
  });

  it('a provider that is down is retried: nothing is stored', async () => {
    const { app, a } = await boot();
    const company = await suggestion(app, a);
    const { fetch } = net({ [DETECT_URL]: () => respond(503) });
    await expect(
      probeCompanyBoard(app.db, ctxOf(a), company.id, { fetch, log }),
    ).rejects.toBeInstanceOf(AtsDetectTransientError);
    expect(await rowOf(app, company.id)).toMatchObject({
      boardProbedAt: null,
      boardOpenJobs: null,
      atsKind: null,
    });
  });

  it('a listing that fails after the board was found is retried too', async () => {
    const { app, a } = await boot();
    const company = await suggestion(app, a);
    const { fetch } = net({
      [DETECT_URL]: () => respond(200, jobList('Platform Engineer')),
      [LIST_URL]: () => respond(503),
    });
    await expect(probeCompanyBoard(app.db, ctxOf(a), company.id, { fetch, log })).rejects.toThrow();
    expect((await rowOf(app, company.id)).boardProbedAt).toBeNull();
  });

  it("runs as a job for the user it belongs to, and never touches another user's company", async () => {
    const { app, a, b } = await boot();
    const mine = await suggestion(app, a);
    const theirs = await suggestion(app, b, 'Their Piper');
    app.jobs.services.sourceFetch = board().fetch;
    await enqueue(
      app.db,
      BOARD_PROBE_KIND,
      { companyId: mine.id },
      { userId: a.userId, dedupeKey: boardProbeDedupeKey(mine.id) },
    );
    // A job for user a naming user b's company finds no such company and does nothing.
    await enqueue(
      app.db,
      BOARD_PROBE_KIND,
      { companyId: theirs.id },
      { userId: a.userId, dedupeKey: boardProbeDedupeKey(theirs.id) },
    );
    await app.jobs.drain();
    expect((await rowOf(app, mine.id)).boardProbedAt).not.toBeNull();
    expect(await rowOf(app, theirs.id)).toMatchObject({ boardProbedAt: null, atsKind: null });
    const done = await app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, BOARD_PROBE_KIND), eq(jobs.status, 'done')))
      .all();
    expect(done).toHaveLength(2);
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
  });

  it('is not queued twice for one company', async () => {
    const { app, a } = await boot();
    const company = await suggestion(app, a);
    for (let i = 0; i < 3; i++) {
      await enqueue(
        app.db,
        BOARD_PROBE_KIND,
        { companyId: company.id },
        { userId: a.userId, dedupeKey: boardProbeDedupeKey(company.id) },
      );
    }
    expect(
      await app.db.select().from(jobs).where(eq(jobs.kind, BOARD_PROBE_KIND)).all(),
    ).toHaveLength(1);
  });
});

describe('listingTitles (#301)', () => {
  const posting = (title: string, postedAt?: number) =>
    ({
      company: 'Pied Piper',
      title,
      postingUrl: 'https://example.com/1',
      externalId: title,
      ...(postedAt === undefined ? {} : { postedAt }),
    }) as NormalizedPosting;

  it('newest first, different titles only, at most 10', () => {
    const postings = [
      posting('Old Engineer', 100),
      posting('New Engineer', 300),
      posting('Mid Engineer', 200),
      posting('New Engineer', 250),
    ];
    expect(listingTitles(postings)).toEqual(['New Engineer', 'Mid Engineer', 'Old Engineer']);
    const many = Array.from({ length: 15 }, (_, i) => posting(`Role ${i}`, 1000 - i));
    expect(listingTitles(many)).toEqual(Array.from({ length: 10 }, (_, i) => `Role ${i}`));
  });

  it('a posting with no date comes after the dated ones, in the listing order', () => {
    expect(
      listingTitles([posting('Undated A'), posting('Dated', 5), posting('Undated B')]),
    ).toEqual(['Dated', 'Undated A', 'Undated B']);
  });

  it('each title is one line of at most 120 characters, as the tagging cuts them', () => {
    const [long] = listingTitles([posting(`Principal ${'x'.repeat(300)}`)]);
    expect(long!.length).toBeLessThanOrEqual(120);
    const [tagged] = listingTitles([posting('Engineer <script>alert(1)</script>\nSecond line')]);
    expect(tagged).not.toMatch(/[<>\n]/);
    expect(listingTitles([posting('   ')])).toEqual([]);
  });
});
