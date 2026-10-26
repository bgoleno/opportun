// Review queue API (Task 7, FR-D3, FR-O7, FR-O10): list, accept (create or attach), dismiss,
// opportunity merge, and the discovery sources API, each isolated between users.
import { dedupeKey, newId, type NormalizedPosting } from '@opportun/core';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerSource, resetSources } from '../src/adapters/discoverySource';
import {
  activities,
  attachments,
  communications,
  dismissalFeedback,
  jobs,
  nextSteps,
  opportunities,
  resumes,
  stageHistory,
} from '../src/db/schema';
import { DISCOVERY_RUN_KIND, MULTI_POSTED_PREFIX } from '../src/jobs/discoveryRun';
import { enqueue } from '../src/jobs/runner';
import {
  createRun,
  createSource,
  insertResult,
  listResults,
  listRuns,
  setDisposition,
  setRanking,
} from '../src/repos/discovery';
import { mergeOpportunities } from '../src/repos/opportunities';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';
import { withFailingWrite } from './db';
import { rawRun } from '../src/db/client';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

const POSTING: NormalizedPosting = {
  company: 'Initech',
  title: 'Staff Platform Engineer',
  descriptionMd: 'Build the platform.',
  postingUrl: 'https://boards.example.com/initech/1',
  location: 'Austin, TX',
  remote: false,
  compNote: '$200k',
  externalId: 'gh-1',
};

/** A valid MCP source config (https transport, so any user may create it). */
const MCP_CONFIG = {
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  tool: 'jobs',
  queryArgs: {},
  mapping: { company: 'company', title: 'title' },
  itemsPath: '',
};

/** Stores a pending result for `c` the way the engine does (one source and run per call). */
async function seedResult(
  app: FastifyInstance,
  c: TestClient,
  posting: NormalizedPosting = POSTING,
  opts: { kind?: 'ats_lever' | 'mcp'; score?: number; rationale?: string } = {},
): Promise<string> {
  const ctx = ctxOf(c);
  const kind = opts.kind ?? 'ats_lever';
  const src = await createSource(app.db, ctx, {
    kind,
    config: kind === 'mcp' ? MCP_CONFIG : { org: 'initech' },
  });
  const run = await createRun(app.db, ctx, { sourceId: src.id });
  const res = await insertResult(app.db, ctx, {
    runId: run.id,
    posting,
    // The real 3-segment company|title|location key (@opportun/core), the same shape every
    // real ingestion path writes (discoveryRun.ts), not an ad-hoc shortcut: issue #226's chain
    // lookup matches on this field as a LIKE prefix, which only works against the real format.
    dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
    resolution: 'full',
  });
  if (opts.score !== undefined) {
    await setRanking(app.db, ctx, res.id, {
      aiScore: opts.score,
      aiRationale: opts.rationale ?? 'ok',
    });
  }
  return res.id;
}

async function testResultRoute(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/__test/discovery-result', async (req) => {
    const ctx = app.requireUser(req);
    const src = await createSource(app.db, ctx, { kind: 'manual', config: {} });
    const run = await createRun(app.db, ctx, { sourceId: src.id });
    return {
      id: (
        await insertResult(app.db, ctx, {
          runId: run.id,
          posting: { ...POSTING, title: `Role ${newId()}` },
          dedupeKey: null,
          resolution: 'full',
        })
      ).id,
    };
  });
}
const createTestResult = async (c: TestClient): Promise<string> =>
  (await c.request({ method: 'POST', url: '/api/v1/__test/discovery-result', payload: {} })).json()
    .id;

describe('GET /discovery/results', () => {
  it('lists pending results best score first with posting, score, rationale, resolution and source kind', async () => {
    const { app, a, b } = await boot();
    await seedResult(app, a, { ...POSTING, title: 'Low' }, { score: 20 });
    await seedResult(app, a, { ...POSTING, title: 'Unranked' });
    await seedResult(app, a, { ...POSTING, title: 'High' }, { score: 90, rationale: 'Great fit.' });
    await seedResult(
      app,
      a,
      { ...POSTING, title: 'Capped' },
      {
        kind: 'mcp',
        score: 40,
        rationale: `${MULTI_POSTED_PREFIX} Great fit.`,
      },
    );
    await seedResult(app, b, { ...POSTING, title: 'Not yours' }, { score: 99 });

    const res = await a.request({
      method: 'GET',
      url: '/api/v1/discovery/results?disposition=pending',
    });
    expect(res.statusCode, res.body).toBe(200);
    const { items, total } = res.json();
    expect(total).toBe(4);
    expect(items.map((i: { posting: { title: string } }) => i.posting.title)).toEqual([
      'High',
      'Capped',
      'Low',
      'Unranked',
    ]);
    expect(items[0]).toMatchObject({
      aiScore: 90,
      aiRationale: 'Great fit.',
      resolution: 'full',
      disposition: 'pending',
      sourceKind: 'ats_lever',
      posting: { company: 'Initech', postingUrl: POSTING.postingUrl },
    });
    expect(items[1]).toMatchObject({ sourceKind: 'mcp', aiScore: 40 });

    const asc = await a.request({
      method: 'GET',
      url: '/api/v1/discovery/results?sort=ai_score&limit=1',
    });
    expect(asc.json().items[0].posting.title).toBe('Unranked');
    expect(asc.json().total).toBe(4);
    const bad = await a.request({ method: 'GET', url: '/api/v1/discovery/results?sort=posting' });
    expect(bad.statusCode).toBe(400);
  });

  assertIsolated({
    name: 'discovery results',
    setup: testResultRoute,
    create: createTestResult,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/discovery/results/${id}` }),
  });
});

describe('POST /discovery/results/:id/accept', () => {
  it('creates exactly one opportunity, and a re-accept is a 409 (Review Focus 3)', async () => {
    const { app, a } = await boot();
    const target = (
      await a.request({
        method: 'POST',
        url: '/api/v1/role-targets',
        payload: { name: 'Platform', titleFamily: 'Platform Engineering' },
      })
    ).json().id;
    const ctx = ctxOf(a);
    const src = await createSource(app.db, ctx, {
      kind: 'ats_lever',
      config: { org: 'initech' },
      roleTargetId: target,
    });
    const run = await createRun(app.db, ctx, { sourceId: src.id });
    const id = (
      await insertResult(app.db, ctx, {
        runId: run.id,
        posting: POSTING,
        dedupeKey: 'k',
        resolution: 'full',
      })
    ).id;

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/accept`,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id, disposition: 'accepted' });
    const oppId = res.json().opportunityId;
    const opp = (await a.request({ method: 'GET', url: `/api/v1/opportunities/${oppId}` })).json();
    expect(opp).toMatchObject({
      companyName: 'Initech',
      title: 'Staff Platform Engineer',
      descriptionMd: 'Build the platform.',
      postingUrl: POSTING.postingUrl,
      location: 'Austin, TX',
      remote: false,
      compNote: '$200k',
      sourceKind: 'discovery',
      sourceRef: id,
      stage: 'discovered',
      roleTargetId: target,
    });

    const again = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/accept`,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: { code: 'duplicate', existingId: oppId } });
    expect(await app.db.select().from(opportunities).all()).toHaveLength(1);
  });

  it('a dedupe 409 names the existing opportunity and keeps the result pending', async () => {
    const { app, a } = await boot();
    const existing = await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: {
        companyName: 'Initech',
        title: 'Platform Engineer',
        location: 'Austin, TX',
        sourceKind: 'manual',
      },
    });
    const existingId = existing.json().id;
    const id = await seedResult(app, a);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/accept`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'duplicate', existingId } });
    const after = (
      await a.request({ method: 'GET', url: `/api/v1/discovery/results/${id}` })
    ).json();
    expect(after).toMatchObject({ disposition: 'pending', opportunityId: null });
    expect(await app.db.select().from(opportunities).all()).toHaveLength(1);

    // force creates a second, un-keyed opportunity (the existing create path's semantics).
    const forced = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/accept`,
      payload: { force: true },
    });
    expect(forced.statusCode).toBe(200);
    const rows = await app.db.select().from(opportunities).all();
    expect(rows).toHaveLength(2);
    // The forced row knows which one it overrode (#9), the same as the manual-create path:
    // discovery-accept's force goes through the same createOpportunity.
    expect(rows.find((r) => r.id !== existingId)?.possibleDuplicateOf).toBe(existingId);
  });

  it('accept with attachTo links the result and adds a link activity instead of creating', async () => {
    const { app, a } = await boot();
    const opp = await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: {
        companyName: 'Initech',
        title: 'Platform Engineer',
        sourceKind: 'manual',
        priority: 1,
      },
    });
    const oppId = opp.json().id;
    const id = await seedResult(app, a, POSTING, { kind: 'mcp' });
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/accept`,
      payload: { attachTo: oppId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ disposition: 'accepted', opportunityId: oppId });
    expect(await app.db.select().from(opportunities).all()).toHaveLength(1);
    const links = await app.db
      .select()
      .from(activities)
      .where(and(eq(activities.opportunityId, oppId), eq(activities.kind, 'link')))
      .all();
    expect(links).toHaveLength(1);
    expect(links[0]!.title).toContain('mcp');
    expect(links[0]!.externalUrl).toBe(POSTING.postingUrl);
    // Nothing about the opportunity is lowered or changed.
    const after = (
      await a.request({ method: 'GET', url: `/api/v1/opportunities/${oppId}` })
    ).json();
    expect(after).toMatchObject({ priority: 1, stage: 'discovered', title: 'Platform Engineer' });
  });

  it("cannot attach to another user's opportunity", async () => {
    const { app, a, b } = await boot();
    const bOpp = (
      await b.request({
        method: 'POST',
        url: '/api/v1/opportunities',
        payload: { companyName: 'Globex', title: 'PM', sourceKind: 'manual' },
      })
    ).json().id;
    const id = await seedResult(app, a);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/accept`,
      payload: { attachTo: bOpp },
    });
    expect(res.statusCode).toBe(404);
    expect(await app.db.select().from(activities).all()).toHaveLength(0);
  });

  assertIsolated({
    name: 'discovery result accept',
    setup: testResultRoute,
    create: createTestResult,
    read: (c, id) =>
      c.request({ method: 'POST', url: `/api/v1/discovery/results/${id}/accept`, payload: {} }),
  });
});

describe('POST /discovery/results/bulk-accept (#184)', () => {
  it('accepts each pending id into its own opportunity and reports accepted per item', async () => {
    const { app, a } = await boot();
    const id1 = await seedResult(app, a, { ...POSTING, title: 'Role One' });
    const id2 = await seedResult(app, a, { ...POSTING, title: 'Role Two' });
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-accept',
      payload: { ids: [id1, id2] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { results } = res.json();
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: id1, outcome: 'accepted' }),
        expect.objectContaining({ id: id2, outcome: 'accepted' }),
      ]),
    );
    expect(await app.db.select().from(opportunities).all()).toHaveLength(2);
  });

  it('reports a dedupe conflict as duplicate with the existing id, never as a generic error', async () => {
    const { app, a } = await boot();
    const existing = (
      await a.request({
        method: 'POST',
        url: '/api/v1/opportunities',
        payload: {
          companyName: 'Initech',
          title: 'Platform Engineer',
          location: 'Austin, TX',
          sourceKind: 'manual',
        },
      })
    ).json().id;
    const id = await seedResult(app, a);
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-accept',
      payload: { ids: [id] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results).toEqual([{ id, outcome: 'duplicate', existingId: existing }]);
    // force is never implicitly passed through the bulk path: no second opportunity is created.
    expect(await app.db.select().from(opportunities).all()).toHaveLength(1);
  });

  it('reports already-accepted, not-found, and a valid id in the same batch independently', async () => {
    const { app, a } = await boot();
    const accepted = await seedResult(app, a, { ...POSTING, title: 'Already Accepted' });
    await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${accepted}/accept`,
      payload: {},
    });
    const pending = await seedResult(app, a, { ...POSTING, title: 'Still Pending' });
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-accept',
      payload: { ids: [accepted, 'not-a-real-id', pending] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: accepted, outcome: 'duplicate' }),
        expect.objectContaining({ id: 'not-a-real-id', outcome: 'not_found' }),
        expect.objectContaining({ id: pending, outcome: 'accepted' }),
      ]),
    );
  });

  it('rejects a batch over the per-request cap', async () => {
    const { a } = await boot();
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-accept',
      payload: { ids },
    });
    expect(res.statusCode).toBe(400);
  });

  it("cannot accept another user's result (isolated per id, not just per request)", async () => {
    const { app, a, b } = await boot();
    const id = await seedResult(app, b);
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-accept',
      payload: { ids: [id] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results).toEqual([{ id, outcome: 'not_found' }]);
  });
});

describe('POST /discovery/results/bulk-accept: location-group chaining (#209)', () => {
  /** Three locations of the same role, detected as a group purely from each result's own
   *  stored dedupeKey, the way a real "select all N matching" selection (every pending id,
   *  no client-side grouping knowledge) would reach this route. */
  async function seedGroup(
    app: FastifyInstance,
    c: TestClient,
    scores: [number, number, number] = [50, 90, 70],
  ): Promise<[string, string, string]> {
    const ids = await Promise.all(
      ['Austin, TX', 'Remote', 'New York, NY'].map((location, i) =>
        seedResult(app, c, { ...POSTING, location }, { score: scores[i] }),
      ),
    );
    return ids as [string, string, string];
  }

  it('accepts the best-scoring member and attaches the rest to the one opportunity it creates', async () => {
    const { app, a } = await boot();
    const [low, best, mid] = await seedGroup(app, a, [50, 90, 70]);
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-accept',
      payload: { ids: [low, best, mid] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const opps = await app.db.select().from(opportunities).all();
    expect(opps).toHaveLength(1);
    const oppId = opps[0]!.id;
    expect(res.json().results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: best, outcome: 'accepted' }),
        expect.objectContaining({ id: low, outcome: 'attached', existingId: oppId }),
        expect.objectContaining({ id: mid, outcome: 'attached', existingId: oppId }),
      ]),
    );
  });

  it("attaches every group member to the EXISTING opportunity when the primary's own accept is a dedupe conflict", async () => {
    const { app, a } = await boot();
    // "Remote" to match seedGroup's highest-scoring (so primary) member's own location below:
    // a hard dedupe conflict needs the full company|title|location key to collide, not just
    // company+title, or createOpportunity treats it as a softer possible-duplicate instead and
    // creates a second, real opportunity rather than refusing with a 409.
    const existing = (
      await a.request({
        method: 'POST',
        url: '/api/v1/opportunities',
        payload: {
          companyName: POSTING.company,
          title: POSTING.title,
          location: 'Remote',
          sourceKind: 'manual',
        },
      })
    ).json().id;
    const [low, best, mid] = await seedGroup(app, a, [50, 90, 70]);
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-accept',
      payload: { ids: [low, best, mid] },
    });
    expect(res.statusCode, res.body).toBe(200);
    // force is never implicitly passed through the bulk path (#184): no second opportunity.
    expect(await app.db.select().from(opportunities).all()).toHaveLength(1);
    expect(res.json().results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: best, outcome: 'duplicate', existingId: existing }),
        expect.objectContaining({ id: low, outcome: 'attached', existingId: existing }),
        expect.objectContaining({ id: mid, outcome: 'attached', existingId: existing }),
      ]),
    );
  });

  it('leaves a singleton (no other pending member shares its role) independent, unaffected by a group elsewhere in the same batch', async () => {
    const { app, a } = await boot();
    const [low, best, mid] = await seedGroup(app, a, [50, 90, 70]);
    const alone = await seedResult(app, a, { ...POSTING, title: 'An Unrelated Role' });
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-accept',
      payload: { ids: [low, best, mid, alone] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await app.db.select().from(opportunities).all()).toHaveLength(2);
    expect(res.json().results).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: alone, outcome: 'accepted' })]),
    );
  });

  it('reports an already-accepted or missing id in a group independently, without disturbing the rest of the chain', async () => {
    const { app, a } = await boot();
    const [low, best, mid] = await seedGroup(app, a, [50, 90, 70]);
    const lowAccept = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${low}/accept`,
      payload: {},
    });
    const lowOppId = lowAccept.json().opportunityId;
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-accept',
      payload: { ids: [low, best, mid, 'not-a-real-id'] },
    });
    expect(res.statusCode, res.body).toBe(200);
    // Before issue #226's fix, best (today's primary by score) would start a second
    // opportunity here, since the group-detection above only sees best+mid, not low's earlier,
    // independent accept. Now it looks for a live, eligible opportunity sharing the group key
    // before creating one, finds low's, and both best and mid attach to it: one opportunity,
    // not two.
    expect(await app.db.select().from(opportunities).all()).toHaveLength(1);
    const results = res.json().results as { id: string; outcome: string; existingId?: string }[];
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get('not-a-real-id')).toEqual({ id: 'not-a-real-id', outcome: 'not_found' });
    expect(byId.get(low)?.outcome).toBe('duplicate'); // already accepted before the bulk request
    expect(byId.get(best)).toMatchObject({ outcome: 'attached', existingId: lowOppId });
    expect(byId.get(mid)).toMatchObject({ outcome: 'attached', existingId: lowOppId });
  });

  // Issue #226: the client (api.ts's bulkRequest) splits a selection over MAX_BULK_SIZE into
  // separate sequential requests with no memory of each other. A location group split across
  // that boundary used to be grouped correctly within whichever chunk(s) its members land in,
  // but not across chunks -- confirmed by reproducing it before fixing it, not just inferred
  // from reading the route's own comment. acceptIntoOpportunity's chain lookup (independent of
  // request boundaries) is what makes this pass now.
  it(
    "a group split across two sequential requests, as the client's own MAX_BULK_SIZE " +
      'chunking would split it, still ends up as one opportunity (#226)',
    async () => {
      const { app, a } = await boot();
      const [low, best, mid] = await seedGroup(app, a, [50, 90, 70]);
      // Chunk 1: low+best land together (best is the primary, low attaches to its opportunity).
      const chunk1 = await a.request({
        method: 'POST',
        url: '/api/v1/discovery/results/bulk-accept',
        payload: { ids: [low, best] },
      });
      expect(chunk1.statusCode, chunk1.body).toBe(200);
      // low (not best) carries existingId: best's own outcome is 'accepted', which never does
      // (existingId means "already existed", the opposite claim); low's 'attached' does.
      const opp1 = chunk1.json().results.find((r: { id: string }) => r.id === low)?.existingId;
      // Chunk 2: mid arrives alone, in a separate request with no memory of chunk 1's group.
      const chunk2 = await a.request({
        method: 'POST',
        url: '/api/v1/discovery/results/bulk-accept',
        payload: { ids: [mid] },
      });
      expect(chunk2.statusCode, chunk2.body).toBe(200);
      // One role, three locations, one bulk selection: should still be one opportunity, with
      // mid attached to it the same way low was.
      expect(await app.db.select().from(opportunities).all()).toHaveLength(1);
      expect(chunk2.json().results).toEqual([
        expect.objectContaining({ id: mid, outcome: 'attached', existingId: opp1 }),
      ]);
    },
  );
});

describe('POST /discovery/results/:id/dismiss', () => {
  it('dismisses and writes a dismissal feedback row tied to the result', async () => {
    const { app, a } = await boot();
    const id = await seedResult(app, a);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/dismiss`,
      payload: { reason: 'seniority', note: 'Too junior.' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id, disposition: 'dismissed' });
    const rows = await app.db.select().from(dismissalFeedback).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: a.userId,
      kind: 'dismissal',
      resultId: id,
      opportunityId: null,
      reason: 'seniority',
      note: 'Too junior.',
    });
    const again = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/dismiss`,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    const bad = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${await seedResult(app, a, { ...POSTING, title: 'x' })}/dismiss`,
      payload: { reason: 'boring' },
    });
    expect(bad.statusCode).toBe(400);
  });

  assertIsolated({
    name: 'discovery result dismiss',
    setup: testResultRoute,
    create: createTestResult,
    read: (c, id) =>
      c.request({ method: 'POST', url: `/api/v1/discovery/results/${id}/dismiss`, payload: {} }),
  });
});

describe('POST /discovery/results/bulk-dismiss (#184)', () => {
  it('dismisses each pending id with the given reason, one feedback row per id', async () => {
    const { app, a } = await boot();
    const id1 = await seedResult(app, a, { ...POSTING, title: 'Role One' });
    const id2 = await seedResult(app, a, { ...POSTING, title: 'Role Two' });
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-dismiss',
      payload: { ids: [id1, id2], reason: 'not_interested' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: id1, outcome: 'dismissed' }),
        expect.objectContaining({ id: id2, outcome: 'dismissed' }),
      ]),
    );
    const rows = await app.db.select().from(dismissalFeedback).all();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ reason: 'not_interested' });
    const after1 = (
      await a.request({ method: 'GET', url: `/api/v1/discovery/results/${id1}` })
    ).json();
    expect(after1).toMatchObject({ disposition: 'dismissed' });
  });

  it('reports already-decided and not-found independently of a valid id in the same batch', async () => {
    const { app, a } = await boot();
    const alreadyDismissed = await seedResult(app, a, { ...POSTING, title: 'Already Dismissed' });
    await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${alreadyDismissed}/dismiss`,
      payload: { reason: 'stale' },
    });
    const pending = await seedResult(app, a, { ...POSTING, title: 'Still Pending' });
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-dismiss',
      payload: { ids: [alreadyDismissed, 'not-a-real-id', pending], reason: 'not_interested' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: alreadyDismissed, outcome: 'already_decided' }),
        expect.objectContaining({ id: 'not-a-real-id', outcome: 'not_found' }),
        expect.objectContaining({ id: pending, outcome: 'dismissed' }),
      ]),
    );
    // The already-dismissed result's original reason is untouched by the bulk request.
    const rows = await app.db
      .select()
      .from(dismissalFeedback)
      .where(eq(dismissalFeedback.resultId, alreadyDismissed))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'stale' });
  });

  it('rejects a batch over the per-request cap', async () => {
    const { a } = await boot();
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-dismiss',
      payload: { ids, reason: 'not_interested' },
    });
    expect(res.statusCode).toBe(400);
  });

  it("cannot dismiss another user's result", async () => {
    const { app, a, b } = await boot();
    const id = await seedResult(app, b);
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-dismiss',
      payload: { ids: [id], reason: 'not_interested' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results).toEqual([{ id, outcome: 'not_found' }]);
  });
});

describe('POST /discovery/results/bulk-undo-dismiss (#184)', () => {
  it('restores dismissed ids to pending and deletes their feedback rows', async () => {
    const { app, a } = await boot();
    const id1 = await seedResult(app, a, { ...POSTING, title: 'Role One' });
    const id2 = await seedResult(app, a, { ...POSTING, title: 'Role Two' });
    await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-dismiss',
      payload: { ids: [id1, id2], reason: 'not_interested' },
    });
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-undo-dismiss',
      payload: { ids: [id1, id2] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: id1, outcome: 'restored' }),
        expect.objectContaining({ id: id2, outcome: 'restored' }),
      ]),
    );
    const after1 = (
      await a.request({ method: 'GET', url: `/api/v1/discovery/results/${id1}` })
    ).json();
    expect(after1).toMatchObject({ disposition: 'pending', opportunityId: null });
    expect(await app.db.select().from(dismissalFeedback).all()).toHaveLength(0);
  });

  it('leaves an id alone and reports already_decided when it moved on since the dismiss', async () => {
    const { app, a } = await boot();
    const movedOn = await seedResult(app, a, { ...POSTING, title: 'Moved On' });
    await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-dismiss',
      payload: { ids: [movedOn], reason: 'not_interested' },
    });
    // The user accepted it after the fact (e.g. via unsuppress then accept), so it is no
    // longer the dismissed-by-that-batch result an undo should touch.
    await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${movedOn}/unsuppress`,
      payload: {},
    });
    await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${movedOn}/accept`,
      payload: {},
    });
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-undo-dismiss',
      payload: { ids: [movedOn] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results).toEqual([{ id: movedOn, outcome: 'already_decided' }]);
    const after = (
      await a.request({ method: 'GET', url: `/api/v1/discovery/results/${movedOn}` })
    ).json();
    expect(after).toMatchObject({ disposition: 'accepted' });
  });

  it('reports not-found for an unknown id', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/results/bulk-undo-dismiss',
      payload: { ids: ['not-a-real-id'] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results).toEqual([{ id: 'not-a-real-id', outcome: 'not_found' }]);
  });
});

describe('POST /opportunities/:id/merge', () => {
  async function newOpp(c: TestClient, title: string): Promise<string> {
    const res = await c.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { companyName: 'Initech', title, sourceKind: 'manual' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id;
  }

  /** One row in each of the six child tables, attached to `oppId`. */
  async function children(app: FastifyInstance, c: TestClient, oppId: string): Promise<void> {
    const now = Date.now();
    await c.request({
      method: 'POST',
      url: `/api/v1/opportunities/${oppId}/activities`,
      payload: { kind: 'note', title: 'Recruiter call', occurredAt: now },
    });
    await c.request({
      method: 'POST',
      url: `/api/v1/opportunities/${oppId}/next-steps`,
      payload: { action: 'Send portfolio' },
    });
    await app.db
      .insert(communications)
      .values({
        id: newId(),
        userId: c.userId,
        channel: 'gmail',
        externalId: newId(),
        from: 'recruiter@initech.example',
        sentAt: now,
        opportunityId: oppId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await app.db
      .insert(resumes)
      .values({
        id: newId(),
        userId: c.userId,
        kind: 'tailored',
        opportunityId: oppId,
        title: 'Resume for Initech',
        store: 'local_file',
        docRef: 'resumes/x.docx',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await app.db
      .insert(attachments)
      .values({
        id: newId(),
        userId: c.userId,
        opportunityId: oppId,
        filename: 'offer.pdf',
        mime: 'application/pdf',
        bytes: 1,
        sha256: 'x',
        storedPath: 'attachments/x',
        createdAt: now,
      })
      .run();
  }

  const countOn = async (app: FastifyInstance, oppId: string) => ({
    activities: (
      await app.db.select().from(activities).where(eq(activities.opportunityId, oppId)).all()
    ).length,
    nextSteps: (
      await app.db.select().from(nextSteps).where(eq(nextSteps.opportunityId, oppId)).all()
    ).length,
    communications: (
      await app.db
        .select()
        .from(communications)
        .where(eq(communications.opportunityId, oppId))
        .all()
    ).length,
    resumes: (await app.db.select().from(resumes).where(eq(resumes.opportunityId, oppId)).all())
      .length,
    stageHistory: (
      await app.db.select().from(stageHistory).where(eq(stageHistory.opportunityId, oppId)).all()
    ).length,
    attachments: (
      await app.db.select().from(attachments).where(eq(attachments.opportunityId, oppId)).all()
    ).length,
  });

  it('moves all six child tables, keeps the forward stage and records one note', async () => {
    const { app, a } = await boot();
    const keep = await newOpp(a, 'Platform Engineer');
    const other = await newOpp(a, 'Platform Eng (dup)');
    await children(app, a, keep);
    await children(app, a, other);
    for (const to of ['interested', 'applied'] as const) {
      await a.request({
        method: 'POST',
        url: `/api/v1/opportunities/${other}/stage`,
        payload: { to },
      });
    }
    const before = { keep: await countOn(app, keep), other: await countOn(app, other) };
    expect(before.other).toEqual({
      activities: 1,
      nextSteps: 1,
      communications: 1,
      resumes: 1,
      stageHistory: 3,
      attachments: 1,
    });

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${keep}/merge`,
      payload: { otherId: other },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: keep, stage: 'applied' });

    const after = await countOn(app, keep);
    expect(after).toEqual({
      activities: before.keep.activities + before.other.activities + 1,
      nextSteps: 2,
      communications: 2,
      resumes: 2,
      // keep's own row, other's three, and the stage move the merge made
      stageHistory: before.keep.stageHistory + before.other.stageHistory + 1,
      attachments: 2,
    });
    const notes = (
      await app.db
        .select()
        .from(activities)
        .where(and(eq(activities.opportunityId, keep), eq(activities.kind, 'note')))
        .all()
    ).filter((n) => n.title.startsWith('Merged'));
    expect(notes).toHaveLength(1);
    expect(await app.db.select().from(opportunities).where(eq(opportunities.id, other)).get()).toBe(
      undefined,
    );
    const gone = await a.request({ method: 'GET', url: `/api/v1/opportunities/${other}` });
    expect(gone.statusCode).toBe(404);
  });

  it('keeps the kept stage when it is further forward', async () => {
    const { a } = await boot();
    const keep = await newOpp(a, 'A');
    const other = await newOpp(a, 'B');
    await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${keep}/stage`,
      payload: { to: 'interested' },
    });
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${keep}/merge`,
      payload: { otherId: other },
    });
    expect(res.json().stage).toBe('interested');
  });

  it('is one transaction: a failure part way leaves everything where it was', async () => {
    const { app, a } = await boot();
    const keep = await newOpp(a, 'A');
    const other = await newOpp(a, 'B');
    await children(app, a, other);
    const before = await countOn(app, other);
    // The final delete fails, after every child row was already moved.
    await withFailingWrite(app, 'opportunities', {
      on: 'DELETE',
      when: `OLD.id = '${other}'`,
      message: 'boom',
    });
    await expect(mergeOpportunities(app.db, ctxOf(a), keep, other)).rejects.toThrow(/boom/);
    expect(await countOn(app, other)).toEqual(before);
    expect((await countOn(app, keep)).activities).toBe(0);
  });

  it('rejects merging an opportunity into itself and unknown or foreign ids', async () => {
    const { a, b } = await boot();
    const keep = await newOpp(a, 'A');
    const self = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${keep}/merge`,
      payload: { otherId: keep },
    });
    expect(self.statusCode).toBe(422);
    const foreign = await newOpp(b, 'B');
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${keep}/merge`,
      payload: { otherId: foreign },
    });
    expect(res.statusCode).toBe(404);
    expect(
      (await b.request({ method: 'GET', url: `/api/v1/opportunities/${foreign}` })).statusCode,
    ).toBe(200);
  });

  assertIsolated({
    name: 'opportunity merge',
    create: (c) => newOpp(c, `Merge me ${newId()}`),
    read: async (c, id) => {
      const own = await newOpp(c, `Keeper ${newId()}`);
      return c.request({
        method: 'POST',
        url: `/api/v1/opportunities/${own}/merge`,
        payload: { otherId: id },
      });
    },
  });
});

/** A board that lists `postings` on every poll; returns its source id and a poll function. */
async function board(app: FastifyInstance, c: TestClient, postings: () => NormalizedPosting[]) {
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      for (const posting of postings()) yield { posting, nextCursor: null };
    },
  });
  const src = await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: 'initech' },
  });
  const poll = async () => {
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: c.userId });
    await app.jobs.drain();
    const [last] = (await listRuns(app.db, ctxOf(c), src.id, { limit: 1, offset: 0 })).items;
    return last!.stats as { inserted: number; duplicates: number };
  };
  return { sourceId: src.id, poll };
}

const pendingIds = async (app: FastifyInstance, c: TestClient) =>
  (await listResults(app.db, ctxOf(c), { limit: 50, offset: 0, disposition: 'pending' })).items.map(
    (r) => r.id,
  );

describe('accepted results are not re-suggested', () => {
  afterEach(() => resetSources());

  it('accept with attachTo, then re-running the source inserts nothing', async () => {
    const { app, a } = await boot();
    const opp = await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { companyName: 'Initech', title: 'Platform work', sourceKind: 'manual' },
    });
    const { poll } = await board(app, a, () => [POSTING]);
    expect((await poll()).inserted).toBe(1);
    const [id] = await pendingIds(app, a);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/accept`,
      payload: { attachTo: opp.json().id },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await poll()).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(await pendingIds(app, a)).toEqual([]);
  });

  it('a force-accepted posting (NULL opportunity key) is not re-suggested either', async () => {
    const { app, a } = await boot();
    await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: {
        companyName: 'Initech',
        title: 'Platform Engineer',
        location: 'Austin, TX',
        sourceKind: 'manual',
      },
    });
    // The live opportunity blocks ingestion, so seed the result as an earlier poll would have.
    const id = await seedResult(app, a);
    const forced = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/accept`,
      payload: { force: true },
    });
    expect(forced.statusCode, forced.body).toBe(200);
    // Drop the manual opportunity: only the force-accepted one (NULL key) remains.
    const manual = (await app.db.select().from(opportunities).all()).find(
      (o) => o.sourceKind === 'manual',
    )!;
    await a.request({ method: 'DELETE', url: `/api/v1/opportunities/${manual.id}` });
    const posting = {
      ...POSTING,
      externalId: 'other-id',
    };
    const { poll } = await board(app, a, () => [posting]);
    // seedResult used dedupe key `company|title`; the engine computes the real key, so make
    // the accepted row carry it to exercise the accepted-key rule.
    await rawRun(
      app.db,
      sql`UPDATE discovery_results SET dedupe_key = 'initech|platform engineer|austin tx' WHERE id = ${id}`,
    );
    expect(await poll()).toMatchObject({ inserted: 0, duplicates: 1 });
  });

  it('a repost with a drifted title but the same externalId is a duplicate on the same source', async () => {
    const { app, a } = await boot();
    let title = POSTING.title;
    const { poll } = await board(app, a, () => [{ ...POSTING, title }]);
    expect((await poll()).inserted).toBe(1);
    title = 'Staff Platform Engineer, Payments';
    expect(await poll()).toMatchObject({ inserted: 0, duplicates: 1 });
  });
});

/** A dismissed result, with a non-null dedupe key so there's something to unsuppress. */
async function testDismissedResultRoute(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/__test/dismissed-discovery-result', async (req) => {
    const ctx = app.requireUser(req);
    const src = await createSource(app.db, ctx, { kind: 'manual', config: {} });
    const run = await createRun(app.db, ctx, { sourceId: src.id });
    const res = await insertResult(app.db, ctx, {
      runId: run.id,
      posting: { ...POSTING, title: `Role ${newId()}` },
      dedupeKey: `dismissed-${newId()}`,
      resolution: 'full',
    });
    await setDisposition(app.db, ctx, res.id, 'dismissed');
    return { id: res.id };
  });
}
const createDismissedTestResult = async (c: TestClient): Promise<string> =>
  (
    await c.request({
      method: 'POST',
      url: '/api/v1/__test/dismissed-discovery-result',
      payload: {},
    })
  ).json().id;

describe('POST /discovery/results/:id/unsuppress (#11)', () => {
  afterEach(() => resetSources());

  it('a dismissed result blocks a repost with a different externalId but the same job', async () => {
    const { app, a } = await boot();
    let externalId = POSTING.externalId;
    const { poll } = await board(app, a, () => [{ ...POSTING, externalId }]);
    expect((await poll()).inserted).toBe(1);
    const [id] = await pendingIds(app, a);
    const dismiss = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/dismiss`,
      payload: {},
    });
    expect(dismiss.statusCode, dismiss.body).toBe(200);
    // A genuinely different requisition id, same company/title/location: the issue's scenario.
    externalId = 'gh-2';
    expect(await poll()).toMatchObject({ inserted: 0, duplicates: 1 });
  });

  it('unsuppress lets the next posting with the key through, without resurfacing the dismissed row itself', async () => {
    const { app, a } = await boot();
    let externalId = POSTING.externalId;
    const { poll } = await board(app, a, () => [{ ...POSTING, externalId }]);
    expect((await poll()).inserted).toBe(1);
    const [id] = await pendingIds(app, a);
    const dismiss = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/dismiss`,
      payload: {},
    });
    expect(dismiss.statusCode, dismiss.body).toBe(200);

    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/unsuppress`,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id, disposition: 'dismissed', dedupeKey: null });
    // The dismissed row itself does not come back to the queue...
    expect(await pendingIds(app, a)).toEqual([]);

    // ...but the next posting with the same job is treated as new, not suppressed.
    externalId = 'gh-2';
    expect(await poll()).toMatchObject({ inserted: 1, duplicates: 0 });
    expect(await pendingIds(app, a)).toHaveLength(1);
  });

  it('is a 409 on a pending result', async () => {
    const { app, a } = await boot();
    const id = await seedResult(app, a);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/unsuppress`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_pending');
  });

  it('is a 409 the second time: nothing is left for it to release', async () => {
    const { app, a } = await boot();
    const id = await seedResult(app, a);
    await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/dismiss`,
      payload: {},
    });
    const first = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/unsuppress`,
      payload: {},
    });
    expect(first.statusCode, first.body).toBe(200);
    const second = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/unsuppress`,
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('not_suppressing');
  });

  it('an accepted result tied to a still-active opportunity cannot be unsuppressed', async () => {
    const { app, a } = await boot();
    const id = await seedResult(app, a);
    const accept = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/accept`,
      payload: {},
    });
    expect(accept.statusCode, accept.body).toBe(200);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/unsuppress`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('opportunity_still_active');
  });

  it('an accepted result can be unsuppressed once its opportunity is dismissed from the pipeline', async () => {
    const { app, a } = await boot();
    const id = await seedResult(app, a);
    const accept = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/accept`,
      payload: {},
    });
    expect(accept.statusCode, accept.body).toBe(200);
    const oppId = accept.json().opportunityId as string;
    const dismissOpp = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${oppId}/stage`,
      payload: { to: 'dismissed' },
    });
    expect(dismissOpp.statusCode, dismissOpp.body).toBe(200);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/unsuppress`,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ disposition: 'accepted', dedupeKey: null });
  });

  assertIsolated({
    name: 'discovery result unsuppress',
    setup: testDismissedResultRoute,
    create: createDismissedTestResult,
    read: (c, id) =>
      c.request({
        method: 'POST',
        url: `/api/v1/discovery/results/${id}/unsuppress`,
        payload: {},
      }),
  });
});

describe('discovery sources API', () => {
  it('creates, lists, patches, runs and deletes a source', async () => {
    const { app, a } = await boot();
    const created = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/sources',
      payload: { kind: 'ats_lever', config: { org: 'initech' }, scheduleCron: '0 7 * * *' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    expect(created.json()).toMatchObject({ kind: 'ats_lever', enabled: true, status: 'ok' });

    const list = await a.request({ method: 'GET', url: '/api/v1/discovery/sources' });
    expect(list.json().total).toBe(1);
    const bad = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/sources',
      payload: { kind: 'ats_lever', config: { org: 'Not A Slug' } },
    });
    expect(bad.statusCode).toBe(422);

    const patched = await a.request({
      method: 'PATCH',
      url: `/api/v1/discovery/sources/${id}`,
      payload: { enabled: false },
    });
    expect(patched.json().enabled).toBe(false);

    const run = await a.request({ method: 'POST', url: `/api/v1/discovery/sources/${id}/run` });
    expect(run.statusCode).toBe(202);
    const job = await app.db.select().from(jobs).where(eq(jobs.id, run.json().jobId)).get();
    expect(job).toMatchObject({
      kind: DISCOVERY_RUN_KIND,
      userId: a.userId,
      payload: { sourceId: id },
    });

    const runs = await a.request({ method: 'GET', url: `/api/v1/discovery/sources/${id}/runs` });
    expect(runs.statusCode).toBe(200);

    const del = await a.request({ method: 'DELETE', url: `/api/v1/discovery/sources/${id}` });
    expect(del.statusCode).toBe(204);
  });

  assertIsolated({
    name: 'discovery sources',
    create: async (c) =>
      (
        await c.request({
          method: 'POST',
          url: '/api/v1/discovery/sources',
          payload: { kind: 'manual', config: {} },
        })
      ).json().id,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/discovery/sources/${id}` }),
  });

  it('run-now on a channel without an adapter (alert_email, manual) is 422, nothing queued', async () => {
    const { app, a } = await boot();
    for (const kind of ['alert_email', 'manual'] as const) {
      const created = await a.request({
        method: 'POST',
        url: '/api/v1/discovery/sources',
        payload: { kind, config: {} },
      });
      const res = await a.request({
        method: 'POST',
        url: `/api/v1/discovery/sources/${created.json().id}/run`,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: { code: 'source_not_runnable' } });
    }
    expect(await app.db.select().from(jobs).where(eq(jobs.kind, DISCOVERY_RUN_KIND)).all()).toEqual(
      [],
    );
  });

  assertIsolated({
    name: 'discovery source run-now',
    create: async (c) =>
      (
        await c.request({
          method: 'POST',
          url: '/api/v1/discovery/sources',
          payload: { kind: 'ats_lever', config: { org: 'initech' } },
        })
      ).json().id,
    read: (c, id) => c.request({ method: 'POST', url: `/api/v1/discovery/sources/${id}/run` }),
  });
});
