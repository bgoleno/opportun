// The discovery pre-filter in shadow mode (https://github.com/bgoleno/opportun/issues/217, N2a of
// #190): the outcome on every new board posting, nothing about ranking changed, title variants
// from one AI call (a mocked provider here) and editable, and recall on what the user accepted.
// Every posting and role target is made up.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import type { NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { discoveryResults, jobs, roleTargets } from '../src/db/schema';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import { DISCOVERY_RUN_KIND, insertLeads } from '../src/jobs/discoveryRun';
import { enqueue } from '../src/jobs/runner';
import {
  cleanTitleVariants,
  makeTitleVariants,
  MAX_TITLE_VARIANTS,
  TITLE_VARIANTS_KIND,
} from '../src/jobs/titleVariants';
import { createSource, listResults } from '../src/repos/discovery';
import { createRoleTarget } from '../src/repos/profile';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const PAGE = { limit: 50, offset: 0 };

const VARIANTS = ['Platform Engineer', 'Site Reliability Engineer', 'Infrastructure Engineer'];

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockImplementation((async (_deps: unknown, task: string) =>
    task === TITLE_VARIANTS_KIND
      ? { titles: VARIANTS }
      : { score: 55, rationale: 'Ranked.', disqualifiers: [] }) as never);
});
afterEach(() => resetSources());

const post = (over: Partial<NormalizedPosting> & { externalId: string }): NormalizedPosting => ({
  company: `Company ${over.externalId}`,
  title: 'Platform Engineer',
  descriptionMd: 'Own the platform.',
  postingUrl: `https://boards.example.com/${over.externalId}`,
  ...over,
});

async function runBoard(
  app: FastifyInstance,
  c: TestClient,
  postings: NormalizedPosting[],
  roleTargetId: string | null = null,
): Promise<void> {
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      for (const posting of postings) yield { posting, nextCursor: null };
    },
  } satisfies DiscoverySource);
  const src = await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: 'initech' },
    roleTargetId,
  });
  await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: c.userId });
  await app.jobs.drain();
}

const platformTarget = (
  app: FastifyInstance,
  c: TestClient,
  over: Partial<Parameters<typeof createRoleTarget>[2]> = {},
) =>
  createRoleTarget(app.db, ctxOf(c), {
    name: 'Platform',
    titleFamily: 'Platform Engineering',
    titleVariants: VARIANTS,
    ...over,
  });

const byExternalId = async (app: FastifyInstance, c: TestClient) =>
  new Map((await listResults(app.db, ctxOf(c), PAGE)).items.map((r) => [r.posting.externalId, r]));

describe('the outcome on a new board posting (#217 criterion 2)', () => {
  it('stores pass, or filtered with its rule, and the title score, for each rule', async () => {
    const { app, a } = await boot();
    await platformTarget(app, a, { remotePref: 'remote', locations: ['Austin, TX'] });
    await runBoard(app, a, [
      post({ externalId: 'pass', remote: true }),
      post({ externalId: 'title', title: 'Office Coordinator' }),
      post({ externalId: 'remote', remote: false }),
      post({ externalId: 'location', location: 'Berlin, Germany' }),
    ]);
    const by = await byExternalId(app, a);
    expect(by.get('pass')).toMatchObject({
      prefilterOutcome: 'pass',
      prefilterRule: null,
      prefilterScore: 1,
    });
    expect(by.get('title')).toMatchObject({
      prefilterOutcome: 'filtered',
      prefilterRule: 'title',
      prefilterScore: 0,
    });
    expect(by.get('remote')).toMatchObject({
      prefilterOutcome: 'filtered',
      prefilterRule: 'remote',
    });
    expect(by.get('location')).toMatchObject({
      prefilterOutcome: 'filtered',
      prefilterRule: 'location',
    });
    // The API carries it.
    const listed = await a.request({ method: 'GET', url: '/api/v1/discovery/results?limit=50' });
    expect(
      (listed.json().items as { prefilterRule: string | null }[])
        .map((i) => i.prefilterRule)
        .sort(),
    ).toEqual(['location', 'remote', 'title', null].sort());
  });

  it('every posting is still ranked as before, filtered or not (shadow mode)', async () => {
    const { app, a } = await boot();
    await platformTarget(app, a);
    await runBoard(app, a, [
      post({ externalId: 'keep' }),
      post({ externalId: 'drop', title: 'Office Coordinator' }),
    ]);
    const ranks = vi
      .mocked(runStructured)
      .mock.calls.filter(([, task]) => task === DISCOVERY_RANK_KIND);
    expect(ranks).toHaveLength(2);
    const by = await byExternalId(app, a);
    expect(by.get('drop')).toMatchObject({ prefilterOutcome: 'filtered', aiScore: 55 });
    expect(by.get('keep')).toMatchObject({ prefilterOutcome: 'pass', aiScore: 55 });
    // Stored as pending like any other: nothing is hidden or dismissed for it.
    expect(by.get('drop')?.disposition).toBe('pending');
    const rankJobs = await app.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, DISCOVERY_RANK_KIND))
      .all();
    expect(rankJobs).toHaveLength(2);
  });

  it('judges by the source’s own role target when it has one', async () => {
    const { app, a } = await boot();
    const sales = await createRoleTarget(app.db, ctxOf(a), {
      name: 'Sales',
      titleFamily: 'Sales',
      titleVariants: ['Account Executive'],
    });
    await platformTarget(app, a);
    await runBoard(app, a, [post({ externalId: 'p' })], sales.id);
    expect((await byExternalId(app, a)).get('p')).toMatchObject({
      prefilterOutcome: 'filtered',
      prefilterRule: 'title',
    });
  });

  it('with no source target, judges by every active target, and not by an inactive one', async () => {
    const { app, a } = await boot();
    await createRoleTarget(app.db, ctxOf(a), {
      name: 'Sales',
      titleFamily: 'Sales',
      titleVariants: ['Account Executive'],
    });
    await platformTarget(app, a, { active: false });
    await runBoard(app, a, [
      post({ externalId: 'p' }),
      post({ externalId: 'ae', title: 'Account Executive' }),
    ]);
    const by = await byExternalId(app, a);
    expect(by.get('p')?.prefilterOutcome).toBe('filtered');
    expect(by.get('ae')?.prefilterOutcome).toBe('pass');
  });

  it('with no role target at all, nothing is judged, and it is ranked as before', async () => {
    const { app, a } = await boot();
    await runBoard(app, a, [post({ externalId: 'p' })]);
    expect((await byExternalId(app, a)).get('p')).toMatchObject({
      prefilterOutcome: null,
      prefilterRule: null,
      prefilterScore: null,
      aiScore: 55,
    });
  });

  it('a source that is not a board is not judged, on the same run path', async () => {
    const { app, a } = await boot();
    await platformTarget(app, a);
    registerSource({
      kind: 'manual',
      async *fetchPostings() {
        yield {
          posting: post({ externalId: 'not-board', title: 'Office Coordinator' }),
          nextCursor: null,
        };
      },
    } satisfies DiscoverySource);
    const src = await createSource(app.db, ctxOf(a), {
      kind: 'manual',
      config: {},
      roleTargetId: null,
    });
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();
    expect((await byExternalId(app, a)).get('not-board')).toMatchObject({
      prefilterOutcome: null,
      aiScore: 55,
    });
  });

  it('a job-alert lead is never judged (owner’s decision 5)', async () => {
    const { app, a } = await boot();
    await platformTarget(app, a);
    const src = await createSource(app.db, ctxOf(a), {
      kind: 'alert_email',
      config: {},
      roleTargetId: null,
    });
    await insertLeads(
      app.db,
      ctxOf(a),
      [post({ externalId: 'lead', title: 'Office Coordinator' })],
      src.id,
    );
    await app.jobs.drain();
    expect((await byExternalId(app, a)).get('lead')?.prefilterOutcome).toBeNull();
  });
});

describe('title variants (#217 criterion 1)', () => {
  const variantCalls = () =>
    vi.mocked(runStructured).mock.calls.filter(([, task]) => task === TITLE_VARIANTS_KIND);
  const stored = async (app: FastifyInstance, id: string) =>
    (await app.db.select().from(roleTargets).where(eq(roleTargets.id, id)).get())?.titleVariants;
  const create = async (c: TestClient, body: Record<string, unknown> = {}) => {
    const res = await c.request({
      method: 'POST',
      url: '/api/v1/role-targets',
      payload: { name: 'Platform', titleFamily: 'Platform Engineering', ...body },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; titleVariants: string[] };
  };
  const patch = (c: TestClient, id: string, body: Record<string, unknown>) =>
    c.request({ method: 'PATCH', url: `/api/v1/role-targets/${id}`, payload: body });

  it('creating a target makes one AI call, with its own fields only, and stores the list', async () => {
    const { app, a } = await boot();
    const made = await create(a, { keywords: ['kubernetes'] });
    expect(made.titleVariants).toEqual([]);
    await app.jobs.drain();
    expect(variantCalls()).toHaveLength(1);
    expect(await stored(app, made.id)).toEqual(VARIANTS);
    const system = variantCalls()[0]![2].system;
    expect(system).toContain('Platform: Platform Engineering');
    expect(system).toContain('keywords kubernetes');
    // What the job is called, and nothing else of the user's.
    expect(system).not.toMatch(/compensation/);
  });

  it('changing the name or the title family makes a new list; any other edit does not', async () => {
    const { app, a } = await boot();
    const made = await create(a);
    await app.jobs.drain();
    expect(variantCalls()).toHaveLength(1);

    expect((await patch(a, made.id, { keywords: ['go'], locations: ['Austin'] })).statusCode).toBe(
      200,
    );
    await app.jobs.drain();
    expect(variantCalls()).toHaveLength(1);

    // The same value again is no change.
    expect((await patch(a, made.id, { name: 'Platform' })).statusCode).toBe(200);
    await app.jobs.drain();
    expect(variantCalls()).toHaveLength(1);

    expect((await patch(a, made.id, { titleFamily: 'Infrastructure' })).statusCode).toBe(200);
    await app.jobs.drain();
    expect(variantCalls()).toHaveLength(2);

    expect((await patch(a, made.id, { name: 'Infra' })).statusCode).toBe(200);
    await app.jobs.drain();
    expect(variantCalls()).toHaveLength(3);
  });

  it('the user can edit the list, and their list is what the filter reads', async () => {
    const { app, a } = await boot();
    const made = await create(a);
    await app.jobs.drain();
    const res = await patch(a, made.id, {
      titleVariants: [' Tooling  Engineer ', 'tooling engineer', 'Build Engineer'],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().titleVariants).toEqual(['Tooling Engineer', 'Build Engineer']);
    await app.jobs.drain();
    // Editing the list makes no call.
    expect(variantCalls()).toHaveLength(1);
    await runBoard(app, a, [post({ externalId: 'b', title: 'Build Engineer' })], made.id);
    expect((await byExternalId(app, a)).get('b')?.prefilterOutcome).toBe('pass');
  });

  it('a rename that writes its own list makes no call, and a list given at creation neither', async () => {
    const { app, a } = await boot();
    const made = await create(a, { titleVariants: ['Tooling Engineer'] });
    await app.jobs.drain();
    expect(variantCalls()).toHaveLength(0);
    expect(made.titleVariants).toEqual(['Tooling Engineer']);
    await patch(a, made.id, { name: 'Tooling', titleVariants: ['Build Engineer'] });
    await app.jobs.drain();
    expect(variantCalls()).toHaveLength(0);
    expect(await stored(app, made.id)).toEqual(['Build Engineer']);
  });

  it('refuses more than 40, or a blank title', async () => {
    const { a } = await boot();
    const made = await create(a, { titleVariants: ['x'] });
    const many = Array.from({ length: MAX_TITLE_VARIANTS + 1 }, (_, i) => `Title ${i}`);
    expect((await patch(a, made.id, { titleVariants: many })).statusCode).toBe(400);
    expect((await patch(a, made.id, { titleVariants: ['  '] })).statusCode).toBe(400);
  });

  it('with AI unavailable the list stays as it was, and the job ends skipped', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
    const made = await create(a);
    await app.jobs.drain();
    expect(await stored(app, made.id)).toEqual([]);
    const job = await app.db.select().from(jobs).where(eq(jobs.kind, TITLE_VARIANTS_KIND)).get();
    expect(job).toMatchObject({ status: 'done', result: { status: 'skipped', reason: 'no_key' } });
  });

  it('a rename while the call runs keeps the old titles off the renamed target', async () => {
    const { app, a } = await boot();
    const made = await createRoleTarget(app.db, ctxOf(a), {
      name: 'Platform',
      titleFamily: 'Platform Engineering',
    });
    vi.mocked(runStructured).mockImplementationOnce((async () => {
      await app.db
        .update(roleTargets)
        .set({ name: 'Renamed' })
        .where(and(eq(roleTargets.id, made.id), eq(roleTargets.userId, a.userId)))
        .run();
      return { titles: VARIANTS };
    }) as never);
    await makeTitleVariants(app.db, ctxOf(a), made.id);
    expect(await stored(app, made.id)).toEqual([]);
  });

  it('another user’s target is not touched', async () => {
    const { app, a, b } = await boot();
    const made = await createRoleTarget(app.db, ctxOf(a), {
      name: 'Platform',
      titleFamily: 'Platform Engineering',
    });
    expect(await makeTitleVariants(app.db, ctxOf(b), made.id)).toEqual({
      status: 'skipped',
      reason: 'missing',
    });
    expect(variantCalls()).toHaveLength(0);
  });

  it('cleans what comes back: one line, duplicates dropped, at most 40', () => {
    expect(cleanTitleVariants([' Data\nEngineer ', 'data engineer', '', 'x'.repeat(300)])).toEqual([
      'Data Engineer',
      'x'.repeat(200),
    ]);
    expect(cleanTitleVariants(Array.from({ length: 60 }, (_, i) => `Title ${i}`))).toHaveLength(
      MAX_TITLE_VARIANTS,
    );
  });
});

describe('GET /discovery/prefilter/recall (#217 criterion 3)', () => {
  const recall = async (c: TestClient) => {
    const res = await c.request({ method: 'GET', url: '/api/v1/discovery/prefilter/recall' });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const decide = async (
    app: FastifyInstance,
    c: TestClient,
    externalId: string,
    disposition: 'accepted' | 'dismissed',
  ) => {
    const r = (await byExternalId(app, c)).get(externalId)!;
    await app.db
      .update(discoveryResults)
      .set({ disposition })
      .where(eq(discoveryResults.id, r.id))
      .run();
  };

  it('with nothing accepted yet: no figure, and a count of zero', async () => {
    const { a } = await boot();
    expect(await recall(a)).toEqual({ positives: 0, kept: 0, recall: null });
  });

  it('counts accepted postings it judged: kept over all of them, the caller’s only', async () => {
    const { app, a, b } = await boot();
    await platformTarget(app, a);
    await runBoard(app, a, [
      post({ externalId: 'kept-1' }),
      post({ externalId: 'kept-2' }),
      post({ externalId: 'kept-3' }),
      post({ externalId: 'missed', title: 'Office Coordinator' }),
      // Dismissed, and still pending: not positives, whatever the filter said.
      post({ externalId: 'no', title: 'Office Manager' }),
      post({ externalId: 'open' }),
    ]);
    for (const id of ['kept-1', 'kept-2', 'kept-3', 'missed']) await decide(app, a, id, 'accepted');
    await decide(app, a, 'no', 'dismissed');
    expect(await recall(a)).toEqual({ positives: 4, kept: 3, recall: 0.75 });
    expect(await recall(b)).toEqual({ positives: 0, kept: 0, recall: null });
  });

  it('an accepted posting it never judged is not counted', async () => {
    const { app, a } = await boot();
    await runBoard(app, a, [post({ externalId: 'unjudged' })]); // no role target yet
    await decide(app, a, 'unjudged', 'accepted');
    expect(await recall(a)).toEqual({ positives: 0, kept: 0, recall: null });
  });

  it('needs a session', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'GET', url: '/api/v1/discovery/prefilter/recall' });
    expect(res.statusCode).toBe(401);
  });
});
