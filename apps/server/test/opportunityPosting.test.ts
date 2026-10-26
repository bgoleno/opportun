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
import { communications } from '../src/db/schema';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import { createCompany } from '../src/repos/companies';
import { upsertInbound } from '../src/repos/communications';
import { createOpportunity, setPostingState, updateOpportunity } from '../src/repos/opportunities';
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
  opts: { title: string; company?: string; ats?: boolean; descriptionMd?: string },
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

  it('refuses an opportunity that already has a description', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, {
      title: 'Product Manager, SIEM',
      descriptionMd: 'already here',
    });
    boardServes([posting('Staff Product Manager, SIEM', '7663059003')]);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'already_described' });
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
