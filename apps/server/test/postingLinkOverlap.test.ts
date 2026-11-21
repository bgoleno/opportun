// https://github.com/bgoleno/opportun/issues/685 (qa's third exploratory pass): a posting-link save
// checked the company's Greenhouse boards before its write, so of two overlapping saves the one
// whose check finished last was stored, not the one sent last; and the first board to hang took
// the whole check budget, so the next boards were never asked. As tl decided on the issue: the
// link is written at once and the identity after, only while the link is still that one; each
// board gets its own share of the budget; and a save that ran out of time before its boards
// answered leaves a one-off job to finish the check.
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { jobs, opportunities } from '../src/db/schema';
import { POSTING_CHECK_KIND, verifyEmbeddedGreenhouse } from '../src/lib/greenhouseEmbed';
import type { safeFetch } from '../src/lib/safeFetch';
import { createCompany } from '../src/repos/companies';
import { createSource } from '../src/repos/discovery';
import { createOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { runQueuedJob } from './runQueuedJob';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const link = (jid: string) => `https://careers.example.com/jobs?gh_jid=${jid}`;
const JOB = /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs\/([0-9]+)$/;

type Answer = 'yes' | 'no' | 'fail' | Promise<'yes' | 'no' | 'fail'>;

/** A Greenhouse API whose answer per board and job the test decides, recording each request. */
function greenhouse(answer: (token: string, jid: string) => Answer) {
  const asked: { token: string; jid: string; timeoutMs: number | undefined }[] = [];
  const fetch = (async (url: string, init?: { timeoutMs?: number }) => {
    const m = JOB.exec(url);
    if (m === null) throw new Error(`unexpected request: ${url}`);
    const [, token, jid] = m as unknown as [string, string, string];
    asked.push({ token, jid, timeoutMs: init?.timeoutMs });
    const a = await answer(token, jid);
    if (a === 'fail') throw new Error('network');
    return {
      status: a === 'yes' ? 200 : 404,
      headers: new Headers(),
      body: Buffer.from(a === 'yes' ? JSON.stringify({ id: Number(jid) }) : '{}'),
    };
  }) as unknown as typeof safeFetch;
  return { asked, fetch };
}

async function companyWithBoards(
  app: Awaited<ReturnType<typeof boot>>['app'],
  c: TestClient,
  boards: string[],
) {
  const ctx = ctxOf(c);
  const [first, ...rest] = boards;
  const co = await createCompany(app.db, ctx, {
    name: 'Example Corp',
    atsKind: 'ats_greenhouse',
    atsRef: first!,
    atsVerifiedAt: Date.now(),
  });
  // Sources are asked newest first, so they are made in reverse: the boards are asked in order.
  for (const org of [...rest].reverse()) {
    await createSource(app.db, ctx, { kind: 'ats_greenhouse', config: { org }, companyId: co.id });
  }
  const opp = await createOpportunity(app.db, ctx, {
    companyName: 'Example Corp',
    title: 'Staff Engineer',
    sourceKind: 'manual',
  });
  return { ctx, opp };
}

const patch = (c: TestClient, id: string, postingUrl: string) =>
  c.request({ method: 'PATCH', url: `/api/v1/opportunities/${id}`, payload: { postingUrl } });

const stored = async (app: Awaited<ReturnType<typeof boot>>['app'], id: string) =>
  (await app.db
    .select({ postingUrl: opportunities.postingUrl, atsJobRef: opportunities.atsJobRef })
    .from(opportunities)
    .where(eq(opportunities.id, id))
    .get())!;

const checks = (app: Awaited<ReturnType<typeof boot>>['app']) =>
  app.db.select().from(jobs).where(eq(jobs.kind, POSTING_CHECK_KIND)).all();

describe('overlapping posting-link saves: the last one sent is stored (#685 criterion 1)', () => {
  it("an earlier save whose board answers last does not overwrite the later save's link", async () => {
    const { app, a } = await boot();
    const { opp } = await companyWithBoards(app, a, ['board']);
    let answerFirst!: () => void;
    const firstHeld = new Promise<'yes'>((r) => (answerFirst = () => r('yes')));
    let firstAsked!: () => void;
    const firstReached = new Promise<void>((r) => (firstAsked = r));
    const gh = greenhouse((_token, jid) => {
      if (jid === '7101') {
        firstAsked();
        return firstHeld;
      }
      return 'yes';
    });
    app.jobs.services.sourceFetch = gh.fetch;

    const earlier = patch(a, opp.id, link('7101'));
    await firstReached;
    const later = await patch(a, opp.id, link('7102'));
    expect(later.statusCode, later.body).toBe(200);
    answerFirst();
    const earlierRes = await earlier;
    expect(earlierRes.statusCode, earlierRes.body).toBe(200);

    const row = await stored(app, opp.id);
    expect(row.postingUrl).toBe(link('7102'));
    expect(row.atsJobRef).toMatchObject({
      kind: 'ats_greenhouse',
      org: 'board',
      externalId: '7102',
    });
    // The earlier save answers with the row as it now is, the later link (tl on #685).
    expect(earlierRes.json<{ postingUrl: string }>().postingUrl).toBe(link('7102'));
  });

  it("an earlier save's identity is never put on a later link that no board holds", async () => {
    const { app, a } = await boot();
    const { opp } = await companyWithBoards(app, a, ['board']);
    let answerFirst!: () => void;
    const firstHeld = new Promise<'yes'>((r) => (answerFirst = () => r('yes')));
    let firstAsked!: () => void;
    const firstReached = new Promise<void>((r) => (firstAsked = r));
    app.jobs.services.sourceFetch = greenhouse((_token, jid) => {
      if (jid === '7101') {
        firstAsked();
        return firstHeld;
      }
      return 'no';
    }).fetch;

    const earlier = patch(a, opp.id, link('7101'));
    await firstReached;
    expect((await patch(a, opp.id, link('7102'))).statusCode).toBe(200);
    answerFirst();
    expect((await earlier).statusCode).toBe(200);

    const row = await stored(app, opp.id);
    expect(row.postingUrl).toBe(link('7102'));
    expect(row.atsJobRef).toBeNull();
  });
});

describe('each board gets its own share of the check budget (#685 criterion 2)', () => {
  it('a first board that hangs leaves the second its time, and the second gives the identity', async () => {
    const { app, a } = await boot();
    const { ctx, opp } = await companyWithBoards(app, a, ['hangs', 'holds', 'third']);
    const gh = greenhouse((token) =>
      token === 'hangs' ? new Promise<'fail'>(() => {}) : token === 'holds' ? 'yes' : 'no',
    );
    // A board that hangs answers only when its own time limit ends it, as safeFetch's does.
    const fetch = (async (url: string, init?: { timeoutMs?: number }) => {
      if (url.includes('/boards/hangs/')) {
        gh.asked.push({ token: 'hangs', jid: '7101', timeoutMs: init?.timeoutMs });
        await new Promise((r) => setTimeout(r, init?.timeoutMs ?? 1000));
        throw new Error('timeout');
      }
      return gh.fetch(url, init as never);
    }) as unknown as typeof safeFetch;
    const ref = await verifyEmbeddedGreenhouse(
      app.db,
      ctx,
      opp,
      link('7101'),
      { fetch, log: { warn: () => {} } as never },
      Date.now(),
      300,
    );
    expect(ref).toMatchObject({ org: 'holds', externalId: '7101' });
    expect(gh.asked.map((x) => x.token)).toEqual(['hangs', 'holds']);
    // The first board's share: a third of the budget, not all of it.
    expect(gh.asked[0]!.timeoutMs).toBeLessThanOrEqual(100);
  });
});

describe('a save that ran out of time leaves a job to finish the check (#685 criterion 3)', () => {
  it('a board that did not answer queues the check; the job fills the identity in', async () => {
    const { app, a } = await boot();
    const { opp } = await companyWithBoards(app, a, ['board']);
    let up = false;
    app.jobs.services.sourceFetch = greenhouse(() => (up ? 'yes' : 'fail')).fetch;
    const res = await patch(a, opp.id, link('7101'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ atsJobRef: unknown }>().atsJobRef).toBeNull();
    const queued = await checks(app);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.userId).toBe(a.userId);

    up = true;
    await runQueuedJob(app, queued[0]!.id);
    const row = await stored(app, opp.id);
    expect(row.postingUrl).toBe(link('7101'));
    expect(row.atsJobRef).toMatchObject({ org: 'board', externalId: '7101' });
  });

  it('the job leaves a link changed since alone', async () => {
    const { app, a } = await boot();
    const { opp } = await companyWithBoards(app, a, ['board']);
    let up = false;
    app.jobs.services.sourceFetch = greenhouse((_t, jid) =>
      up || jid !== '7101' ? (jid === '7101' ? 'yes' : 'no') : 'fail',
    ).fetch;
    await patch(a, opp.id, link('7101'));
    const [queued] = await checks(app);
    // Changed meanwhile to a link no board holds.
    expect((await patch(a, opp.id, link('7102'))).statusCode).toBe(200);
    up = true;
    await runQueuedJob(app, queued!.id);
    const row = await stored(app, opp.id);
    expect(row.postingUrl).toBe(link('7102'));
    expect(row.atsJobRef).toBeNull();
  });

  it('every board answering no queues nothing', async () => {
    const { app, a } = await boot();
    const { opp } = await companyWithBoards(app, a, ['board', 'other']);
    app.jobs.services.sourceFetch = greenhouse(() => 'no').fetch;
    expect((await patch(a, opp.id, link('7101'))).statusCode).toBe(200);
    expect(await checks(app)).toHaveLength(0);
  });
});

// tl on #714: criterion 2's "concurrent saves to one host each get a fair chance". The host takes
// one request a second, shared by every save (safeFetch's per-host bucket), so four saves that
// each need their third board ask for 12 s of it at once, more than their 5 s budgets cover.
// Each still ends with its identity: in its response, or once its queued check has run.
describe('concurrent saves to one host each end with their identity (#685 criterion 2)', () => {
  it('four saves at once, each needing its third board', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { app, a } = await boot();
      const { ctx } = await companyWithBoards(app, a, ['b1', 'b2', 'b3']);
      const opps = [];
      for (const title of ['Backend', 'Frontend', 'Platform', 'Data']) {
        opps.push(
          await createOpportunity(app.db, ctx, {
            companyName: 'Example Corp',
            title: `${title} Engineer`,
            sourceKind: 'manual',
          }),
        );
      }
      // One request at a time, a second each; a request whose turn would end past its own time
      // limit fails when the limit ends, as safeFetch's does.
      let hostFreeAt = Date.now();
      const fetch = (async (url: string, init?: { timeoutMs?: number }) => {
        const m = JOB.exec(url);
        if (m === null) throw new Error(`unexpected request: ${url}`);
        const [, token, jid] = m as unknown as [string, string, string];
        const start = Date.now();
        const end = Math.max(start, hostFreeAt) + 1000;
        if (init?.timeoutMs !== undefined && end - start > init.timeoutMs) {
          await new Promise((r) => setTimeout(r, init.timeoutMs));
          throw new Error('timeout');
        }
        hostFreeAt = end;
        await new Promise((r) => setTimeout(r, end - start));
        const held = token === 'b3';
        return {
          status: held ? 200 : 404,
          headers: new Headers(),
          body: Buffer.from(held ? JSON.stringify({ id: Number(jid) }) : '{}'),
        };
      }) as unknown as typeof safeFetch;
      app.jobs.services.sourceFetch = fetch;

      const saves = opps.map((o, i) => patch(a, o.id, link(`700${i + 1}`)));
      let settled = false;
      const all = Promise.all(saves).finally(() => (settled = true));
      while (!settled) await vi.advanceTimersByTimeAsync(250);
      for (const res of await all) expect(res.statusCode, res.body).toBe(200);
      // More than the budgets cover: not every save could finish in its 5 s.
      const queued = await checks(app);
      expect(queued.length).toBeGreaterThan(0);
      for (const job of queued) {
        let done = false;
        const running = runQueuedJob(app, job.id).finally(() => (done = true));
        while (!done) await vi.advanceTimersByTimeAsync(250);
        await running;
      }
      for (const [i, o] of opps.entries()) {
        expect((await stored(app, o.id)).atsJobRef).toMatchObject({
          org: 'b3',
          externalId: `700${i + 1}`,
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// tl's optional point on #714: a save that sends its link unchanged asks no board again, as before
// #685 (the form sends every field, so each edit would otherwise re-ask them).
describe('an unchanged link is not checked again (#685)', () => {
  it('re-saving the same link asks no board', async () => {
    const { app, a } = await boot();
    const { opp } = await companyWithBoards(app, a, ['board']);
    const gh = greenhouse(() => 'fail');
    app.jobs.services.sourceFetch = gh.fetch;
    expect((await patch(a, opp.id, link('7101'))).statusCode).toBe(200);
    const asked = gh.asked.length;
    expect(asked).toBeGreaterThan(0);
    expect((await patch(a, opp.id, link('7101'))).statusCode).toBe(200);
    expect(gh.asked.length).toBe(asked);
  });
});
