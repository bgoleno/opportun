// The board probe after a company suggestion (https://github.com/bgoleno/opportun/issues/221, #190
// N5a): one public request to the company's job board, with no AI call, stores how many jobs it has
// open and how many of them the pre-filter passes for the user's role targets. Every request goes
// through the real safeFetch logic over a scripted DNS table and transport, as in atsDetect.test.ts.
import { runStructured } from '@opportun/ai';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSources, type SourceContext } from '../src/adapters/discoverySource';
import { companies, jobs } from '../src/db/schema';
import { AtsDetectTransientError } from '../src/jobs/atsDetect';
import {
  BOARD_PROBE_KIND,
  boardProbeDedupeKey,
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
