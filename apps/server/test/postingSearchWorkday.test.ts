// Finding an opportunity's posting on a Workday board (FR-D10 through FR-O1's find-posting flow).
// The board is read from its CXS listing only (titles, paths and requisition ids); a description
// is fetched from the detail endpoint just for the posting(s) the flow settles on, since one
// detail per board row would cost a request per posting. Every request goes to the board's own
// host through the fake Workday server below.
import type { Db } from '../src/db/client';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { communications } from '../src/db/schema';
import type { safeFetch, SafeFetchOptions } from '../src/lib/safeFetch';
import { findPosting } from '../src/lib/postingSearch';
import { createCompany } from '../src/repos/companies';
import { listActivities } from '../src/repos/activities';
import { upsertInbound } from '../src/repos/communications';
import { pointAtStoredBody } from './storedBody';
import { createSource } from '../src/repos/discovery';
import { createOpportunity, getOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/ats/${name}`, import.meta.url), 'utf8');

const HOST = 'globexnetworks.wd5.myworkdayjobs.com';
const CONFIG = { host: HOST, tenant: 'globexnetworks', site: 'globexexternalcareers' };
const CXS = `https://${HOST}/wday/cxs/globexnetworks/globexexternalcareers`;
const JOBS = `${CXS}/jobs`;
const PAN_PATH =
  '/job/Santa-Clara-CA/Principal-Product-Manager---AURL---Web-Protection--CDSS-_JR-000001';
const PAN_LINK = `https://${HOST}/globexexternalcareers${PAN_PATH}`;
const DETAIL_PAN = `${CXS}${PAN_PATH}`;

type Reply = { status: number; body: string };

/** A fake Workday server (every request recorded); unmapped URLs 404. */
function fakeWorkday(routes: Record<string, () => Reply>) {
  const calls: { url: string; opts: SafeFetchOptions }[] = [];
  const table = new Map(Object.entries(routes));
  const fetch = (async (url, opts) => {
    calls.push({ url, opts });
    const r = table.get(url)?.() ?? { status: 404, body: '' };
    return { status: r.status, headers: new Headers(), body: Buffer.from(r.body) };
  }) as typeof safeFetch;
  return { calls, fetch };
}

const healthy = () =>
  fakeWorkday({
    [JOBS]: () => ({ status: 200, body: fixture('workday-jobs.json') }),
    [DETAIL_PAN]: () => ({ status: 200, body: fixture('workday-job.json') }),
  });

const sctx = (fetch: typeof safeFetch) => ({
  fetch,
  log: { warn: () => {}, info: () => {}, error: () => {} } as never,
});

/** A Globex Networks opportunity whose company polls the Workday board. */
async function panOpportunity(app: Awaited<ReturnType<typeof boot>>['app'], c: TestClient) {
  const ctx = ctxOf(c);
  const company = await createCompany(app.db, ctx, {
    name: 'Globex Networks',
    atsKind: 'ats_workday',
    atsRef: 'globexnetworks/globexexternalcareers',
    atsVerifiedAt: Date.now(),
  });
  await createSource(app.db, ctx, { kind: 'ats_workday', config: CONFIG, companyId: company.id });
  return createOpportunity(app.db, ctx, {
    companyName: 'Globex Networks',
    title: 'Principal Product Manager, Web Protection',
    sourceKind: 'import',
  });
}

async function linkMail(app: { db: Db }, c: TestClient, opportunityId: string, body: string) {
  const db = app.db;
  const { id } = await upsertInbound(db, ctxOf(c), 'gmail', {
    externalId: `m-${opportunityId}`,
    threadKey: `t-${opportunityId}`,
    from: 'recruiter@example.com',
    to: ['owner@example.com'],
    subject: 'Principal PM role',
    snippet: body.slice(0, 80),
    bodyText: body,
    sentAt: Date.now(),
  });
  await pointAtStoredBody(db, ctxOf(c).userId, id, `attachments/ab/m-${opportunityId}`);
  await db.update(communications).set({ opportunityId }).where(eq(communications.id, id)).run();
}

describe('findPosting on a Workday board', () => {
  it("resolves a recruiter's Workday link by requisition id, fetching one detail", async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await panOpportunity(app, a);
    const mail = `Here is the req: ${PAN_LINK}/apply`;
    await linkMail(app, a, opp.id, mail);
    const { calls, fetch } = healthy();

    const out = await findPosting(app.db, ctx, opp.id, sctx(fetch), {
      readBody: async () => mail,
    });

    expect(out).toMatchObject({ status: 'exact', via: 'email_link' });
    if (out.status !== 'exact') throw new Error('expected exact');
    expect(out.candidate.posting).toMatchObject({
      externalId: 'JR-000001',
      company: 'Globex Networks',
      postingUrl: PAN_LINK,
    });
    // Sanitized: the description HTML became text.
    expect(out.candidate.posting.descriptionMd).toContain('web protection');
    expect(out.candidate.posting.descriptionMd).not.toMatch(/[<>]/);
    // The link names the posting's path: its detail is fetched directly, no listing read.
    expect(calls.map((c) => c.url)).toEqual([DETAIL_PAN]);
    expect(
      calls.every((c) => c.opts.allowHosts.length === 1 && c.opts.allowHosts[0] === HOST),
    ).toBe(true);
  });

  it('title-matches the board and describes only the single confident candidate', async () => {
    const { app, a } = await boot();
    const opp = await panOpportunity(app, a);
    const { calls, fetch } = healthy();

    const out = await findPosting(app.db, ctxOf(a), opp.id, sctx(fetch), {
      readBody: async () => '',
    });

    expect(out).toMatchObject({ status: 'single', via: 'board' });
    if (out.status !== 'single') throw new Error('expected single');
    expect(out.candidate.posting.externalId).toBe('JR-000001');
    expect(out.candidate.posting.descriptionMd).toContain('web protection');
    expect(calls.map((c) => c.url)).toEqual([JOBS, DETAIL_PAN]);
  });

  it('detects the Workday board from a careers URL when the company has none on record', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'Globex Networks',
      careersUrl: `https://${HOST}/globexexternalcareers`,
    });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Globex Networks',
      title: 'Principal Product Manager, Web Protection',
      sourceKind: 'import',
    });
    const { fetch } = healthy();

    const out = await findPosting(app.db, ctx, opp.id, sctx(fetch), { readBody: async () => '' });

    expect(out).toMatchObject({ status: 'single', via: 'board' });
  });

  it('offers a foreign Workday link for confirmation, described', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    // The company has no board at all; the link names Palo Alto's.
    await createCompany(app.db, ctx, { name: 'Initech' });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Initech',
      title: 'Product Manager',
      sourceKind: 'import',
    });
    await linkMail(app, a, opp.id, `fwd: ${PAN_LINK}`);
    const { calls, fetch } = healthy();

    const out = await findPosting(app.db, ctx, opp.id, sctx(fetch), {
      readBody: async () => `fwd: ${PAN_LINK}`,
    });

    expect(out).toMatchObject({ status: 'candidates', via: 'email_link_unverified' });
    if (out.status !== 'candidates') throw new Error('expected candidates');
    expect(out.candidates[0]!.posting.descriptionMd).toContain('web protection');
    // Of the Workday host (detection probes the slug providers first): the one detail.
    expect(calls.map((c) => c.url).filter((u) => u.includes(HOST))).toEqual([DETAIL_PAN]);
  });

  it('in the service window the flow degrades to candidates instead of failing', async () => {
    const { app, a } = await boot();
    const opp = await panOpportunity(app, a);
    const mail = `Here is the req: ${PAN_LINK}`;
    await linkMail(app, a, opp.id, mail);
    // The listing answered, then the window opened before the detail.
    const { fetch } = fakeWorkday({
      [JOBS]: () => ({ status: 200, body: fixture('workday-jobs.json') }),
      [DETAIL_PAN]: () => ({ status: 503, body: '' }),
    });

    const out = await findPosting(app.db, ctxOf(a), opp.id, sctx(fetch), {
      readBody: async () => mail,
    });

    // Nothing to attach without a description: the user sees the req and can paste.
    expect(out.status).toBe('candidates');
    if (out.status !== 'candidates') throw new Error('expected candidates');
    expect(out.candidates[0]!.posting.externalId).toBe('JR-000001');
    expect(out.candidates[0]!.posting.descriptionMd ?? null).toBeNull();
  });
});

describe('attaching a Workday candidate from the picker', () => {
  it('fetches the description of an undescribed Workday posting before attaching it', async () => {
    const { app, a } = await boot();
    const opp = await panOpportunity(app, a);
    app.jobs.services.sourceFetch = healthy().fetch;

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${opp.id}/posting`,
      payload: {
        posting: {
          company: 'globexnetworks',
          title: 'Principal Product Manager - AURL - Web Protection (CDSS)',
          postingUrl: PAN_LINK,
          externalId: 'JR-000001',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const stored = await getOpportunity(app.db, ctxOf(a), opp.id);
    expect(stored.descriptionMd).toContain('web protection');
    expect(stored.postingUrl).toBe(PAN_LINK);
  });
});

describe('find-posting cost on a large Workday board', () => {
  it('falls back to the listing when the linked posting is gone (404 detail)', async () => {
    const { app, a } = await boot();
    const opp = await panOpportunity(app, a);
    const gone = `https://${HOST}/globexexternalcareers/job/Remote/Old-Role_JR-999999`;
    const mail = `Here is the req: ${gone}`;
    await linkMail(app, a, opp.id, mail);
    const { calls, fetch } = healthy();

    const out = await findPosting(app.db, ctxOf(a), opp.id, sctx(fetch), {
      readBody: async () => mail,
    });

    // The req is not on the board any more; the board's own title match still answers.
    expect(out).toMatchObject({ status: 'single', via: 'board' });
    expect(calls.map((c) => c.url)).toEqual([
      `${CXS}/job/Remote/Old-Role_JR-999999`,
      JOBS,
      DETAIL_PAN,
    ]);
  });

  it('reads at most 10 listing pages per board and says the board was cut short', async () => {
    const { app, a } = await boot();
    const opp = await panOpportunity(app, a);
    const size = 500;
    const calls: string[] = [];
    const fetch = (async (url: string, opts: SafeFetchOptions) => {
      calls.push(url);
      if (url !== JOBS) return { status: 404, headers: new Headers(), body: Buffer.from('') };
      const { offset, limit } = JSON.parse(opts.post!.body) as { offset: number; limit: number };
      const rows = Array.from({ length: Math.min(limit, size - offset) }, (_, i) => ({
        title: `Unrelated Role ${offset + i}`,
        externalPath: `/job/Remote/Unrelated-Role-${offset + i}_R-${offset + i}`,
      }));
      return {
        status: 200,
        headers: new Headers(),
        body: Buffer.from(JSON.stringify({ total: offset === 0 ? size : 0, jobPostings: rows })),
      };
    }) as typeof safeFetch;

    const out = await findPosting(app.db, ctxOf(a), opp.id, sctx(fetch), {
      readBody: async () => '',
    });

    expect(calls.filter((u) => u === JOBS)).toHaveLength(10);
    expect(out.status).toBe('none');
    expect(out.note).toBe(
      'Large Workday board: showing the first 200 of 500 postings. Paste the posting link or text if yours is not among them.',
    );

    // The route passes the note on.
    app.jobs.services.sourceFetch = fetch;
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${opp.id}/find-posting`,
    });
    expect(res.json()).toMatchObject({ outcome: 'none', note: out.note });
  });

  it('attaches the single confident match on a truncated board and keeps the note (#114)', async () => {
    const { app, a } = await boot();
    const opp = await panOpportunity(app, a);
    const size = 500;
    const matchAt = 150;
    const fetch = (async (url: string, opts: SafeFetchOptions) => {
      if (url === DETAIL_PAN) {
        return {
          status: 200,
          headers: new Headers(),
          body: Buffer.from(fixture('workday-job.json')),
        };
      }
      if (url !== JOBS) return { status: 404, headers: new Headers(), body: Buffer.from('') };
      const { offset, limit } = JSON.parse(opts.post!.body) as { offset: number; limit: number };
      const rows = Array.from({ length: Math.min(limit, size - offset) }, (_, i) => {
        const n = offset + i;
        return n === matchAt
          ? { title: opp.title, externalPath: PAN_PATH }
          : {
              title: `Unrelated Role ${n}`,
              externalPath: `/job/Remote/Unrelated-Role-${n}_R-${n}`,
            };
      });
      return {
        status: 200,
        headers: new Headers(),
        body: Buffer.from(JSON.stringify({ total: offset === 0 ? size : 0, jobPostings: rows })),
      };
    }) as typeof safeFetch;

    const out = await findPosting(app.db, ctxOf(a), opp.id, sctx(fetch), {
      readBody: async () => '',
    });

    // Confirms the fixture setup actually exercises the gap #114 names: a single confident
    // match from a board read only in part, which findPosting already hands back with a note.
    expect(out).toMatchObject({ status: 'single' });
    expect(out.note).toBe(
      'Large Workday board: showing the first 200 of 500 postings. Paste the posting link or text if yours is not among them.',
    );

    // The route attaches it (no dialog opens on this path) and must not drop the note on the
    // floor the way the early return on 'exact' | 'single' did before #114.
    app.jobs.services.sourceFetch = fetch;
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${opp.id}/find-posting`,
    });
    expect(res.json()).toMatchObject({ outcome: 'attached', note: out.note });

    // And the note is not only a one-shot response the caller could fail to read: it is also
    // on the opportunity's own timeline, which outlives the response and any toast built from it.
    const ctx = ctxOf(a);
    const { items } = await listActivities(app.db, ctx, opp.id, { limit: 50, offset: 0 });
    const entry = items.find((i) => i.kind === 'link');
    expect(entry!.bodyMd).toContain('Large Workday board: showing the first 200 of 500');
  });
});
