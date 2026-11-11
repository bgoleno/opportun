// Every writer of a posting's identity, for a Greenhouse job embedded on a company's own careers
// page (https://github.com/bgoleno/opportun/issues/398, criteria 2, 3 and 6, with tl's note on
// board reads). Every host here is synthetic; the only "requests" are to a counting fake.
import type { AtsJobRef, NormalizedPosting } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import type { Db } from '../src/db/client';
import { communications, opportunities, resumes } from '../src/db/schema';
import { backfillAtsJobRefs } from '../src/jobs/atsJobRefBackfill';
import { reconcilePosting } from '../src/jobs/postingReconcile';
import { attachPosting } from '../src/lib/postingAttach';
import { confirmPosting } from '../src/lib/postingConfirm';
import type { safeFetch } from '../src/lib/safeFetch';
import { upsertInbound } from '../src/repos/communications';
import { createCompany } from '../src/repos/companies';
import {
  createOpportunity,
  getOpportunity,
  recordAtsJobRef,
  setPostingState,
  updateOpportunity,
} from '../src/repos/opportunities';
import { insertResume } from '../src/repos/resumes';
import { destinationRefusal } from '../src/repos/submissionReview';
import { createSubmissionDraft } from '../src/repos/submissions';
import { useApi } from './api';
import type { TestClient } from './isolation';

const JID = '8136554';
const CAREERS = `https://careers.examplecorp.example/jobs?gh_jid=${JID}`;
const BOARD_PAGE = `https://job-boards.greenhouse.io/examplecorp/jobs/${JID}`;
const VERIFIED: AtsJobRef = {
  kind: 'ats_greenhouse',
  org: 'examplecorp',
  externalId: JID,
  url: BOARD_PAGE,
  verifiedVia: 'gh_jid',
  verifiedAt: 1_700_000_000_000,
};

/** Greenhouse's job endpoint for the boards in `holds`, counting every request made. */
function greenhouseApi(holds: Record<string, string[]> = {}) {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    const m = /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs\/([0-9]+)$/.exec(
      url,
    );
    const held =
      m !== null && new Map(Object.entries(holds)).get(m[1] as string)?.includes(m[2] as string);
    return {
      status: held === true ? 200 : 404,
      headers: new Headers(),
      body: Buffer.from(held === true ? JSON.stringify({ id: Number(m?.[2]) }) : '{}'),
    };
  }) as unknown as typeof safeFetch;
  return { asked, fetch };
}

let api = greenhouseApi();
const boot = useApi(() => ({
  build: { sourceFetch: ((...args: Parameters<typeof safeFetch>) => api.fetch(...args)) as never },
}));
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
afterEach(() => {
  resetSources();
  api = greenhouseApi();
});

/** An embedded Greenhouse board: its API gives each posting the company's careers link. */
function embeddedBoardServes(postings: NormalizedPosting[]): { reads: number } {
  const counter = { reads: 0 };
  const source: DiscoverySource = {
    kind: 'ats_greenhouse',
    async *fetchPostings() {
      counter.reads += 1;
      for (const p of postings) yield { posting: p, nextCursor: null };
    },
  };
  registerSource(source);
  return counter;
}

function embedded(title: string, externalId: string, link = CAREERS): NormalizedPosting {
  return {
    company: 'Example Corp',
    title,
    descriptionMd: `What We Do: ${title}.`,
    postingUrl: link,
    location: 'Remote',
    externalId,
  };
}

async function seed(
  app: { db: Db },
  c: TestClient,
  opts: { board?: string | null; title?: string } = {},
): Promise<string> {
  const ctx = ctxOf(c);
  const board = opts.board === undefined ? 'examplecorp' : opts.board;
  await createCompany(app.db, ctx, {
    name: 'Example Corp',
    ...(board === null
      ? {}
      : { atsKind: 'ats_greenhouse', atsRef: board, atsVerifiedAt: Date.now() }),
  });
  const opp = await createOpportunity(app.db, ctx, {
    companyName: 'Example Corp',
    title: opts.title ?? 'Staff Platform Engineer',
    sourceKind: 'import',
  });
  return opp.id;
}

async function refOf(app: { db: Db }, c: TestClient, id: string) {
  return (await getOpportunity(app.db, ctxOf(c), id)).atsJobRef ?? null;
}

/** One of the user's messages, linked to the opportunity, carrying `body`. */
async function linkedMail(app: { db: Db }, c: TestClient, opportunityId: string, body: string) {
  const { id } = await upsertInbound(app.db, ctxOf(c), 'gmail', {
    externalId: `m-${opportunityId}`,
    threadKey: `t-${opportunityId}`,
    from: 'recruiter@example.com',
    to: ['owner@example.com'],
    subject: 'The role',
    snippet: body.slice(0, 80),
    bodyText: body,
    sentAt: Date.now(),
  });
  await app.db.update(communications).set({ opportunityId }).where(eq(communications.id, id)).run();
}

/** A final base resume the draft can use. */
async function finalBaseResume(app: { db: Db }, c: TestClient): Promise<string> {
  const r = await insertResume(app.db, ctxOf(c), {
    kind: 'base',
    title: 'Example Resume',
    store: 'local_file',
    docRef: `resumes/${crypto.randomUUID()}.txt`,
    opportunityId: null,
    parentResumeId: null,
  });
  await app.db.update(resumes).set({ status: 'final' }).where(eq(resumes.id, r.id)).run();
  return r.id;
}

describe("Find posting resolves the opportunity's own careers link (tl on #414, blocking 1)", () => {
  it('the posting with that gh_jid on the company board is the hit, ahead of a title match, with no extra request', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { title: 'Staff Platform Engineer' });
    await updateOpportunity(app.db, ctxOf(a), id, { postingUrl: CAREERS });
    // A same-title posting first, then the job the link names: the link's job wins.
    const board = embeddedBoardServes([
      embedded('Staff Platform Engineer', '1', 'https://careers.examplecorp.example/jobs?gh_jid=1'),
      embedded('Senior Platform Engineer, Infra', JID),
    ]);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('attached');
    expect(res.json().candidate.posting.externalId).toBe(JID);
    expect(await refOf(app, a, id)).toMatchObject({
      org: 'examplecorp',
      externalId: JID,
      url: BOARD_PAGE,
    });
    expect(board.reads).toBe(1);
    expect(api.asked).toEqual([]);
  });

  it('when no board read answers it, the identity comes from the API check, and the description is left alone', async () => {
    const { app, a } = await boot();
    api = greenhouseApi({ examplecorp: [JID] });
    const id = await seed(app, a, { title: 'Staff Platform Engineer' });
    await updateOpportunity(app.db, ctxOf(a), id, { postingUrl: CAREERS });
    embeddedBoardServes([]);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await refOf(app, a, id)).toMatchObject({ org: 'examplecorp', url: BOARD_PAGE });
    expect(api.asked).toHaveLength(1);
    expect((await getOpportunity(app.db, ctxOf(a), id)).descriptionMd ?? null).toBeNull();
  });

  it("a description the user wrote: no board read, the API check, and the user's text untouched", async () => {
    const { app, a } = await boot();
    api = greenhouseApi({ examplecorp: [JID] });
    const id = await seed(app, a);
    await updateOpportunity(app.db, ctxOf(a), id, {
      postingUrl: CAREERS,
      descriptionMd: 'My own notes about this role.',
    });
    const board = embeddedBoardServes([embedded('Staff Platform Engineer', JID)]);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('identified');
    expect(board.reads).toBe(0);
    expect(await refOf(app, a, id)).toMatchObject({ org: 'examplecorp', url: BOARD_PAGE });
    expect((await getOpportunity(app.db, ctxOf(a), id)).descriptionMd).toBe(
      'My own notes about this role.',
    );
  });

  it('a description the user wrote and no board holds the job: 409 as before, and no identity', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    await updateOpportunity(app.db, ctxOf(a), id, {
      postingUrl: CAREERS,
      descriptionMd: 'My own notes about this role.',
    });
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(res.statusCode).toBe(409);
    expect(await refOf(app, a, id)).toBeNull();
  });

  it('the same careers link arriving only in mail gets no identity, and no request (criterion 6)', async () => {
    const { app, a } = await boot();
    api = greenhouseApi({ examplecorp: [JID] });
    const id = await seed(app, a);
    await linkedMail(app, a, id, `Here is the role: ${CAREERS}`);
    embeddedBoardServes([]);
    await a.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });
    expect(await refOf(app, a, id)).toBeNull();
    expect(api.asked).toEqual([]);
  });
});

describe("the own link is matched only on the company's own boards (sec on #414, R4)", () => {
  it('a board a message names, holding the same job id, never gives the identity, and is never asked', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    await updateOpportunity(app.db, ctxOf(a), id, { postingUrl: CAREERS });
    // A message links a job on another board; that board also holds the own link's job id.
    await linkedMail(app, a, id, 'See https://job-boards.greenhouse.io/othercorp/jobs/999');
    const reads: string[] = [];
    const source: DiscoverySource = {
      kind: 'ats_greenhouse',
      async *fetchPostings(_sctx, config) {
        const org = String((config as { org?: unknown }).org);
        reads.push(org);
        if (org === 'othercorp') {
          yield { posting: embedded('Staff Platform Engineer', JID), nextCursor: null };
        }
      },
    };
    registerSource(source);
    await a.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });
    const ref = await refOf(app, a, id);
    expect(ref?.org ?? null).not.toBe('othercorp');
    expect((await getOpportunity(app.db, ctxOf(a), id)).descriptionMd ?? null).toBeNull();
    expect(api.asked.some((u) => u.includes('othercorp'))).toBe(false);
    expect(reads).toContain('examplecorp');
  });
});

describe('attach from a board read keeps the identity of the link it keeps (tl on #414, blocking 3)', () => {
  it('a posting with no link of its own keeps the verified identity of the stored careers link', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    await updateOpportunity(app.db, ctxOf(a), id, { postingUrl: CAREERS });
    await setPostingState(app.db, ctxOf(a), id, {
      postingState: 'confirmed',
      postingStateDetail: null,
      atsJobRef: VERIFIED,
    });
    await attachPosting(
      app.db,
      ctxOf(a),
      id,
      {
        company: 'Example Corp',
        title: 'Staff Platform Engineer',
        descriptionMd: 'What We Do.',
        externalId: JID,
      },
      'board',
      undefined,
      { readFrom: { kind: 'ats_greenhouse', org: 'examplecorp' } },
    );
    expect(await refOf(app, a, id)).toMatchObject({
      org: 'examplecorp',
      externalId: JID,
      url: BOARD_PAGE,
    });
  });
});

describe('recordAtsJobRef writes only for the link that was checked (tl on #414)', () => {
  it('a link other than the stored one: nothing is written', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    await updateOpportunity(app.db, ctxOf(a), id, { postingUrl: CAREERS });
    const before = await getOpportunity(app.db, ctxOf(a), id);
    // Proven for another link than the one stored now (the user changed it meanwhile).
    expect(
      await recordAtsJobRef(
        app.db,
        ctxOf(a),
        id,
        'https://careers.examplecorp.example/jobs?gh_jid=42',
        VERIFIED,
      ),
    ).toBeNull();
    const after = await getOpportunity(app.db, ctxOf(a), id);
    expect(after.atsJobRef ?? null).toBeNull();
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('an identity already set: nothing is written over it', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    await updateOpportunity(app.db, ctxOf(a), id, { postingUrl: CAREERS });
    const other = {
      ...VERIFIED,
      org: 'othercorp',
      url: 'https://job-boards.greenhouse.io/othercorp/jobs/8136554',
    };
    await setPostingState(app.db, ctxOf(a), id, {
      postingState: 'confirmed',
      postingStateDetail: null,
      atsJobRef: other,
    });
    const before = await getOpportunity(app.db, ctxOf(a), id);
    expect(await recordAtsJobRef(app.db, ctxOf(a), id, CAREERS, VERIFIED)).toBeNull();
    const after = await getOpportunity(app.db, ctxOf(a), id);
    expect(after.atsJobRef).toEqual(other);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('the stored link and no identity: written', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    await updateOpportunity(app.db, ctxOf(a), id, { postingUrl: CAREERS });
    expect((await recordAtsJobRef(app.db, ctxOf(a), id, CAREERS, VERIFIED))?.atsJobRef).toEqual(
      VERIFIED,
    );
  });
});

describe('a draft from a verified identity hands off to the board page (criterion 2)', () => {
  it("the draft's destination is the board page, never the careers link", async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    await updateOpportunity(app.db, ctxOf(a), id, { postingUrl: CAREERS });
    await app.db
      .update(opportunities)
      .set({ stage: 'interested' })
      .where(eq(opportunities.id, id))
      .run();
    await setPostingState(app.db, ctxOf(a), id, {
      postingState: 'confirmed',
      postingStateDetail: null,
      atsJobRef: VERIFIED,
    });
    const resume = await finalBaseResume(app, a);
    const { submission } = await createSubmissionDraft(app.db, ctxOf(a), id, {
      resumeId: resume,
      idempotencyKey: 'k-398',
    });
    expect(submission.destinationUrl).toBe(BOARD_PAGE);
    expect(submission.atsRef).toBe('examplecorp');
    expect(submission.atsExternalId).toBe(JID);
  });
});

describe('writers that ask nobody keep a verified identity while the link names its job (criterion 3)', () => {
  it("a user's confirm keeps it, and drops it for a link that names another job", async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    await updateOpportunity(app.db, ctxOf(a), id, { postingUrl: CAREERS });
    await setPostingState(app.db, ctxOf(a), id, {
      postingState: 'needs_review',
      postingStateDetail: 'ambiguous',
      atsJobRef: VERIFIED,
    });
    await confirmPosting(app.db, ctxOf(a), id);
    expect(await refOf(app, a, id)).toEqual(VERIFIED);

    const { id: other } = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Example Corp',
      title: 'Another Role',
      sourceKind: 'import',
    });
    await updateOpportunity(app.db, ctxOf(a), other, {
      postingUrl: 'https://careers.examplecorp.example/jobs?gh_jid=1',
    });
    await setPostingState(app.db, ctxOf(a), other, {
      postingState: 'needs_review',
      postingStateDetail: 'ambiguous',
      atsJobRef: VERIFIED,
    });
    await confirmPosting(app.db, ctxOf(a), other);
    expect(await refOf(app, a, other)).toBeNull();
    expect(api.asked).toEqual([]);
  });

  it('the backfill leaves a verified identity in place, and asks nobody', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    await updateOpportunity(app.db, ctxOf(a), id, { postingUrl: CAREERS });
    await setPostingState(app.db, ctxOf(a), id, {
      postingState: 'confirmed',
      postingStateDetail: null,
      atsJobRef: VERIFIED,
    });
    expect(await backfillAtsJobRefs(app.db, ctxOf(a))).toEqual({
      read: 1,
      set: 0,
      changed: 0,
      cleared: 0,
    });
    expect(await refOf(app, a, id)).toEqual(VERIFIED);
    expect(api.asked).toEqual([]);
  });

  it('a URL edit in the repository (no request) keeps it for the same job and drops it for another', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    await setPostingState(app.db, ctxOf(a), id, {
      postingState: 'confirmed',
      postingStateDetail: null,
      atsJobRef: VERIFIED,
    });
    await updateOpportunity(app.db, ctxOf(a), id, {
      postingUrl: `https://www.examplecorp.example/careers/eng?gh_jid=${JID}`,
    });
    expect(await refOf(app, a, id)).toEqual(VERIFIED);
    await updateOpportunity(app.db, ctxOf(a), id, {
      postingUrl: 'https://www.examplecorp.example/careers/eng?gh_jid=42',
    });
    expect(await refOf(app, a, id)).toBeNull();
  });
});

describe('a board read is the proof: reconcile and Find posting record it with no extra request (tl on #398)', () => {
  it('Find posting attaches a posting read from the embedded board with the verified identity', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    const board = embeddedBoardServes([
      embedded('Staff Platform Engineer', JID),
      embedded('Designer', '2', 'https://careers.examplecorp.example/jobs?gh_jid=2'),
    ]);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('attached');
    const ref = await refOf(app, a, id);
    expect(ref).toMatchObject({
      kind: 'ats_greenhouse',
      org: 'examplecorp',
      externalId: JID,
      url: BOARD_PAGE,
      verifiedVia: 'gh_jid',
    });
    // The posting stays as the user has it: the careers link.
    expect(res.json().opportunity.postingUrl).toBe(CAREERS);
    expect(board.reads).toBe(1);
    expect(api.asked).toEqual([]);
  });

  it('reconcile records it from its own read, with no request', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    await updateOpportunity(app.db, ctxOf(a), id, { postingUrl: CAREERS });
    const board = embeddedBoardServes([embedded('Staff Platform Engineer', JID)]);
    const out = await reconcilePosting(app.db, ctxOf(a), id, {
      fetch: api.fetch,
      log: { warn: () => {}, info: () => {}, error: () => {} } as never,
    });
    expect(out).toMatchObject({ status: 'confirmed' });
    expect(await refOf(app, a, id)).toMatchObject({ org: 'examplecorp', verifiedVia: 'gh_jid' });
    expect(board.reads).toBe(1);
    expect(api.asked).toEqual([]);
  });

  it("a posting whose link's gh_jid differs from its own id gets none", async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    embeddedBoardServes([
      embedded('Staff Platform Engineer', JID, 'https://careers.examplecorp.example/jobs?gh_jid=1'),
    ]);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/find-posting`,
    });
    expect(res.json().outcome).toBe('attached');
    expect(await refOf(app, a, id)).toBeNull();
  });

  it("a board= parameter in the posting's link is ignored: the token is the board that was read", async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    embeddedBoardServes([embedded('Staff Platform Engineer', JID, `${CAREERS}&board=othercorp`)]);
    await a.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });
    expect((await refOf(app, a, id))?.org).toBe('examplecorp');
  });
});

describe('a careers link from anywhere else needs its own check (criterion 1)', () => {
  it('a pasted careers link: one request to the known board, then the verified identity', async () => {
    const { app, a } = await boot();
    api = greenhouseApi({ examplecorp: [JID] });
    const id = await seed(app, a);
    const res = await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${id}`,
      payload: { postingUrl: CAREERS },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await refOf(app, a, id)).toMatchObject({ org: 'examplecorp', url: BOARD_PAGE });
    expect(api.asked).toEqual([
      `https://boards-api.greenhouse.io/v1/boards/examplecorp/jobs/${JID}`,
    ]);
  });

  it('no known board: no request and no identity', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { board: null });
    await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${id}`,
      payload: { postingUrl: CAREERS },
    });
    expect(await refOf(app, a, id)).toBeNull();
    expect(api.asked).toEqual([]);
  });

  it('a known board that does not hold the job: no identity', async () => {
    const { app, a } = await boot();
    api = greenhouseApi({ examplecorp: ['1'] });
    const id = await seed(app, a);
    await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${id}`,
      payload: { postingUrl: CAREERS },
    });
    expect(await refOf(app, a, id)).toBeNull();
    expect(api.asked).toHaveLength(1);
  });
});

describe('a picked board row comes from the client: never a board read (sec on #414)', () => {
  const picked = {
    ...embedded('Staff Platform Engineer', JID, `${CAREERS}&board=othercorp`),
  };

  it("is checked with one request to the company's own board; board= is never asked", async () => {
    const { app, a } = await boot();
    api = greenhouseApi({ examplecorp: [JID], othercorp: [JID] });
    const id = await seed(app, a);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting`,
      payload: { posting: picked },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await refOf(app, a, id)).toMatchObject({ org: 'examplecorp', url: BOARD_PAGE });
    expect(api.asked).toEqual([
      `https://boards-api.greenhouse.io/v1/boards/examplecorp/jobs/${JID}`,
    ]);
  });

  it('gets no identity when the known board says no, whatever the row claims', async () => {
    const { app, a } = await boot();
    api = greenhouseApi({ othercorp: [JID] });
    const id = await seed(app, a);
    await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/posting`,
      payload: { posting: picked },
    });
    expect(await refOf(app, a, id)).toBeNull();
    expect(api.asked.some((u) => u.includes('othercorp'))).toBe(false);
  });
});

describe('the handoff destination (criterion 2)', () => {
  it('is the board page; the careers link itself is still refused as a destination', () => {
    const sub = { atsKind: 'ats_greenhouse' as const, atsExternalId: JID, atsRef: 'examplecorp' };
    expect(destinationRefusal(BOARD_PAGE, sub)).toBeNull();
    expect(destinationRefusal(CAREERS, sub)).toBe('not_ats_board');
  });
});
