// Posting routes (Task 5, FR-O1): find a posting for an opportunity and attach one. A single
// confident match attaches without asking; several come back for the user to pick; no board at
// all answers with the paste hint. LinkedIn links are refused up front (constraint C-1).
import type { Db } from '../src/db/client';
import type { NormalizedPosting } from '@opportun/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { PASTE_TEXT_HINT } from '../src/routes/capture';
import type { safeFetch } from '../src/lib/safeFetch';
import { eq } from 'drizzle-orm';
import { communications, opportunities } from '../src/db/schema';
import { atsJobRefOfUrl } from '../src/lib/atsJobRef';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import { createCompany } from '../src/repos/companies';
import { upsertInbound } from '../src/repos/communications';
import {
  createOpportunity,
  getOpportunity,
  setPostingState,
  updateOpportunity,
} from '../src/repos/opportunities';
import { reconcilePosting } from '../src/jobs/postingReconcile';
import { rederivePosting } from '../src/lib/postingRederive';
import { createActivity, listActivities } from '../src/repos/activities';
import { useApi } from './api';
import type { TestClient } from './isolation';

/** Every probe 404s: ATS detection finds nothing and nothing is transient. */
const missingFetch = (async () => ({
  status: 404,
  headers: new Headers(),
  body: Buffer.from(''),
})) as unknown as typeof safeFetch;

const boot = useApi(() => ({ build: { sourceFetch: missingFetch } }));
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

afterEach(() => resetSources());

function posting(title: string, externalId: string): NormalizedPosting {
  return {
    company: 'Sentinel Edge',
    title,
    descriptionMd: `What We Do: ${title}.`,
    postingUrl: `https://job-boards.greenhouse.io/sentineledge/jobs/${externalId}`,
    location: 'United States of America',
    externalId,
  };
}

/** A Greenhouse board that serves `postings` with no network. */
function boardServes(postings: NormalizedPosting[]): void {
  const source: DiscoverySource = {
    kind: 'ats_greenhouse',
    async *fetchPostings() {
      for (const p of postings) yield { posting: p, nextCursor: null };
    },
  };
  registerSource(source);
}

async function seed(
  app: { db: Db },
  client: TestClient,
  opts: {
    title: string;
    company?: string;
    ats?: boolean;
    descriptionMd?: string;
    postingUrl?: string;
  },
): Promise<string> {
  const db = app.db;
  const ctx = ctxOf(client);
  const name = opts.company ?? 'Sentinel Edge';
  await createCompany(db, ctx, {
    name,
    ...(opts.ats === false
      ? {}
      : { atsKind: 'ats_greenhouse', atsRef: 'sentineledge', atsVerifiedAt: Date.now() }),
  });
  const opp = await createOpportunity(db, ctx, {
    companyName: name,
    title: opts.title,
    sourceKind: 'import',
    ...(opts.descriptionMd === undefined ? {} : { descriptionMd: opts.descriptionMd }),
    ...(opts.postingUrl === undefined ? {} : { postingUrl: opts.postingUrl }),
  });
  return opp.id;
}

describe('POST /opportunities/:id/find-posting', () => {
  it('attaches straight away for a single match', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    boardServes([
      posting('Staff Product Manager, SIEM', '7663059003'),
      posting('Reseller Sales Manager', '1'),
    ]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'attached' });
    expect(res.json().opportunity.descriptionMd).toContain('What We Do');
    expect(res.json().opportunity.postingUrl).toContain('7663059003');
  });

  it('returns candidates for review when several match', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager' });
    boardServes([
      posting('Staff Product Manager, AI Inference', '2'),
      posting('Staff Product Manager, Networking', '3'),
    ]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    const body = res.json();
    expect(body.outcome).toBe('candidates');
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0].posting.descriptionMd).toContain('What We Do');
    expect(body.board.length).toBeGreaterThanOrEqual(2);
  });

  it('answers none with the board listing when nothing is confident', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, {
      title: 'Staff Product Manager, Experimentation and Data Platform',
    });
    boardServes([posting('Staff Product Manager - Data Products', '4')]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.json().outcome).toBe('none');
    expect(res.json().candidates).toHaveLength(1);
  });

  it('answers 200 when a board row is too malformed to serialize', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    // greenhouse.ts maps an untitled job to title '', which NormalizedPostingSchema rejects.
    boardServes([{ ...posting('Reseller Sales Manager', '1'), title: '' }]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'none', candidates: [] });
  });

  it('offers a referenced posting from another board for confirmation instead of attaching it', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    const db = app.db;
    const ctx = ctxOf(a);
    const mail = await upsertInbound(db, ctx, 'gmail', {
      externalId: 'm-foreign',
      threadKey: 't-foreign',
      from: 'friend@example.com',
      to: ['owner@example.com'],
      subject: 'you might like this',
      snippet: 'see https://job-boards.greenhouse.io/acme/jobs/999',
      bodyText: 'see https://job-boards.greenhouse.io/acme/jobs/999',
      sentAt: Date.now(),
    });
    await db
      .update(communications)
      .set({ opportunityId: id })
      .where(eq(communications.id, mail.id))
      .run();
    boardServes([posting('Director of Product, Acme', '999')]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ outcome: 'candidates', needsConfirmation: true });
    expect(body.candidates).toHaveLength(1);
    const after = await a.request({ method: 'GET', url: `/api/v1/opportunities/${id}` });
    expect(after.json().descriptionMd).toBeNull();
  });

  it('finds again for an opportunity already confirmed (issue #255): no state gate blocks it', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    boardServes([posting('Staff Product Manager, SIEM', '7663059003')]);
    const first = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(first.json()).toMatchObject({ outcome: 'attached' });
    const confirmed = await a.request({ method: 'GET', url: `/api/v1/opportunities/${id}` });
    expect(confirmed.json()).toMatchObject({ postingState: 'confirmed', postingStateDetail: null });

    // A fresh board read (what Refetch is for), on an opportunity the route's own
    // already-described gate would otherwise refuse: system-written descriptions pass.
    boardServes([posting('Staff Product Manager, SIEM II', '7663059003')]);
    const second = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ outcome: 'attached' });
    expect(second.json().opportunity.descriptionMd).toContain('SIEM II');
  });

  it('answers no_board with the paste hint', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, {
      title: 'Staff Product Manager',
      company: 'Meridian Systems',
      ats: false,
    });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.json()).toMatchObject({
      outcome: 'no_board',
      needsCareersUrl: true,
      hint: PASTE_TEXT_HINT,
    });
  });

  // #756 (tl): a described posting never checked had no way on (Find posting hid, a link save sets
  // only the identity). Find posting now confirms it from the board, keeping the user's own
  // description (design D11), and marks it user_confirmed so no later pass reads the description
  // as the employer's copy.
  it('a described posting never checked is confirmed from the board, its description kept', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, {
      title: 'Product Manager, SIEM',
      descriptionMd: 'my own notes on the role',
    });
    boardServes([posting('Staff Product Manager, SIEM', '7663059003')]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'attached' });
    const out = await getOpportunity(app.db, ctxOf(a), id);
    expect(out).toMatchObject({
      descriptionMd: 'my own notes on the role',
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
      postingUrl: 'https://job-boards.greenhouse.io/sentineledge/jobs/7663059003',
    });
    expect(out.atsJobRef).not.toBeNull();
    // A later reconcile or re-derive leaves the kept description alone.
    const sctx = { fetch: missingFetch, log: { warn: () => undefined } } as never;
    const noBoard = (async () => {
      throw new Error('no board should be read');
    }) as never;
    await reconcilePosting(app.db, ctxOf(a), id, sctx, { board: noBoard });
    await rederivePosting(app.db, ctxOf(a), id, sctx, { board: noBoard }).catch(() => undefined);
    expect((await getOpportunity(app.db, ctxOf(a), id)).descriptionMd).toBe(
      'my own notes on the role',
    );
  });

  // qa and tl on #804: the opportunity's own job, named by its stored identity or its board link,
  // is the posting. Missing from the board, no title match stands in for it: it is offered, never
  // attached or confirmed, with or without a description the user wrote.
  const OWN_LINK = 'https://job-boards.greenhouse.io/sentineledge/jobs/1003';
  for (const descriptionMd of ['my own notes on the role', undefined]) {
    const which = descriptionMd === undefined ? 'with no description' : 'with a user description';
    it(`a board link whose job is missing: a title match is a candidate only, ${which}`, async () => {
      const { app, a } = await boot();
      const id = await seed(app, a, {
        title: 'Staff Platform Engineer',
        postingUrl: OWN_LINK,
        ...(descriptionMd === undefined ? {} : { descriptionMd }),
      });
      // qa's state: the identity a link save stores, posting state still null.
      await app.db
        .update(opportunities)
        .set({ atsJobRef: atsJobRefOfUrl(OWN_LINK) })
        .where(eq(opportunities.id, id))
        .run();
      const before = await getOpportunity(app.db, ctxOf(a), id);
      expect(before).toMatchObject({ postingState: null, atsJobRef: { externalId: '1003' } });
      boardServes([posting('Staff Platform Engineer II', '1002')]);

      const res = await a.request({
        method: 'POST',
        url: `/api/v1/opportunities/${id}/find-posting`,
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().outcome).not.toBe('attached');
      const out = await getOpportunity(app.db, ctxOf(a), id);
      expect(out.postingUrl).toBe(OWN_LINK);
      expect(out.atsJobRef).toMatchObject({ externalId: '1003' });
      expect(out.postingState).not.toBe('confirmed');
      expect(out.descriptionMd ?? null).toBe(descriptionMd ?? before.descriptionMd ?? null);
    });
  }

  it('a board link whose job is on the board: that job is attached, not a closer title', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, {
      title: 'Staff Platform Engineer',
      postingUrl: OWN_LINK,
      descriptionMd: 'my own notes on the role',
    });
    boardServes([
      posting('Staff Platform Engineer', '1002'),
      posting('Platform Engineer (Infra)', '1003'),
    ]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'attached' });
    const out = await getOpportunity(app.db, ctxOf(a), id);
    expect(out).toMatchObject({
      postingUrl: OWN_LINK,
      postingState: 'confirmed',
      descriptionMd: 'my own notes on the role',
    });
    expect(out.atsJobRef).toMatchObject({ externalId: '1003' });
  });

  // #812 (qa on #804): the stored identity on its own, with no link, and when it and the link
  // name different jobs. The stored one is the opportunity's own job.
  const storeIdentity = async (app: { db: Db }, id: string, url: string) =>
    app.db
      .update(opportunities)
      .set({ atsJobRef: atsJobRefOfUrl(url) })
      .where(eq(opportunities.id, id))
      .run();

  it('a stored identity with no link, missing from the board: a title match is a candidate only', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Platform Engineer' });
    await storeIdentity(app, id, OWN_LINK);
    boardServes([posting('Staff Platform Engineer II', '1002')]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).not.toBe('attached');
    const out = await getOpportunity(app.db, ctxOf(a), id);
    expect(out).toMatchObject({ postingUrl: null, atsJobRef: { externalId: '1003' } });
    expect(out.postingState).not.toBe('confirmed');
  });

  it('a stored identity that differs from the link: the stored job is the one attached', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, {
      title: 'Staff Platform Engineer',
      postingUrl: 'https://job-boards.greenhouse.io/sentineledge/jobs/1005',
    });
    await storeIdentity(app, id, OWN_LINK);
    boardServes([posting('Staff Platform Engineer', '1005'), posting('Platform Engineer', '1003')]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'attached' });
    const out = await getOpportunity(app.db, ctxOf(a), id);
    expect(out.atsJobRef).toMatchObject({ externalId: '1003' });
    expect(out.postingUrl).toBe(OWN_LINK);
  });

  // #812 (qa on #804; tl): Find posting and Refetch on a confirmed posting with the user's own
  // description re-check the board and keep the description; the opportunity's own job decides.
  it('confirmed, own description, no job of its own: a title match is a candidate only (#812)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, {
      title: 'Product Manager, SIEM',
      descriptionMd: 'already here',
    });
    await setPostingState(app.db, ctxOf(a), id, {
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });
    boardServes([posting('Staff Product Manager, SIEM', '7663059003')]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('candidates');
    expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject({
      descriptionMd: 'already here',
      postingUrl: null,
      atsJobRef: null,
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });
  });

  it('confirmed, own description, its own job on the board: refreshed, the description kept (#812)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, {
      title: 'Staff Platform Engineer',
      postingUrl: OWN_LINK,
      descriptionMd: 'my own notes on the role',
    });
    await storeIdentity(app, id, OWN_LINK);
    await setPostingState(app.db, ctxOf(a), id, {
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });
    boardServes([posting('Staff Platform Engineer', '1002'), posting('Platform Engineer', '1003')]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'attached' });
    const out = await getOpportunity(app.db, ctxOf(a), id);
    expect(out).toMatchObject({
      descriptionMd: 'my own notes on the role',
      postingUrl: OWN_LINK,
      atsJobRef: { externalId: '1003' },
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
      location: null,
    });
    const { items } = await listActivities(app.db, ctxOf(a), id, { limit: 50, offset: 0 });
    expect(
      items.some(
        (i) =>
          i.bodyMd?.includes("Checked on the company's board; your description was kept.") === true,
      ),
    ).toBe(true);
  });

  it('confirmed, own description, its own job missing: nothing changes, and it says so (#812)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, {
      title: 'Staff Platform Engineer',
      postingUrl: OWN_LINK,
      descriptionMd: 'my own notes on the role',
    });
    await storeIdentity(app, id, OWN_LINK);
    await setPostingState(app.db, ctxOf(a), id, {
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });
    const before = await getOpportunity(app.db, ctxOf(a), id);
    boardServes([posting('Staff Platform Engineer II', '1002')]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('candidates');
    expect(res.json().note).toContain("isn't on the company's board");
    const out = await getOpportunity(app.db, ctxOf(a), id);
    expect(out).toMatchObject({
      descriptionMd: before.descriptionMd,
      postingUrl: before.postingUrl,
      atsJobRef: before.atsJobRef,
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });
  });

  // qa on #830: the identity a Find posting confirm stores takes its org from the posting's own
  // link, which need not be the board's token (vandelay vs vandelayindustries). A Refetch must
  // still find that job on the company's board, every time, not only once.
  it('a Find posting confirm, then Refetch twice: its own job is found though the link names another org token (#812)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, {
      title: 'Staff Platform Engineer',
      descriptionMd: 'my own notes on the role',
    });
    const own: NormalizedPosting = {
      ...posting('Staff Platform Engineer', '1003'),
      postingUrl: 'https://job-boards.greenhouse.io/sentinel/jobs/1003',
    };
    boardServes([own, posting('Staff Platform Engineer II', '1002')]);
    const find = () =>
      a.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });

    expect((await find()).json()).toMatchObject({ outcome: 'attached' });
    const first = await getOpportunity(app.db, ctxOf(a), id);
    // The identity's org stays its link's slug (postingAtsJobRef, tl on #140): the assisted-apply
    // handoff compares the destination's slug with it.
    expect(first).toMatchObject({
      postingState: 'confirmed',
      atsJobRef: { externalId: '1003', org: 'sentinel' },
    });

    for (let i = 0; i < 2; i++) {
      const res = await find();
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ outcome: 'attached' });
      const out = await getOpportunity(app.db, ctxOf(a), id);
      expect(out).toMatchObject({
        descriptionMd: 'my own notes on the role',
        postingState: 'confirmed',
        postingStateDetail: 'user_confirmed',
        atsJobRef: { externalId: '1003', org: 'sentinel' },
      });
    }
  });

  // qa on #830: a picked row stores its link's slug (vandelay), and a Refetch afterwards must find
  // that job again on the board read under its own token, not offer it back as a candidate.
  it('a row picked, then Refetch: the picked job is found on the board again (#812)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, {
      title: 'Staff Platform Engineer',
      descriptionMd: 'my own notes on the role',
    });
    const picked: NormalizedPosting = {
      ...posting('Staff Platform Engineer II', '1002'),
      postingUrl: 'https://job-boards.greenhouse.io/sentinel/jobs/1002',
    };
    boardServes([picked]);
    const pick = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting`,
      payload: { posting: picked },
    });
    expect(pick.statusCode, pick.body).toBe(200);
    expect((await getOpportunity(app.db, ctxOf(a), id)).atsJobRef).toMatchObject({
      externalId: '1002',
      org: 'sentinel',
    });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'attached' });
    expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject({
      descriptionMd: 'my own notes on the role',
      postingState: 'confirmed',
      atsJobRef: { externalId: '1002', org: 'sentinel' },
    });
  });

  it('a board row picked on a confirmed posting is logged as the change it is, not a check (#812)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, {
      title: 'Staff Platform Engineer',
      postingUrl: OWN_LINK,
      descriptionMd: 'my own notes on the role',
    });
    await storeIdentity(app, id, OWN_LINK);
    await setPostingState(app.db, ctxOf(a), id, {
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting`,
      payload: { posting: posting('Staff Platform Engineer II', '1002') },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { items } = await listActivities(app.db, ctxOf(a), id, { limit: 50, offset: 0 });
    const attached = items.find((i) => i.title === 'Job posting attached');
    expect(attached?.bodyMd).not.toContain('Checked on the company');
    expect(attached?.bodyMd).toContain('Your own description was kept.');
  });

  it('confirmed, own description: pasted text over it is still refused (#812)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Platform Engineer', descriptionMd: 'mine' });
    await setPostingState(app.db, ctxOf(a), id, {
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting`,
      payload: { text: 'Pasted text of some posting, long enough to count as a description.' },
    });
    expect(res.statusCode).toBe(409);
    expect((await getOpportunity(app.db, ctxOf(a), id)).descriptionMd).toBe('mine');
  });

  it("404s for another user's opportunity", async () => {
    const { app, a, b } = await boot();
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    boardServes([posting('Staff Product Manager, SIEM', '7663059003')]);

    const res = await b.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /opportunities/:id/posting', () => {
  it('attaches pasted text as the description', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager' });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting`,
      payload: { text: 'Staff PM, SIEM. You will own the SIEM roadmap.' },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().descriptionMd).toContain('You will own the SIEM roadmap');
  });

  it('attaches a chosen candidate', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager' });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting`,
      payload: { posting: posting('Staff Product Manager, Networking', '3') },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().postingUrl).toContain('/jobs/3');
  });

  it('refuses a pasted LinkedIn URL and names the compliant path', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager' });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting`,
      payload: { url: 'https://www.linkedin.com/jobs/view/5550005005/' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toEqual({ code: 'prohibited_host', hint: PASTE_TEXT_HINT });
  });

  it('refuses a pasted Indeed URL the same way, before any fetch (issue #75)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager' });
    const requested: string[] = [];
    app.jobs.services.sourceFetch = (async (url: string) => {
      requested.push(url);
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof app.jobs.services.sourceFetch;

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting`,
      payload: { url: 'https://www.indeed.com/viewjob?jk=00000000deadbeef' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toEqual({ code: 'prohibited_host', hint: PASTE_TEXT_HINT });
    expect(requested).toEqual([]);
  });

  it('rejects a body naming more than one source', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager' });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting`,
      payload: { text: 'a description', url: 'https://example.com/jobs/1' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /opportunities/:id/posting/confirm (issue #250)', () => {
  it('confirms a flagged posting, leaving the description untouched', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager' });
    await setPostingState(app.db, { userId: a.userId, isAdmin: false }, id, {
      postingState: 'needs_review',
      postingStateDetail: 'none_found',
    });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting/confirm`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });
    const { items } = await listActivities(app.db, { userId: a.userId, isAdmin: false }, id, {
      limit: 50,
      offset: 0,
    });
    const note = items.find((i) => i.title === 'Posting confirmed by you');
    expect(note).toBeDefined();
  });

  it('refuses to confirm an opportunity with nothing flagged', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager' });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting/confirm`,
    });

    expect(res.statusCode).toBe(409);
  });

  it('refuses to confirm the edited flag: Review board copy already resolves it', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager' });
    await setPostingState(app.db, { userId: a.userId, isAdmin: false }, id, {
      postingState: 'needs_review',
      postingStateDetail: 'edited',
    });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting/confirm`,
    });

    expect(res.statusCode).toBe(409);
  });

  it("404s for another user's opportunity", async () => {
    const { app, a, b } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager' });
    await setPostingState(app.db, { userId: a.userId, isAdmin: false }, id, {
      postingState: 'needs_review',
      postingStateDetail: 'none_found',
    });

    const res = await b.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting/confirm`,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /opportunities/:id/posting/unconfirm (issue #250)', () => {
  it('reverses a user confirmation back to needs_review/none_found', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager' });
    await setPostingState(app.db, { userId: a.userId, isAdmin: false }, id, {
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting/unconfirm`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      postingState: 'needs_review',
      postingStateDetail: 'none_found',
    });
  });

  it('refuses to unconfirm a board match: only a user confirmation is reversible this way', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager' });
    await setPostingState(app.db, { userId: a.userId, isAdmin: false }, id, {
      postingState: 'confirmed',
      postingStateDetail: null,
    });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting/unconfirm`,
    });

    expect(res.statusCode).toBe(409);
  });
});

describe('POST /opportunities/:id/posting/rederive (issue #264)', () => {
  const RAW_CAPTURE = [
    'About the job',
    'Join the company that is building the telemetry infrastructure for the AI era.',
    'Remote, Full-time',
    'About the company',
    'Sentinel Edge is a company.',
  ].join('\n');

  /** `seed`'s shape plus a stored capture and a junk description, standing in for the #238
   *  corruption #264's "Done when" bar is about. */
  async function seedCorrupted(
    app: { db: Db },
    client: TestClient,
    opts: { title: string; ats?: boolean },
  ): Promise<string> {
    const ctx = ctxOf(client);
    const junk = '{"json": "noise"}'.repeat(50);
    const id = await seed(app, client, { ...opts, descriptionMd: junk });
    await updateOpportunity(app.db, ctx, id, {
      descriptionFingerprint: descriptionFingerprint(junk),
    });
    await createActivity(app.db, ctx, id, {
      kind: 'capture',
      title: 'Captured from LinkedIn',
      bodyMd: RAW_CAPTURE,
      occurredAt: Date.now(),
      participants: [],
      externalUrl: 'https://www.linkedin.com/jobs/view/1',
    });
    await setPostingState(app.db, ctx, id, { postingState: 'confirmed', postingStateDetail: null });
    return id;
  }

  it('derives the description from the capture when the company has no board', async () => {
    const { app, a } = await boot();
    const id = await seedCorrupted(app, a, { title: 'Staff Product Manager', ats: false });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting/rederive`,
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.outcome).toBe('capture_only');
    expect(body.opportunity.descriptionMd).toContain('telemetry infrastructure');
  });

  it('merges the board copy when a confident match exists', async () => {
    const { app, a } = await boot();
    const id = await seedCorrupted(app, a, { title: 'Staff Product Manager' });
    boardServes([posting('Staff Product Manager', '7663059003')]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting/rederive`,
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.outcome).toBe('merged');
    expect(body.opportunity.descriptionMd).toContain('What We Do');
  });

  it('refuses without force when the description is the user’s own writing', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager', ats: false });
    await createActivity(app.db, ctxOf(a), id, {
      kind: 'capture',
      title: 'Captured from LinkedIn',
      bodyMd: RAW_CAPTURE,
      occurredAt: Date.now(),
      participants: [],
      externalUrl: 'https://www.linkedin.com/jobs/view/1',
    });
    await updateOpportunity(app.db, ctxOf(a), id, { descriptionMd: 'my own notes' });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting/rederive`,
    });

    expect(res.statusCode).toBe(409);
  });

  it('succeeds with force even when the description is the user’s own writing', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager', ats: false });
    await createActivity(app.db, ctxOf(a), id, {
      kind: 'capture',
      title: 'Captured from LinkedIn',
      bodyMd: RAW_CAPTURE,
      occurredAt: Date.now(),
      participants: [],
      externalUrl: 'https://www.linkedin.com/jobs/view/1',
    });
    await updateOpportunity(app.db, ctxOf(a), id, { descriptionMd: 'my own notes' });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting/rederive`,
      payload: { force: true },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().opportunity.descriptionMd).toContain('telemetry infrastructure');
  });

  it('refuses when the opportunity has no stored capture', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Product Manager', ats: false });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting/rederive`,
    });

    expect(res.statusCode).toBe(409);
  });

  it("404s for another user's opportunity", async () => {
    const { app, a, b } = await boot();
    const id = await seedCorrupted(app, a, { title: 'Staff Product Manager', ats: false });

    const res = await b.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting/rederive`,
    });

    expect(res.statusCode).toBe(404);
  });
});
