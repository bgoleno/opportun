// One card, several locations: capturing the posting of any one of them ends the whole card (the
// owner's decision on https://github.com/bgoleno/opportun/issues/967; tl's ruling,
// https://github.com/bgoleno/opportun/issues/967#issuecomment-7119802645; qa's cases 50 to 54 and 57).
// A card is one company and one whole title (cardKey). Another level, title, company or user is
// another card. Every posting is made up.
import { enqueue } from '../src/lib/jobQueue';
import { dedupeKey, newId, type NormalizedPosting } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { registerSource, resetSources } from '../src/adapters/discoverySource';
import { onSlowTransaction } from '../src/db/gate';
import { discoveryResults, discoveryRuns, opportunities } from '../src/db/schema';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import { resolveCapture } from '../src/lib/captureResolve';
import { listActivities } from '../src/repos/activities';
import {
  createRun,
  createSource,
  ensureChannelSource,
  getResult,
  insertResult,
  setDisposition,
} from '../src/repos/discovery';
import {
  createOpportunity,
  getOpportunity,
  transitionOpportunity,
} from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { heldApart } from './race';
import { runQueuedJob } from './runQueuedJob';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const close = (app: FastifyInstance, id: string) =>
  app.db.update(opportunities).set({ stage: 'closed' }).where(eq(opportunities.id, id)).run();
afterEach(() => resetSources());

const PAGE = 'Own the platform, as the page has it.';
const JOB = { company: 'Initech', title: 'Senior Platform Engineer' };
const CITIES = ['Austin, TX', 'Boston, MA', 'Chicago, IL'];

type SiteId = 'linkedin' | 'indeed';
const idOf = (site: SiteId, n: number): string =>
  site === 'linkedin' ? String(1_000_000_001 + n) : `0000000000000a0${String(n + 1)}`;
const urlOf = (site: SiteId, n: number): string =>
  site === 'linkedin'
    ? `https://www.linkedin.com/jobs/view/${idOf(site, n)}/`
    : `https://www.indeed.com/viewjob?jk=${idOf(site, n)}`;

/** The nth location of the card, as its site's alert stores it. */
async function location(
  app: FastifyInstance,
  c: TestClient,
  site: SiteId,
  n: number,
  over: Partial<NormalizedPosting> = {},
): Promise<string> {
  const ctx = ctxOf(c);
  const source = await ensureChannelSource(app.db, ctx, 'alert_email');
  const run = await createRun(app.db, ctx, { sourceId: source.id });
  const posting: NormalizedPosting = {
    ...JOB,
    location: CITIES.at(n) ?? `City ${String(n)}`,
    postingUrl: urlOf(site, n),
    externalId: idOf(site, n),
    ...over,
  };
  return (
    await insertResult(app.db, ctx, {
      runId: run.id,
      posting,
      dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
      resolution: 'needs_capture',
    })
  ).id;
}

const capture = (
  app: FastifyInstance,
  c: TestClient,
  site: SiteId,
  n: number,
  over: Partial<NormalizedPosting> = {},
) =>
  resolveCapture(app.db, ctxOf(c), {
    posting: {
      ...JOB,
      location: null,
      descriptionMd: PAGE,
      postingUrl: urlOf(site, n),
      externalId: `${site}:${idOf(site, n)}`,
      ...over,
    },
    captureText: PAGE,
    siteId: site,
  });

const resultsOf = (app: FastifyInstance, c: TestClient) =>
  app.db.select().from(discoveryResults).where(eq(discoveryResults.userId, c.userId)).all();
const opportunitiesOf = (app: FastifyInstance, c: TestClient) =>
  app.db.select().from(opportunities).where(eq(opportunities.userId, c.userId)).all();

/** The links on the timeline: one for each posting that is on it. */
async function linksOf(app: FastifyInstance, c: TestClient, id: string): Promise<string[]> {
  const { items } = await listActivities(app.db, ctxOf(c), id, { limit: 50, offset: 0 });
  return items
    .filter((i) => i.kind === 'link')
    .map((i) => `${(i.bodyMd ?? '').split('\n').at(-1) ?? ''} ${i.externalUrl ?? ''}`)
    .sort();
}
const linkFor = (site: SiteId, n: number) => `${CITIES.at(n) ?? ''} ${urlOf(site, n)}`;

const CARDS: readonly (readonly [string, readonly SiteId[]])[] = [
  ['two on LinkedIn', ['linkedin', 'linkedin']],
  ['two on Indeed', ['indeed', 'indeed']],
  ['one on each', ['linkedin', 'indeed']],
  ['three on LinkedIn', ['linkedin', 'linkedin', 'linkedin']],
  ['three on Indeed', ['indeed', 'indeed', 'indeed']],
  ['three across both', ['linkedin', 'indeed', 'linkedin']],
];
const CASES = CARDS.flatMap(([name, sites]) => sites.map((_s, n) => [name, n, sites] as const));

describe('capturing one location of a card', () => {
  it.each(CASES)(
    '%s, the one at %i first: the whole card goes, into one opportunity',
    async (_name, first, sites) => {
      const { app, a } = await boot();
      const ids: string[] = [];
      for (const [n, site] of sites.entries()) ids.push(await location(app, a, site, n));

      const done = await capture(app, a, sites[first]!, first);

      expect(done).toMatchObject({ createdOpportunity: true, resultId: ids[first] });
      expect([...done.linkedLeadIds].sort()).toEqual(ids.filter((_id, n) => n !== first).sort());
      expect(done.linked).toBe(sites.length - 1);
      const opps = await opportunitiesOf(app, a);
      expect(opps).toHaveLength(1);
      expect(opps[0]).toMatchObject({
        stage: 'interested',
        descriptionMd: PAGE,
        location: CITIES[first],
        postingUrl: urlOf(sites[first]!, first),
      });
      const rows = await resultsOf(app, a);
      expect(rows).toHaveLength(sites.length);
      for (const r of rows)
        expect(r).toMatchObject({ disposition: 'accepted', opportunityId: opps[0]!.id });
      const others = sites.flatMap((site, n) => (n === first ? [] : [linkFor(site, n)])).sort();
      expect(await linksOf(app, a, opps[0]!.id)).toEqual(others);

      // Another of its locations later: the same opportunity, and nothing more than a timeline entry.
      const second = (first + 1) % sites.length;
      const again = await capture(app, a, sites[second]!, second);
      expect(again).toMatchObject({
        opportunityId: done.opportunityId,
        resultId: ids[second],
        createdOpportunity: false,
        stageMovedTo: null,
        linkedLeadIds: [],
        linked: 0,
      });
      expect(await opportunitiesOf(app, a)).toHaveLength(1);
      expect(await resultsOf(app, a)).toHaveLength(sites.length);
      expect(await linksOf(app, a, opps[0]!.id)).toEqual(others);
    },
  );

  it('every location of it, however many the page has loaded', async () => {
    const { app, a } = await boot();
    for (let n = 0; n < 205; n++) {
      await location(app, a, 'linkedin', n, { location: `City ${String(n)}` });
    }
    const done = await capture(app, a, 'linkedin', 0);
    expect(done.linked).toBe(204);
    expect((await resultsOf(app, a)).every((r) => r.disposition === 'accepted')).toBe(true);
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
  });

  it('Sr and Senior are one card', async () => {
    const { app, a } = await boot();
    await location(app, a, 'linkedin', 0);
    const sr = await location(app, a, 'linkedin', 1, { title: 'Sr. Platform Engineer' });
    await capture(app, a, 'linkedin', 0);
    expect((await getResult(app.db, ctxOf(a), sr)).disposition).toBe('accepted');
  });

  it.each([
    ['another level', { title: 'Principal Platform Engineer' }],
    ['another title', { title: 'Senior Data Engineer' }],
    ['another company', { company: 'Globex' }],
  ])('%s is untouched', async (_what, over) => {
    const { app, a } = await boot();
    await location(app, a, 'linkedin', 0);
    const other = await location(app, a, 'linkedin', 1, over);
    const before = await getResult(app.db, ctxOf(a), other);
    const done = await capture(app, a, 'linkedin', 0);
    expect(done.linkedLeadIds).toEqual([]);
    expect(await getResult(app.db, ctxOf(a), other)).toEqual(before);
  });

  it("another user's is untouched, and so is one already dismissed", async () => {
    const { app, a, b } = await boot();
    await location(app, a, 'linkedin', 0);
    const dismissed = await location(app, a, 'linkedin', 1);
    await setDisposition(app.db, ctxOf(a), dismissed, 'dismissed');
    await location(app, b, 'linkedin', 0);
    await location(app, b, 'linkedin', 1);
    const theirs = await resultsOf(app, b);
    const done = await capture(app, a, 'linkedin', 0);
    expect(done.linkedLeadIds).toEqual([]);
    expect(await getResult(app.db, ctxOf(a), dismissed)).toMatchObject({
      disposition: 'dismissed',
      opportunityId: null,
    });
    expect(await resultsOf(app, b)).toEqual(theirs);
    expect(await opportunitiesOf(app, b)).toEqual([]);
  });

  it('a posting captured again takes no card that came later', async () => {
    const { app, a } = await boot();
    await location(app, a, 'linkedin', 0);
    await capture(app, a, 'linkedin', 0);
    const later = await location(app, a, 'linkedin', 1);
    const again = await capture(app, a, 'linkedin', 0);
    expect(again.linkedLeadIds).toEqual([]);
    expect((await getResult(app.db, ctxOf(a), later)).disposition).toBe('pending');
  });
});

describe('the opportunity it goes into', () => {
  const tracked = (app: FastifyInstance, c: TestClient, n: number) =>
    createOpportunity(app.db, ctxOf(c), {
      companyName: JOB.company,
      title: JOB.title,
      location: CITIES[n]!,
      sourceKind: 'manual',
    });

  it("one that holds another location's key, and every posting with it", async () => {
    const { app, a } = await boot();
    const boston = await tracked(app, a, 1);
    for (const n of [0, 1, 2]) await location(app, a, 'linkedin', n);
    const done = await capture(app, a, 'linkedin', 0);
    expect(done).toMatchObject({ opportunityId: boston.id, createdOpportunity: false, linked: 2 });
    expect(done.stageMovedTo).toBe('interested');
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
    expect(await linksOf(app, a, boston.id)).toEqual(
      [0, 1, 2].map((n) => linkFor('linkedin', n)).sort(),
    );
  });

  it('the oldest, when two locations have one', async () => {
    const { app, a } = await boot();
    const boston = await tracked(app, a, 1);
    const chicago = await tracked(app, a, 2);
    for (const [id, createdAt] of [
      [boston.id, 2_000],
      [chicago.id, 1_000],
    ] as const) {
      await app.db.update(opportunities).set({ createdAt }).where(eq(opportunities.id, id)).run();
    }
    for (const n of [0, 1, 2]) await location(app, a, 'linkedin', n);
    expect((await capture(app, a, 'linkedin', 0)).opportunityId).toBe(chicago.id);
  });

  it("the captured one's own key before another location's", async () => {
    const { app, a } = await boot();
    await tracked(app, a, 1);
    const austin = await tracked(app, a, 0);
    for (const n of [0, 1]) await location(app, a, 'linkedin', n);
    expect((await capture(app, a, 'linkedin', 0)).opportunityId).toBe(austin.id);
  });

  it("the one an earlier location of the role was accepted into, as Accept's own chain", async () => {
    const { app, a } = await boot();
    const first = await location(app, a, 'linkedin', 0);
    const accepted = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${first}/accept`,
      payload: {},
    });
    const { opportunityId } = accepted.json();
    for (const n of [1, 2]) await location(app, a, 'linkedin', n);
    const done = await capture(app, a, 'linkedin', 1);
    expect(done).toMatchObject({ opportunityId, createdOpportunity: false, linked: 1 });
    expect((await getOpportunity(app.db, ctxOf(a), opportunityId)).stage).toBe('interested');
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
  });

  it("not another level's, accepted earlier", async () => {
    const { app, a } = await boot();
    const other = await location(app, a, 'linkedin', 0, { title: 'Principal Platform Engineer' });
    await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${other}/accept`,
      payload: {},
    });
    await location(app, a, 'linkedin', 1);
    const done = await capture(app, a, 'linkedin', 1);
    expect(done.createdOpportunity).toBe(true);
  });

  it('none of these when the key it would hold is another job’s on the same site, over: kept apart', async () => {
    const { app, a } = await boot();
    // Another LinkedIn posting under the same key, tracked: what keeps two apart (#73, #80).
    const there = await location(app, a, 'linkedin', 0);
    const accepted = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${there}/accept`,
      payload: {},
    });
    const { opportunityId } = accepted.json();
    // Open, it is the role, and the card goes to it (#1037, captureJoins.test.ts).
    await close(app, opportunityId);
    await location(app, a, 'linkedin', 2, { location: CITIES[0] });
    const done = await capture(app, a, 'linkedin', 2, { location: CITIES[0] });
    expect(done.createdOpportunity).toBe(true);
    expect(done.opportunityId).not.toBe(opportunityId);
  });
});

// Levels are different jobs (the owner), and the stored key strips them: by key only the same whole
// title counts, for a lead, an accepted result and an opportunity (tl's review of
// https://github.com/bgoleno/opportun/pull/980).
describe('another level under the same key', () => {
  const PRINCIPAL = { title: 'Principal Platform Engineer' };
  /** A board's result: its id says nothing of LinkedIn, so the key alone could match it. */
  async function boardResult(app: FastifyInstance, c: TestClient, n: number, title: string) {
    const source = await createSource(app.db, ctxOf(c), {
      kind: 'ats_lever',
      config: { org: 'initech' },
    });
    const run = await createRun(app.db, ctxOf(c), { sourceId: source.id });
    const location = CITIES[n]!;
    return (
      await insertResult(app.db, ctxOf(c), {
        runId: run.id,
        posting: {
          ...JOB,
          title,
          location,
          descriptionMd: 'As the board has it.',
          postingUrl: `https://boards.example.com/initech/${title.length}-${n}`,
          externalId: `gh-${title.length}-${n}`,
        },
        dedupeKey: dedupeKey(JOB.company, title, location),
        resolution: 'full',
      })
    ).id;
  }
  const noteOf = async (app: FastifyInstance, c: TestClient, id: string) =>
    (await listActivities(app.db, ctxOf(c), id, { limit: 50, offset: 0 })).items
      .map((i) => i.title)
      .filter((t) => t.startsWith('Kept apart'));

  it('pending, in two places: neither is taken', async () => {
    const { app, a } = await boot();
    const ids = [
      await boardResult(app, a, 0, PRINCIPAL.title),
      await boardResult(app, a, 1, PRINCIPAL.title),
    ];
    const done = await capture(app, a, 'linkedin', 0, { location: CITIES[0] });
    expect(done).toMatchObject({ createdOpportunity: true, linkedLeadIds: [] });
    for (const id of ids) {
      expect((await getResult(app.db, ctxOf(a), id)).disposition).toBe('pending');
    }
    expect((await opportunitiesOf(app, a))[0]!.title).toBe(JOB.title);
  });

  it('older than the card: the one found by id is completed, and its own card goes with it', async () => {
    const { app, a } = await boot();
    const older = await boardResult(app, a, 0, PRINCIPAL.title);
    const austin = await location(app, a, 'linkedin', 0);
    const boston = await location(app, a, 'linkedin', 1);
    const done = await capture(app, a, 'linkedin', 0, { location: CITIES[0] });
    expect(done).toMatchObject({ resultId: austin, linkedLeadIds: [boston], linked: 1 });
    expect((await opportunitiesOf(app, a)).map((o) => o.title)).toEqual([JOB.title]);
    expect((await getResult(app.db, ctxOf(a), older)).disposition).toBe('pending');
  });

  it('a lead found by id comes before an older one of the same title found by key', async () => {
    const { app, a } = await boot();
    const older = await boardResult(app, a, 0, JOB.title);
    const austin = await location(app, a, 'linkedin', 0);
    // Not the one that needs a capture, which would come first whatever its match.
    await app.db
      .update(discoveryResults)
      .set({ resolution: 'full' })
      .where(eq(discoveryResults.id, austin))
      .run();
    const done = await capture(app, a, 'linkedin', 0, { location: CITIES[0] });
    expect(done).toMatchObject({ resultId: austin, linkedLeadIds: [older] });
  });

  it('tracked, under another location of the card: the card gets its own', async () => {
    const { app, a } = await boot();
    const principal = await createOpportunity(app.db, ctxOf(a), {
      companyName: JOB.company,
      title: PRINCIPAL.title,
      location: CITIES[1]!,
      sourceKind: 'manual',
    });
    for (const n of [0, 1]) await location(app, a, 'linkedin', n);
    const done = await capture(app, a, 'linkedin', 0);
    expect(done).toMatchObject({ createdOpportunity: true, linked: 1 });
    expect(done.opportunityId).not.toBe(principal.id);
    expect((await getOpportunity(app.db, ctxOf(a), principal.id)).stage).toBe('discovered');
  });

  it.each([
    ['made by hand', false],
    ['accepted from a board', true],
  ])(
    'tracked, under its own key, %s: kept apart, flagged, and the note says why',
    async (_w, fromBoard) => {
      const { app, a } = await boot();
      let there: string;
      if (fromBoard) {
        const id = await boardResult(app, a, 0, PRINCIPAL.title);
        const res = await a.request({
          method: 'POST',
          url: `/api/v1/discovery/results/${id}/accept`,
          payload: {},
        });
        there = res.json().opportunityId;
      } else {
        const opp = await createOpportunity(app.db, ctxOf(a), {
          companyName: JOB.company,
          title: PRINCIPAL.title,
          location: CITIES[0]!,
          sourceKind: 'manual',
        });
        there = opp.id;
      }
      const austin = await location(app, a, 'linkedin', 0);
      const done = await capture(app, a, 'linkedin', 0, { location: CITIES[0] });
      expect(done).toMatchObject({ createdOpportunity: true, resultId: austin });
      const own = (await opportunitiesOf(app, a)).find((o) => o.id === done.opportunityId)!;
      expect(own).toMatchObject({
        title: JOB.title,
        possibleDuplicateOf: there,
        stage: 'interested',
      });
      expect(await noteOf(app, a, own.id)).toEqual(['Kept apart from a job at another level']);
      expect((await getOpportunity(app.db, ctxOf(a), there)).stage).toBe('discovered');
    },
  );

  it.each([
    ['the same title', JOB.title],
    ['the same, its level written short', 'Sr. Platform Engineer'],
  ])(
    '%s is not another level: the hand-made opportunity is filled, as before',
    async (_w, title) => {
      const { app, a } = await boot();
      const there = await createOpportunity(app.db, ctxOf(a), {
        companyName: JOB.company,
        title,
        location: CITIES[0]!,
        sourceKind: 'manual',
      });
      await location(app, a, 'linkedin', 0);
      const done = await capture(app, a, 'linkedin', 0, { location: CITIES[0] });
      expect(done).toMatchObject({ opportunityId: there.id, createdOpportunity: false });
    },
  );

  it('the same title on another site is still taken by its key', async () => {
    const { app, a } = await boot();
    const indeed = await location(app, a, 'indeed', 0);
    const done = await capture(app, a, 'linkedin', 0, { location: CITIES[0] });
    expect(done.resultId).toBe(indeed);
  });
});

it('one just kept apart is not then found by another posting on the card', async () => {
  const { app, a } = await boot();
  const other = await location(app, a, 'linkedin', 2, { location: CITIES[0] });
  const accepted = await a.request({
    method: 'POST',
    url: `/api/v1/discovery/results/${other}/accept`,
    payload: {},
  });
  await close(app, accepted.json().opportunityId);
  // Of the same card and key, with no id to contradict the tracked one.
  const noId = await location(app, a, 'linkedin', 0, {
    location: CITIES[0],
    postingUrl: 'https://careers.example.com/1',
    externalId: 'opaque-1',
  });
  const austin = await location(app, a, 'linkedin', 0);
  const done = await capture(app, a, 'linkedin', 0, { location: CITIES[0] });
  expect(done).toMatchObject({ createdOpportunity: true, resultId: austin, linkedLeadIds: [noId] });
  expect(done.opportunityId).not.toBe(accepted.json().opportunityId);
});

describe('a holder of another location that is no longer open', () => {
  it.each(['dismissed', 'closed'] as const)(
    '%s: it is left, and the open one is taken',
    async (stage) => {
      const { app, a } = await boot();
      const make = (n: number) =>
        createOpportunity(app.db, ctxOf(a), {
          companyName: JOB.company,
          title: JOB.title,
          location: CITIES[n]!,
          sourceKind: 'manual',
        });
      const boston = await make(1);
      const chicago = await make(2);
      await transitionOpportunity(app.db, ctxOf(a), boston.id, {
        to: stage,
        ...(stage === 'closed' ? { closedReason: 'withdrawn' as const } : {}),
      });
      for (const [id, createdAt] of [
        [boston.id, 1_000],
        [chicago.id, 2_000],
      ] as const) {
        await app.db.update(opportunities).set({ createdAt }).where(eq(opportunities.id, id)).run();
      }
      for (const n of [0, 1, 2]) await location(app, a, 'linkedin', n);
      expect((await capture(app, a, 'linkedin', 0)).opportunityId).toBe(chicago.id);
      expect((await getOpportunity(app.db, ctxOf(a), boston.id)).stage).toBe(stage);
    },
  );

  it.each(['dismissed', 'closed'] as const)('only one, %s: a new opportunity', async (stage) => {
    const { app, a } = await boot();
    const boston = await createOpportunity(app.db, ctxOf(a), {
      companyName: JOB.company,
      title: JOB.title,
      location: CITIES[1]!,
      sourceKind: 'manual',
    });
    await transitionOpportunity(app.db, ctxOf(a), boston.id, {
      to: stage,
      ...(stage === 'closed' ? { closedReason: 'withdrawn' as const } : {}),
    });
    for (const n of [0, 1]) await location(app, a, 'linkedin', n);
    const done = await capture(app, a, 'linkedin', 0);
    expect(done).toMatchObject({ createdOpportunity: true, linked: 1 });
    expect((await getOpportunity(app.db, ctxOf(a), boston.id)).stage).toBe(stage);
  });
});

// The lead's stored key is of its posting as it came; a board, or the capture, can have given it a
// location since, and creating with that one met its holder: 409, each time the page was captured.
describe('a lead that has been given a location since', () => {
  const given = async (app: FastifyInstance, c: TestClient) => {
    const id = await location(app, c, 'linkedin', 0, { location: null });
    const posting = { ...(await getResult(app.db, ctxOf(c), id)).posting, location: CITIES[0]! };
    await app.db.update(discoveryResults).set({ posting }).where(eq(discoveryResults.id, id)).run();
    return id;
  };
  const holder = (app: FastifyInstance, c: TestClient, title = JOB.title) =>
    createOpportunity(app.db, ctxOf(c), {
      companyName: JOB.company,
      title,
      location: CITIES[0]!,
      sourceKind: 'manual',
    });

  it('an open opportunity there, of the same title: it is the one', async () => {
    const { app, a } = await boot();
    const id = await given(app, a);
    const there = await holder(app, a);
    const done = await capture(app, a, 'linkedin', 0);
    expect(done).toMatchObject({
      resultId: id,
      opportunityId: there.id,
      createdOpportunity: false,
    });
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
  });

  it('one that holds the key it was stored with: it is the one', async () => {
    const { app, a } = await boot();
    await given(app, a);
    const there = await createOpportunity(app.db, ctxOf(a), {
      companyName: JOB.company,
      title: JOB.title,
      sourceKind: 'manual',
    });
    const done = await capture(app, a, 'linkedin', 0, { location: CITIES[1] });
    expect(done).toMatchObject({ opportunityId: there.id, createdOpportunity: false });
  });

  it('another level there: kept apart and flagged', async () => {
    const { app, a } = await boot();
    await given(app, a);
    const there = await holder(app, a, 'Principal Platform Engineer');
    const done = await capture(app, a, 'linkedin', 0);
    expect(done.createdOpportunity).toBe(true);
    const own = (await opportunitiesOf(app, a)).find((o) => o.id === done.opportunityId);
    expect(own?.possibleDuplicateOf).toBe(there.id);
    expect((await capture(app, a, 'linkedin', 0)).opportunityId).toBe(done.opportunityId);
    expect(await opportunitiesOf(app, a)).toHaveLength(2);
  });

  // The posting's own key, so its holder is the opportunity at any stage, as for its other two.
  it.each([
    ['applied', 'applied'],
    ['closed', 'closed'],
    ['dismissed', 'interested'],
  ] as const)(
    'an opportunity there at %s, of the same title: it is the one, at %s',
    async (stage, after) => {
      const { app, a } = await boot();
      const id = await given(app, a);
      const there = await holder(app, a);
      for (const to of stage === 'applied' ? (['interested', 'applied'] as const) : [stage]) {
        await transitionOpportunity(app.db, ctxOf(a), there.id, {
          to,
          ...(to === 'closed' ? { closedReason: 'withdrawn' as const } : {}),
        });
      }
      for (const result of [id, id]) {
        const done = await capture(app, a, 'linkedin', 0);
        expect(done).toMatchObject({ resultId: result, opportunityId: there.id });
      }
      expect((await getOpportunity(app.db, ctxOf(a), there.id)).stage).toBe(after);
      expect(await opportunitiesOf(app, a)).toHaveLength(1);
    },
  );

  it('one whose leads are another posting on the site, over: kept apart, once', async () => {
    const { app, a } = await boot();
    const other = await location(app, a, 'linkedin', 2, { location: CITIES[0] });
    const accepted = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${other}/accept`,
      payload: {},
    });
    await close(app, accepted.json().opportunityId);
    await given(app, a);
    const done = await capture(app, a, 'linkedin', 0);
    expect(done.createdOpportunity).toBe(true);
    expect((await capture(app, a, 'linkedin', 0)).opportunityId).toBe(done.opportunityId);
    expect(await opportunitiesOf(app, a)).toHaveLength(2);
  });
});

describe('a run that stores a new location during the capture', () => {
  async function board(app: FastifyInstance, c: TestClient): Promise<string> {
    const posting: NormalizedPosting = {
      ...JOB,
      location: CITIES[1]!,
      descriptionMd: 'As the board has it.',
      postingUrl: 'https://boards.example.com/initech/1',
      externalId: 'gh-1',
    };
    registerSource({
      kind: 'ats_lever',
      async *fetchPostings() {
        yield { posting, nextCursor: null };
      },
    });
    const source = await createSource(app.db, ctxOf(c), {
      kind: 'ats_lever',
      config: { org: 'initech' },
      roleTargetId: null,
    });
    const at = Date.now() - 86_400_000;
    await app.db
      .insert(discoveryRuns)
      .values({
        id: newId(),
        userId: c.userId,
        sourceId: source.id,
        startedAt: at,
        finishedAt: at,
        stats: null,
        error: null,
      })
      .run();
    return source.id;
  }
  async function runBoard(app: FastifyInstance, c: TestClient, sourceId: string): Promise<void> {
    const queued = await enqueue(
      app.db,
      DISCOVERY_RUN_KIND,
      { sourceId },
      { dedupeKey: `${DISCOVERY_RUN_KIND}:${sourceId}`, userId: c.userId },
    );
    await runQueuedJob(app, queued);
  }
  const boardRow = async (app: FastifyInstance, c: TestClient) =>
    (await resultsOf(app, c)).find((r) => r.posting.externalId === 'gh-1');

  it('the run first: its location goes with the card', async () => {
    const { app, a } = await boot();
    onSlowTransaction(() => undefined);
    const source = await board(app, a);
    await location(app, a, 'linkedin', 0);
    const [, done] = await heldApart(
      app,
      'discovery.ingest.locked',
      () => runBoard(app, a, source),
      () => capture(app, a, 'linkedin', 0),
    );
    expect(await boardRow(app, a)).toMatchObject({
      disposition: 'accepted',
      opportunityId: done.opportunityId,
    });
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
  });

  it('the capture first: never lost, and never a second opportunity', async () => {
    const { app, a } = await boot();
    onSlowTransaction(() => undefined);
    const source = await board(app, a);
    await location(app, a, 'linkedin', 0);
    const [done] = await heldApart(
      app,
      'captureResolve.matched.locked',
      () => capture(app, a, 'linkedin', 0),
      () => runBoard(app, a, source),
    );
    expect(await boardRow(app, a)).toBeDefined();
    expect((await opportunitiesOf(app, a)).map((o) => o.id)).toEqual([done.opportunityId]);
  });
});
