// A posting that reaches Discovery after its role is in the pipeline (#971, and the owner's decision
// on https://github.com/bgoleno/opportun/issues/967): no card and no second opportunity. It is linked
// to the open opportunity, whose stage and description stay as they are. Every posting is made up.
import { dedupeKey, newId, type NormalizedPosting, type OpportunityStage } from '@opportun/core';
import { runStructured } from '@opportun/ai';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activities, discoveryResults, discoveryRuns, jobs, opportunities } from '../src/db/schema';
import { registerSource, resetSources } from '../src/adapters/discoverySource';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import { insertLeads } from '../src/lib/discoveryIngest';
import { enqueue } from '../src/lib/jobQueue';
import { resolveCapture } from '../src/lib/captureResolve';
import {
  createRun,
  createSource,
  ensureChannelSource,
  insertResult,
  prefilterRecall,
} from '../src/repos/discovery';
import { isLockTimeout } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import { pipelineText } from '../src/jobs/companySuggest';
import { previewPurge } from '../src/jobs/purge';
import { MULTI_POSTED_PREFIX } from '../src/lib/jobKinds';
import { useApi } from './api';
import { testDialect } from './db';
import { heldApart, pauseAt } from './race';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
});
afterEach(() => resetSources());

const JOB = { company: 'Initech', title: 'Platform Engineer' };
const PAGE = 'Own the platform, as the page has it.';
const HERE = 'Austin, TX';
const THERE = 'Boston, MA';
const OPEN: readonly OpportunityStage[] = [
  'discovered',
  'interested',
  'preparing',
  'applied',
  'in_process',
  'offer',
];

type Site = readonly [siteId: string, id: string, url: string, other: string, otherUrl: string];
const SITES: readonly Site[] = [
  [
    'linkedin',
    '1000000001',
    'https://www.linkedin.com/jobs/view/1000000001',
    '1000000002',
    'https://www.linkedin.com/jobs/view/1000000002',
  ],
  [
    'indeed',
    'abc123def4567890',
    'https://www.indeed.com/viewjob?jk=abc123def4567890',
    'fed321cba0987654',
    'https://www.indeed.com/viewjob?jk=fed321cba0987654',
  ],
];
const [LINKEDIN] = SITES as [Site, Site];

const capture = (
  app: FastifyInstance,
  c: TestClient,
  [siteId, id, url]: Site,
  location: string | null,
  over: Partial<NormalizedPosting> = {},
) =>
  resolveCapture(app.db, ctxOf(c), {
    posting: {
      ...JOB,
      location,
      descriptionMd: PAGE,
      postingUrl: url,
      externalId: `${siteId}:${id}`,
      ...over,
    },
    captureText: PAGE,
    siteId,
  });

const CONFIGS = {
  mcp: {
    transport: 'http',
    url: 'https://mcp.example.com',
    tool: 'jobs',
    queryArgs: {},
    mapping: { company: 'company', title: 'title' },
    itemsPath: '',
  },
  ats_lever: { org: 'initech' },
};

/** Postings as a source of `kind` hands them over. */
async function arrive(
  app: FastifyInstance,
  c: TestClient,
  postings: NormalizedPosting[],
  kind: 'alert_email' | 'mcp' | 'ats_lever' = 'alert_email',
) {
  const source =
    kind === 'alert_email'
      ? await ensureChannelSource(app.db, ctxOf(c), kind)
      : await createSource(app.db, ctxOf(c), { kind, config: CONFIGS[kind], roleTargetId: null });
  return await insertLeads(app.db, ctxOf(c), postings, source.id);
}
const alertOf = (
  [, id, url]: Site,
  location: string | null,
  over: Partial<NormalizedPosting> = {},
): NormalizedPosting => ({ ...JOB, location, postingUrl: url, externalId: id, ...over });
const another = (
  [, , , id, url]: Site,
  location: string | null,
  over: Partial<NormalizedPosting> = {},
): NormalizedPosting => ({ ...JOB, location, postingUrl: url, externalId: id, ...over });

const resultsOf = (app: FastifyInstance, c: TestClient) =>
  app.db.select().from(discoveryResults).where(eq(discoveryResults.userId, c.userId)).all();
const opportunitiesOf = (app: FastifyInstance, c: TestClient) =>
  app.db.select().from(opportunities).where(eq(opportunities.userId, c.userId)).all();
const pendingOf = async (app: FastifyInstance, c: TestClient) =>
  (await resultsOf(app, c)).filter((r) => r.disposition === 'pending');
const entries = (app: FastifyInstance, opportunityId: string) =>
  app.db
    .select()
    .from(activities)
    .where(and(eq(activities.opportunityId, opportunityId), eq(activities.kind, 'link')))
    .all();
const jobsOf = async (app: FastifyInstance, resultId: string) =>
  (await app.db.select().from(jobs).all()).filter((j) =>
    JSON.stringify(j.payload).includes(resultId),
  );
const move = (app: FastifyInstance, id: string, stage: OpportunityStage) =>
  app.db.update(opportunities).set({ stage }).where(eq(opportunities.id, id)).run();

/** How the opportunity came to be. */
const ORIGINS = {
  async captured(app: FastifyInstance, c: TestClient): Promise<string> {
    return (await capture(app, c, LINKEDIN, HERE)).opportunityId;
  },
  async accepted(app: FastifyInstance, c: TestClient): Promise<string> {
    const { inserted } = await arrive(app, c, [alertOf(LINKEDIN, HERE, { descriptionMd: PAGE })]);
    const res = await c.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${inserted[0]!.id}/accept`,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ opportunityId: string }>().opportunityId;
  },
  async 'made by hand'(app: FastifyInstance, c: TestClient): Promise<string> {
    const res = await c.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: {
        companyName: JOB.company,
        title: JOB.title,
        location: HERE,
        descriptionMd: PAGE,
        sourceKind: 'manual',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  },
};
const ORIGIN_NAMES = Object.keys(ORIGINS) as (keyof typeof ORIGINS)[];

/** Nothing new to review: one linked result, one entry, the opportunity as it was. */
async function expectLinked(
  app: FastifyInstance,
  c: TestClient,
  before: Awaited<ReturnType<typeof opportunitiesOf>>,
  posting: NormalizedPosting,
  via: string,
) {
  expect(await pendingOf(app, c)).toEqual([]);
  const after = await opportunitiesOf(app, c);
  // A timeline entry touches nothing else on the opportunity.
  const facts = (o: (typeof after)[number]) => ({
    id: o.id,
    stage: o.stage,
    descriptionMd: o.descriptionMd,
    location: o.location,
    compNote: o.compNote,
    dedupeKey: o.dedupeKey,
    title: o.title,
  });
  expect(after.map(facts)).toEqual(before.map(facts));
  const linked = (await resultsOf(app, c)).filter((r) => r.rankSkipReason === 'linked');
  expect(linked).toHaveLength(1);
  expect(linked[0]).toMatchObject({
    disposition: 'accepted',
    opportunityId: before[0]!.id,
    aiScore: null,
    prefilterOutcome: null,
    prefilterScore: null,
    dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
  });
  const list = await entries(app, before[0]!.id);
  expect(
    list
      .filter((e) => e.externalUrl === (posting.postingUrl ?? null))
      .map((e) => [e.title, e.bodyMd]),
  ).toEqual([
    [
      `Also posted via ${via}`,
      [`${posting.company}: ${posting.title}`, posting.location].filter(Boolean).join('\n'),
    ],
  ]);
  expect(await jobsOf(app, linked[0]!.id)).toEqual([]);
}

describe.each(ORIGIN_NAMES)('another location of a role %s', (origin) => {
  it.each(OPEN)('at %s: linked, no card, nothing else changed', async (stage) => {
    const { app, a } = await boot();
    const id = await ORIGINS[origin](app, a);
    await move(app, id, stage);
    const before = await opportunitiesOf(app, a);
    const posting = another(LINKEDIN, THERE);
    const { stats, inserted } = await arrive(app, a, [posting]);
    expect([stats, inserted]).toMatchObject([
      { fetched: 1, inserted: 0, duplicates: 0, suppressed: 0, invalid: 0, linked: 1 },
      [],
    ]);
    await expectLinked(app, a, before, posting, 'a job alert email (alert_email)');
    // Again: known now.
    expect((await arrive(app, a, [posting])).stats).toMatchObject({ linked: 0, duplicates: 1 });
  });

  it.each(['mcp', 'ats_lever'] as const)('from a source of kind %s too', async (kind) => {
    const { app, a } = await boot();
    const id = await ORIGINS[origin](app, a);
    await move(app, id, 'applied');
    const before = await opportunitiesOf(app, a);
    const posting = another(LINKEDIN, THERE, {
      externalId: 'opaque-1',
      postingUrl: 'https://boards.example.com/initech/1',
    });
    expect((await arrive(app, a, [posting], kind)).stats.linked).toBe(1);
    expect(await pendingOf(app, a)).toEqual([]);
    expect((await opportunitiesOf(app, a)).map((o) => [o.id, o.stage])).toEqual(
      before.map((o) => [o.id, o.stage]),
    );
  });

  it.each(['closed', 'dismissed'] as const)('at %s: a card', async (stage) => {
    const { app, a } = await boot();
    const id = await ORIGINS[origin](app, a);
    await move(app, id, stage);
    expect((await arrive(app, a, [another(LINKEDIN, THERE)])).stats).toMatchObject({
      inserted: 1,
      linked: 0,
    });
    expect(await pendingOf(app, a)).toHaveLength(1);
  });

  it.each([
    ['another level', { title: 'Principal Platform Engineer' }],
    ['another title', { title: 'Data Engineer' }],
    ['another company', { company: 'Globex' }],
  ])('%s: a card', async (_what, over) => {
    const { app, a } = await boot();
    await ORIGINS[origin](app, a);
    expect((await arrive(app, a, [another(LINKEDIN, THERE, over)])).stats).toMatchObject({
      inserted: 1,
      linked: 0,
    });
    expect(await pendingOf(app, a)).toHaveLength(1);
  });

  it("another user's: a card", async () => {
    const { app, a, b } = await boot();
    await ORIGINS[origin](app, a);
    expect((await arrive(app, b, [another(LINKEDIN, THERE)])).stats.inserted).toBe(1);
    expect(await pendingOf(app, b)).toHaveLength(1);
  });
});

/** Stored nothing, said nothing: the very posting is on the timeline already (tl on #971). */
async function expectDuplicate(
  app: FastifyInstance,
  c: TestClient,
  posting: NormalizedPosting,
  kind: 'alert_email' | 'mcp' = 'alert_email',
) {
  const [results, opps] = [await resultsOf(app, c), await opportunitiesOf(app, c)];
  const notes = await app.db.select().from(activities).all();
  expect((await arrive(app, c, [posting], kind)).stats).toMatchObject({
    duplicates: 1,
    linked: 0,
    inserted: 0,
  });
  expect(await resultsOf(app, c)).toEqual(results);
  expect(await opportunitiesOf(app, c)).toEqual(opps);
  expect(await app.db.select().from(activities).all()).toEqual(notes);
}

describe.each(SITES)('the same posting on %s, captured before its alert', (...site) => {
  it.each([
    [null, HERE],
    [HERE, THERE],
    [HERE, null],
    [HERE, HERE],
  ])('captured at %s, the alert at %s: a duplicate, by its id', async (at, alerted) => {
    const { app, a } = await boot();
    await capture(app, a, site, at);
    await expectDuplicate(app, a, alertOf(site, alerted));
  });

  it.each([...OPEN, 'closed'] as const)(
    'its opportunity at %s, its title drifted',
    async (stage) => {
      const { app, a } = await boot();
      const { opportunityId } = await capture(app, a, site, HERE);
      await move(app, opportunityId, stage);
      await expectDuplicate(app, a, alertOf(site, THERE, { title: 'Infrastructure (Platform)' }));
    },
  );

  it('through another source, its id in its link alone', async () => {
    const { app, a } = await boot();
    await capture(app, a, site, HERE);
    const posting = alertOf(site, THERE, { title: 'Infrastructure', externalId: 'opaque-1' });
    await expectDuplicate(app, a, posting, 'mcp');
  });

  // The capture's own result alone: its entry is written after, in a transaction of its own.
  it('while the capture is between its opportunity and its entry', async () => {
    const { app, a } = await boot();
    const pause = pauseAt('captureResolve.settled');
    const capturing = capture(app, a, site, HERE);
    await pause.reached;
    await expectDuplicate(app, a, alertOf(site, THERE, { title: 'Infrastructure' }));
    pause.release();
    await capturing;
  });

  it('with its entry deleted by the user', async () => {
    const { app, a } = await boot();
    await capture(app, a, site, HERE);
    await app.db.delete(activities).where(eq(activities.userId, a.userId)).run();
    await expectDuplicate(app, a, alertOf(site, THERE, { title: 'Infrastructure' }));
  });

  // Only a capture says it: an accepted result of another source does not, even with the id as a
  // capture stores it.
  it('accepted from another source with the same id, its title drifted: a card, as today', async () => {
    const { app, a } = await boot();
    const id = `${site[0]}:${site[1]}`;
    const own = await arrive(app, a, [alertOf(site, HERE, { externalId: id })], 'mcp');
    const accepted = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${own.inserted[0]!.id}/accept`,
      payload: {},
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const drifted = alertOf(site, THERE, { title: 'Infrastructure' });
    expect((await arrive(app, a, [drifted])).stats).toMatchObject({ inserted: 1, duplicates: 0 });
  });

  it('another id of a role with another title: a card', async () => {
    const { app, a } = await boot();
    await capture(app, a, site, HERE);
    const posting = another(site, THERE, { title: 'Infrastructure (Platform)' });
    expect((await arrive(app, a, [posting])).stats).toMatchObject({ linked: 0, inserted: 1 });
  });

  it('the same id text on another site: a card', async () => {
    const { app, a } = await boot();
    await capture(app, a, site, HERE);
    const posting = alertOf(site, THERE, {
      title: 'Infrastructure (Platform)',
      postingUrl: 'https://boards.example.com/jobs/1',
    });
    expect((await arrive(app, a, [posting], 'mcp')).stats.inserted).toBe(1);
  });

  // Found by the text of the address, refused by what it says.
  it('a capture whose address only contains the id: a card', async () => {
    const { app, a } = await boot();
    await capture(app, a, site, HERE);
    await app.db.delete(discoveryResults).run();
    await app.db
      .update(activities)
      .set({ externalUrl: `https://boards.example.com/jobs/${site[1]}` })
      .where(eq(activities.kind, 'capture'))
      .run();
    const posting = alertOf(site, THERE, { title: 'Infrastructure (Platform)' });
    expect((await arrive(app, a, [posting], 'mcp')).stats.inserted).toBe(1);
  });

  it.each(['its result', 'its entry'])("another user's capture, by %s: a card", async (by) => {
    const { app, a, b } = await boot();
    await capture(app, a, site, HERE);
    if (by === 'its result') await app.db.delete(activities).run();
    else await app.db.delete(discoveryResults).run();
    const posting = alertOf(site, THERE, { title: 'Infrastructure (Platform)' });
    expect((await arrive(app, b, [posting])).stats.inserted).toBe(1);
  });

  it.each(['its result', 'its entry'])('its opportunity dismissed, by %s: a card', async (by) => {
    const { app, a } = await boot();
    const { opportunityId } = await capture(app, a, site, HERE);
    await move(app, opportunityId, 'dismissed');
    if (by === 'its result') await app.db.delete(activities).run();
    else await app.db.delete(discoveryResults).run();
    const posting = alertOf(site, THERE, { title: 'Infrastructure (Platform)' });
    expect((await arrive(app, a, [posting])).stats.inserted).toBe(1);
  });

  it('its opportunity deleted: a card, as today', async () => {
    const { app, a } = await boot();
    const { opportunityId } = await capture(app, a, site, HERE);
    const del = await a.request({
      method: 'DELETE',
      url: `/api/v1/opportunities/${opportunityId}`,
    });
    expect(del.statusCode, del.body).toBeLessThan(300);
    const posting = alertOf(site, THERE, { title: 'Infrastructure (Platform)' });
    expect((await arrive(app, a, [posting])).stats.inserted).toBe(1);
  });
});

describe('a captured posting found by its timeline entry alone', () => {
  it('a second site’s capture reused the first site’s result', async () => {
    const { app, a } = await boot();
    const [linkedin, indeed] = SITES as [Site, Site];
    const first = await capture(app, a, linkedin, HERE);
    const second = await capture(app, a, indeed, HERE);
    expect(second.opportunityId).toBe(first.opportunityId);
    expect((await resultsOf(app, a)).map((r) => r.posting.externalId)).toEqual([
      'linkedin:1000000001',
    ]);
    await expectDuplicate(app, a, alertOf(indeed, THERE, { title: 'Infrastructure' }));
  });
});

/** A pending card that arrived before anything here could link it. */
async function card(app: FastifyInstance, c: TestClient, posting: NormalizedPosting) {
  const source = await ensureChannelSource(app.db, ctxOf(c), 'alert_email');
  const run = await createRun(app.db, ctxOf(c), { sourceId: source.id });
  const result = await insertResult(app.db, ctxOf(c), {
    runId: run.id,
    posting,
    dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
    resolution: 'needs_capture',
  });
  return result.id;
}

describe('a card already there', () => {
  const accept = (c: TestClient, id: string, payload: Record<string, unknown> = {}) =>
    c.request({ method: 'POST', url: `/api/v1/discovery/results/${id}/accept`, payload });

  it.each(OPEN)('of a role at %s: Accept goes to that opportunity', async (stage) => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    await move(app, id, stage);
    const cardId = await card(app, a, another(LINKEDIN, THERE));
    const res = await accept(a, cardId);
    expect([res.statusCode, res.json().opportunityId]).toEqual([200, id]);
    expect((await opportunitiesOf(app, a)).map((o) => [o.id, o.stage])).toEqual([[id, stage]]);
    expect(await entries(app, id)).toHaveLength(1);
  });

  // As before: the same location too is a question, which Attach answers (tl on #967).
  it.each([true, false])('at its own location it asks (another one too: %s)', async (both) => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    if (both) {
      const row = (await opportunitiesOf(app, a))[0]!;
      await app.db
        .insert(opportunities)
        .values({
          ...row,
          id: newId(),
          location: 'Chicago, IL',
          dedupeKey: dedupeKey(JOB.company, JOB.title, 'Chicago, IL'),
          createdAt: row.createdAt - 1000,
        })
        .run();
    }
    const cardId = await card(app, a, another(LINKEDIN, HERE));
    const res = await accept(a, cardId);
    expect([res.statusCode, res.json().error]).toEqual([
      409,
      { code: 'duplicate', existingId: id },
    ]);
    const attached = await accept(a, cardId, { attachTo: id });
    expect([attached.statusCode, attached.json().opportunityId]).toEqual([200, id]);
  });

  it.each(['applied', 'offer'] as const)('bulk accept of a role at %s', async (stage) => {
    const { app, a } = await boot();
    const id = await ORIGINS.captured(app, a);
    await move(app, id, stage);
    const cardId = await card(app, a, another(LINKEDIN, THERE));
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-accept',
      payload: { ids: [cardId] },
    });
    expect(res.json().results).toEqual([{ id: cardId, outcome: 'attached', existingId: id }]);
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
  });

  it.each(['applied', 'closed'] as const)(
    'the very posting captured, its opportunity at %s: Accept goes to it',
    async (stage) => {
      const { app, a } = await boot();
      const { opportunityId } = await capture(app, a, LINKEDIN, HERE);
      await move(app, opportunityId, stage);
      const cardId = await card(app, a, alertOf(LINKEDIN, THERE, { title: 'Infrastructure' }));
      const res = await accept(a, cardId);
      expect([res.statusCode, res.json().opportunityId]).toEqual([200, opportunityId]);
      expect((await opportunitiesOf(app, a)).map((o) => o.stage)).toEqual([stage]);
      expect(await entries(app, opportunityId)).toHaveLength(1);
    },
  );

  it('the very posting captured, its opportunity dismissed: its own', async () => {
    const { app, a } = await boot();
    const { opportunityId } = await capture(app, a, LINKEDIN, HERE);
    await move(app, opportunityId, 'dismissed');
    const cardId = await card(app, a, alertOf(LINKEDIN, THERE, { title: 'Infrastructure' }));
    const res = await accept(a, cardId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().opportunityId).not.toBe(opportunityId);
  });

  it('Create anyway still makes its own', async () => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    await move(app, id, 'applied');
    const cardId = await card(app, a, another(LINKEDIN, THERE));
    const res = await accept(a, cardId, { force: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(await opportunitiesOf(app, a)).toHaveLength(2);
  });

  it.each(['closed', 'dismissed'] as const)('of a role at %s: its own', async (stage) => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    await move(app, id, stage);
    const cardId = await card(app, a, another(LINKEDIN, THERE));
    const res = await accept(a, cardId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().opportunityId).not.toBe(id);
    expect(await opportunitiesOf(app, a)).toHaveLength(2);
  });
});

// The stored key strips the level at either end, so by key alone another level at the same place is
// the same job: it is not (tl on #985, the owner on #967).
describe('another level of the title at the very same place', () => {
  const PRINCIPAL = { title: `Principal ${JOB.title}` };
  const accept = (c: TestClient, id: string, payload: Record<string, unknown> = {}) =>
    c.request({ method: 'POST', url: `/api/v1/discovery/results/${id}/accept`, payload });
  const FEED = { postingUrl: 'https://boards.example.com/initech/1' };
  /** The other level, through a source nothing came from yet. */
  const principal = (over: Partial<NormalizedPosting> = {}): NormalizedPosting =>
    another(LINKEDIN, HERE, { ...PRINCIPAL, ...FEED, externalId: 'board-9', ...over });

  type Beside = (app: FastifyInstance, c: TestClient) => Promise<unknown>;
  const BESIDE: readonly (readonly [string, Beside])[] = [
    ['a captured opportunity', (app, c) => ORIGINS.captured(app, c)],
    ['an opportunity made by hand', (app, c) => ORIGINS['made by hand'](app, c)],
    [
      'an accepted result alone',
      async (app, c) => {
        const id = await ORIGINS.accepted(app, c);
        await app.db
          .update(opportunities)
          .set({ dedupeKey: null })
          .where(eq(opportunities.id, id))
          .run();
      },
    ],
    [
      'a dismissed result',
      async (app, c) => {
        const { inserted } = await arrive(app, c, [alertOf(LINKEDIN, HERE)]);
        const res = await c.request({
          method: 'POST',
          url: `/api/v1/discovery/results/${inserted[0]!.id}/dismiss`,
          payload: { reason: 'stale' },
        });
        expect(res.statusCode, res.body).toBe(200);
      },
    ],
    [
      'a linked result',
      async (app, c) => {
        const id = await ORIGINS['made by hand'](app, c);
        await app.db
          .update(opportunities)
          .set({ location: THERE, dedupeKey: dedupeKey(JOB.company, JOB.title, THERE) })
          .where(eq(opportunities.id, id))
          .run();
        expect((await arrive(app, c, [alertOf(LINKEDIN, HERE)])).stats.linked).toBe(1);
      },
    ],
  ];

  it.each(BESIDE)('beside %s: a card, and the same title is a duplicate', async (_what, beside) => {
    const { app, a } = await boot();
    await beside(app, a);
    const { stats, inserted } = await arrive(app, a, [principal()], 'ats_lever');
    expect(stats).toMatchObject({ inserted: 1, duplicates: 0, linked: 0 });
    expect(inserted[0]!.aiRationale).toBeNull();
    expect((await pendingOf(app, a)).map((r) => r.posting.title)).toEqual([PRINCIPAL.title]);
    // The control: the title that is there, through a source nothing came from yet.
    const same = principal({ title: JOB.title, externalId: 'board-10' });
    expect((await arrive(app, a, [same], 'mcp')).stats).toMatchObject({ duplicates: 1 });
  });

  it('beside a decided result stored without a title: a duplicate, as today', async () => {
    const { app, a } = await boot();
    const { inserted } = await arrive(app, a, [alertOf(LINKEDIN, HERE)]);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${inserted[0]!.id}/dismiss`,
      payload: { reason: 'stale' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const posting: Record<string, unknown> = { company: JOB.company };
    await app.db
      .update(discoveryResults)
      .set({ posting: posting as NormalizedPosting })
      .where(eq(discoveryResults.id, inserted[0]!.id))
      .run();
    expect((await arrive(app, a, [principal()], 'ats_lever')).stats).toMatchObject({
      duplicates: 1,
    });
  });

  it('beside a pending card of the same source: another card', async () => {
    const { app, a } = await boot();
    await arrive(app, a, [alertOf(LINKEDIN, HERE)]);
    const { stats } = await arrive(app, a, [another(LINKEDIN, HERE, PRINCIPAL)]);
    expect(stats).toMatchObject({ inserted: 1, duplicates: 0 });
    const again = another(LINKEDIN, HERE, { externalId: '1000000003', postingUrl: null });
    expect((await arrive(app, a, [again])).stats).toMatchObject({ duplicates: 1 });
  });

  it('beside a pending card of another source: new, not posted on several', async () => {
    const { app, a } = await boot();
    await arrive(app, a, [alertOf(LINKEDIN, HERE)]);
    const other = await arrive(app, a, [principal()], 'ats_lever');
    expect(other.inserted.map((r) => r.aiRationale)).toEqual([null]);
    const same = await arrive(
      app,
      a,
      [principal({ title: JOB.title, externalId: 'board-10' })],
      'mcp',
    );
    expect(same.inserted.map((r) => r.aiRationale)).toEqual([MULTI_POSTED_PREFIX]);
  });

  it.each([
    ['Senior', 'Sr'],
    ['Sr.', 'Senior'],
    ['Junior', 'Jr'],
  ])('%s and %s are one level: a duplicate', async (first, second) => {
    const { app, a } = await boot();
    const posting = (level: string, id: string) =>
      principal({ title: `${level} ${JOB.title}`, externalId: id });
    const { inserted } = await arrive(app, a, [posting(first, 'b-1')], 'ats_lever');
    expect((await accept(a, inserted[0]!.id)).statusCode).toBe(200);
    expect((await arrive(app, a, [posting(second, 'b-2')], 'mcp')).stats).toMatchObject({
      duplicates: 1,
    });
  });

  it('its next poll is a duplicate, pending and once made by Create anyway', async () => {
    const { app, a } = await boot();
    await ORIGINS['made by hand'](app, a);
    const { inserted } = await arrive(app, a, [principal()], 'ats_lever');
    let n = 0;
    // One source, another id each time: what finds it is its key and its title.
    const poll = () => arrive(app, a, [principal({ externalId: `board-2${(n += 1)}` })]);
    // Another source's first: posted on several. Then it is this source's own.
    expect((await poll()).stats).toMatchObject({ inserted: 1 });
    expect((await poll()).stats).toMatchObject({ duplicates: 1 });
    // Its key is the other level's, so Accept asks, and Create anyway makes it.
    const asked = await accept(a, inserted[0]!.id);
    expect([asked.statusCode, asked.json().error.code]).toEqual([409, 'duplicate']);
    const made = await accept(a, inserted[0]!.id, { force: true });
    expect(made.statusCode, made.body).toBe(200);
    expect(await opportunitiesOf(app, a)).toHaveLength(2);
    expect((await poll()).stats).toMatchObject({ duplicates: 1 });
    const elsewhere = principal({ externalId: 'board-12' });
    expect((await arrive(app, a, [elsewhere], 'mcp')).stats).toMatchObject({ duplicates: 1 });
  });

  // Only a holder of the same card is the question (tl on #985).
  it('a holder at another level is not the question: Accept goes to the open one of its title', async () => {
    const { app, a } = await boot();
    const make = async (title: string, location: string) =>
      (
        await a.request({
          method: 'POST',
          url: '/api/v1/opportunities',
          payload: { companyName: JOB.company, title, location, sourceKind: 'manual' },
        })
      ).json<{ id: string }>().id;
    const senior = `Senior ${JOB.title}`;
    await make(PRINCIPAL.title, HERE);
    const boston = await make(senior, THERE);
    const { inserted, stats } = await arrive(app, a, [principal({ title: senior })], 'ats_lever');
    // At ingest it is linked by itself; a card that was there before goes the same way at Accept.
    expect([stats.linked, inserted]).toEqual([1, []]);
    await app.db
      .update(discoveryResults)
      .set({ disposition: 'pending', opportunityId: null, rankSkipReason: null })
      .where(eq(discoveryResults.userId, a.userId))
      .run();
    const [card] = await pendingOf(app, a);
    const res = await accept(a, card!.id);
    expect([res.statusCode, res.json().opportunityId]).toEqual([200, boston]);
    expect(await opportunitiesOf(app, a)).toHaveLength(2);
  });
});

// Criterion 6 (tl on https://github.com/bgoleno/opportun/pull/980): as Accept does, with the same end.
describe.each(SITES)('a card on %s captured, another level tracked in its city', (...site) => {
  const SENIOR = `Senior ${JOB.title}`;
  const make = async (c: TestClient, title: string, location: string) => {
    const res = await c.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { companyName: JOB.company, title, location, sourceKind: 'manual' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  /** The open role in Boston: accepted from a result, or made by hand. */
  const IN_BOSTON = {
    async accepted(app: FastifyInstance, c: TestClient): Promise<string> {
      // A board's: no id of the site's, so nothing but its card says what it is.
      const id = await card(app, c, {
        ...JOB,
        title: SENIOR,
        location: THERE,
        postingUrl: 'https://boards.example.com/initech/b',
        externalId: 'board-b',
      });
      const res = await c.request({
        method: 'POST',
        url: `/api/v1/discovery/results/${id}/accept`,
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ opportunityId: string }>().opportunityId;
    },
    'made by hand': (_app: FastifyInstance, c: TestClient) => make(c, SENIOR, THERE),
  };

  it.each(['accepted', 'made by hand'] as const)(
    'its own level open in another city, %s: goes to that one',
    async (how) => {
      const { app, a } = await boot();
      const principal = await make(a, `Principal ${JOB.title}`, HERE);
      const boston = await IN_BOSTON[how](app, a);
      const cardId = await card(app, a, alertOf(site, HERE, { title: SENIOR }));
      const captured = await capture(app, a, site, HERE, { title: SENIOR });
      expect([captured.opportunityId, captured.resultId]).toEqual([boston, cardId]);
      expect((await opportunitiesOf(app, a)).map((o) => o.id).sort()).toEqual(
        [principal, boston].sort(),
      );
      expect(await pendingOf(app, a)).toEqual([]);
    },
  );

  it('its own level closed in the other city: its own, kept apart from the other level', async () => {
    const { app, a } = await boot();
    const principal = await make(a, `Principal ${JOB.title}`, HERE);
    const boston = await IN_BOSTON.accepted(app, a);
    await move(app, boston, 'closed');
    await card(app, a, alertOf(site, HERE, { title: SENIOR }));
    const captured = await capture(app, a, site, HERE, { title: SENIOR });
    expect([principal, boston]).not.toContain(captured.opportunityId);
    expect(await opportunitiesOf(app, a)).toHaveLength(3);
  });

  it('its own level attached by hand to the other level’s: that one refuses itself', async () => {
    const { app, a } = await boot();
    const principal = await make(a, `Principal ${JOB.title}`, HERE);
    const boston = await card(app, a, another(site, THERE, { title: SENIOR }));
    const attached = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${boston}/accept`,
      payload: { attachTo: principal },
    });
    expect(attached.statusCode, attached.body).toBe(200);
    await card(app, a, alertOf(site, HERE, { title: SENIOR }));
    const captured = await capture(app, a, site, HERE, { title: SENIOR });
    expect(captured.opportunityId).not.toBe(principal);
  });

  // The kept-apart holder is what #73 says: another posting on the site, under the card's own key.
  it.each(['accepted', 'made by hand'] as const)(
    'kept apart as another posting, the other city’s %s: not chained, as before',
    async (how) => {
      const { app, a } = await boot();
      const boston = await IN_BOSTON[how](app, a);
      const holder = (await capture(app, a, site, HERE, { title: SENIOR, location: HERE }))
        .opportunityId;
      expect(holder).not.toBe(boston);
      await card(app, a, another(site, HERE, { title: SENIOR }));
      const [siteId, , , otherId, otherUrl] = site;
      const captured = await capture(app, a, [siteId, otherId, otherUrl, '', ''], HERE, {
        title: SENIOR,
      });
      expect([boston, holder]).not.toContain(captured.opportunityId);
      expect(await opportunitiesOf(app, a)).toHaveLength(3);
    },
  );
});

// tl on #985: a lead of another location says nothing of who holds this one's key.
describe.each(SITES)('a capture on %s of a role with another location on it', (...site) => {
  it.each(['linked', 'accepted'] as const)('%s: goes to the role, no second one', async (how) => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    if (how === 'linked') {
      expect((await arrive(app, a, [another(site, THERE)])).stats.linked).toBe(1);
    } else {
      const cardId = await card(app, a, another(site, THERE));
      const res = await a.request({
        method: 'POST',
        url: `/api/v1/discovery/results/${cardId}/accept`,
        payload: {},
      });
      expect(res.json<{ opportunityId: string }>().opportunityId).toBe(id);
    }
    const captured = await capture(app, a, site, HERE);
    expect(captured.opportunityId).toBe(id);
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
  });

  it.each([
    ['without a location', null, 'own'],
    ['under this very key', HERE, 'own'],
    ['with its key released', THERE, 'released'],
  ] as const)('a lead %s still keeps it apart (#73)', async (_what, location, key) => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    const cardId = await card(app, a, another(site, location));
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${cardId}/accept`,
      payload: { attachTo: id },
    });
    expect(res.statusCode, res.body).toBe(200);
    if (key === 'released') {
      await app.db
        .update(discoveryResults)
        .set({ dedupeKey: null })
        .where(eq(discoveryResults.id, cardId))
        .run();
    }
    const captured = await capture(app, a, site, HERE);
    expect(captured.opportunityId).not.toBe(id);
  });
});

// sec on #985: nobody decided a linked posting, so it says nothing of who holds a key, nor of where a
// description came from.
describe.each(SITES)('a capture on %s of a role with a linked posting behind it', (...site) => {
  const [siteId, , , otherId, otherUrl] = site;
  const SECOND: Site = [siteId, otherId, otherUrl, '', ''];
  const NO_ID = { postingUrl: 'https://short.example.com/x', externalId: 'opaque-1' };

  it.each([
    ['without a location', null],
    ['with one', THERE],
  ])('another posting captured stays kept apart, the linked one %s', async (_what, location) => {
    const { app, a } = await boot();
    const first = await capture(app, a, site, HERE);
    const { stats } = await arrive(app, a, [alertOf(site, location, NO_ID)]);
    expect(stats.linked).toBe(1);
    const second = await capture(app, a, SECOND, HERE);
    expect([second.createdOpportunity, second.opportunityId === first.opportunityId]).toEqual([
      true,
      false,
    ]);
  });

  it('a lead of no id the user accepted still lets it attach, as before', async () => {
    const { app, a } = await boot();
    const first = await capture(app, a, site, HERE);
    const cardId = await card(app, a, alertOf(site, null, NO_ID));
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${cardId}/accept`,
      payload: { attachTo: first.opportunityId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await capture(app, a, SECOND, HERE)).opportunityId).toBe(first.opportunityId);
  });

  const OWN = 'My own words on it';
  const byHand = async (app: FastifyInstance, c: TestClient) => {
    const id = await ORIGINS['made by hand'](app, c);
    await app.db
      .update(opportunities)
      .set({ descriptionMd: OWN, descriptionFingerprint: null })
      .where(eq(opportunities.id, id))
      .run();
    return id;
  };
  const textOf = async (app: FastifyInstance, c: TestClient) =>
    (await opportunitiesOf(app, c)).map((o) => o.descriptionMd);

  it('a linked posting with the user’s very words is no stand-in: they stay', async () => {
    const { app, a } = await boot();
    const id = await byHand(app, a);
    const { stats } = await arrive(app, a, [another(site, THERE, { descriptionMd: OWN })]);
    expect(stats.linked).toBe(1);
    const captured = await capture(app, a, SECOND, THERE);
    expect(captured.opportunityId).toBe(id);
    expect(await textOf(app, a)).toEqual([OWN]);
  });

  it.each([null, 'no_key'] as const)(
    'one the user accepted with that text is (skip reason %s): the page replaces it',
    async (rankSkipReason) => {
      const { app, a } = await boot();
      const id = await byHand(app, a);
      const cardId = await card(app, a, another(site, THERE, { descriptionMd: OWN }));
      const res = await a.request({
        method: 'POST',
        url: `/api/v1/discovery/results/${cardId}/accept`,
        payload: { attachTo: id },
      });
      expect(res.statusCode, res.body).toBe(200);
      await app.db
        .update(discoveryResults)
        .set({ rankSkipReason })
        .where(eq(discoveryResults.id, cardId))
        .run();
      const captured = await capture(app, a, SECOND, THERE);
      expect(captured.opportunityId).toBe(id);
      expect(await textOf(app, a)).toEqual([PAGE]);
    },
  );
});

// The owner's decision on #971, for a place ingest linked: nobody decided it, so it holds its key only
// while its role is open (https://github.com/bgoleno/opportun/issues/990, qa on #985).
describe('a place linked while its role was open, posted again with a new id', () => {
  const [, , , linkedId, linkedUrl] = LINKEDIN;
  const LINKED = another(LINKEDIN, THERE);
  const again = (id = '1000000009'): NormalizedPosting => ({
    ...JOB,
    location: THERE,
    externalId: id,
    postingUrl: `https://www.linkedin.com/jobs/view/${id}`,
  });
  /** The role, with the place linked to it. */
  async function linked(app: FastifyInstance, c: TestClient): Promise<string> {
    const id = await ORIGINS['made by hand'](app, c);
    expect((await arrive(app, c, [LINKED])).stats.linked).toBe(1);
    return id;
  }
  const GONE: readonly (readonly [
    string,
    (app: FastifyInstance, c: TestClient, id: string) => Promise<unknown>,
  ])[] = [
    ['closed', (app, _c, id) => move(app, id, 'closed')],
    ['dismissed', (app, _c, id) => move(app, id, 'dismissed')],
    [
      'deleted',
      async (_app, c, id) => {
        const res = await c.request({ method: 'DELETE', url: `/api/v1/opportunities/${id}` });
        expect(res.statusCode, res.body).toBeLessThan(300);
      },
    ],
  ];

  it.each(GONE)('the role %s: a card, once', async (_how, ends) => {
    const { app, a } = await boot();
    await ends(app, a, await linked(app, a));
    const { stats, inserted } = await arrive(app, a, [again()]);
    expect(stats).toMatchObject({ inserted: 1, linked: 0, duplicates: 0 });
    expect(inserted[0]!.aiRationale).toBeNull(); // not posted on several: the linked one is no card
    // Its next poll, and another id of it from the same source.
    for (const next of [again(), again('1000000010')]) {
      expect((await arrive(app, a, [next])).stats).toMatchObject({ duplicates: 1, inserted: 0 });
    }
    expect(await pendingOf(app, a)).toHaveLength(1);
  });

  it.each(GONE)(
    'the role %s: the very posting that was linked brings no card',
    async (_how, ends) => {
      const { app, a } = await boot();
      await ends(app, a, await linked(app, a));
      expect((await arrive(app, a, [LINKED])).stats).toMatchObject({ duplicates: 1, inserted: 0 });
      expect(await pendingOf(app, a)).toEqual([]);
    },
  );

  it('the role closed, and the place captured into it: the same id brings no card', async () => {
    const { app, a } = await boot();
    const id = await linked(app, a);
    const page: Site = ['linkedin', linkedId, linkedUrl, '', ''];
    expect((await capture(app, a, page, THERE)).opportunityId).toBe(id);
    await move(app, id, 'closed');
    const other = another(LINKEDIN, THERE, { externalId: 'opaque-9' });
    expect((await arrive(app, a, [other], 'mcp')).stats).toMatchObject({ duplicates: 1 });
  });

  it.each(OPEN)('the role at %s: a duplicate, as before', async (stage) => {
    const { app, a } = await boot();
    await move(app, await linked(app, a), stage);
    expect((await arrive(app, a, [again()])).stats).toMatchObject({ duplicates: 1, inserted: 0 });
  });

  it('the role opened again: a duplicate again', async () => {
    const { app, a } = await boot();
    const id = await linked(app, a);
    await move(app, id, 'closed');
    await move(app, id, 'applied');
    expect((await arrive(app, a, [again()])).stats).toMatchObject({ duplicates: 1, inserted: 0 });
  });

  it.each(GONE)(
    'accepted by the user, not linked, the role %s: a duplicate, as before',
    async (_how, ends) => {
      const { app, a } = await boot();
      const id = await ORIGINS['made by hand'](app, a);
      const cardId = await card(app, a, LINKED);
      const res = await a.request({
        method: 'POST',
        url: `/api/v1/discovery/results/${cardId}/accept`,
        payload: { attachTo: id },
      });
      expect(res.statusCode, res.body).toBe(200);
      await ends(app, a, id);
      expect((await arrive(app, a, [again()])).stats).toMatchObject({ duplicates: 1, inserted: 0 });
    },
  );

  it('dismissed by the user beside it: a duplicate, as before', async () => {
    const { app, a } = await boot();
    const id = await linked(app, a);
    await move(app, id, 'closed');
    const { inserted } = await arrive(app, a, [again()]);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${inserted[0]!.id}/dismiss`,
      payload: { reason: 'stale' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await arrive(app, a, [again('1000000011')])).stats).toMatchObject({ duplicates: 1 });
  });

  it('accepted then: an opportunity of its own, and the place is a duplicate', async () => {
    const { app, a } = await boot();
    const closed = await linked(app, a);
    await move(app, closed, 'closed');
    const { inserted } = await arrive(app, a, [again()]);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${inserted[0]!.id}/accept`,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().opportunityId).not.toBe(closed);
    expect((await arrive(app, a, [again('1000000011')])).stats).toMatchObject({ duplicates: 1 });
  });

  it("another user's: theirs alone", async () => {
    const { app, a, b } = await boot();
    await move(app, await linked(app, a), 'closed');
    await linked(app, b);
    expect((await arrive(app, b, [again()])).stats).toMatchObject({ duplicates: 1, inserted: 0 });
    expect((await arrive(app, a, [again()])).stats).toMatchObject({ duplicates: 0, inserted: 1 });
  });
});

// tl on #995: the card that makes is captured where Accept would put it, not into the role that is over.
describe.each([
  ['linkedin', SITES[0] as Site, SITES[1] as Site],
  ['indeed', SITES[1] as Site, SITES[0] as Site],
] as const)('a capture on %s of a place linked while its role was open', (_site, mine, theirs) => {
  const [siteId, , , freshId, freshUrl] = mine;
  const FRESH: Site = [siteId, freshId, freshUrl, '', ''];
  const NO_ID = { postingUrl: 'https://short.example.com/x', externalId: 'opaque-1' };
  /** The linked posting: another site's, or one with no id that can be read. */
  const LINKED_AS = {
    'another site’s': another(theirs, THERE),
    'one of no id': another(theirs, THERE, NO_ID),
  };
  const HOWS = Object.keys(LINKED_AS) as (keyof typeof LINKED_AS)[];
  const CASES = HOWS.flatMap((how) =>
    (['closed', 'dismissed'] as const).flatMap((stage) =>
      [true, false].map((withCard) => [how, stage, withCard] as const),
    ),
  );
  async function role(
    app: FastifyInstance,
    c: TestClient,
    how: keyof typeof LINKED_AS,
    stage: OpportunityStage,
  ): Promise<string> {
    const id = await ORIGINS['made by hand'](app, c);
    expect((await arrive(app, c, [LINKED_AS[how]])).stats.linked).toBe(1);
    await move(app, id, stage);
    return id;
  }

  it.each(CASES)(
    'linked as %s, the role %s, a card there %s: its own',
    async (how, stage, withCard) => {
      const { app, a } = await boot();
      const over = await role(app, a, how, stage);
      if (withCard) expect((await arrive(app, a, [another(mine, THERE)])).stats.inserted).toBe(1);
      const before = (await opportunitiesOf(app, a)).find((o) => o.id === over);
      const captured = await capture(app, a, FRESH, THERE);
      expect(captured.createdOpportunity).toBe(true);
      expect(captured.opportunityId).not.toBe(over);
      const after = await opportunitiesOf(app, a);
      expect(after.find((o) => o.id === over)).toEqual(before);
      expect(after).toHaveLength(2);
      expect(await pendingOf(app, a)).toEqual([]);
    },
  );

  it.each(HOWS)('linked as %s, the role open: goes to it, as before', async (how) => {
    const { app, a } = await boot();
    const id = await role(app, a, how, 'applied');
    expect((await capture(app, a, FRESH, THERE)).opportunityId).toBe(id);
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
  });

  it.each(['closed', 'dismissed'] as const)(
    'the very posting linked, the role %s: goes to it, as before',
    async (stage) => {
      const { app, a } = await boot();
      const id = await ORIGINS['made by hand'](app, a);
      expect((await arrive(app, a, [another(mine, THERE)])).stats.linked).toBe(1);
      await move(app, id, stage);
      expect((await capture(app, a, FRESH, THERE)).opportunityId).toBe(id);
    },
  );

  it.each(['closed', 'dismissed'] as const)(
    'accepted by the user, not linked, the role %s: goes to it, as before',
    async (stage) => {
      const { app, a } = await boot();
      const id = await ORIGINS['made by hand'](app, a);
      const cardId = await card(app, a, LINKED_AS['another site’s']);
      const res = await a.request({
        method: 'POST',
        url: `/api/v1/discovery/results/${cardId}/accept`,
        payload: { attachTo: id },
      });
      expect(res.statusCode, res.body).toBe(200);
      await move(app, id, stage);
      expect((await capture(app, a, FRESH, THERE)).opportunityId).toBe(id);
    },
  );
});

describe('a role renamed since', () => {
  const rename = (app: FastifyInstance, id: string) =>
    app.db
      .update(opportunities)
      .set({ title: 'What I call it', dedupeKey: dedupeKey(JOB.company, 'What I call it', HERE) })
      .where(eq(opportunities.id, id))
      .run();

  it.each(['captured', 'accepted'] as const)(
    'is found by the result %s into it',
    async (origin) => {
      const { app, a } = await boot();
      const id = await ORIGINS[origin](app, a);
      await rename(app, id);
      expect((await arrive(app, a, [another(LINKEDIN, THERE)])).stats).toMatchObject({
        linked: 1,
        inserted: 0,
      });
      const linked = (await resultsOf(app, a)).filter((r) => r.rankSkipReason === 'linked');
      expect(linked.map((r) => r.opportunityId)).toEqual([id]);
    },
  );

  it('made by hand, nothing has the old title: a card', async () => {
    const { app, a } = await boot();
    await rename(app, await ORIGINS['made by hand'](app, a));
    expect((await arrive(app, a, [another(LINKEDIN, THERE)])).stats.inserted).toBe(1);
  });

  it('and is found by its new title', async () => {
    const { app, a } = await boot();
    await rename(app, await ORIGINS.accepted(app, a));
    const posting = another(LINKEDIN, THERE, { title: 'What I call it' });
    expect((await arrive(app, a, [posting])).stats.linked).toBe(1);
  });
});

describe('a board run', () => {
  it('links what it finds, whatever the pre-filter and the first run would hold back', async () => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    const posting: NormalizedPosting = {
      ...JOB,
      location: THERE,
      descriptionMd: PAGE,
      postingUrl: 'https://boards.example.com/initech/1',
      externalId: 'lv-1',
    };
    registerSource({
      kind: 'ats_lever',
      async *fetchPostings() {
        yield { posting, nextCursor: null };
      },
    });
    const source = await createSource(app.db, ctxOf(a), {
      kind: 'ats_lever',
      config: { org: 'initech' },
      roleTargetId: null,
    });
    const before = await opportunitiesOf(app, a);
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: source.id }, { userId: a.userId });
    await app.jobs.drain();
    await expectLinked(app, a, before, posting, 'Lever (ats_lever)');
    expect((await opportunitiesOf(app, a)).map((o) => o.id)).toEqual([id]);
    const run = await app.db
      .select()
      .from(discoveryRuns)
      .where(eq(discoveryRuns.sourceId, source.id))
      .get();
    expect(run?.stats).toMatchObject({ fetched: 1, linked: 1, inserted: 0 });
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
  });
});

describe('Capture posting, by hand', () => {
  it('answers that it is already there, naming the opportunity', async () => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    await move(app, id, 'applied');
    vi.mocked(runStructured).mockResolvedValueOnce({
      companyName: JOB.company,
      title: JOB.title,
      location: THERE,
      remote: null,
      compNote: null,
      descriptionMd: 'As pasted.',
      postingUrl: null,
    });
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/capture',
      payload: { text: 'Platform Engineer at Initech (Boston, MA)' },
    });
    expect([res.statusCode, res.json().error]).toMatchObject([
      409,
      { code: 'duplicate', existingId: id },
    ]);
    expect(await pendingOf(app, a)).toEqual([]);
    expect(await entries(app, id)).toHaveLength(1);
  });
});

describe('a denied company', () => {
  it('is dismissed as today, not linked', async () => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    const opp = (await opportunitiesOf(app, a)).find((o) => o.id === id)!;
    const res = await a.request({
      method: 'PATCH',
      url: `/api/v1/companies/${opp.companyId}`,
      payload: { status: 'denied' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await arrive(app, a, [another(LINKEDIN, THERE)])).stats).toMatchObject({
      suppressed: 1,
      linked: 0,
    });
    expect(await entries(app, id)).toEqual([]);
  });
});

describe('a hand-made pair', () => {
  it('links to the oldest', async () => {
    const { app, a } = await boot();
    const first = await ORIGINS['made by hand'](app, a);
    const second = newId();
    const row = (await opportunitiesOf(app, a))[0]!;
    await app.db
      .insert(opportunities)
      .values({
        ...row,
        id: second,
        location: 'Chicago, IL',
        dedupeKey: dedupeKey(JOB.company, JOB.title, 'Chicago, IL'),
        createdAt: row.createdAt + 1000,
      })
      .run();
    await arrive(app, a, [another(LINKEDIN, THERE)]);
    const linked = (await resultsOf(app, a)).filter((r) => r.rankSkipReason === 'linked');
    expect(linked.map((r) => r.opportunityId)).toEqual([first]);
  });
});

describe('ingest and what else writes the role, in each order', () => {
  const LATE = another(LINKEDIN, THERE);
  const remove = (c: TestClient, id: string) =>
    c.request({ method: 'DELETE', url: `/api/v1/opportunities/${id}` });
  const merge = (c: TestClient, id: string, otherId: string) =>
    c.request({ method: 'POST', url: `/api/v1/opportunities/${id}/merge`, payload: { otherId } });
  /** The same role, made by hand at a third place, newer or older than the first. */
  async function second(app: FastifyInstance, c: TestClient): Promise<string> {
    const res = await c.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: {
        companyName: JOB.company,
        title: JOB.title,
        location: 'Chicago, IL',
        sourceKind: 'manual',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }
  const linkedInto = async (app: FastifyInstance, c: TestClient) =>
    (await resultsOf(app, c)).filter((r) => r.rankSkipReason === 'linked');

  it('a delete first: a card, as the role is gone', async () => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    const [del, { stats }] = await heldApart(
      app,
      'opportunities.delete.locked',
      () => remove(a, id),
      () => arrive(app, a, [LATE]),
    );
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect(stats).toMatchObject({ inserted: 1, linked: 0 });
    expect(await pendingOf(app, a)).toHaveLength(1);
  });

  it('the link first: the delete takes the entry with it, and the result keeps no opportunity', async () => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    const [{ stats }, del] = await heldApart(
      app,
      'discovery.ingest.linking.locked',
      () => arrive(app, a, [LATE]),
      () => remove(a, id),
    );
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect(stats).toMatchObject({ inserted: 0, linked: 1 });
    expect((await linkedInto(app, a)).map((r) => r.opportunityId)).toEqual([null]);
    expect(await opportunitiesOf(app, a)).toEqual([]);
  });

  it.each(['merge', 'link'] as const)('a merge of the role, the %s first', async (first) => {
    const { app, a } = await boot();
    const gone = await ORIGINS['made by hand'](app, a);
    const kept = await second(app, a);
    const merging = () => merge(a, kept, gone);
    const linking = () => arrive(app, a, [LATE]);
    const [merged, { stats }] =
      first === 'merge'
        ? await heldApart(app, 'opportunities.merge.locked', merging, linking)
        : ((
            await heldApart(app, 'discovery.ingest.linking.locked', linking, merging)
          ).reverse() as [
            Awaited<ReturnType<typeof merging>>,
            Awaited<ReturnType<typeof linking>>,
          ]);
    expect(merged.statusCode, merged.body).toBe(200);
    expect(stats).toMatchObject({ inserted: 0, linked: 1 });
    expect((await opportunitiesOf(app, a)).map((o) => o.id)).toEqual([kept]);
    expect((await linkedInto(app, a)).map((r) => r.opportunityId)).toEqual([kept]);
    expect(
      (await entries(app, kept)).filter((e) => e.externalUrl === LATE.postingUrl),
    ).toHaveLength(1);
  });

  it.each(['capture', 'link'] as const)(
    'a capture of the arriving posting itself, the %s first',
    async (first) => {
      const { app, a } = await boot();
      const id = await ORIGINS['made by hand'](app, a);
      const [, , , otherId, otherUrl] = LINKEDIN;
      const page: Site = ['linkedin', otherId, otherUrl, '', ''];
      const capturing = () => capture(app, a, page, THERE);
      const linking = () => arrive(app, a, [LATE]);
      if (first === 'capture') {
        await heldApart(app, 'captureResolve.matched.locked', capturing, linking);
        // The capture has its own opportunity as B of #967 is not here; its posting is no card.
        expect(await pendingOf(app, a)).toEqual([]);
        return;
      }
      const [{ stats }, captured] = await heldApart(
        app,
        'discovery.ingest.linking.locked',
        linking,
        capturing,
      );
      expect(stats.linked).toBe(1);
      expect(captured.opportunityId).toBe(id);
      expect(await opportunitiesOf(app, a)).toHaveLength(1);
      expect(await pendingOf(app, a)).toEqual([]);
    },
  );

  it('an Accept that makes the role, held: the card it leaves is linked by its own Accept', async () => {
    const { app, a } = await boot();
    onSlowTransaction(() => undefined); // parked on purpose
    const { inserted } = await arrive(app, a, [alertOf(LINKEDIN, HERE)]);
    const accept = (id: string) =>
      a.request({ method: 'POST', url: `/api/v1/discovery/results/${id}/accept`, payload: {} });
    const pause = pauseAt('discovery.decide.locked');
    const accepting = accept(inserted[0]!.id);
    await pause.reached;
    const arriving = arrive(app, a, [LATE]);
    // Postgres: the role is not there to be seen, and nothing waits. SQLite: one writer at a time.
    if (testDialect === 'postgres') expect((await arriving).stats.inserted).toBe(1);
    pause.release();
    const res = await accepting;
    expect(res.statusCode, res.body).toBe(200);
    const { stats } = await arriving;
    if (testDialect === 'sqlite') expect(stats.linked).toBe(1);
    for (const r of await pendingOf(app, a)) {
      const late = await accept(r.id);
      expect(late.json().opportunityId).toBe(res.json().opportunityId);
    }
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
    expect(await pendingOf(app, a)).toEqual([]);
  });

  it.runIf(testDialect === 'postgres')('closed between the two looks: a card', async () => {
    const { app, a } = await boot();
    onSlowTransaction(() => undefined);
    const id = await ORIGINS['made by hand'](app, a);
    const pause = pauseAt('discovery.ingest.linking');
    const arriving = arrive(app, a, [LATE]);
    await pause.reached;
    await move(app, id, 'closed');
    pause.release();
    expect((await arriving).stats).toMatchObject({ inserted: 1, linked: 0 });
  });

  it('one wait for the user’s lock is bounded as the ingest lock’s is', async () => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    if (testDialect === 'sqlite') return; // the write gate is the one wait
    onSlowTransaction(() => undefined);
    const pause = pauseAt('opportunities.delete.locked');
    const deleting = remove(a, id);
    await pause.reached;
    const source = await ensureChannelSource(app.db, ctxOf(a), 'manual');
    // Ended by that bound (55P03), not by the statement's, 30 s (57014): the code says which, where a
    // busy host's clock could not (#948).
    const ended = await insertLeads(app.db, ctxOf(a), [LATE], source.id, undefined, {
      lockTimeoutMs: 200,
    }).catch((err: unknown) => err);
    expect(isLockTimeout(ended), String(ended)).toBe(true);
    pause.release();
    expect((await deleting).statusCode).toBeLessThan(300);
  });
});

describe('a linked posting is nobody’s decision', () => {
  it('leaves the pre-filter’s recall and the suggestions’ evidence as they were', async () => {
    const { app, a } = await boot();
    const target = await a.request({
      method: 'POST',
      url: '/api/v1/role-targets',
      payload: { name: 'Platform', titleFamily: 'Platform Engineer' },
    });
    expect(target.statusCode, target.body).toBe(201);
    await ORIGINS['made by hand'](app, a);
    const recall = await prefilterRecall(app.db, ctxOf(a));
    const evidence = await pipelineText(app.db, ctxOf(a));
    const posting = another(LINKEDIN, THERE, {
      externalId: 'lv-1',
      postingUrl: 'https://boards.example.com/initech/1',
      descriptionMd: PAGE,
    });
    expect((await arrive(app, a, [posting], 'ats_lever')).stats.linked).toBe(1);
    expect(await prefilterRecall(app.db, ctxOf(a))).toEqual(recall);
    expect(await pipelineText(app.db, ctxOf(a))).toBe(evidence);
    // An accept counts, so the two above can move.
    await app.db
      .update(discoveryResults)
      .set({ rankSkipReason: null })
      .where(eq(discoveryResults.userId, a.userId))
      .run();
    expect((await prefilterRecall(app.db, ctxOf(a))).positives).toBe(recall.positives + 1);
    expect(await pipelineText(app.db, ctxOf(a))).not.toBe(evidence);
  });

  it('is kept by a purge of discovery results', async () => {
    const { app, a } = await boot();
    await ORIGINS['made by hand'](app, a);
    await arrive(app, a, [another(LINKEDIN, THERE)]);
    expect((await previewPurge(app.db, ctxOf(a))).discoveryResults).toBe(0);
  });

  it('is not unsuppressed while its opportunity is open', async () => {
    const { app, a } = await boot();
    const id = await ORIGINS['made by hand'](app, a);
    await arrive(app, a, [another(LINKEDIN, THERE)]);
    const [linked] = (await resultsOf(app, a)).filter((r) => r.rankSkipReason === 'linked');
    const unsuppress = () =>
      a.request({ method: 'POST', url: `/api/v1/discovery/results/${linked!.id}/unsuppress` });
    const refused = await unsuppress();
    expect([refused.statusCode, refused.json().error.code]).toEqual([
      409,
      'opportunity_still_active',
    ]);
    await move(app, id, 'dismissed');
    expect((await unsuppress()).statusCode).toBe(200);
    // Another id: the same one from the same source stays a duplicate, as today.
    const next = another(LINKEDIN, THERE, { externalId: '1000000009', postingUrl: null });
    expect((await arrive(app, a, [next])).stats).toMatchObject({
      linked: 0,
      inserted: 1,
    });
  });
});
