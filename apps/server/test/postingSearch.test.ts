// Finding an existing opportunity's posting (Task 3, FR-O1 via FR-D7's machinery): the job id in
// a linked email resolves exactly; otherwise the company's board is title-matched, and a board
// that cannot be read leaves the opportunity as it was.
import type { Db } from '../src/db/client';
import type { NormalizedPosting } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { SourceKind } from '../src/adapters/discoverySource';
import { communications } from '../src/db/schema';
import { TITLE_MATCH_THRESHOLD } from '../src/jobs/leadResolve';
import type { safeFetch } from '../src/lib/safeFetch';
import { findPosting, type BoardLookup } from '../src/lib/postingSearch';
import { createCompany } from '../src/repos/companies';
import { upsertInbound } from '../src/repos/communications';
import { pointAtStoredBody } from './storedBody';
import { createOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

function posting(title: string, externalId: string, location = 'United States'): NormalizedPosting {
  return {
    company: 'Acme',
    title,
    descriptionMd: `What We Do: ${title}.`,
    postingUrl: `https://job-boards.greenhouse.io/acme/jobs/${externalId}`,
    location,
    externalId,
  };
}

/** A board that always serves `postings`, recording what it was asked for. */
function board(postings: NormalizedPosting[]): {
  lookup: BoardLookup;
  asked: { kind: SourceKind; org: string }[];
} {
  const asked: { kind: SourceKind; org: string }[] = [];
  return {
    asked,
    lookup: async (_sctx, kind, config) => {
      asked.push({ kind, org: String(config.org) });
      return postings;
    },
  };
}

/** Every fetch 404s: board detection finds nothing and nothing is transient. */
const missingFetch = (async () => ({
  status: 404,
  headers: new Headers(),
  body: Buffer.from(''),
})) as unknown as typeof safeFetch;

const sctx = (fetch: typeof safeFetch = missingFetch) => ({
  fetch,
  log: { warn: () => {}, info: () => {}, error: () => {} } as never,
});

/** One of the user's messages, linked to the opportunity, whose body is `body`. */
async function linkedMail(
  app: { db: Db },
  client: TestClient,
  opportunityId: string,
  body: string,
  opts: { sentAt?: number; externalId?: string; bodyRef?: string | null } = {},
) {
  const db = app.db;
  const ctx = ctxOf(client);
  const externalId = opts.externalId ?? `m-${opportunityId}`;
  // `bodyRef: null` is the shape every message has once Plan 3 lands: nothing on disk, and the
  // ATS references extracted at ingest instead.
  const bodyRef = opts.bodyRef === undefined ? `attachments/ab/${externalId}` : opts.bodyRef;
  const { id } = await upsertInbound(db, ctx, 'gmail', {
    externalId,
    threadKey: `t-${externalId}`,
    from: 'recruiter@example.com',
    to: ['owner@example.com'],
    subject: 'Next steps',
    snippet: body.slice(0, 80),
    bodyText: body,
    sentAt: opts.sentAt ?? Date.now(),
  });
  if (bodyRef !== null) await pointAtStoredBody(db, ctx.userId, id, bodyRef);
  await db.update(communications).set({ opportunityId }).where(eq(communications.id, id)).run();
  return {
    readBody: async () => body,
    bodies: bodyRef === null ? {} : { [bodyRef]: body },
  };
}

describe('findPosting', () => {
  it('resolves the posting from the references extracted at ingest, with no body to read', async () => {
    // Design D-5. Plan 3 stops persisting bodies, so the link a recruiter sent has to survive
    // as the handful of references extracted when the message arrived. `readBody` throws here:
    // if find-posting still reaches for a body, this test fails rather than passing on a
    // fallback that will not exist in production.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'Lumen Analytics',
      atsKind: 'ats_greenhouse',
      atsRef: 'brightforge',
      atsVerifiedAt: Date.now(),
    });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Lumen Analytics',
      title: 'Staff Product Manager',
      sourceKind: 'import',
    });
    // The link sits past the snippet, which is the case the stored references exist for: the
    // snippet fallback already covers a link in the first few lines.
    const body = `${'Thanks for making the time earlier today. The details we discussed are below, '.repeat(3)}the role: https://boards.greenhouse.io/brightforge/jobs/5550002002`;
    await linkedMail(app, a, opp.id, body, { bodyRef: null });
    const { lookup } = board([posting('Senior Product Manager, Lumen Models', '5550002002')]);

    const out = await findPosting(app.db, ctx, opp.id, sctx(), {
      readBody: () => {
        throw new Error('the body is gone: find-posting must use the stored references');
      },
      board: lookup,
    });

    expect(out).toMatchObject({ status: 'exact', via: 'email_link' });
    if (out.status !== 'exact') throw new Error('expected exact');
    expect(out.candidate.posting.externalId).toBe('5550002002');
  });

  it("resolves the posting named in a linked email, on the company's own board", async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'Lumen Analytics',
      atsKind: 'ats_greenhouse',
      atsRef: 'brightforge',
      atsVerifiedAt: Date.now(),
    });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Lumen Analytics',
      title: 'Staff Product Manager',
      sourceKind: 'import',
    });
    const { readBody } = await linkedMail(
      app,
      a,
      opp.id,
      'the role: https://www.brightforge.example/careers/job?gh_jid=5550002002&board=brightforge',
    );
    const { lookup, asked } = board([
      posting('Senior Product Manager, Lumen Models', '5550002002'),
      posting('Staff Product Manager, Networking', '4642612006'),
    ]);

    const out = await findPosting(app.db, ctx, opp.id, sctx(), { readBody, board: lookup });

    expect(out).toMatchObject({ status: 'exact', via: 'email_link' });
    if (out.status !== 'exact') throw new Error('expected exact');
    expect(out.candidate.posting.externalId).toBe('5550002002');
    expect(out.candidate.score).toBe(1);
    expect(asked).toEqual([{ kind: 'ats_greenhouse', org: 'brightforge' }]);
  });

  it('asks for confirmation when the reference is on a board the company does not own', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'Sentinel Edge',
      atsKind: 'ats_greenhouse',
      atsRef: 'sentineledge',
      atsVerifiedAt: Date.now(),
    });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      sourceKind: 'import',
    });
    // A forwarded link to another company's job: it resolves, but it is not this company's board.
    const { readBody } = await linkedMail(
      app,
      a,
      opp.id,
      'you might also like https://job-boards.greenhouse.io/acme/jobs/999',
    );
    const lookup: BoardLookup = async (_sctx, _kind, config) =>
      config.org === 'acme'
        ? [posting('Director of Product, Acme', '999')]
        : [posting('Reseller Sales Manager', '1')];

    const out = await findPosting(app.db, ctx, opp.id, sctx(), { readBody, board: lookup });

    expect(out).toMatchObject({ status: 'candidates', via: 'email_link_unverified' });
    if (out.status !== 'candidates') throw new Error('expected candidates');
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]!.posting.externalId).toBe('999');
  });

  it("prefers the newest message's reference when they name different reqs", async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'BrightForge',
      atsKind: 'ats_greenhouse',
      atsRef: 'brightforge',
      atsVerifiedAt: Date.now(),
    });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'BrightForge',
      title: 'Staff Product Manager',
      sourceKind: 'import',
    });
    // Two linked messages, each naming a different req; the recruiter's newer one wins.
    const old = await linkedMail(
      app,
      a,
      opp.id,
      'first: https://www.brightforge.example/careers/job?gh_jid=5550003003&board=brightforge',
      {
        sentAt: Date.now() - 86_400_000,
        externalId: 'older',
      },
    );
    const recent = await linkedMail(
      app,
      a,
      opp.id,
      'then: https://www.brightforge.example/careers/job?gh_jid=5550002002&board=brightforge',
      {
        sentAt: Date.now(),
        externalId: 'newer',
      },
    );
    const bodies = new Map([...Object.entries(old.bodies), ...Object.entries(recent.bodies)]);
    // Board order is the opposite of message order, so only reference order can decide.
    const { lookup } = board([
      posting('Staff Product Manager, Training Infrastructure', '5550003003'),
      posting('Senior Product Manager, Lumen Models', '5550002002'),
    ]);

    const out = await findPosting(app.db, ctx, opp.id, sctx(), {
      readBody: async (ref) => bodies.get(ref) ?? '',
      board: lookup,
    });

    expect(out).toMatchObject({ status: 'exact', via: 'email_link' });
    if (out.status !== 'exact') throw new Error('expected exact');
    expect(out.candidate.posting.externalId).toBe('5550002002');
  });

  it('returns a single candidate when one board title passes the threshold', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'Sentinel Edge',
      atsKind: 'ats_greenhouse',
      atsRef: 'sentineledge',
      atsVerifiedAt: Date.now(),
    });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      sourceKind: 'import',
    });
    const { lookup } = board([
      posting('Staff Product Manager, SIEM', '7663059003'),
      posting('Reseller Sales Manager', '8003013003'),
    ]);

    const out = await findPosting(app.db, ctx, opp.id, sctx(), {
      readBody: async () => '',
      board: lookup,
    });

    expect(out.status).toBe('single');
    if (out.status !== 'single') throw new Error('expected single');
    expect(out.candidate.posting.title).toBe('Staff Product Manager, SIEM');
    expect(out.candidate.score).toBeGreaterThanOrEqual(TITLE_MATCH_THRESHOLD);
  });

  it('returns several candidates, highest score first', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'BrightForge',
      atsKind: 'ats_greenhouse',
      atsRef: 'brightforge',
      atsVerifiedAt: Date.now(),
    });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'BrightForge',
      title: 'Staff Product Manager',
      sourceKind: 'import',
    });
    const { lookup } = board([
      posting('Staff Product Manager, AI Inference', '4720733006'),
      posting('Staff Product Manager, Networking', '4642612006'),
      posting('Reseller Sales Manager', '1'),
    ]);

    const out = await findPosting(app.db, ctx, opp.id, sctx(), {
      readBody: async () => '',
      board: lookup,
    });

    expect(out.status).toBe('candidates');
    if (out.status !== 'candidates') throw new Error('expected candidates');
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates[0]!.score).toBeGreaterThanOrEqual(out.candidates[1]!.score);
  });

  it('confirms the single perfect title match even though lesser matches also clear the confident bar (#235)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'Snowbase',
      atsKind: 'ats_greenhouse',
      atsRef: 'snowbase',
      atsVerifiedAt: Date.now(),
    });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Snowbase',
      title: 'Senior Product Manager, Data Observability',
      sourceKind: 'import',
    });
    // Shaped after the reported board: one exact title (1.0), one close relative (0.8), and a
    // title family that reliably clears the 0.6 bar without ever matching exactly.
    const { lookup } = board([
      posting('Senior Product Manager, Data Observability', '1'),
      posting('Senior Product Manager, Data Platform', '2'),
      posting('Senior Product Manager - Streaming', '3'),
      posting('Senior Product Manager - Marketplace', '4'),
      posting('Senior Product Manager - Security', '5'),
      posting('Senior Product Manager - Analytics', '6'),
      posting('Senior Product Manager - Compliance', '7'),
    ]);

    const out = await findPosting(app.db, ctx, opp.id, sctx(), {
      readBody: async () => '',
      board: lookup,
    });

    expect(out.status).toBe('single');
    if (out.status !== 'single') throw new Error('expected single');
    expect(out.candidate.posting.title).toBe('Senior Product Manager, Data Observability');
    expect(out.candidate.score).toBe(1);
  });

  it('stays ambiguous when two postings both score a perfect title match (#235)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'Deepwave',
      atsKind: 'ats_greenhouse',
      atsRef: 'deepwave',
      atsVerifiedAt: Date.now(),
    });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Deepwave',
      title: 'Staff Product Manager, AI Applications',
      sourceKind: 'import',
    });
    // Same title, two locations, distinct enough descriptions that rankCandidates treats them as
    // separate roles rather than collapsing one into the other's otherLocations.
    const roleA: NormalizedPosting = {
      ...posting('Staff Product Manager, AI Applications', '1', 'US-CA-Menlo Park'),
      descriptionMd: `Role A. ${'x'.repeat(250)}`,
    };
    const roleB: NormalizedPosting = {
      ...posting('Staff Product Manager, AI Applications', '2', 'US-NY-New York'),
      descriptionMd: `Role B. ${'y'.repeat(250)}`,
    };
    const { lookup } = board([roleA, roleB]);

    const out = await findPosting(app.db, ctx, opp.id, sctx(), {
      readBody: async () => '',
      board: lookup,
    });

    expect(out.status).toBe('candidates');
    if (out.status !== 'candidates') throw new Error('expected candidates');
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates.every((c) => c.score === 1)).toBe(true);
  });

  it('drops a board row that sanitizes to an invalid posting', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'Sentinel Edge',
      atsKind: 'ats_greenhouse',
      atsRef: 'sentineledge',
      atsVerifiedAt: Date.now(),
    });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      sourceKind: 'import',
    });
    // An adapter can map an untitled job to title '' (greenhouse.ts), which no posting schema
    // accepts; it must be dropped rather than fail the search or the response serializer.
    const { lookup } = board([
      { ...posting('x', '1'), title: '' },
      posting('Reseller Sales Manager', '2'),
    ]);

    const out = await findPosting(app.db, ctx, opp.id, sctx(), {
      readBody: async () => '',
      board: lookup,
    });

    expect(out.status).toBe('none');
    if (out.status !== 'none') throw new Error('expected none');
    expect(out.candidates.map((c) => c.posting.title)).toEqual(['Reseller Sales Manager']);
  });

  it('returns none with the board listing when nothing passes', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'Northwind Labs',
      atsKind: 'ats_greenhouse',
      atsRef: 'northwind',
      atsVerifiedAt: Date.now(),
    });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Northwind Labs',
      title: 'Staff Product Manager, Experimentation and Data Platform',
      sourceKind: 'import',
    });
    const { lookup } = board([
      posting('Staff Product Manager - Data Products', '5550001001'),
      posting('Staff Engineer, Experimentation', '7703477003'),
    ]);

    const out = await findPosting(app.db, ctx, opp.id, sctx(), {
      readBody: async () => '',
      board: lookup,
    });

    expect(out.status).toBe('none');
    if (out.status !== 'none') throw new Error('expected none');
    expect(out.candidates.length).toBeGreaterThan(0);
    expect(out.candidates[0]!.score).toBeLessThan(TITLE_MATCH_THRESHOLD);
  });

  it('hands back more of the board than the confident few', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'BrightForge',
      atsKind: 'ats_greenhouse',
      atsRef: 'brightforge',
      atsVerifiedAt: Date.now(),
    });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'BrightForge',
      title: 'Staff Product Manager',
      sourceKind: 'import',
    });
    // A big board, nothing confident: the user's own search is the only way to the right req.
    const big = Array.from({ length: 60 }, (_, i) => posting(`Engineer ${i}`, String(i)));
    const { lookup } = board(big);

    const out = await findPosting(app.db, ctx, opp.id, sctx(), {
      readBody: async () => '',
      board: lookup,
    });

    expect(out.status).toBe('none');
    if (out.status !== 'none') throw new Error('expected none');
    expect(out.candidates.length).toBeGreaterThan(20);
  });

  it('answers no_board when the company has no ATS and no careers URL', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, { name: 'Meridian Systems' });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Meridian Systems',
      title: 'Staff Product Manager',
      sourceKind: 'import',
    });
    const { lookup } = board([posting('Staff Product Manager', '1')]);

    const out = await findPosting(app.db, ctx, opp.id, sctx(), {
      readBody: async () => '',
      board: lookup,
    });

    expect(out).toEqual({ status: 'no_board', needsCareersUrl: true });
  });

  it('survives an unreachable board', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'Sentinel Edge',
      atsKind: 'ats_greenhouse',
      atsRef: 'sentineledge',
      atsVerifiedAt: Date.now(),
    });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      sourceKind: 'import',
    });
    const boom: BoardLookup = () => Promise.reject(new Error('ECONNRESET'));

    const out = await findPosting(app.db, ctx, opp.id, sctx(), {
      readBody: async () => '',
      board: boom,
    });

    expect(out).toMatchObject({ status: 'none' });
  });

  it("404s for another user's opportunity", async () => {
    const { app, a, b } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, { name: 'Sentinel Edge' });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      sourceKind: 'import',
    });
    const { lookup } = board([]);

    await expect(
      findPosting(app.db, ctxOf(b), opp.id, sctx(), { readBody: async () => '', board: lookup }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
