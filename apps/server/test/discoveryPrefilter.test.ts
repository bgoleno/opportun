// The discovery pre-filter in shadow mode (https://github.com/bgoleno/opportun/issues/217, N2a of
// #190): the outcome on every new board posting, nothing about ranking changed, title variants
// from one AI call (a mocked provider here) and editable, and recall on what the user accepted.
// Every posting and role target is made up.
import { AiUnavailableError, runStructured, TitleVariantsOutputSchema } from '@opportun/ai';
import type { NormalizedPosting } from '@opportun/core';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { discoveryResults, jobs, roleTargets, settings } from '../src/db/schema';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import { DISCOVERY_RUN_KIND, insertLeads } from '../src/jobs/discoveryRun';
import { enqueue } from '../src/jobs/runner';
import {
  cleanTitleVariants,
  makeTitleVariants,
  MAX_TITLE_VARIANTS,
  sweepTitleVariantsFor,
  TITLE_VARIANTS_KIND,
  TITLE_VARIANTS_SWEEP_CRON,
  TITLE_VARIANTS_SWEEP_KIND,
  titleKeyOf,
} from '../src/jobs/titleVariants';
import { putSecret } from '../src/lib/secretBox';
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
    expect(await sweepTitleVariantsFor(app.db, ctxOf(a))).toBe(0);
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

  // The jobs of this kind, oldest first, by what each ended as.
  const results = async (app: FastifyInstance) =>
    (
      await app.db
        .select()
        .from(jobs)
        .where(eq(jobs.kind, TITLE_VARIANTS_KIND))
        .orderBy(asc(jobs.createdAt), asc(jobs.id))
        .all()
    ).map((j) => j.result);
  /** The next call does `during`, then answers with `titles`. */
  const duringNextCall = (during: () => Promise<unknown>, titles = ['Stale Answer']) =>
    vi.mocked(runStructured).mockImplementationOnce((async () => {
      await during();
      return { titles };
    }) as never);
  const saved = async (res: Promise<{ statusCode: number; body: string }>) => {
    const done = await res;
    expect(done.statusCode, done.body).toBe(200);
  };
  const callSystem = (i: number) =>
    (variantCalls().at(i)![2] as unknown as { system: string }).system;

  describe('a rename while the job waits or runs (tl, blocking 1)', () => {
    it('during the call: through the route and the queue, the new title gets its own list', async () => {
      const { app, a } = await boot();
      duringNextCall(async () => {
        await saved(patch(a, made.id, { titleFamily: 'Infrastructure' }));
      });
      const made = await create(a);
      await app.jobs.drain();
      expect(variantCalls()).toHaveLength(2);
      expect(callSystem(1)).toContain('Infrastructure');
      expect(await stored(app, made.id)).toEqual(VARIANTS);
      // The refused write says so: it does not report a list it did not store.
      expect(await results(app)).toEqual([
        { status: 'skipped', reason: 'changed_during_call' },
        { status: 'made', count: VARIANTS.length },
      ]);
    });

    it('a second rename during a rename’s call: the list is for the last name', async () => {
      const { app, a } = await boot();
      const made = await create(a);
      await app.jobs.drain();
      duringNextCall(async () => {
        await saved(patch(a, made.id, { name: 'Third Name' }));
      }, ['For The Second Name']);
      await saved(patch(a, made.id, { name: 'Second Name' }));
      await app.jobs.drain();
      expect(variantCalls()).toHaveLength(3);
      expect(callSystem(2)).toContain('Third Name');
      expect(await stored(app, made.id)).toEqual(VARIANTS);
    });

    it('while the job waits: no call for the old title, one for the new', async () => {
      const { app, a } = await boot();
      const made = await create(a);
      await saved(patch(a, made.id, { name: 'Renamed' }));
      await app.jobs.drain();
      expect(variantCalls()).toHaveLength(1);
      expect(callSystem(0)).toContain('Renamed');
      expect(await results(app)).toEqual([
        { status: 'skipped', reason: 'renamed' },
        { status: 'made', count: VARIANTS.length },
      ]);
    });

    it('renamed and back while the first call runs: that call’s list stands, with no second', async () => {
      const { app, a } = await boot();
      duringNextCall(async () => {
        await saved(patch(a, made.id, { name: 'Elsewhere' }));
        await saved(patch(a, made.id, { name: 'Platform' }));
      }, ['For Platform']);
      const made = await create(a);
      await app.jobs.drain();
      expect(variantCalls()).toHaveLength(1);
      expect(await stored(app, made.id)).toEqual(['For Platform']);
    });
  });

  describe('a list the user saves wins (tl, blocking 2)', () => {
    it('saved during the call: the AI’s answer is not stored', async () => {
      const { app, a } = await boot();
      duringNextCall(async () => {
        await saved(patch(a, made.id, { titleVariants: ['My Own Title'] }));
      });
      const made = await create(a);
      await app.jobs.drain();
      expect(await stored(app, made.id)).toEqual(['My Own Title']);
      expect(await results(app)).toEqual([{ status: 'skipped', reason: 'changed_during_call' }]);
    });

    it('cleared during the call: empty is what they saved', async () => {
      const { app, a } = await boot();
      duringNextCall(async () => {
        await saved(patch(a, made.id, { titleVariants: [] }));
      });
      const made = await create(a);
      await app.jobs.drain();
      expect(await stored(app, made.id)).toEqual([]);
    });

    it('saved while the job waits: no call at all', async () => {
      const { app, a } = await boot();
      const made = await create(a);
      await saved(patch(a, made.id, { titleVariants: ['My Own Title'] }));
      await app.jobs.drain();
      expect(variantCalls()).toHaveLength(0);
      expect(await stored(app, made.id)).toEqual(['My Own Title']);
      expect(await results(app)).toEqual([{ status: 'skipped', reason: 'user_list' }]);
    });

    it('a rename and a list in one save, while a job waits: their list, no call', async () => {
      const { app, a } = await boot();
      const made = await create(a);
      await saved(patch(a, made.id, { name: 'Renamed', titleVariants: ['My Own Title'] }));
      await app.jobs.drain();
      expect(variantCalls()).toHaveLength(0);
      expect(await stored(app, made.id)).toEqual(['My Own Title']);
    });

    it('saved while the job waits on a retry: the retry makes no call', async () => {
      const { app, a } = await boot();
      vi.mocked(runStructured).mockRejectedValueOnce(new AiUnavailableError('provider_error'));
      const made = await create(a);
      await app.jobs.drain();
      expect(variantCalls()).toHaveLength(1);
      const [waiting] = await app.db.select().from(jobs).where(eq(jobs.kind, TITLE_VARIANTS_KIND));
      expect(waiting).toMatchObject({ status: 'pending', attempts: 1 });
      await saved(patch(a, made.id, { titleVariants: ['My Own Title'] }));
      await app.db.update(jobs).set({ runAt: 0 }).where(eq(jobs.id, waiting!.id)).run();
      await app.jobs.drain();
      expect(variantCalls()).toHaveLength(1);
      expect(await stored(app, made.id)).toEqual(['My Own Title']);
    });
  });

  it('a provider that is down gets the job’s retries, and the retry makes the list', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockRejectedValueOnce(new AiUnavailableError('provider_error'));
    const made = await create(a);
    await app.jobs.drain();
    await app.db.update(jobs).set({ runAt: 0 }).where(eq(jobs.kind, TITLE_VARIANTS_KIND)).run();
    await app.jobs.drain();
    expect(variantCalls()).toHaveLength(2);
    expect(await stored(app, made.id)).toEqual(VARIANTS);
  });

  describe('an answer with nothing in it (tl, should fix)', () => {
    it('keeps the list, and says so instead of reporting one made', async () => {
      const { app, a } = await boot();
      const made = await create(a);
      await app.jobs.drain();
      vi.mocked(runStructured).mockResolvedValueOnce({ titles: [] } as never);
      await saved(patch(a, made.id, { name: 'Renamed' }));
      await app.jobs.drain();
      expect(await stored(app, made.id)).toEqual(VARIANTS);
      expect((await results(app))[1]).toEqual({ status: 'skipped', reason: 'empty_answer' });
    });

    it('one long or blank title does not fail the whole answer', () => {
      const titles = ['x'.repeat(300), ' ', 'Data Engineer'];
      expect(TitleVariantsOutputSchema.safeParse({ titles }).success).toBe(true);
      expect(cleanTitleVariants(titles)).toEqual(['x'.repeat(200), 'Data Engineer']);
    });
  });

  describe('a target with no list gets one without a rename (tl, blocking 3)', () => {
    const existing = (app: FastifyInstance, c: TestClient, over: { active?: boolean } = {}) =>
      createRoleTarget(app.db, ctxOf(c), {
        name: 'Platform',
        titleFamily: 'Platform Engineering',
        ...over,
      });

    it('the sweep makes one for a target from before this, once', async () => {
      const { app, a } = await boot();
      const made = await existing(app, a);
      expect(await sweepTitleVariantsFor(app.db, ctxOf(a))).toBe(1);
      await app.jobs.drain();
      expect(await stored(app, made.id)).toEqual(VARIANTS);
      expect(await sweepTitleVariantsFor(app.db, ctxOf(a))).toBe(0);
      expect(variantCalls()).toHaveLength(1);
    });

    it('the sweep picks up a call skipped for no key or budget, and a bad answer', async () => {
      const { app, a } = await boot();
      vi.mocked(runStructured).mockRejectedValueOnce(new AiUnavailableError('no_key'));
      const made = await create(a);
      await app.jobs.drain();
      expect(await stored(app, made.id)).toEqual([]);
      expect(await sweepTitleVariantsFor(app.db, ctxOf(a))).toBe(1);
      await app.jobs.drain();
      expect(await stored(app, made.id)).toEqual(VARIANTS);
    });

    it('does not refill a list the user cleared, nor one they saved', async () => {
      const { app, a } = await boot();
      const made = await create(a);
      await app.jobs.drain();
      await saved(patch(a, made.id, { titleVariants: [] }));
      expect(await sweepTitleVariantsFor(app.db, ctxOf(a))).toBe(0);
      expect(await stored(app, made.id)).toEqual([]);
      // A rename asks for a list again, whatever they had.
      await saved(patch(a, made.id, { name: 'Renamed' }));
      await app.jobs.drain();
      expect(await stored(app, made.id)).toEqual(VARIANTS);
    });

    it('leaves an inactive target, and another user’s', async () => {
      const { app, a, b } = await boot();
      await existing(app, a, { active: false });
      await existing(app, b);
      expect(await sweepTitleVariantsFor(app.db, ctxOf(a))).toBe(0);
    });

    it('adding an AI key sweeps that user’s targets', async () => {
      const { app, a, b } = await boot();
      const made = await existing(app, a);
      await existing(app, b);
      const res = await a.request({
        method: 'POST',
        url: '/api/v1/secrets',
        payload: { kind: 'ai_api_key', label: 'anthropic', value: 'sk-test-sweep-value' },
      });
      expect(res.statusCode, res.body).toBe(201);
      const queued = await app.db
        .select()
        .from(jobs)
        .where(eq(jobs.kind, TITLE_VARIANTS_KIND))
        .all();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ userId: a.userId, payload: { roleTargetId: made.id } });
    });

    it('the nightly sweep covers every user with a key, and skips one without', async () => {
      const { app, a, b } = await boot();
      const withKey = await existing(app, a);
      await existing(app, b);
      await putSecret(app.db, ctxOf(a), 'ai_api_key', 'anthropic', 'sk-test-sweep-value');
      await enqueue(app.db, TITLE_VARIANTS_SWEEP_KIND, {});
      await app.jobs.drain();
      // The finished one: the schedule also keeps its next occurrence pending.
      const [sweep] = await app.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.kind, TITLE_VARIANTS_SWEEP_KIND), eq(jobs.status, 'done')));
      expect(sweep).toMatchObject({ result: { queued: 1 } });
      expect(variantCalls()).toHaveLength(1);
      expect(await stored(app, withKey.id)).toEqual(VARIANTS);
    });

    it('is on a nightly schedule from boot', async () => {
      const { app } = await boot();
      const row = await app.db
        .select()
        .from(settings)
        .where(eq(settings.key, `schedule:${TITLE_VARIANTS_SWEEP_KIND}`))
        .get();
      expect(row?.value).toMatchObject({ cron: TITLE_VARIANTS_SWEEP_CRON, enabled: true });
    });
  });

  it('another user’s target is not touched', async () => {
    const { app, a, b } = await boot();
    const made = await createRoleTarget(app.db, ctxOf(a), {
      name: 'Platform',
      titleFamily: 'Platform Engineering',
    });
    expect(await makeTitleVariants(app.db, ctxOf(b), made.id, titleKeyOf(made))).toEqual({
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

  it('counts accepted board postings: kept over all of them, the caller’s only', async () => {
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
    // With a target of its own to judge against, another user still sees none of these.
    await platformTarget(app, b);
    expect(await recall(b)).toEqual({ positives: 0, kept: 0, recall: null });
  });

  it('with no role target to judge against, an accepted posting is not counted', async () => {
    const { app, a } = await boot();
    await runBoard(app, a, [post({ externalId: 'unjudged' })]); // no role target yet
    await decide(app, a, 'unjudged', 'accepted');
    expect(await recall(a)).toEqual({ positives: 0, kept: 0, recall: null });
  });

  it('counts a decision from before the filter, with no stored outcome (tl, blocking 5)', async () => {
    const { app, a } = await boot();
    await runBoard(app, a, [
      post({ externalId: 'old-kept' }),
      post({ externalId: 'old-missed', title: 'Office Coordinator' }),
    ]); // no role target yet, so neither has a stored outcome
    const by = await byExternalId(app, a);
    expect(by.get('old-kept')?.prefilterOutcome).toBeNull();
    await decide(app, a, 'old-kept', 'accepted');
    await decide(app, a, 'old-missed', 'accepted');
    await platformTarget(app, a);
    expect(await recall(a)).toEqual({ positives: 2, kept: 1, recall: 0.5 });
  });

  it('moves when the user edits a list, whatever was stored at ingest', async () => {
    const { app, a } = await boot();
    const made = await platformTarget(app, a);
    await runBoard(app, a, [post({ externalId: 'missed', title: 'Office Coordinator' })]);
    await decide(app, a, 'missed', 'accepted');
    expect(await recall(a)).toEqual({ positives: 1, kept: 0, recall: 0 });
    const res = await a.request({
      method: 'PATCH',
      url: `/api/v1/role-targets/${made.id}`,
      payload: { titleVariants: ['Office Coordinator'] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await recall(a)).toEqual({ positives: 1, kept: 1, recall: 1 });
  });

  it('judges by the source’s own target, ignores inactive ones, and only board sources', async () => {
    const { app, a } = await boot();
    const own = await platformTarget(app, a);
    await createRoleTarget(app.db, ctxOf(a), {
      name: 'Sales',
      titleFamily: 'Sales',
      titleVariants: ['Account Executive'],
    });
    await createRoleTarget(app.db, ctxOf(a), {
      name: 'Inactive',
      titleFamily: 'Office',
      titleVariants: ['Office Coordinator'],
      active: false,
    });
    // Against every active target, Account Executive passes; against the source's own, it misses.
    await runBoard(app, a, [post({ externalId: 'any', title: 'Account Executive' })]);
    await runBoard(app, a, [post({ externalId: 'own', title: 'Account Executive II' })], own.id);
    // Matches only the inactive target.
    await runBoard(app, a, [post({ externalId: 'off', title: 'Office Coordinator' })]);
    registerSource({
      kind: 'manual',
      async *fetchPostings() {
        yield { posting: post({ externalId: 'not-board' }), nextCursor: null };
      },
    } satisfies DiscoverySource);
    const manual = await createSource(app.db, ctxOf(a), {
      kind: 'manual',
      config: {},
      roleTargetId: null,
    });
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: manual.id }, { userId: a.userId });
    await app.jobs.drain();
    for (const id of ['any', 'own', 'off', 'not-board']) await decide(app, a, id, 'accepted');
    expect(await recall(a)).toEqual({ positives: 3, kept: 1, recall: 1 / 3 });
  });

  it('needs a session', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'GET', url: '/api/v1/discovery/prefilter/recall' });
    expect(res.statusCode).toBe(401);
  });
});
