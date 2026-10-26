import { runStructured, TASK_PROMPT_VARS } from '@opportun/ai';
import { newId } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissalFeedback, jobs, prompts, settings } from '../src/db/schema';
import { enqueue } from '../src/jobs/runner';
import { feedbackSummary, REFINE_CRON, REFINE_JOB_KIND } from '../src/jobs/refineClassifyPrompt';
import { createProposedVersion, getActivePrompt } from '../src/repos/prompts';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
});

const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

/** A valid proposal: the seeded prompt with one extra instruction. */
async function proposalFrom(app: FastifyInstance, c: TestClient, extra: string): Promise<string> {
  const seed = (await getActivePrompt(app.db, ctxOf(c), 'comms.classify'))!;
  return `${seed.body}\n\n${extra}`;
}

let at = Date.now() - 100_000;
async function addFeedback(
  app: FastifyInstance,
  userId: string,
  n: number,
  reason: string,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    at += 1;
    await app.db
      .insert(dismissalFeedback)
      .values({
        id: newId(),
        userId,
        kind: 'classification',
        reason,
        note: 'Private subject line',
        at,
      })
      .run();
  }
}

async function runJob(app: FastifyInstance): Promise<void> {
  const id = await enqueue(app.db, REFINE_JOB_KIND, {});
  await app.jobs.drain();
  const job = await app.db.select().from(jobs).where(eq(jobs.id, id)).get();
  expect(job?.status, job?.lastError ?? '').toBe('done');
}

async function activeFlags(app: FastifyInstance) {
  return (
    await app.db.select({ id: prompts.id, isActive: prompts.isActive }).from(prompts).all()
  ).sort((x, y) => (x.id < y.id ? -1 : 1));
}

async function proposals(app: FastifyInstance, userId: string) {
  return await app.db
    .select()
    .from(prompts)
    .where(and(eq(prompts.userId, userId), eq(prompts.proposed, true)))
    .all();
}

describe('classification prompt refinement job', () => {
  it('with 5 corrections creates an inactive proposed version and activates nothing', async () => {
    const { app, a, b } = await boot();
    await addFeedback(app, a.userId, 3, 'outreach targeted -> broadcast_spam');
    await addFeedback(app, a.userId, 2, 'classification networking -> solicitation');
    await addFeedback(app, b.userId, 2, 'outreach targeted -> irrelevant');
    const before = await activeFlags(app);
    const activeBefore = (await getActivePrompt(app.db, ctxOf(a), 'comms.classify'))!;
    const body = await proposalFrom(
      app,
      a,
      'Treat agency blasts listing many roles as broadcast_spam.',
    );
    vi.mocked(runStructured).mockResolvedValueOnce({
      proposedPrompt: body,
      changeSummary: 'Agency blasts are now broadcast spam.',
    });

    await runJob(app);

    // Only user a had enough feedback.
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(1);
    const [, task, opts] = vi.mocked(runStructured).mock.calls[0]!;
    expect(task).toBe('discovery.refine_prompt');
    expect(opts.system).toContain(activeBefore.body);
    expect(opts.system).toContain('- 3 times: outreach targeted -> broadcast_spam');
    expect(opts.system).toContain('- 2 times: classification networking -> solicitation');
    expect(opts.system).not.toContain('Private subject line');

    const proposed = await proposals(app, a.userId);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({
      taskKey: 'comms.classify',
      body,
      isActive: false,
      proposed: true,
      proposalSummary: 'Agency blasts are now broadcast spam.',
      parentId: activeBefore.id,
    });
    expect(await proposals(app, b.userId)).toHaveLength(0);
    // Nothing was activated or deactivated anywhere.
    const after = (await activeFlags(app)).filter((r) => r.id !== proposed[0]!.id);
    expect(after).toEqual(before);
    expect((await getActivePrompt(app.db, ctxOf(a), 'comms.classify'))!.id).toBe(activeBefore.id);

    // The listing marks it as a proposal.
    const list = await a.request({
      method: 'GET',
      url: '/api/v1/ai/prompts?taskKey=comms.classify',
    });
    const item = list.json().items.find((v: { id: string }) => v.id === proposed[0]!.id);
    expect(item).toMatchObject({ proposed: true, isActive: false });

    // The same corrections are not used twice: a second run is a no-op.
    await runJob(app);
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(1);
  });

  it('fewer than 5 corrections is a no-op', async () => {
    const { app, a } = await boot();
    await addFeedback(app, a.userId, 4, 'outreach targeted -> irrelevant');
    const count = (await app.db.select().from(prompts).all()).length;
    await runJob(app);
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
    expect(await app.db.select().from(prompts).all()).toHaveLength(count);
  });

  it('rejects a proposal that changes the placeholders', async () => {
    const { app, a } = await boot();
    await addFeedback(app, a.userId, 5, 'outreach targeted -> irrelevant');
    vi.mocked(runStructured).mockResolvedValueOnce({
      proposedPrompt: 'Classify {{message_untrusted}} and also {{secret_var}}.',
      changeSummary: 'x',
    });
    await runJob(app);
    expect(await proposals(app, a.userId)).toHaveLength(0);
  });

  it('a newer proposal supersedes an unaccepted one', async () => {
    const { app, a } = await boot();
    await addFeedback(app, a.userId, 5, 'outreach targeted -> irrelevant');
    vi.mocked(runStructured).mockResolvedValueOnce({
      proposedPrompt: await proposalFrom(app, a, 'First idea.'),
      changeSummary: 'first',
    });
    await runJob(app);
    await addFeedback(app, a.userId, 5, 'outreach irrelevant -> targeted');
    vi.mocked(runStructured).mockResolvedValueOnce({
      proposedPrompt: await proposalFrom(app, a, 'Second idea.'),
      changeSummary: 'second',
    });
    await runJob(app);
    const pending = await proposals(app, a.userId);
    expect(pending.map((p) => p.proposalSummary)).toEqual(['second']);
    // Only the five new rows were summarized.
    const second = vi.mocked(runStructured).mock.calls[1]![2];
    expect(second.system).toContain('- 5 times: outreach irrelevant -> targeted');
    expect(second.system).not.toContain('targeted -> irrelevant');
  });

  it('is seeded weekly on Monday at 06:00', async () => {
    const { app } = await boot();
    const row = await app.db
      .select()
      .from(settings)
      .where(eq(settings.key, `schedule:${REFINE_JOB_KIND}`))
      .get();
    expect(row?.value).toEqual({ cron: REFINE_CRON, enabled: true });
    expect(REFINE_CRON).toBe('0 6 * * 1');
  });

  it('summarizes corrections as counted patterns', () => {
    expect(feedbackSummary(['a', 'b', 'a', null])).toBe(
      [
        'The user corrected 4 classifications since the last refinement.',
        'Each line is a pattern of corrections: what the classifier said, then what the user chose.',
        '- 2 times: a',
        '- 1 time: b',
        '- 1 time: confirmed',
      ].join('\n'),
    );
  });
});

describe('accepting and discarding a proposal', () => {
  it('accept activates the version and clears the proposed flag', async () => {
    const { app, a } = await boot();
    const body = await proposalFrom(app, a, 'Accepted idea.');
    const p = await createProposedVersion(app.db, ctxOf(a), 'comms.classify', body, 'summary');
    expect((await getActivePrompt(app.db, ctxOf(a), 'comms.classify'))!.id).not.toBe(p.id);
    // The generic activate is not the way to accept a proposal.
    const generic = await a.request({
      method: 'POST',
      url: `/api/v1/ai/prompts/${p.id}/activate`,
    });
    expect(generic.statusCode).toBe(409);
    expect(generic.json().error.code).toBe('proposal_use_accept');
    expect((await getActivePrompt(app.db, ctxOf(a), 'comms.classify'))!.id).not.toBe(p.id);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/ai/prompts/${p.id}/accept-proposal`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: p.id, isActive: true, proposed: false });
    expect((await getActivePrompt(app.db, ctxOf(a), 'comms.classify'))!.id).toBe(p.id);
    expect(await proposals(app, a.userId)).toHaveLength(0);
    // Once accepted it is no longer a proposal.
    const again = await a.request({
      method: 'POST',
      url: `/api/v1/ai/prompts/${p.id}/accept-proposal`,
    });
    expect(again.statusCode).toBe(404);
  });

  it('discard deletes the proposal and leaves the active prompt alone', async () => {
    const { app, a } = await boot();
    const active = (await getActivePrompt(app.db, ctxOf(a), 'comms.classify'))!;
    const p = await createProposedVersion(app.db, ctxOf(a), 'comms.classify', active.body, 's');
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/ai/prompts/${p.id}/discard-proposal`,
    });
    expect(res.statusCode).toBe(204);
    expect(await proposals(app, a.userId)).toHaveLength(0);
    expect((await getActivePrompt(app.db, ctxOf(a), 'comms.classify'))!.id).toBe(active.id);
    // An ordinary version cannot be discarded through this endpoint.
    const seedDiscard = await a.request({
      method: 'POST',
      url: `/api/v1/ai/prompts/${active.id}/discard-proposal`,
    });
    expect(seedDiscard.statusCode).toBe(404);
  });

  it('the classify task variables are what proposals must keep', () => {
    expect([...TASK_PROMPT_VARS['comms.classify']].sort()).toEqual([
      'message_untrusted',
      'open_opportunities_untrusted',
      'role_targets',
    ]);
  });
});

async function seedProposalRoute(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/__test/proposal', async (req) => {
    const ctx = app.requireUser(req);
    const active = (await getActivePrompt(app.db, ctx, 'comms.classify'))!;
    return {
      id: (await createProposedVersion(app.db, ctx, 'comms.classify', active.body, 's')).id,
    };
  });
}

const createProposal = async (c: TestClient): Promise<string> =>
  (await c.request({ method: 'POST', url: '/api/v1/__test/proposal', payload: {} })).json().id;

assertIsolated({
  name: 'proposal accept',
  setup: seedProposalRoute,
  create: createProposal,
  read: (c, id) => c.request({ method: 'POST', url: `/api/v1/ai/prompts/${id}/accept-proposal` }),
});

assertIsolated({
  name: 'proposal discard',
  setup: seedProposalRoute,
  create: createProposal,
  read: (c, id) => c.request({ method: 'POST', url: `/api/v1/ai/prompts/${id}/discard-proposal` }),
});
