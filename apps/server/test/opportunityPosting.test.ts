// Posting routes (Task 5, FR-O1): find a posting for an opportunity and attach one. A single
// confident match attaches without asking; several come back for the user to pick; no board at
// all answers with the paste hint. LinkedIn links are refused up front (constraint C-1).
import type { Db } from '../src/db/client';
import { sha256Hex, type NormalizedPosting } from '@opportun/core';
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
import { setRaceHook } from '../src/lib/racePoints';
import { createCompany } from '../src/repos/companies';
import { upsertInbound } from '../src/repos/communications';
import {
  createOpportunity,
  deleteOpportunity,
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

afterEach(() => {
  resetSources();
  setRaceHook(undefined);
});

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

  // #835 (qa on #830): a board that could not be read is said as such, with a retry, and "no
  // close match" only when the board was read.
  it('a board that cannot be read answers unreachable, not none (#835)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    registerSource({
      kind: 'ats_greenhouse',
      // eslint-disable-next-line require-yield -- a board whose read fails before any posting
      async *fetchPostings() {
        throw new Error('fetch failed: ECONNRESET');
      },
    });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'unreachable' });
    expect((await getOpportunity(app.db, ctxOf(a), id)).postingState).toBeNull();
  });

  it('a board read with no match still answers none (#835)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    boardServes([posting('Reseller Sales Manager', '1')]);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(res.json()).toMatchObject({ outcome: 'none' });
  });

  it('a search for a board that could not finish answers unreachable, not no_board (#866)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, {
      title: 'Staff Product Manager',
      company: 'Meridian Systems',
      ats: false,
    });
    app.jobs.services.sourceFetch = (async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    }) as unknown as typeof safeFetch;

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ outcome: 'unreachable' });
    expect((await getOpportunity(app.db, ctxOf(a), id)).postingState).toBeNull();
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
    // It said "Checked on the company's board" each time (#812); a Refetch that changes nothing now
    // leaves the timeline as it was (#866).
    expect(items.filter((i) => i.kind === 'link')).toEqual([]);
  });

  // #835 (qa on #830): a Refetch that finds the same job, link and all, changed nothing, and says
  // so; one that rewrote the link names the rewrite rather than "Checked".
  it('a Refetch that changes nothing answers unchanged (#835)', async () => {
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
    boardServes([posting('Platform Engineer', '1003')]);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(res.json()).toMatchObject({ outcome: 'attached', unchanged: true });
    expect(res.json().changed).toBeUndefined();
  });

  const refetch = async (a: TestClient, id: string) => {
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting?seen=confirmed`,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const entries = async (app: { db: Db }, a: TestClient, id: string) =>
    (await listActivities(app.db, ctxOf(a), id, { limit: 50, offset: 0 })).items.filter(
      (i) => i.title === 'Job posting attached',
    );

  it('Refetches that change nothing add no timeline entry, on the board description (#866)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    boardServes([posting('Staff Product Manager, SIEM', '7663059003')]);
    const first = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    // The first attach is recorded, with nothing said of what it changed: it is the first.
    expect(first.json()).toMatchObject({ outcome: 'attached' });
    expect(first.json().changed).toBeUndefined();
    expect(await entries(app, a, id)).toHaveLength(1);

    for (let i = 0; i < 2; i += 1) {
      expect(await refetch(a, id)).toMatchObject({ outcome: 'attached', unchanged: true });
    }
    expect(await entries(app, a, id)).toHaveLength(1);
  });

  it('a Refetch that changes only the description says so (#866)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    boardServes([posting('Staff Product Manager, SIEM', '7663059003')]);
    await a.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });
    boardServes([
      {
        ...posting('Staff Product Manager, SIEM', '7663059003'),
        descriptionMd: 'What We Do: now also Kafka.',
      },
    ]);

    const body = await refetch(a, id);

    expect(body).toMatchObject({ outcome: 'attached', changed: ['description'] });
    expect(body.unchanged).toBeUndefined();
    expect((await entries(app, a, id)).map((i) => i.bodyMd)).toContainEqual(
      expect.stringContaining("The description was updated to the board's."),
    );
  });

  it('a row picked on a confirmed posting names each thing it changed (#866)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    boardServes([{ ...posting('Staff Product Manager, SIEM', '7663059003'), location: undefined }]);
    await a.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });
    const picked = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting`,
      payload: {
        posting: {
          ...posting('Staff Product Manager, SIEM', '7663059004'),
          descriptionMd: 'Another text.',
          remote: true,
          compNote: '$200k',
        },
      },
    });
    expect(picked.statusCode, picked.body).toBe(200);
    const line = (await entries(app, a, id)).map((i) => i.bodyMd ?? '');
    expect(line).toContainEqual(
      expect.stringContaining("The posting link was updated to the board's."),
    );
    expect(line).toContainEqual(
      expect.stringContaining('Took location, remote, compensation from the board.'),
    );
  });

  it('a Refetch that fills in facts the opportunity lacked is not "nothing changed" (#866)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    const bare = { ...posting('Staff Product Manager, SIEM', '7663059003'), location: undefined };
    boardServes([bare]);
    await a.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });
    boardServes([{ ...bare, location: 'Berlin', remote: false, compNote: '$200k' }]);

    const body = await refetch(a, id);

    expect(body).toMatchObject({ changed: ['location', 'remote', 'compensation'] });
    expect(body.unchanged).toBeUndefined();
    expect(await entries(app, a, id)).toHaveLength(2);
  });

  // qa's 0.5.0 pass: the fields came back, and the answer was "unchanged".
  it('a Refetch that puts back fields the user cleared names them (#866)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    boardServes([
      {
        ...posting('Staff Product Manager, SIEM', '7663059003'),
        location: 'Berlin',
        remote: true,
      },
    ]);
    await a.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });
    const cleared = await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${id}`,
      payload: { location: null, remote: null },
    });
    expect(cleared.json()).toMatchObject({ location: null, remote: null });

    const body = await refetch(a, id);

    expect(body).toMatchObject({
      changed: ['location', 'remote'],
      opportunity: { location: 'Berlin', remote: true },
    });
    expect(body.unchanged).toBeUndefined();
    expect((await entries(app, a, id)).map((i) => i.bodyMd)).toContainEqual(
      expect.stringContaining('Took location, remote from the board.'),
    );
    // With those back, the next one changes nothing, and says so.
    expect(await refetch(a, id)).toMatchObject({ unchanged: true });
  });

  // qa and tl on #930: a Refetch is not the user's confirmation, so a kept description leaves the
  // state as it was, and "nothing changed" is true of the state too.
  describe('a Refetch leaves the confirmation as it was (#866)', () => {
    const MINE = 'my own notes on the role';
    /** Matched on the board, then its description edited: the state says nothing of the user. */
    async function matchedThenEdited() {
      const { app, a } = await boot();
      const id = await seed(app, a, { title: 'Product Manager, SIEM' });
      boardServes([posting('Staff Product Manager, SIEM', '7663059003')]);
      await a.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });
      const edited = await a.request({
        method: 'PATCH',
        url: `/api/v1/opportunities/${id}`,
        payload: { descriptionMd: MINE },
      });
      expect(edited.json()).toMatchObject({
        descriptionMd: MINE,
        postingState: 'confirmed',
        postingStateDetail: null,
      });
      return { app, a, id };
    }
    const state = async (app: { db: Db }, a: TestClient, id: string) => {
      const o = await getOpportunity(app.db, ctxOf(a), id);
      return [o.postingState, o.postingStateDetail, o.descriptionMd];
    };

    it('matched, then edited, nothing changed: still matched, and the answer says it was kept', async () => {
      const { app, a, id } = await matchedThenEdited();
      for (let i = 0; i < 2; i += 1) {
        expect(await refetch(a, id)).toMatchObject({
          outcome: 'attached',
          unchanged: true,
          keptDescription: true,
          opportunity: { postingState: 'confirmed', postingStateDetail: null },
        });
      }
      expect(await state(app, a, id)).toEqual(['confirmed', null, MINE]);
      expect(await entries(app, a, id)).toHaveLength(1);
      // Nothing of the user's to take back.
      const undo = await a.request({
        method: 'POST',
        url: `/api/v1/opportunities/${id}/posting/unconfirm`,
      });
      expect(undo.statusCode).toBe(409);
      // What user_confirmed guarded: neither a re-derive nor a check takes the text as the
      // employer's. The board is there to be read, with other text.
      const sctx = { fetch: missingFetch, log: { warn: () => undefined } } as never;
      await expect(rederivePosting(app.db, ctxOf(a), id, sctx)).rejects.toMatchObject({
        code: 'already_described',
      });
      await reconcilePosting(app.db, ctxOf(a), id, sctx);
      expect(await state(app, a, id)).toEqual(['needs_review', 'edited', MINE]);
    });

    it('matched, then edited, only the link changed: named and recorded, still matched', async () => {
      const { app, a } = await boot();
      const id = await seed(app, a, {
        title: 'Staff Platform Engineer',
        postingUrl: 'https://careers.sentineledge.example/jobs?gh_jid=1003',
        descriptionMd: MINE,
      });
      await storeIdentity(app, id, OWN_LINK);
      await setPostingState(app.db, ctxOf(a), id, {
        postingState: 'confirmed',
        postingStateDetail: null,
      });
      boardServes([posting('Platform Engineer', '1003')]);

      expect(await refetch(a, id)).toMatchObject({ changed: ['link'], keptDescription: true });

      expect(await state(app, a, id)).toEqual(['confirmed', null, MINE]);
      expect((await entries(app, a, id))[0]?.bodyMd).toContain('Your own description was kept.');
    });

    it('confirmed by the user, with their text: stays confirmed by them', async () => {
      const { app, a, id } = await matchedThenEdited();
      await setPostingState(app.db, ctxOf(a), id, {
        postingState: 'confirmed',
        postingStateDetail: 'user_confirmed',
      });
      expect(await refetch(a, id)).toMatchObject({ unchanged: true, keptDescription: true });
      expect(await state(app, a, id)).toEqual(['confirmed', 'user_confirmed', MINE]);
    });

    it("confirmed by the user, with the board's own text: stays confirmed by them", async () => {
      const { app, a } = await boot();
      const id = await seed(app, a, { title: 'Product Manager, SIEM' });
      boardServes([posting('Staff Product Manager, SIEM', '7663059003')]);
      await a.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });
      const text = (await getOpportunity(app.db, ctxOf(a), id)).descriptionMd;
      await setPostingState(app.db, ctxOf(a), id, {
        postingState: 'confirmed',
        postingStateDetail: 'user_confirmed',
      });
      const body = await refetch(a, id);
      expect(body).toMatchObject({ unchanged: true });
      expect(body.keptDescription).toBeUndefined();
      expect(await state(app, a, id)).toEqual(['confirmed', 'user_confirmed', text]);
    });

    // As before: the board's text is what is stored now, and it is said.
    it("confirmed by the user, with the board's older text: the new copy is a match", async () => {
      const { app, a } = await boot();
      const id = await seed(app, a, { title: 'Product Manager, SIEM' });
      const p = posting('Staff Product Manager, SIEM', '7663059003');
      boardServes([p]);
      await a.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });
      await setPostingState(app.db, ctxOf(a), id, {
        postingState: 'confirmed',
        postingStateDetail: 'user_confirmed',
      });
      boardServes([{ ...p, descriptionMd: 'What We Do: now also Kafka.' }]);
      expect(await refetch(a, id)).toMatchObject({ changed: ['description'] });
      expect(await state(app, a, id)).toEqual(['confirmed', null, 'What We Do: now also Kafka.']);
    });

    // The user's choice, as before.
    it('a row picked on a matched posting, their description kept: confirmed by them', async () => {
      const { app, a, id } = await matchedThenEdited();
      const picked = await a.request({
        method: 'POST',
        url: `/api/v1/opportunities/${id}/posting`,
        payload: { posting: posting('Staff Product Manager, SIEM', '7663059003') },
      });
      expect(picked.statusCode, picked.body).toBe(200);
      expect(await state(app, a, id)).toEqual(['confirmed', 'user_confirmed', MINE]);
    });
  });

  it('a row picked by hand is recorded even when it changes nothing (#866)', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    const same = posting('Staff Product Manager, SIEM', '7663059003');
    boardServes([same]);
    await a.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });
    const picked = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting`,
      payload: { posting: same },
    });
    expect(picked.statusCode, picked.body).toBe(200);
    expect(await entries(app, a, id)).toHaveLength(2);
  });

  it('a Refetch that rewrote the link names the rewrite, not "Checked" (#835)', async () => {
    const { app, a } = await boot();
    const careers = 'https://careers.sentineledge.example/jobs?gh_jid=1003';
    const id = await seed(app, a, {
      title: 'Staff Platform Engineer',
      postingUrl: careers,
      descriptionMd: 'my own notes on the role',
    });
    await storeIdentity(app, id, OWN_LINK);
    await setPostingState(app.db, ctxOf(a), id, {
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });
    boardServes([posting('Platform Engineer', '1003')]);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(res.json()).toMatchObject({ outcome: 'attached', changed: ['link'] });
    expect(res.json().unchanged).not.toBe(true);
    expect((await getOpportunity(app.db, ctxOf(a), id)).postingUrl).toBe(OWN_LINK);
    const { items } = await listActivities(app.db, ctxOf(a), id, { limit: 50, offset: 0 });
    const line = items.find((i) => i.title === 'Job posting attached')?.bodyMd ?? '';
    expect(line).not.toContain('Checked on the company');
    expect(line).toContain('link');
    expect(line).toContain('Your own description was kept.');
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

// The job Find posting found is tracked already (https://github.com/bgoleno/opportun/issues/936): the
// refusal names that opportunity, the user's own.
describe('a job already tracked as another opportunity', () => {
  /** One of a's tracking the job at the board's location, and another without a location. */
  async function twice() {
    const { app, a, b } = await boot();
    const p = posting('Product Manager, SIEM', '7663059003');
    const id = await seed(app, a, { title: 'Product Manager, SIEM' });
    const tracked = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      location: p.location!,
      sourceKind: 'manual',
    });
    boardServes([p]);
    return { app, a, b, id, tracked: tracked.id, p };
  }
  const named = (existingId: string) => ({
    error: {
      code: 'duplicate',
      existingId,
      existingTitle: 'Product Manager, SIEM',
      existingCompany: 'Sentinel Edge',
    },
  });

  it('Find posting: refused, naming it, with nothing attached', async () => {
    const { app, a, id, tracked } = await twice();
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual(named(tracked));
    expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject({
      postingUrl: null,
      postingState: null,
      descriptionMd: null,
    });
  });

  it('a row picked by hand: the same', async () => {
    const { a, id, tracked, p } = await twice();
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting`,
      payload: { posting: p },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual(named(tracked));
  });

  it("another user's opportunity for the job neither refuses nor is named", async () => {
    const { app, b, tracked, p } = await twice();
    const id = await seed(app, b, { title: 'Product Manager, SIEM' });
    boardServes([p]);
    const res = await b.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'attached' });
    expect(res.body).not.toContain(tracked);
  });

  // Gone between the refusal and the lookup: the refusal stands, unnamed.
  it('one deleted as it is refused: still refused, without a name', async () => {
    const { app, a, id, tracked } = await twice();
    setRaceHook(async (point) => {
      if (point === 'posting.alreadyTracked') await deleteOpportunity(app.db, ctxOf(a), tracked);
    });
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'duplicate', existingId: tracked } });
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

  // #1010: force alone is an answer about some text; `replaceDescription` says which.
  describe('over the description it was asked about, and no other', () => {
    const OLD = 'my own notes';
    const MINE = 'what I wrote in the other tab: café, 東京 🚀';
    /** An opportunity with a stored capture and `text`, the user's own or the system's. */
    async function captured(text: string | null, by: 'user' | 'system') {
      const { app, a } = await boot();
      const ctx = ctxOf(a);
      const id = await seed(app, a, {
        title: 'Staff Product Manager',
        ats: false,
        ...(text === null ? {} : { descriptionMd: text }),
      });
      await createActivity(app.db, ctx, id, {
        kind: 'capture',
        title: 'Captured from LinkedIn',
        bodyMd: RAW_CAPTURE,
        occurredAt: Date.now(),
        participants: [],
        externalUrl: 'https://www.linkedin.com/jobs/view/1',
      });
      if (text !== null && by === 'system') {
        await updateOpportunity(app.db, ctx, id, {
          descriptionFingerprint: descriptionFingerprint(text),
        });
      }
      return {
        app,
        id,
        ctx,
        // Another tab of the same user's: its save is a request of its own.
        save: async (descriptionMd: string | null) => {
          const res = await a.request({
            method: 'PATCH',
            url: `/api/v1/opportunities/${id}`,
            payload: { descriptionMd },
          });
          expect(res.statusCode, res.body).toBe(200);
        },
        rederive: (payload: Record<string, unknown>) =>
          a.request({
            method: 'POST',
            url: `/api/v1/opportunities/${id}/posting/rederive`,
            payload,
          }),
        read: () => getOpportunity(app.db, ctx, id),
        notes: async () =>
          (await listActivities(app.db, ctx, id, { limit: 50, offset: 0 })).items
            .filter((i) => i.kind === 'note')
            .map((i) => i.title),
      };
    }
    /** What the page sends: the answer, and the text it was about. */
    const about = (text: string | null) => ({
      force: true,
      replaceDescription: sha256Hex(text ?? ''),
    });

    it.each([
      ['the user’s own', OLD, 'user'],
      ['the system’s', OLD, 'system'],
      ['none', null, 'system'],
    ] as const)('%s, as it was asked about: replaced', async (_what, text, by) => {
      const { rederive, read } = await captured(text, by);
      const res = await rederive(about(text));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ outcome: 'capture_only' });
      expect((await read()).descriptionMd).toContain('telemetry infrastructure');
    });

    it.each([
      ['an edit of the user’s own', OLD, 'user'],
      ['an edit of the system’s', OLD, 'system'],
      ['a first description', null, 'system'],
    ] as const)('%s in another tab since is kept, and it says so', async (_what, text, by) => {
      const { save, rederive, read, notes } = await captured(text, by);
      await save(MINE);
      const before = await read();
      const res = await rederive(about(text));
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toEqual({
        code: 'description_changed',
        message:
          "This opportunity's description changed since this page showed it, so nothing was changed. Check the description, then try again.",
      });
      expect(await read()).toEqual(before);
      expect(before.descriptionMd).toBe(MINE);
      expect(await notes()).toEqual([]);
      // Asked again, about the text that is there.
      expect((await rederive(about(MINE))).statusCode).toBe(200);
    });

    it('a description cleared in another tab since is not filled', async () => {
      const { save, rederive, read } = await captured(OLD, 'user');
      await save(null);
      expect((await rederive(about(OLD))).statusCode).toBe(409);
      expect((await read()).descriptionMd).toBeNull();
    });

    // Not the user's, so their edit is not at stake; but it is not what they were asked about.
    it('a copy the board check wrote since is left too', async () => {
      const { app, ctx, id, rederive, read } = await captured(OLD, 'system');
      await updateOpportunity(app.db, ctx, id, {
        descriptionMd: "the board's copy",
        descriptionFingerprint: descriptionFingerprint("the board's copy"),
      });
      expect((await rederive(about(OLD))).statusCode).toBe(409);
      expect((await read()).descriptionMd).toBe("the board's copy");
    });

    // A page open across the upgrade, or another caller: it says yes, and not to what.
    it('force alone does not replace the user’s own description', async () => {
      const { rederive, read } = await captured(OLD, 'user');
      const res = await rederive({ force: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('already_described');
      expect((await read()).descriptionMd).toBe(OLD);
    });

    it('force alone still re-derives over the system’s', async () => {
      const { rederive } = await captured(OLD, 'system');
      expect((await rederive({ force: true })).json().outcome).toBe('capture_only');
    });

    it('the text alone, with no force, replaces nothing of the user’s', async () => {
      const { rederive, read } = await captured(OLD, 'user');
      const res = await rederive({ replaceDescription: sha256Hex(OLD) });
      expect(res.json().error.code).toBe('already_described');
      expect((await read()).descriptionMd).toBe(OLD);
    });

    it.each(['', 'x', 'A'.repeat(64)])(
      'a fingerprint that is not one is refused: %s',
      async (bad) => {
        const { rederive, read } = await captured(OLD, 'user');
        expect((await rederive({ force: true, replaceDescription: bad })).statusCode).toBe(400);
        expect((await read()).descriptionMd).toBe(OLD);
      },
    );

    it('a posting the user confirmed, with their own text: both, as before', async () => {
      const { app, ctx, id, rederive, read } = await captured(OLD, 'user');
      await setPostingState(app.db, ctx, id, {
        postingState: 'confirmed',
        postingStateDetail: 'user_confirmed',
      });
      expect((await rederive({ replaceDescription: sha256Hex(OLD) })).json().error.code).toBe(
        'user_confirmed',
      );
      expect((await rederive({ force: true })).json().error.code).toBe('already_described');
      expect((await read()).descriptionMd).toBe(OLD);
      expect((await rederive(about(OLD))).statusCode).toBe(200);
    });
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
