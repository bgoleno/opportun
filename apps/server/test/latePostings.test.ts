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
import { onSlowTransaction } from '../src/db/gate';
import { pipelineText } from '../src/jobs/companySuggest';
import { previewPurge } from '../src/jobs/purge';
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

describe('a card already there', () => {
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
    const began = performance.now();
    await expect(
      insertLeads(app.db, ctxOf(a), [LATE], source.id, undefined, { lockTimeoutMs: 200 }),
    ).rejects.toThrow();
    expect(performance.now() - began).toBeLessThan(5000);
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
    expect((await arrive(app, a, [another(LINKEDIN, THERE)])).stats).toMatchObject({
      linked: 0,
    });
  });
});
