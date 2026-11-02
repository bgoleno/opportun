// An opportunity's ATS identity follows its posting, however the posting got there (issue
// https://github.com/bgoleno/opportun/issues/137, with the Tech Lead's design note on it).
// Organised by the issue's acceptance criteria. Every URL here is synthetic; nothing is fetched.
import type { NormalizedPosting } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { opportunities, resumes, settings } from '../src/db/schema';
import {
  BACKFILL_ATS_JOB_REFS_MARKER_KEY,
  backfillAtsJobRefs,
  enqueueBackfillAtsJobRefsOnce,
} from '../src/jobs/atsJobRefBackfill';
import { confirm } from '../src/jobs/postingReconcile';
import { postingAtsJobRef } from '../src/lib/atsJobRef';
import { attachPosting } from '../src/lib/postingAttach';
import { confirmPosting } from '../src/lib/postingConfirm';
import type { UserCtx } from '../src/repos/base';
import { createOpportunity, getOpportunity, updateOpportunity } from '../src/repos/opportunities';
import { insertResume } from '../src/repos/resumes';
import { useApi } from './api';
import { captureLogs } from './helpers';
import { pauseAt } from './race';
import type { TestClient } from './isolation';

const boot = useApi();
const logs = captureLogs();
const logBoot = useApi(() => ({ logStream: logs }));
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

const BOARD_URL = 'https://job-boards.greenhouse.io/sentineledge/jobs/7663059003';
const OTHER_BOARD_URL = 'https://jobs.lever.co/sentineledge/5a6b7c8d-1111-2222-3333-444455556666';
/** A company career page embedding the same Greenhouse job: no board host, so no identity. */
const CAREER_PAGE_URL = 'https://www.sentineledge.example/careers/apply?gh_jid=7663059003';

const BOARD_REF = {
  kind: 'ats_greenhouse' as const,
  org: 'sentineledge',
  externalId: '7663059003',
  url: BOARD_URL,
};

const posting = (postingUrl: string | null, text = 'What We Do: cybercrime is growing.') =>
  ({
    company: 'Sentinel Edge',
    title: 'Staff Product Manager, SIEM',
    descriptionMd: text,
    postingUrl,
  }) as NormalizedPosting;

async function newOpportunity(app: FastifyInstance, c: TestClient): Promise<string> {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Sentinel Edge',
    title: `Product Manager, SIEM ${Math.random().toString(36).slice(2, 8)}`,
    sourceKind: 'import',
  });
  return opp.id;
}

const refOf = async (app: FastifyInstance, c: TestClient, id: string) =>
  (await getOpportunity(app.db, ctxOf(c), id)).atsJobRef ?? null;

describe('the shared rule (lib/atsJobRef postingAtsJobRef)', () => {
  it.each([
    ['a Greenhouse board posting', BOARD_URL, BOARD_REF],
    [
      'a Lever board posting',
      OTHER_BOARD_URL,
      {
        kind: 'ats_lever',
        org: 'sentineledge',
        externalId: '5a6b7c8d-1111-2222-3333-444455556666',
        url: OTHER_BOARD_URL,
      },
    ],
    [
      'a gh_jid on the board host itself: the board slug stands in for the org',
      'https://job-boards.greenhouse.io/sentineledge?gh_jid=7663059003',
      {
        kind: 'ats_greenhouse',
        org: 'sentineledge',
        externalId: '7663059003',
        url: 'https://job-boards.greenhouse.io/sentineledge?gh_jid=7663059003',
      },
    ],
  ])('%s gives its identity', (_n, url, expected) => {
    expect(postingAtsJobRef(url)).toEqual(expected);
  });

  it.each([
    ['a career page embedding a board (gh_jid)', CAREER_PAGE_URL],
    ['a board with no single job', 'https://job-boards.greenhouse.io/sentineledge'],
    ['a LinkedIn job', 'https://www.linkedin.com/jobs/view/1234567890'],
    ['no URL', null],
  ])('%s gives none', (_n, url) => {
    expect(postingAtsJobRef(url)).toBeNull();
  });
});

describe('criterion 1: attaching a board posting records its identity with the confirm', () => {
  it('a board URL sets the ref the shared rule gives, and the posting is confirmed', async () => {
    const { app, a } = await boot();
    const id = await newOpportunity(app, a);
    const view = await attachPosting(app.db, ctxOf(a), id, posting(BOARD_URL), 'board');
    expect(view.postingState).toBe('confirmed');
    expect(view.atsJobRef).toEqual(BOARD_REF);
    expect(await refOf(app, a, id)).toEqual(postingAtsJobRef(BOARD_URL));
  });

  it('a posting with no URL of its own keeps the stored URL, and its identity', async () => {
    const { app, a } = await boot();
    const id = await newOpportunity(app, a);
    await app.db
      .update(opportunities)
      .set({ postingUrl: BOARD_URL })
      .where(eq(opportunities.id, id))
      .run();
    const view = await attachPosting(app.db, ctxOf(a), id, posting(null), 'paste');
    expect(view.postingUrl).toBe(BOARD_URL);
    expect(view.atsJobRef).toEqual(BOARD_REF);
  });
});

describe('criteria 2 and 3: a posting that is not on a board leaves no identity, old or new', () => {
  it('a career-page (gh_jid) posting gives no ref', async () => {
    const { app, a } = await boot();
    const id = await newOpportunity(app, a);
    const view = await attachPosting(app.db, ctxOf(a), id, posting(CAREER_PAGE_URL), 'paste');
    expect(view.postingState).toBe('confirmed');
    expect(view.atsJobRef ?? null).toBeNull();
  });

  it('attaching a non-board posting over one with a ref clears it', async () => {
    const { app, a } = await boot();
    const id = await newOpportunity(app, a);
    await attachPosting(app.db, ctxOf(a), id, posting(BOARD_URL), 'board');
    expect(await refOf(app, a, id)).toEqual(BOARD_REF);
    // The system wrote the first description, so a replacement posting may follow it.
    await attachPosting(app.db, ctxOf(a), id, posting(CAREER_PAGE_URL, 'Another text.'), 'paste');
    expect(await refOf(app, a, id)).toBeNull();
  });

  it('replacing a board posting with another board posting replaces the identity', async () => {
    const { app, a } = await boot();
    const id = await newOpportunity(app, a);
    await attachPosting(app.db, ctxOf(a), id, posting(BOARD_URL), 'board');
    await attachPosting(app.db, ctxOf(a), id, posting(OTHER_BOARD_URL, 'Another text.'), 'paste');
    expect(await refOf(app, a, id)).toEqual(postingAtsJobRef(OTHER_BOARD_URL));
  });

  it('a Refetch of a career page clears a ref an earlier rule read from it', async () => {
    const { app, a } = await boot();
    const id = await newOpportunity(app, a);
    await attachPosting(app.db, ctxOf(a), id, posting(CAREER_PAGE_URL), 'paste');
    // As reconcile used to store it: a ref read from a career page.
    const stale = {
      kind: 'ats_greenhouse' as const,
      org: null,
      externalId: '7663059003',
      url: CAREER_PAGE_URL,
    };
    await app.db
      .update(opportunities)
      .set({ atsJobRef: stale })
      .where(eq(opportunities.id, id))
      .run();
    await attachPosting(app.db, ctxOf(a), id, posting(CAREER_PAGE_URL, 'Refetched.'), 'paste');
    expect(await refOf(app, a, id)).toBeNull();
  });
});

describe('reconcile uses the same rule', () => {
  it('a board posting confirms with its identity; a career-page one with none', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const onBoard = await newOpportunity(app, a);
    await confirm(app.db, ctx, await getOpportunity(app.db, ctx, onBoard), posting(BOARD_URL));
    expect(await refOf(app, a, onBoard)).toEqual(BOARD_REF);

    const onCareerPage = await newOpportunity(app, a);
    await confirm(
      app.db,
      ctx,
      await getOpportunity(app.db, ctx, onCareerPage),
      posting(CAREER_PAGE_URL),
    );
    expect(await refOf(app, a, onCareerPage)).toBeNull();
  });
});

describe("a user's own confirm records the posting's identity", () => {
  it('confirming a flagged board posting sets its ref', async () => {
    const { app, a } = await boot();
    const id = await newOpportunity(app, a);
    await app.db
      .update(opportunities)
      .set({
        postingUrl: BOARD_URL,
        postingState: 'needs_review',
        postingStateDetail: 'none_found',
      })
      .where(eq(opportunities.id, id))
      .run();
    const view = await confirmPosting(app.db, ctxOf(a), id);
    expect(view.postingState).toBe('confirmed');
    expect(view.atsJobRef).toEqual(BOARD_REF);
  });
});

describe('criterion 4: a PATCH that changes postingUrl re-derives the identity', () => {
  const patchUrl = (c: TestClient, id: string, postingUrl: string | null) =>
    c.request({ method: 'PATCH', url: `/api/v1/opportunities/${id}`, payload: { postingUrl } });

  it('to another board posting: its identity; to a career page: none; posting stays confirmed', async () => {
    const { app, a } = await boot();
    const id = await newOpportunity(app, a);
    await attachPosting(app.db, ctxOf(a), id, posting(BOARD_URL), 'board');

    const toOther = await patchUrl(a, id, OTHER_BOARD_URL);
    expect(toOther.statusCode, toOther.body).toBe(200);
    expect(await refOf(app, a, id)).toEqual(postingAtsJobRef(OTHER_BOARD_URL));

    const toPage = await patchUrl(a, id, CAREER_PAGE_URL);
    expect(toPage.statusCode, toPage.body).toBe(200);
    expect(await refOf(app, a, id)).toBeNull();
    // The PATCH does not touch the posting state: the URL edit alone moves the identity.
    expect((await getOpportunity(app.db, ctxOf(a), id)).postingState).toBe('confirmed');
  });

  it('clearing the URL clears the identity; an edit that leaves the URL alone keeps it', async () => {
    const { app, a } = await boot();
    const id = await newOpportunity(app, a);
    await attachPosting(app.db, ctxOf(a), id, posting(BOARD_URL), 'board');

    const same = await patchUrl(a, id, BOARD_URL);
    expect(same.statusCode).toBe(200);
    const notes = await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${id}`,
      payload: { title: 'Staff Product Manager' },
    });
    expect(notes.statusCode).toBe(200);
    expect(await refOf(app, a, id)).toEqual(BOARD_REF);

    expect((await patchUrl(a, id, null)).statusCode).toBe(200);
    expect(await refOf(app, a, id)).toBeNull();
  });
});

describe('criterion 5: the backfill brings every confirmed posting identity in line, once', () => {
  /** A row as the old code could leave it, built directly. */
  async function row(
    app: FastifyInstance,
    c: TestClient,
    set: Partial<typeof opportunities.$inferInsert>,
  ): Promise<string> {
    const id = await newOpportunity(app, c);
    await app.db.update(opportunities).set(set).where(eq(opportunities.id, id)).run();
    return id;
  }

  const OLD_A = postingAtsJobRef(OTHER_BOARD_URL);
  const CAREER_REF = {
    kind: 'ats_greenhouse' as const,
    org: null,
    externalId: '7663059003',
    url: CAREER_PAGE_URL,
  };

  it('sets, changes and clears where the stored ref disagrees, and nothing else; a second run changes nothing', async () => {
    const { app, a, b } = await boot();
    const confirmed = { postingState: 'confirmed' as const };
    // Attached by hand before #137: no ref.
    const noRef = await row(app, a, { ...confirmed, postingUrl: BOARD_URL });
    // Reconciled on posting A, then re-attached to B before #137 (tl on #140): A's ref on B.
    const staleRef = await row(app, a, { ...confirmed, postingUrl: BOARD_URL, atsJobRef: OLD_A });
    // The old reconcile rule read a ref from a career page.
    const careerRef = await row(app, a, {
      ...confirmed,
      postingUrl: CAREER_PAGE_URL,
      atsJobRef: CAREER_REF,
    });
    // Already right, or nothing to derive: never written.
    const right = await row(app, a, { ...confirmed, postingUrl: BOARD_URL, atsJobRef: BOARD_REF });
    const careerNoRef = await row(app, a, { ...confirmed, postingUrl: CAREER_PAGE_URL });
    const notConfirmed = await row(app, a, {
      postingState: 'needs_review',
      postingUrl: BOARD_URL,
      atsJobRef: OLD_A,
    });
    const noUrl = await row(app, a, { ...confirmed, postingUrl: null, atsJobRef: OLD_A });
    const othersRow = await row(app, b, { ...confirmed, postingUrl: BOARD_URL });

    const stamps = async () =>
      new Map(
        (
          await app.db
            .select({ id: opportunities.id, t: opportunities.updatedAt })
            .from(opportunities)
            .all()
        ).map((r) => [r.id, r.t]),
      );
    const before = await stamps();
    expect(await backfillAtsJobRefs(app.db, ctxOf(a))).toEqual({
      read: 5,
      set: 1,
      changed: 1,
      cleared: 1,
    });
    expect(await refOf(app, a, noRef)).toEqual(BOARD_REF);
    expect(await refOf(app, a, staleRef)).toEqual(BOARD_REF);
    expect(await refOf(app, a, careerRef)).toBeNull();
    expect(await refOf(app, a, notConfirmed)).toEqual(OLD_A); // not confirmed: not read
    expect(await refOf(app, a, noUrl)).toEqual(OLD_A); // no URL: not read
    expect(await refOf(app, b, othersRow)).toBeNull(); // another user's run, not this one
    const after = await stamps();
    for (const untouched of [right, careerNoRef, notConfirmed, noUrl, othersRow]) {
      expect(after.get(untouched)).toBe(before.get(untouched));
    }

    expect(await backfillAtsJobRefs(app.db, ctxOf(a))).toEqual({
      read: 5,
      set: 0,
      changed: 0,
      cleared: 0,
    });
    expect(await stamps()).toEqual(after);
  });

  it.each([
    [
      'a reconcile that confirmed another board posting',
      async (app: FastifyInstance, c: TestClient, id: string): Promise<unknown> =>
        confirm(
          app.db,
          ctxOf(c),
          await getOpportunity(app.db, ctxOf(c), id),
          posting(OTHER_BOARD_URL),
        ),
      (): unknown => postingAtsJobRef(OTHER_BOARD_URL),
    ],
    [
      'a URL edit to a career page',
      async (app: FastifyInstance, c: TestClient, id: string): Promise<unknown> =>
        updateOpportunity(app.db, ctxOf(c), id, { postingUrl: CAREER_PAGE_URL }),
      (): unknown => null,
    ],
  ] as const)('never overwrites %s landing meanwhile (race)', async (_n, meanwhile, expected) => {
    const { app, a } = await boot();
    const id = await row(app, a, {
      postingState: 'confirmed',
      postingUrl: BOARD_URL,
      atsJobRef: OLD_A,
      updatedAt: 1,
    });
    const pause = pauseAt('opportunities.backfillAtsJobRef.beforeWrite');
    const running = backfillAtsJobRefs(app.db, ctxOf(a));
    await pause.reached;
    await meanwhile(app, a, id);
    pause.release();
    expect(await running).toEqual({ read: 1, set: 0, changed: 0, cleared: 0 });
    expect(await refOf(app, a, id)).toEqual(expected());
  });

  it('is queued once per deployment; the jobs fill each user and log counts only', async () => {
    logs.lines.length = 0;
    const { app, a, b } = await logBoot({ logLevel: 'info' });
    // Boot already ran the once-guard; clear it to see a deployment upgrading with old rows.
    await app.db.delete(settings).where(eq(settings.key, BACKFILL_ATS_JOB_REFS_MARKER_KEY)).run();
    const forA = await row(app, a, { postingState: 'confirmed', postingUrl: BOARD_URL });
    const forB = await row(app, b, {
      postingState: 'confirmed',
      postingUrl: BOARD_URL,
      atsJobRef: OLD_A,
    });
    expect(await enqueueBackfillAtsJobRefsOnce(app.db)).toBe(2);
    expect(await enqueueBackfillAtsJobRefsOnce(app.db)).toBe(0);
    await app.jobs.drain();
    expect(await refOf(app, a, forA)).toEqual(BOARD_REF);
    expect(await refOf(app, b, forB)).toEqual(BOARD_REF);

    const lines = logs.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'ats job ref backfill');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(
        Object.keys(line).filter((k) => ['read', 'set', 'changed', 'cleared'].includes(k)),
      ).toHaveLength(4);
    }
    // Counts only: no ids, URLs or company names in what the backfill logged.
    const logged = JSON.stringify(lines);
    for (const secret of [forA, forB, BOARD_URL, 'Sentinel Edge', 'sentineledge']) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("tl on #140: reconcile's own write, and the board's own slug", () => {
  it('reconcile on an unchanged URL replaces a stale ref with the derived one', async () => {
    const { app, a } = await boot();
    const id = await newOpportunity(app, a);
    // The URL is already the board posting, so the URL edit rule never fires here.
    await app.db
      .update(opportunities)
      .set({ postingUrl: BOARD_URL, atsJobRef: postingAtsJobRef(OTHER_BOARD_URL) })
      .where(eq(opportunities.id, id))
      .run();
    await confirm(app.db, ctxOf(a), await getOpportunity(app.db, ctxOf(a), id), posting(BOARD_URL));
    expect(await refOf(app, a, id)).toEqual(BOARD_REF);
  });

  it('a Greenhouse board= parameter never overrides the board the URL is on', async () => {
    const url =
      'https://boards.greenhouse.io/sentineledge/jobs/7663059003?gh_jid=7663059003&board=other';
    expect(postingAtsJobRef(url)).toMatchObject({ kind: 'ats_greenhouse', org: 'sentineledge' });
  });
});

describe('readers of the identity: starting assisted apply (the EM on #140)', () => {
  const ON = { submissions: true };

  async function finalResume(app: FastifyInstance, c: TestClient): Promise<string> {
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

  const draft = (c: TestClient, id: string, resumeId: string) =>
    c.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/submissions`,
      payload: { idempotencyKey: crypto.randomUUID(), resumeId },
    });

  it('a posting attached by hand on a board can now start a draft, for that requisition', async () => {
    const { app, a } = await boot(ON);
    const id = await newOpportunity(app, a);
    await app.db
      .update(opportunities)
      .set({ stage: 'interested' })
      .where(eq(opportunities.id, id))
      .run();
    await attachPosting(app.db, ctxOf(a), id, posting(BOARD_URL), 'paste');
    const res = await draft(a, id, await finalResume(app, a));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      atsKind: 'ats_greenhouse',
      atsRef: 'sentineledge',
      atsExternalId: '7663059003',
      destinationUrl: BOARD_URL,
    });
  });

  it('a posting whose identity was cleared is refused with no_ats_identity', async () => {
    const { app, a } = await boot(ON);
    const id = await newOpportunity(app, a);
    await app.db
      .update(opportunities)
      .set({ stage: 'interested' })
      .where(eq(opportunities.id, id))
      .run();
    await attachPosting(app.db, ctxOf(a), id, posting(BOARD_URL), 'paste');
    await updateOpportunity(app.db, ctxOf(a), id, { postingUrl: CAREER_PAGE_URL });
    const res = await draft(a, id, await finalResume(app, a));
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'no_ats_identity' } });
  });
});

describe("#143: the board path's own job id comes before a stray gh_jid", () => {
  /** The same posting without the stray parameter: the identity the board path names. */
  const clean = (url: string) => {
    const u = new URL(url);
    u.searchParams.delete('gh_jid');
    return postingAtsJobRef(u.href);
  };

  it.each([
    ['Greenhouse', 'https://boards.greenhouse.io/acme/jobs/4140005?gh_jid=4140999'],
    ['Lever', 'https://jobs.lever.co/acme/5a6b7c8d-1111-2222-3333-444455556666?gh_jid=4140999'],
    ['Ashby', 'https://jobs.ashbyhq.com/acme/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b?gh_jid=4140999'],
    [
      'Workday',
      'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Remote/Platform-Engineer_JR-000123?gh_jid=4140999',
    ],
  ])('%s: the path id, not the gh_jid', (_kind, url) => {
    const expected = clean(url);
    expect(expected).not.toBeNull(); // the board path itself names a job
    expect(postingAtsJobRef(url)).toEqual({ ...expected, url });
    expect(postingAtsJobRef(url)?.externalId).not.toBe('4140999');
  });

  it('a gh_jid on a Greenhouse board URL with no job in its path still names the job', () => {
    expect(postingAtsJobRef('https://job-boards.greenhouse.io/acme?gh_jid=4140999')).toMatchObject({
      kind: 'ats_greenhouse',
      org: 'acme',
      externalId: '4140999',
    });
  });

  it('a gh_jid on another kind of board with no job in its path names nothing (the kind check)', () => {
    expect(postingAtsJobRef('https://jobs.lever.co/acme?gh_jid=4140999')).toBeNull();
  });

  it('a gh_jid on a company career page still names nothing', () => {
    expect(postingAtsJobRef(CAREER_PAGE_URL)).toBeNull();
  });
});

describe('#143: lines no test pinned before', () => {
  it("reconcile with a posting that has no URL of its own takes the stored URL's identity", async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const id = await newOpportunity(app, a);
    await app.db
      .update(opportunities)
      .set({ postingUrl: BOARD_URL })
      .where(eq(opportunities.id, id))
      .run();
    await confirm(app.db, ctx, await getOpportunity(app.db, ctx, id), posting(null));
    expect(await refOf(app, a, id)).toEqual(BOARD_REF);
  });

  it('the backfill is queued once per deployment, even after its jobs have finished', async () => {
    const { app } = await boot();
    await app.db.delete(settings).where(eq(settings.key, BACKFILL_ATS_JOB_REFS_MARKER_KEY)).run();
    expect(await enqueueBackfillAtsJobRefsOnce(app.db)).toBe(2);
    await app.jobs.drain(); // finished: no unfinished job left to dedupe a second queueing
    const marker = await app.db
      .select()
      .from(settings)
      .where(eq(settings.key, BACKFILL_ATS_JOB_REFS_MARKER_KEY))
      .get();
    expect(marker).toBeDefined();
    expect(await enqueueBackfillAtsJobRefsOnce(app.db)).toBe(0);
  });
});
