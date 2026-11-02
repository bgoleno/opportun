// An opportunity's ATS identity follows its posting, however the posting got there (issue
// https://github.com/bgoleno/opportun/issues/137, with the Tech Lead's design note on it).
// Organised by the issue's acceptance criteria. Every URL here is synthetic; nothing is fetched.
import type { NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { opportunities, settings } from '../src/db/schema';
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
import { createOpportunity, getOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import { pauseAt } from './race';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

const BOARD_URL = 'https://job-boards.greenhouse.io/sentineledge/jobs/7663059003';
const OTHER_BOARD_URL = 'https://jobs.lever.co/sentineledge/5a6b7c8d-1111-2222-3333-444455556666';
/** A company career page embedding the same Greenhouse job: no board host, so no identity. */
const CAREER_PAGE_URL = 'https://www.sentineledge.example/careers/apply?gh_jid=7663059003';

const BOARD_REF = {
  kind: 'ats_greenhouse',
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

describe('criterion 5: the backfill gives existing confirmed board postings their identity, once', () => {
  /** A row as the old code left it, built directly. */
  async function row(
    app: FastifyInstance,
    c: TestClient,
    set: Partial<typeof opportunities.$inferInsert>,
  ): Promise<string> {
    const id = await newOpportunity(app, c);
    await app.db.update(opportunities).set(set).where(eq(opportunities.id, id)).run();
    return id;
  }

  it('fills confirmed board postings with no ref, and nothing else; a second run changes nothing', async () => {
    const { app, a, b } = await boot();
    const kept = {
      kind: 'ats_lever' as const,
      org: 'kept',
      externalId: 'kept-1',
      url: OTHER_BOARD_URL,
    };
    const fill = await row(app, a, { postingState: 'confirmed', postingUrl: BOARD_URL });
    const careerPage = await row(app, a, {
      postingState: 'confirmed',
      postingUrl: CAREER_PAGE_URL,
    });
    const hasRef = await row(app, a, {
      postingState: 'confirmed',
      postingUrl: BOARD_URL,
      atsJobRef: kept,
    });
    const notConfirmed = await row(app, a, { postingState: 'needs_review', postingUrl: BOARD_URL });
    const noUrl = await row(app, a, { postingState: 'confirmed', postingUrl: null });
    const othersRow = await row(app, b, { postingState: 'confirmed', postingUrl: BOARD_URL });

    expect(await backfillAtsJobRefs(app.db, ctxOf(a))).toEqual({ scanned: 2, filled: 1 });
    expect(await refOf(app, a, fill)).toEqual(BOARD_REF);
    expect(await refOf(app, a, careerPage)).toBeNull();
    expect(await refOf(app, a, hasRef)).toEqual(kept); // never touched
    expect(await refOf(app, a, notConfirmed)).toBeNull();
    expect(await refOf(app, a, noUrl)).toBeNull();
    expect(await refOf(app, b, othersRow)).toBeNull(); // another user's run, not this one

    const updatedAt = async () =>
      (
        await app.db
          .select({ t: opportunities.updatedAt })
          .from(opportunities)
          .where(and(eq(opportunities.userId, a.userId)))
          .all()
      )
        .map((r) => r.t)
        .sort();
    const before = await updatedAt();
    expect(await backfillAtsJobRefs(app.db, ctxOf(a))).toEqual({ scanned: 1, filled: 0 });
    expect(await updatedAt()).toEqual(before);
  });

  it('is queued once per deployment, and the queued jobs fill each user', async () => {
    const { app, a, b } = await boot();
    // Boot already ran the once-guard; clear it to see a deployment upgrading with old rows.
    await app.db.delete(settings).where(eq(settings.key, BACKFILL_ATS_JOB_REFS_MARKER_KEY)).run();
    const forA = await newOpportunity(app, a);
    const forB = await newOpportunity(app, b);
    for (const id of [forA, forB]) {
      await app.db
        .update(opportunities)
        .set({ postingState: 'confirmed', postingUrl: BOARD_URL })
        .where(eq(opportunities.id, id))
        .run();
    }
    expect(await enqueueBackfillAtsJobRefsOnce(app.db)).toBe(2);
    expect(await enqueueBackfillAtsJobRefsOnce(app.db)).toBe(0);
    await app.jobs.drain();
    expect(await refOf(app, a, forA)).toEqual(BOARD_REF);
    expect(await refOf(app, b, forB)).toEqual(BOARD_REF);
  });

  it.each([
    [
      'a ref written meanwhile',
      { atsJobRef: { kind: 'ats_lever', org: 'x', externalId: 'y', url: OTHER_BOARD_URL } },
    ],
    ['a new posting URL written meanwhile', { postingUrl: CAREER_PAGE_URL }],
  ] as const)('never overwrites %s (race)', async (_n, meanwhile) => {
    const { app, a } = await boot();
    const id = await row(app, a, { postingState: 'confirmed', postingUrl: BOARD_URL });
    const pause = pauseAt('opportunities.backfillAtsJobRef.beforeWrite');
    const running = backfillAtsJobRefs(app.db, ctxOf(a));
    await pause.reached;
    await app.db.update(opportunities).set(meanwhile).where(eq(opportunities.id, id)).run();
    pause.release();
    expect(await running).toEqual({ scanned: 1, filled: 0 });
    const after = await getOpportunity(app.db, ctxOf(a), id);
    expect(after.atsJobRef ?? null).toEqual('atsJobRef' in meanwhile ? meanwhile.atsJobRef : null);
  });
});
