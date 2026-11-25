// A capture with no card, at another posting of an open role, joins that role's opportunity (the
// owner's decision: one role is one opportunity; https://github.com/bgoleno/opportun/issues/1037, tl's
// design there). Every posting is made up.
import { dedupeKey, type NormalizedPosting, type OpportunityStage } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { activities, discoveryResults, jobs, opportunities, stageHistory } from '../src/db/schema';
import { resolveCapture } from '../src/lib/captureResolve';
import { insertLeads } from '../src/lib/discoveryIngest';
import { POSTING_RECONCILE_KIND } from '../src/lib/jobKinds';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import { createRun, ensureChannelSource, getResult, insertResult } from '../src/repos/discovery';
import { createOpportunity, getOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import { testDialect } from './db';
import { onSlowTransaction } from '../src/db/gate';
import { heldApart, pauseAt, settledOrWaiting, whileParked } from './race';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

const JOB = { company: 'Initech', title: 'Platform Engineer' };
const PAGE = 'Own the platform, as the page has it.';
const HERE = 'Austin, TX';
const THERE = 'Boston, MA';
const ELSEWHERE = 'Denver, CO';
const OPEN: readonly OpportunityStage[] = [
  'discovered',
  'interested',
  'preparing',
  'applied',
  'in_process',
  'offer',
];

/** A posting on a site: its id there. */
type At = readonly [site: 'linkedin' | 'indeed', n: number];
const IDS = {
  linkedin: (n: number) => String(1_000_000_000 + n),
  indeed: (n: number) => `abc123def45678${String(n).padStart(2, '0')}`,
};
const URLS = {
  linkedin: (id: string) => `https://www.linkedin.com/jobs/view/${id}`,
  indeed: (id: string) => `https://www.indeed.com/viewjob?jk=${id}`,
};
const idOf = ([site, n]: At) => IDS[site](n);
const urlOf = (at: At) => URLS[at[0]](idOf(at));

const postingAt = (
  at: At,
  location: string | null,
  over: Partial<NormalizedPosting> = {},
): NormalizedPosting => ({
  ...JOB,
  location,
  descriptionMd: PAGE,
  postingUrl: urlOf(at),
  externalId: `${at[0]}:${idOf(at)}`,
  ...over,
});
const capture = (
  app: FastifyInstance,
  c: TestClient,
  at: At,
  location: string | null,
  over: Partial<NormalizedPosting> = {},
) =>
  resolveCapture(app.db, ctxOf(c), {
    posting: postingAt(at, location, over),
    captureText: `${PAGE} ${idOf(at)}`,
    siteId: at[0],
  });

/** A card of the role, from a job alert. */
async function card(
  app: FastifyInstance,
  c: TestClient,
  at: At,
  location: string | null,
  over: Partial<NormalizedPosting> = {},
): Promise<string> {
  const source = await ensureChannelSource(app.db, ctxOf(c), 'alert_email');
  const run = await createRun(app.db, ctxOf(c), { sourceId: source.id });
  const posting = postingAt(at, location, { externalId: idOf(at), descriptionMd: null, ...over });
  return (
    await insertResult(app.db, ctxOf(c), {
      runId: run.id,
      posting,
      dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
      resolution: 'needs_capture',
    })
  ).id;
}
const alert = async (app: FastifyInstance, c: TestClient, at: At, location: string | null) => {
  const source = await ensureChannelSource(app.db, ctxOf(c), 'alert_email');
  const posting = postingAt(at, location, { externalId: idOf(at), descriptionMd: null });
  return (await insertLeads(app.db, ctxOf(c), [posting], source.id)).stats;
};
const send = (
  c: TestClient,
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) => c.request({ method, url: `/api/v1${url}`, ...(payload === undefined ? {} : { payload }) });
const accept = async (c: TestClient, id: string, payload: Record<string, unknown> = {}) => {
  const res = await send(c, 'POST', `/discovery/results/${id}/accept`, payload);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ opportunityId: string }>().opportunityId;
};

const resultsOf = (app: FastifyInstance, c: TestClient) =>
  app.db.select().from(discoveryResults).where(eq(discoveryResults.userId, c.userId)).all();
const opportunitiesOf = (app: FastifyInstance, c: TestClient) =>
  app.db.select().from(opportunities).where(eq(opportunities.userId, c.userId)).all();
const entriesOf = (app: FastifyInstance, id: string, kind: 'link' | 'capture') =>
  app.db
    .select()
    .from(activities)
    .where(and(eq(activities.opportunityId, id), eq(activities.kind, kind)))
    .all();
const checksOf = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(jobs).where(eq(jobs.kind, POSTING_RECONCILE_KIND)).all()).filter(
    (j) => JSON.stringify(j.payload).includes(id),
  );
const historyOf = (app: FastifyInstance, id: string) =>
  app.db.select().from(stageHistory).where(eq(stageHistory.opportunityId, id)).all();
const move = (app: FastifyInstance, id: string, stage: OpportunityStage) =>
  app.db.update(opportunities).set({ stage }).where(eq(opportunities.id, id)).run();
const set = (app: FastifyInstance, id: string, patch: Record<string, unknown>) =>
  app.db.update(opportunities).set(patch).where(eq(opportunities.id, id)).run();

const byHand = async (
  app: FastifyInstance,
  c: TestClient,
  over: Record<string, unknown> = {},
): Promise<string> =>
  (
    await createOpportunity(app.db, ctxOf(c), {
      companyName: JOB.company,
      title: JOB.title,
      location: HERE,
      descriptionMd: 'my own words on it',
      sourceKind: 'manual',
      ...over,
    })
  ).id;

/** How the opportunity of the role, at HERE, came to be. */
const ORIGINS = {
  captured: async (app: FastifyInstance, c: TestClient) =>
    (await capture(app, c, ['linkedin', 1], HERE)).opportunityId,
  accepted: async (app: FastifyInstance, c: TestClient) =>
    await accept(c, await card(app, c, ['linkedin', 1], HERE, { descriptionMd: PAGE })),
  'made by hand': (app: FastifyInstance, c: TestClient) => byHand(app, c),
  // Its key was held by another then, so it has none: found by its result only.
  'made by Create anyway': async (app: FastifyInstance, c: TestClient) => {
    const asked = await byHand(app, c);
    const id = await accept(c, await card(app, c, ['linkedin', 1], HERE), { force: true });
    expect((await send(c, 'DELETE', `/opportunities/${asked}`)).statusCode).toBe(204);
    expect((await getOpportunity(app.db, ctxOf(c), id)).dedupeKey).toBeNull();
    return id;
  },
};
type Origin = keyof typeof ORIGINS;
const ORIGIN_NAMES = Object.keys(ORIGINS) as Origin[];
const SITES = ['linkedin', 'indeed'] as const;

/** What a posting of another place must not change. */
const own = (o: Awaited<ReturnType<typeof opportunitiesOf>>[number]) => ({
  id: o.id,
  title: o.title,
  location: o.location,
  postingUrl: o.postingUrl,
  remote: o.remote,
  compNote: o.compNote,
  dedupeKey: o.dedupeKey,
  postingState: o.postingState,
  postingStateDetail: o.postingStateDetail,
  sourceRef: o.sourceRef,
});

describe.each(SITES)('a capture on %s of another place of an open role', (site) => {
  const P: At = [site, 2];

  describe.each(ORIGIN_NAMES)('%s', (origin) => {
    it.each(OPEN)('at %s: joins it', async (stage) => {
      const { app, a } = await boot();
      const id = await ORIGINS[origin](app, a);
      await set(app, id, { stage, descriptionMd: 'what it had' });
      const before = await opportunitiesOf(app, a);
      const history = await historyOf(app, id);
      const checks = await checksOf(app, id);

      const done = await capture(app, a, P, THERE, { remote: true, compNote: '$1' });

      expect(done).toMatchObject({
        opportunityId: id,
        createdOpportunity: false,
        anotherPosting: true,
        description: 'kept',
        currentStage: stage === 'discovered' ? 'interested' : stage,
        stageMovedTo: stage === 'discovered' ? 'interested' : null,
        linkedLeadIds: [],
      });
      const after = await opportunitiesOf(app, a);
      expect(after.map(own)).toEqual(before.map(own));
      expect(after[0]?.descriptionMd).toBe('what it had');
      expect((await historyOf(app, id)).length - history.length).toBe(
        stage === 'discovered' ? 1 : 0,
      );
      // Decided by the user, so never 'linked'.
      const lead = await getResult(app.db, ctxOf(a), done.resultId);
      expect(lead).toMatchObject({
        disposition: 'accepted',
        opportunityId: id,
        rankSkipReason: null,
        dedupeKey: dedupeKey(JOB.company, JOB.title, THERE),
        sourceKind: 'extension',
      });
      expect((await entriesOf(app, id, 'capture')).at(-1)).toMatchObject({
        bodyMd: `${PAGE} ${idOf(P)}`,
        externalUrl: urlOf(P),
      });
      const said = (await entriesOf(app, id, 'link')).filter((e) => e.externalUrl === urlOf(P));
      expect(said.map((e) => [e.title, e.bodyMd])).toEqual([
        [expect.stringMatching(/^Also posted via /), `${JOB.company}: ${JOB.title}\n${THERE}`],
      ]);
      // Nothing of it needs looking up: an alert of it would change nothing either.
      expect(await checksOf(app, id)).toEqual(checks);
    });

    it('captured again: one result, one entry of the place, the page each time', async () => {
      const { app, a } = await boot();
      const id = await ORIGINS[origin](app, a);
      const first = await capture(app, a, P, THERE);
      const pages = (await entriesOf(app, id, 'capture')).length;
      const results = await resultsOf(app, a);
      for (const stage of ['interested', 'applied', 'closed'] as const) {
        await move(app, id, stage);
        const again = await capture(app, a, P, THERE);
        expect(again).toMatchObject({
          opportunityId: id,
          resultId: first.resultId,
          createdOpportunity: false,
          currentStage: stage,
        });
        expect(again.anotherPosting).toBeUndefined();
      }
      expect((await resultsOf(app, a)).length).toBe(results.length);
      expect((await entriesOf(app, id, 'capture')).length).toBe(pages + 3);
      expect(
        (await entriesOf(app, id, 'link')).filter((e) => e.externalUrl === urlOf(P)),
      ).toHaveLength(1);
      expect(await opportunitiesOf(app, a)).toHaveLength(1);
    });

    it('a third place joins too, each place said once', async () => {
      const { app, a } = await boot();
      const id = await ORIGINS[origin](app, a);
      await capture(app, a, P, THERE);
      expect(await capture(app, a, [site, 3], ELSEWHERE)).toMatchObject({
        opportunityId: id,
        anotherPosting: true,
      });
      expect(await opportunitiesOf(app, a)).toHaveLength(1);
      const places = (await entriesOf(app, id, 'link')).map((e) => e.bodyMd?.split('\n')[1]);
      expect(places.filter((p) => p === THERE || p === ELSEWHERE).sort()).toEqual([
        THERE,
        ELSEWHERE,
      ]);
    });

    it.each(['closed', 'dismissed', 'deleted'] as const)('%s: its own', async (how) => {
      const { app, a } = await boot();
      const id = await ORIGINS[origin](app, a);
      if (how === 'deleted') await send(a, 'DELETE', `/opportunities/${id}`);
      else await move(app, id, how);
      const before = (await opportunitiesOf(app, a)).filter((o) => o.id === id);
      const done = await capture(app, a, P, THERE);
      expect(done.createdOpportunity).toBe(true);
      expect(done.anotherPosting).toBeUndefined();
      expect((await opportunitiesOf(app, a)).filter((o) => o.id === id)).toEqual(before);
      expect((await getOpportunity(app.db, ctxOf(a), done.opportunityId)).stage).toBe('interested');
    });
  });

  it.each([
    ['another level', { title: `Principal ${JOB.title}` }, true],
    ['another title', { title: 'Data Engineer' }, true],
    ['one word more', { title: `${JOB.title} Two` }, true],
    ['another company', { company: 'Globex' }, true],
    ['the company as its key folds it', { company: 'INITECH' }, false],
  ] as const)('%s: its own is %s', async (_what, over, ownOne) => {
    const { app, a } = await boot();
    const id = await ORIGINS.captured(app, a);
    const done = await capture(app, a, P, THERE, over);
    expect(done.createdOpportunity).toBe(ownOne);
    expect(done.opportunityId === id).toBe(!ownOne);
  });

  it('a level written short is the same level', async () => {
    const { app, a } = await boot();
    const id = await byHand(app, a, { title: `Senior ${JOB.title}` });
    expect(await capture(app, a, P, THERE, { title: `Sr ${JOB.title}` })).toMatchObject({
      opportunityId: id,
    });
  });

  it("another user's is nothing to it", async () => {
    const { app, a, b } = await boot();
    const theirs = await ORIGINS.captured(app, b);
    const before = [await opportunitiesOf(app, b), await resultsOf(app, b)];
    const notes = await entriesOf(app, theirs, 'capture');
    expect((await capture(app, a, P, THERE)).createdOpportunity).toBe(true);
    const mine = (await opportunitiesOf(app, a))[0]!.id;
    expect((await capture(app, a, [site, 3], ELSEWHERE)).opportunityId).toBe(mine);
    expect([await opportunitiesOf(app, b), await resultsOf(app, b)]).toEqual(before);
    expect(await entriesOf(app, theirs, 'capture')).toEqual(notes);
  });

  describe('at the place of another level', () => {
    const SENIOR = { title: `Senior ${JOB.title}` };

    it('with no open one of its own title: its own, kept apart from it', async () => {
      const { app, a } = await boot();
      const principal = await byHand(app, a, { title: `Principal ${JOB.title}` });
      const done = await capture(app, a, P, HERE, SENIOR);
      expect(done.createdOpportunity).toBe(true);
      const mine = (await opportunitiesOf(app, a)).find((o) => o.id === done.opportunityId);
      expect(mine?.possibleDuplicateOf).toBe(principal);
      const [other] = (await opportunitiesOf(app, a)).filter((o) => o.id === principal);
      expect(other?.stage).toBe('discovered');
    });

    it('with an open one of its own title elsewhere: joins that', async () => {
      const { app, a } = await boot();
      const principal = await byHand(app, a, { title: `Principal ${JOB.title}` });
      const senior = await byHand(app, a, { ...SENIOR, location: THERE });
      expect(await capture(app, a, P, HERE, SENIOR)).toMatchObject({
        opportunityId: senior,
        anotherPosting: true,
      });
      expect(await entriesOf(app, principal, 'capture')).toEqual([]);
    });
  });

  it('the very posting of a closed one finds that, as before', async () => {
    const { app, a } = await boot();
    const first = await capture(app, a, P, HERE);
    await move(app, first.opportunityId, 'closed');
    const open = await byHand(app, a, { location: THERE });
    expect((await capture(app, a, P, HERE)).opportunityId).toBe(first.opportunityId);
    expect(await entriesOf(app, open, 'capture')).toEqual([]);
  });

  describe('of several', () => {
    const make = async (app: FastifyInstance, c: TestClient, location: string, at: number) => {
      const id = await byHand(app, c, { location });
      await set(app, id, { createdAt: at });
      return id;
    };
    it('open: the oldest, whichever was made first', async () => {
      for (const [x, y] of [
        [1, 2],
        [2, 1],
      ] as const) {
        const { app, a } = await boot();
        const one = await make(app, a, HERE, x);
        const two = await make(app, a, ELSEWHERE, y);
        expect((await capture(app, a, P, THERE)).opportunityId).toBe(x < y ? one : two);
      }
    });
    it('its own key’s first, the older or not', async () => {
      const { app, a } = await boot();
      await make(app, a, HERE, 1);
      const there = await make(app, a, THERE, 2);
      const done = await capture(app, a, P, THERE);
      expect(done.opportunityId).toBe(there);
      expect(done.anotherPosting).toBeUndefined();
    });
    it.each(['closed', 'dismissed'] as const)('one open and one %s: the open one', async (over) => {
      for (const [x, y] of [
        [1, 2],
        [2, 1],
      ] as const) {
        const { app, a } = await boot();
        const gone = await make(app, a, HERE, x);
        await move(app, gone, over);
        const open = await make(app, a, ELSEWHERE, y);
        const before = (await opportunitiesOf(app, a)).find((o) => o.id === gone);
        expect((await capture(app, a, P, THERE)).opportunityId).toBe(open);
        expect((await opportunitiesOf(app, a)).find((o) => o.id === gone)).toEqual(before);
      }
    });
  });

  describe('what it fills, known to be another posting', () => {
    const RICH = { remote: true, compNote: '$200k' };

    it.each([null, '', '   '])('no description (%j): the page’s, as the system’s', async (text) => {
      const { app, a } = await boot();
      const id = await byHand(app, a, { descriptionMd: null });
      await set(app, id, { descriptionMd: text, postingState: 'confirmed' });
      const done = await capture(app, a, P, THERE, RICH);
      expect(done).toMatchObject({ opportunityId: id, description: 'added', anotherPosting: true });
      expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject({
        descriptionMd: PAGE,
        descriptionFingerprint: descriptionFingerprint(PAGE),
        descriptionIsUserWritten: false,
        location: HERE,
        postingUrl: null,
        remote: null,
        compNote: null,
        // A confirmed posting is not checked again, as before.
        postingState: 'confirmed',
      });
    });

    it('a description it wrote has the posting checked', async () => {
      const { app, a } = await boot();
      const id = await byHand(app, a, { descriptionMd: null });
      await capture(app, a, P, THERE);
      expect((await getOpportunity(app.db, ctxOf(a), id)).postingState).toBe('searching');
      expect(await checksOf(app, id)).toHaveLength(1);
    });

    it.each([
      ['the user’s', 'mine', null],
      ['a snippet nobody edited', 'a snippet', null],
      ['the system’s', 'the board’s', descriptionFingerprint('the board’s')],
      ['the system’s, one space more', 'the board’s ', descriptionFingerprint('the board’s')],
    ])('%s is kept byte for byte, and nothing else filled', async (_what, text, fingerprint) => {
      const { app, a } = await boot();
      const id = await byHand(app, a);
      await set(app, id, { descriptionMd: text, descriptionFingerprint: fingerprint });
      const before = await opportunitiesOf(app, a);
      const done = await capture(app, a, P, THERE, RICH);
      expect(done).toMatchObject({ opportunityId: id, description: 'kept' });
      const after = await opportunitiesOf(app, a);
      expect(after.map(own)).toEqual(before.map(own));
      expect(after[0]).toMatchObject({ descriptionMd: text, descriptionFingerprint: fingerprint });
      expect(await checksOf(app, id)).toEqual([]);
    });

    // A second capture of it is still another posting's.
    it('captured again it fills nothing more', async () => {
      const { app, a } = await boot();
      const id = await byHand(app, a);
      await capture(app, a, P, THERE);
      const before = await opportunitiesOf(app, a);
      await capture(app, a, P, THERE, RICH);
      expect((await opportunitiesOf(app, a)).map(own)).toEqual(before.map(own));
      expect(await checksOf(app, id)).toEqual([]);
    });

    it('by its id alone, its place not read: the same', async () => {
      const { app, a } = await boot();
      const id = (await capture(app, a, [site, 1], HERE, { postingUrl: null })).opportunityId;
      await set(app, id, { postingUrl: null, postingState: 'needs_review' });
      const before = await opportunitiesOf(app, a);
      for (const said of [true, undefined]) {
        const done = await capture(app, a, P, null, RICH);
        expect(done).toMatchObject({ opportunityId: id, createdOpportunity: false });
        expect(done.anotherPosting).toBe(said);
        expect((await opportunitiesOf(app, a)).map(own)).toEqual(before.map(own));
      }
    });

    it('not by an id that only some of what is behind it contradicts', async () => {
      const { app, a } = await boot();
      const id = await byHand(app, a);
      await capture(app, a, [site, 1], THERE);
      await capture(app, a, [site === 'linkedin' ? 'indeed' : 'linkedin', 4], ELSEWHERE);
      await capture(app, a, P, null, RICH);
      expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject(RICH);
    });

    it('nor the page of its own place, when all behind it are of other places', async () => {
      const { app, a } = await boot();
      const id = await byHand(app, a);
      await capture(app, a, [site, 1], THERE);
      const done = await capture(app, a, P, HERE, RICH);
      expect(done.opportunityId).toBe(id);
      expect(done.anotherPosting).toBeUndefined();
      expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject(RICH);
    });
  });

  describe('where nothing says it is another posting: as an existing one is filled today', () => {
    it.each([
      ['the role has no place', null, THERE, undefined],
      ['the page has none', HERE, null, true],
    ])('%s', async (_what, role, page, said) => {
      const { app, a } = await boot();
      const id = await byHand(app, a, { location: role });
      const done = await capture(app, a, P, page, { compNote: '$200k' });
      // Joined by its card, so it is said, but where there is nothing for it to be another than (#1064);
      // not known to be another, so it fills.
      expect(done.opportunityId).toBe(id);
      expect(done.anotherPosting).toBe(said);
      expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject({
        location: role ?? page,
        postingUrl: urlOf(P),
        compNote: '$200k',
        postingState: 'searching',
      });
      expect(await checksOf(app, id)).toHaveLength(1);
    });

    it('two with no place on one site, the role’s place known: both join', async () => {
      const { app, a } = await boot();
      const id = await byHand(app, a);
      expect((await capture(app, a, P, null)).opportunityId).toBe(id);
      expect((await capture(app, a, [site, 3], null)).opportunityId).toBe(id);
      expect(await opportunitiesOf(app, a)).toHaveLength(1);
    });
  });

  // The page the opportunity came from, whatever its place reads as the second time, and whatever the
  // user has made of it since, is no other posting.
  it.each([
    ['its place spelled another way', 'Austin, Texas, United States', undefined],
    ['its place changed by the user', HERE, 'Remote'],
  ])('its own page again, %s: not another posting', async (_what, location, edited) => {
    const { app, a } = await boot();
    const id = (await capture(app, a, P, HERE, { compNote: null })).opportunityId;
    if (edited !== undefined) await set(app, id, { location: edited });
    await set(app, id, { postingState: 'needs_review', postingStateDetail: 'none_found' });
    const done = await capture(app, a, P, location, { compNote: '$5' });
    expect(done).toMatchObject({ opportunityId: id, createdOpportunity: false });
    expect(done.anotherPosting).toBeUndefined();
    expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject({
      compNote: '$5',
      postingState: 'searching',
    });
  });

  it('a page of the key’s own opportunity is no other posting, its place read otherwise later', async () => {
    const { app, a } = await boot();
    const id = await byHand(app, a);
    const first = await capture(app, a, P, HERE);
    expect([first.opportunityId, first.anotherPosting]).toEqual([id, undefined]);
    // Nor for another posting's having joined since.
    await capture(app, a, [site, 1], THERE);
    const again = await capture(app, a, P, 'Austin, Texas, United States', { compNote: '$5' });
    expect([again.opportunityId, again.anotherPosting]).toEqual([id, undefined]);
    expect((await getOpportunity(app.db, ctxOf(a), id)).compNote).toBe('$5');
  });

  describe('once joined, at Discovery', () => {
    it('its alert is a duplicate, another place of the role is linked, while the role is open', async () => {
      const { app, a } = await boot();
      const id = await ORIGINS['made by hand'](app, a);
      await capture(app, a, P, THERE);
      expect(await alert(app, a, P, THERE)).toMatchObject({ duplicates: 1, inserted: 0 });
      expect(await alert(app, a, [site, 4], ELSEWHERE)).toMatchObject({ linked: 1 });
      expect((await opportunitiesOf(app, a)).map((o) => o.id)).toEqual([id]);
    });

    // As an accepted one's: the user decided it. #990 is for a place ingest linked.
    it('the role closed: a repost of its place is a duplicate until it is unsuppressed', async () => {
      const { app, a } = await boot();
      const id = await ORIGINS['made by hand'](app, a);
      const { resultId } = await capture(app, a, P, THERE);
      await move(app, id, 'closed');
      const board = async (externalId: string) => {
        const source = await ensureChannelSource(app.db, ctxOf(a), 'alert_email');
        const posting = postingAt(P, THERE, {
          externalId,
          postingUrl: 'https://short.example.com/x',
        });
        return (await insertLeads(app.db, ctxOf(a), [posting], source.id)).stats;
      };
      expect(await board('opaque-1')).toMatchObject({ duplicates: 1, inserted: 0 });
      await move(app, id, 'dismissed');
      const let_go = await send(a, 'POST', `/discovery/results/${resultId}/unsuppress`, {});
      expect(let_go.statusCode, let_go.body).toBe(200);
      expect(await board('opaque-2')).toMatchObject({ inserted: 1 });
    });

    it('a pending card of the role with another id stays, and its Accept goes to the role', async () => {
      const { app, a } = await boot();
      const id = await ORIGINS['made by hand'](app, a);
      const other = await card(app, a, [site, 5], ELSEWHERE);
      await capture(app, a, P, THERE);
      expect((await getResult(app.db, ctxOf(a), other)).disposition).toBe('pending');
      expect(await accept(a, other)).toBe(id);
    });
  });

  describe('kept apart from the closed holder of its own key, another place of the role open', () => {
    it.each(['no card', 'a card'] as const)('with %s: joins the open one', async (how) => {
      const { app, a } = await boot();
      const closed = (await capture(app, a, [site, 1], HERE)).opportunityId;
      await move(app, closed, 'closed');
      const open = await byHand(app, a, { location: THERE });
      const before = (await opportunitiesOf(app, a)).find((o) => o.id === closed);
      if (how === 'a card') await card(app, a, P, HERE);
      expect((await capture(app, a, P, HERE)).opportunityId).toBe(open);
      expect((await opportunitiesOf(app, a)).find((o) => o.id === closed)).toEqual(before);
    });

    it.each(['closed', 'dismissed'] as const)(
      'with none open, %s: its own, noted, and that one’s facts as they were',
      async (stage) => {
        const { app, a } = await boot();
        const over = (await capture(app, a, [site, 1], HERE)).opportunityId;
        await move(app, over, stage);
        const before = (await opportunitiesOf(app, a)).find((o) => o.id === over);
        const done = await capture(app, a, P, HERE);
        expect(done.createdOpportunity).toBe(true);
        expect(done.anotherPosting).toBeUndefined();
        const notes = (await entriesOf(app, done.opportunityId, 'link')).map((e) => e.title);
        expect(notes).toContainEqual(expect.stringMatching(/^Kept apart from a different /));
        const rows = await opportunitiesOf(app, a);
        const after = rows.find((o) => o.id === over);
        // A new one past a dismissed one takes its key, as a capture's own always did.
        const key = stage === 'dismissed' ? { dedupeKey: null } : {};
        expect(after).toEqual({ ...before, ...key });
        expect(rows.find((o) => o.id === done.opportunityId)?.possibleDuplicateOf).toBe(
          stage === 'dismissed' ? null : over,
        );
      },
    );
  });
});

// https://github.com/bgoleno/opportun/issues/1064, part B.
describe.each(SITES)('the first page captured, on %s, into one that has nothing', (site) => {
  const P: At = [site, 2];
  const alsoPosted = async (app: FastifyInstance, id: string) =>
    (await entriesOf(app, id, 'link')).filter((e) => e.title.startsWith('Also posted'));

  it.each([
    ['by hand', 'manual', null, null],
    ['from mail', 'communication', null, null],
    ['by hand, its place and link emptied', 'manual', '  ', ''],
  ] as const)('%s: not called another posting, and fills it', async (_how, kind, place, link) => {
    const { app, a } = await boot();
    const id = await byHand(app, a, { location: null, descriptionMd: null, sourceKind: kind });
    await set(app, id, { location: place, postingUrl: link });
    const done = await capture(app, a, P, THERE, { compNote: '$1' });
    expect(done).toMatchObject({ opportunityId: id, createdOpportunity: false });
    expect(done.anotherPosting).toBeUndefined();
    expect(await alsoPosted(app, id)).toEqual([]);
    expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject({
      descriptionMd: PAGE,
      compNote: '$1',
      postingState: 'searching',
    });
    expect(await resultsOf(app, a)).toMatchObject([
      { id: done.resultId, disposition: 'accepted', opportunityId: id },
    ]);
    // Nor when it is captured again; the next posting is another.
    expect((await capture(app, a, P, THERE)).anotherPosting).toBeUndefined();
    await set(app, id, { location: THERE });
    const next = await capture(app, a, [site, 3], ELSEWHERE);
    expect([next.opportunityId, next.anotherPosting]).toEqual([id, true]);
    expect(await alsoPosted(app, id)).toHaveLength(1);
  });

  it.each([
    ['a place', { location: HERE }],
    ['a link', { postingUrl: 'https://example.com/mine' }],
    ['a result behind it', { location: null }],
  ])('with %s: another', async (what, patch) => {
    for (const kind of ['manual', 'communication']) {
      const { app, a } = await boot();
      const id = await byHand(app, a, { location: null, sourceKind: kind });
      if (what === 'a result behind it') {
        await capture(app, a, [site, 1], HERE);
        await set(app, id, { location: null, postingUrl: null });
      }
      await set(app, id, patch);
      const done = await capture(app, a, P, THERE);
      expect([done.opportunityId, done.anotherPosting]).toEqual([id, true]);
      expect(await alsoPosted(app, id)).toHaveLength(1);
    }
  });
});

// What a second capture is judged by (tl on https://github.com/bgoleno/opportun/pull/1062).
describe.each(SITES)('captured again, on %s', (site) => {
  const other = site === 'linkedin' ? 'indeed' : 'linkedin';
  const FULL = { remote: true, compNote: '$1' };
  const P: At = [site, 2];
  /** As a check that has found nothing left it, so that another one shows. */
  const CHECKED = { postingState: 'needs_review', postingStateDetail: 'none_found' };
  const THRICE = (place: string) =>
    [
      ['with its place', [place, place, place]],
      ['its place read by turns', [place, null, place]],
      ['its place not read again', [place, null, null]],
    ] as const;

  it.each(THRICE(THERE))(
    'another site’s posting of a place that joined: its own result, said once, %s',
    async (_what, places) => {
      const { app, a } = await boot();
      const id = (await capture(app, a, [site, 1], HERE)).opportunityId;
      const joined = await capture(app, a, P, THERE);
      await set(app, id, { postingUrl: null, ...CHECKED });
      const facts = (await opportunitiesOf(app, a)).map(own);
      const checks = await checksOf(app, id);
      const O: At = [other, 9];
      const said: unknown[] = [];
      const results = new Set<string>();
      for (const place of places) {
        const done = await capture(app, a, O, place, FULL);
        expect(done).toMatchObject({ opportunityId: id, createdOpportunity: false });
        said.push(done.anotherPosting);
        results.add(done.resultId);
        expect((await opportunitiesOf(app, a)).map(own)).toEqual(facts);
      }
      expect(said).toEqual([true, undefined, undefined]);
      expect(results.size).toBe(1);
      expect(results.has(joined.resultId)).toBe(false);
      expect(await resultsOf(app, a)).toHaveLength(3);
      expect(
        (await entriesOf(app, id, 'link')).filter((e) => e.externalUrl === urlOf(O)),
      ).toHaveLength(1);
      expect(await checksOf(app, id)).toEqual(checks);
    },
  );

  describe('a role made by hand, which its first posting stands for', () => {
    it.each([...THRICE(HERE), ['its place read never', [null, null, null]] as const])(
      'another id of it, %s: fills nothing',
      async (_what, places) => {
        const { app, a } = await boot();
        const id = await byHand(app, a);
        await capture(app, a, [site, 1], HERE);
        await set(app, id, { postingUrl: null, ...CHECKED });
        const facts = (await opportunitiesOf(app, a)).map(own);
        const checks = await checksOf(app, id);
        const said: unknown[] = [];
        for (const place of places) {
          const done = await capture(app, a, P, place, FULL);
          expect(done.opportunityId).toBe(id);
          said.push(done.anotherPosting);
          expect((await opportunitiesOf(app, a)).map(own)).toEqual(facts);
        }
        expect(said).toEqual([true, undefined, undefined]);
        expect(await checksOf(app, id)).toEqual(checks);
        // The first one is the role's own, before and after.
        for (const place of places) {
          const done = await capture(app, a, [site, 1], place, FULL);
          expect([done.opportunityId, done.anotherPosting]).toEqual([id, undefined]);
        }
        expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject({
          ...FULL,
          postingUrl: urlOf([site, 1]),
          postingState: 'searching',
        });
      },
    );

    it('not one of another place that joined before it', async () => {
      const { app, a } = await boot();
      const id = await byHand(app, a);
      expect((await capture(app, a, [site, 1], THERE)).anotherPosting).toBe(true);
      await capture(app, a, P, HERE);
      await set(app, id, { ...CHECKED });
      expect((await capture(app, a, P, HERE, FULL)).anotherPosting).toBeUndefined();
      expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject({
        ...FULL,
        postingState: 'searching',
      });
      // And the one of the other place stays another.
      const facts = (await opportunitiesOf(app, a)).map(own);
      await set(app, id, { compNote: null });
      await capture(app, a, [site, 1], THERE, FULL);
      expect((await opportunitiesOf(app, a)).map(own)).toEqual(
        facts.map((f) => ({ ...f, compNote: null })),
      );
    });

    // What the first one is stored with does not matter, nor what has become of the role's place.
    it.each([
      ['the first one stored with no place', null, HERE],
      ['the role’s place taken off since', HERE, null],
    ])('%s: the other fills nothing the second time', async (_what, first, after) => {
      const { app, a } = await boot();
      const id = await byHand(app, a);
      await capture(app, a, [site, 1], first);
      await capture(app, a, P, HERE);
      await set(app, id, { postingUrl: null, location: after, ...CHECKED });
      const facts = (await opportunitiesOf(app, a)).map(own);
      expect((await capture(app, a, P, HERE, FULL)).anotherPosting).toBeUndefined();
      expect((await opportunitiesOf(app, a)).map(own)).toEqual(facts);
    });

    it('one that does not contradict it, of no known place, fills the second time too', async () => {
      const { app, a } = await boot();
      const id = await byHand(app, a);
      await capture(app, a, [site, 1], HERE);
      await capture(app, a, [other, 9], null);
      await capture(app, a, [other, 9], null, FULL);
      expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject(FULL);
    });

    it('with no place of its own: the oldest of any', async () => {
      const { app, a } = await boot();
      const id = await byHand(app, a, { location: null });
      await capture(app, a, [site, 1], null);
      await set(app, id, { postingUrl: null, ...CHECKED });
      const facts = (await opportunitiesOf(app, a)).map(own);
      for (let i = 0; i < 3; i += 1) {
        await capture(app, a, P, null, FULL);
        expect((await opportunitiesOf(app, a)).map(own)).toEqual(facts);
      }
      expect((await capture(app, a, [site, 1], null, FULL)).anotherPosting).toBeUndefined();
      expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject(FULL);
    });
  });

  it.each([
    ['the board or the user', 'Austin, Texas, United States'],
    ['the user, as another place', 'Remote'],
  ])(
    'the page of what it came from, which has no id, its place respelled by %s: no other posting',
    async (_who, respelled) => {
      const { app, a } = await boot();
      const id = await accept(
        a,
        await card(app, a, P, HERE, {
          externalId: null,
          postingUrl: 'https://jobs.example.com/r/abc',
          descriptionMd: PAGE,
        }),
      );
      await capture(app, a, P, HERE);
      await set(app, id, { location: respelled, remote: null, compNote: null });
      for (let i = 0; i < 3; i += 1) {
        await set(app, id, CHECKED);
        const done = await capture(app, a, P, HERE, FULL);
        expect([done.opportunityId, done.anotherPosting]).toEqual([id, undefined]);
        expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject({
          ...FULL,
          location: respelled,
          postingState: 'searching',
        });
      }
      expect(await resultsOf(app, a)).toHaveLength(1);
    },
  );

  it('a card with no id, captured at another place: said once, with one entry of it', async () => {
    const { app, a } = await boot();
    const id = (await capture(app, a, [site, 1], HERE)).opportunityId;
    await card(app, a, P, THERE, {
      externalId: null,
      postingUrl: 'https://jobs.example.com/r/abc',
    });
    for (let i = 0; i < 3; i += 1) {
      const done = await capture(app, a, P, THERE);
      expect([done.opportunityId, done.anotherPosting]).toEqual([id, undefined]);
    }
    const links = await entriesOf(app, id, 'link');
    expect(links.filter((e) => (e.title ?? '').startsWith('Also posted'))).toHaveLength(1);
  });

  it('a page with no id at another place: one result, said once', async () => {
    const { app, a } = await boot();
    const id = (await capture(app, a, [site, 1], HERE)).opportunityId;
    const said: unknown[] = [];
    for (let i = 0; i < 3; i += 1) {
      const done = await capture(app, a, P, THERE, { externalId: null, postingUrl: null });
      expect(done.opportunityId).toBe(id);
      said.push(done.anotherPosting);
    }
    expect(said).toEqual([true, undefined, undefined]);
    expect(await resultsOf(app, a)).toHaveLength(2);
  });
});

// The owner, on the issue: another id of one site at the role's own place is that role too, while it is
// open. #73 kept it apart; from one that is over, or at another level, it still is.
describe.each(SITES)('a capture on %s of another id at the place of an open role', (site) => {
  const P: At = [site, 2];
  const FROM = {
    captured: async (app: FastifyInstance, c: TestClient, at: string | null) =>
      (await capture(app, c, [site, 1], at)).opportunityId,
    accepted: async (app: FastifyInstance, c: TestClient, at: string | null) =>
      await accept(c, await card(app, c, [site, 1], at, { descriptionMd: PAGE })),
  };
  const CASES = (['captured', 'accepted'] as const).flatMap((from) =>
    ([HERE, null] as const).map((at) => [from, at] as const),
  );

  describe.each(CASES)('%s, its place %s', (from, at) => {
    it.each(OPEN)('at %s: joins it, and gives it nothing of its own', async (stage) => {
      const { app, a } = await boot();
      const id = await FROM[from](app, a, at);
      await set(app, id, { stage, postingUrl: null, descriptionMd: 'what it had' });
      const before = await opportunitiesOf(app, a);
      const checks = await checksOf(app, id);
      const done = await capture(app, a, P, at, { remote: true, compNote: '$1' });
      expect(done).toMatchObject({
        opportunityId: id,
        createdOpportunity: false,
        anotherPosting: true,
        description: 'kept',
        currentStage: stage === 'discovered' ? 'interested' : stage,
      });
      const after = await opportunitiesOf(app, a);
      expect(after.map(own)).toEqual(before.map(own));
      expect(after[0]).toMatchObject({ descriptionMd: 'what it had', possibleDuplicateOf: null });
      expect(await checksOf(app, id)).toEqual(checks);
      expect(
        (await entriesOf(app, id, 'link')).filter((e) => e.externalUrl === urlOf(P)),
      ).toHaveLength(1);
    });

    it('with no description: its page’s, and nothing else', async () => {
      const { app, a } = await boot();
      const id = await FROM[from](app, a, at);
      await set(app, id, { descriptionMd: null, descriptionFingerprint: null, postingUrl: null });
      expect(await capture(app, a, P, at, { compNote: '$1' })).toMatchObject({
        opportunityId: id,
        description: 'added',
      });
      expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject({
        descriptionMd: PAGE,
        descriptionIsUserWritten: false,
        postingUrl: null,
        compNote: null,
        location: at,
      });
    });

    it('each again finds it by its id, with one result each', async () => {
      const { app, a } = await boot();
      const id = await FROM[from](app, a, at);
      await set(app, id, { postingUrl: null });
      const facts = (await opportunitiesOf(app, a)).map(own);
      const p = await capture(app, a, P, at);
      // It stays another posting's the second time.
      await capture(app, a, P, at, { remote: true, compNote: '$1' });
      expect((await opportunitiesOf(app, a)).map(own)).toEqual(facts);
      const results = (await resultsOf(app, a)).length;
      for (const [site_, n] of [P, [site, 1], P] as const) {
        const again = await capture(app, a, [site_, n], at);
        expect(again).toMatchObject({ opportunityId: id, createdOpportunity: false });
        expect(again.anotherPosting).toBeUndefined();
        if (n === 2) expect(again.resultId).toBe(p.resultId);
      }
      expect((await resultsOf(app, a)).length).toBe(results);
      expect(await opportunitiesOf(app, a)).toHaveLength(1);
      // A third is no other case.
      expect((await capture(app, a, [site, 3], at)).opportunityId).toBe(id);
    });

    it('with a card of its own: the card goes to it, and it gets nothing else', async () => {
      const { app, a } = await boot();
      const id = await FROM[from](app, a, at);
      await set(app, id, { postingUrl: null });
      const before = await opportunitiesOf(app, a);
      const checks = await checksOf(app, id);
      const cardId = await card(app, a, P, at);
      const done = await capture(app, a, P, at, { compNote: '$1' });
      expect(done).toMatchObject({ opportunityId: id, resultId: cardId, anotherPosting: true });
      expect((await getResult(app.db, ctxOf(a), cardId)).opportunityId).toBe(id);
      expect((await opportunitiesOf(app, a)).map(own)).toEqual(before.map(own));
      expect(await checksOf(app, id)).toEqual(checks);
      expect(
        (await entriesOf(app, id, 'link')).filter((e) => e.externalUrl === urlOf(P)),
      ).toHaveLength(1);
    });
  });

  it('its card names the place and the page none: goes to the role, and gives it nothing', async () => {
    const { app, a } = await boot();
    const id = await FROM.captured(app, a, HERE);
    await set(app, id, { postingUrl: null });
    const before = await opportunitiesOf(app, a);
    const cardId = await card(app, a, P, HERE);
    const done = await capture(app, a, P, null, { compNote: '$1' });
    expect(done).toMatchObject({ opportunityId: id, resultId: cardId, anotherPosting: true });
    expect((await opportunitiesOf(app, a)).map(own)).toEqual(before.map(own));
  });

  it('one at another level there is kept apart, its own title open elsewhere or not', async () => {
    for (const open of [false, true]) {
      const { app, a } = await boot();
      const principal = (
        await capture(app, a, [site, 1], HERE, { title: `Principal ${JOB.title}` })
      ).opportunityId;
      const senior = open
        ? await byHand(app, a, { title: `Senior ${JOB.title}`, location: THERE })
        : undefined;
      const done = await capture(app, a, P, HERE, { title: `Senior ${JOB.title}` });
      expect(done.opportunityId).not.toBe(principal);
      expect(done.createdOpportunity).toBe(!open);
      if (open) expect(done.opportunityId).toBe(senior);
      expect(await entriesOf(app, principal, 'capture')).toHaveLength(1);
    }
  });
});

describe('beside what comes at the same moment', () => {
  const P: At = ['linkedin', 2];
  const role = async () => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    return { app, a, id, joins: () => capture(app, a, P, THERE) };
  };
  /** One opportunity of the role, and P's result in it once. */
  const one = async (app: FastifyInstance, a: TestClient, id: string) => {
    expect((await opportunitiesOf(app, a)).map((o) => o.id)).toEqual([id]);
    const mine = (await resultsOf(app, a)).filter((r) => r.posting.postingUrl === urlOf(P));
    expect(mine.map((r) => [r.disposition, r.opportunityId])).toEqual([['accepted', id]]);
  };

  it('an alert of the same posting, the capture first', async () => {
    const { app, a, id, joins } = await role();
    const [done, stats] = await heldApart(app, 'captureResolve.matched.locked', joins, () =>
      alert(app, a, P, THERE),
    );
    expect([done.opportunityId, stats.duplicates]).toEqual([id, 1]);
    await one(app, a, id);
  });

  it('an alert of the same posting first', async () => {
    const { app, a, id, joins } = await role();
    const [stats, done] = await heldApart(
      app,
      'discovery.ingest.linking.locked',
      () => alert(app, a, P, THERE),
      joins,
    );
    expect([stats.linked, done.opportunityId]).toEqual([1, id]);
    await one(app, a, id);
  });

  it.each(['the capture', 'the Accept'] as const)(
    'an Accept of a card of the role, with no opportunity yet, %s first: one',
    async (first) => {
      const { app, a } = await boot();
      const there = await card(app, a, ['linkedin', 7], HERE);
      const capturing = () => capture(app, a, P, THERE);
      const accepting = () => send(a, 'POST', `/discovery/results/${there}/accept`, {});
      const [x, y] =
        first === 'the capture'
          ? await heldApart(app, 'captureResolve.matched.locked', capturing, accepting)
          : await heldApart(app, 'discovery.decide.locked', accepting, capturing).then(
              ([r, c]) => [c, r] as const,
            );
      expect(y.statusCode, y.body).toBe(200);
      expect(y.json<{ opportunityId: string }>().opportunityId).toBe(x.opportunityId);
      expect(await opportunitiesOf(app, a)).toHaveLength(1);
    },
  );

  it.each([
    ['the same posting', P, THERE],
    ['another place', ['linkedin', 3], ELSEWHERE],
  ] as const)('another capture, of %s: one opportunity', async (_what, at, where) => {
    const { app, a } = await boot();
    const [x, y] = await heldApart(
      app,
      'captureResolve.matched.locked',
      () => capture(app, a, P, THERE),
      () => capture(app, a, at, where),
    );
    expect(x.createdOpportunity).toBe(true);
    expect([y.opportunityId, y.createdOpportunity]).toEqual([x.opportunityId, false]);
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
  });

  it('a delete first: its own', async () => {
    const { app, a, id, joins } = await role();
    const [removed, done] = await heldApart(
      app,
      'opportunities.delete.locked',
      () => send(a, 'DELETE', `/opportunities/${id}`),
      joins,
    );
    expect(removed.statusCode, removed.body).toBe(204);
    expect(done.createdOpportunity).toBe(true);
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
  });

  // The capture's own steps after it is saved (its entry, the fill, the stage) each find the opportunity
  // as it then is, so one gone between two of them is not found, as for any capture. Captured again, the
  // page is where its result is.
  const orGone = (capturing: Promise<Awaited<ReturnType<typeof capture>>>) =>
    capturing.catch((err: unknown) => {
      expect(err).toMatchObject({ statusCode: 404 });
      return null;
    });

  it('the capture first, then a delete: nothing is left of it but its result, and again it has its own', async () => {
    const { app, a, id, joins } = await role();
    const [, removed] = await heldApart(
      app,
      'captureResolve.matched.locked',
      () => orGone(joins()),
      () => send(a, 'DELETE', `/opportunities/${id}`),
    );
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await opportunitiesOf(app, a)).toEqual([]);
    expect((await resultsOf(app, a)).map((r) => [r.disposition, r.opportunityId])).toEqual([
      ['accepted', null],
    ]);
    expect((await capture(app, a, P, THERE)).createdOpportunity).toBe(true);
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
  });

  it('a merge of the role first: its title is gone, so the page has its own', async () => {
    const { app, a, id, joins } = await role();
    const keep = await byHand(app, a, { title: 'Data Analyst' });
    const [merged, done] = await heldApart(
      app,
      'opportunities.merge.locked',
      () => send(a, 'POST', `/opportunities/${keep}/merge`, { otherId: id }),
      joins,
    );
    expect(merged.statusCode, merged.body).toBe(200);
    expect(done.createdOpportunity).toBe(true);
    expect((await opportunitiesOf(app, a)).map((o) => o.id).sort()).toEqual(
      [keep, done.opportunityId].sort(),
    );
  });

  it('the capture first, then a merge: it goes along, and again it is found there', async () => {
    const { app, a, id, joins } = await role();
    const keep = await byHand(app, a, { title: 'Data Analyst' });
    const [, merged] = await heldApart(
      app,
      'captureResolve.matched.locked',
      () => orGone(joins()),
      () => send(a, 'POST', `/opportunities/${keep}/merge`, { otherId: id }),
    );
    expect(merged.statusCode, merged.body).toBe(200);
    expect((await opportunitiesOf(app, a)).map((o) => o.id)).toEqual([keep]);
    const again = await capture(app, a, P, THERE);
    expect([again.opportunityId, again.createdOpportunity]).toEqual([keep, false]);
    expect((await entriesOf(app, keep, 'capture')).length).toBeGreaterThan(0);
    expect((await resultsOf(app, a)).map((r) => r.opportunityId)).toEqual([keep]);
  });

  // A stage change takes no lock of the user's, so either order is one the user can have meant.
  it.each(['closed', 'dismissed'] as const)(
    'the role %s before: its own; after: it stays in it',
    async (to) => {
      const stage = (c: TestClient, id: string) =>
        send(c, 'POST', `/opportunities/${id}/stage`, {
          to,
          ...(to === 'closed' ? { closedReason: 'withdrawn' } : {}),
        });
      const first = await role();
      expect((await stage(first.a, first.id)).statusCode).toBe(200);
      expect((await first.joins()).createdOpportunity).toBe(true);

      const second = await role();
      onSlowTransaction(() => undefined);
      const pause = pauseAt('captureResolve.matched.locked');
      const joining = second.joins();
      const [moving] = await whileParked(pause, async () => {
        const sent = stage(second.a, second.id);
        await settledOrWaiting(second.app, sent);
        return [sent] as const;
      });
      const [done, moved] = await Promise.all([joining, moving]);
      expect(moved.statusCode, moved.body).toBe(200);
      // On Postgres the move may be seen by the look that follows the point; then it has its own.
      const results = (await resultsOf(second.app, second.a)).map((r) => r.opportunityId);
      expect(results).toEqual([done.opportunityId]);
      if (testDialect !== 'postgres') expect(done.opportunityId).toBe(second.id);
      expect((await opportunitiesOf(second.app, second.a)).length).toBe(
        done.createdOpportunity ? 2 : 1,
      );
    },
  );

  it.each(['the capture', 'New opportunity'] as const)(
    'New opportunity of the same posting’s place, %s first: the user’s is theirs, and nothing is lost',
    async (first) => {
      const { app, a, id, joins } = await role();
      const making = () =>
        send(a, 'POST', '/opportunities', {
          companyName: JOB.company,
          title: JOB.title,
          location: THERE,
          sourceKind: 'manual',
        });
      const [done, made] =
        first === 'the capture'
          ? await heldApart(app, 'captureResolve.matched.locked', joins, making)
          : await heldApart(app, 'opportunities.create.locked', making, joins).then(
              ([m, c]) => [c, m] as const,
            );
      expect(made.statusCode, made.body).toBe(201);
      // Its own key's first: the separate one the user made.
      expect(done.opportunityId).toBe(
        first === 'the capture' ? id : made.json<{ id: string }>().id,
      );
      expect(await opportunitiesOf(app, a)).toHaveLength(2);
    },
  );

  it('an Unsuppress of the role’s own result changes nothing of it', async () => {
    const { app, a } = await boot();
    const id = await ORIGINS.accepted(app, a);
    const [result] = await resultsOf(app, a);
    const refused = await send(a, 'POST', `/discovery/results/${result!.id}/unsuppress`, {});
    expect(refused.statusCode).toBe(409);
    expect((await capture(app, a, P, THERE)).opportunityId).toBe(id);
  });
});
