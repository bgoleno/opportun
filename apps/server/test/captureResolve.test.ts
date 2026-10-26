// A job capture resolves to an opportunity at `interested` (design D1, D2, D3, D11, D12, D15,
// D20, D22, D23, D24). This is the half of #17 that the manual paste path has always had and
// the extension never did: the capture completes the lead it matches instead of storing a
// second `[multi-posted]` twin beside it.
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { resolveCapture } from '../src/lib/captureResolve';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import { listActivities } from '../src/repos/activities';
import {
  createRun,
  ensureChannelSource,
  getResult,
  insertResult,
  listResults,
  type DiscoveryResultView,
} from '../src/repos/discovery';
import {
  createOpportunity,
  getOpportunity,
  transitionOpportunity,
  updateOpportunity,
  type OpportunityView,
} from '../src/repos/opportunities';
import type { UserCtx } from '../src/repos/base';
import { queryAll } from './db';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

const TITLE = 'Staff Product Manager';
const PAGE = [
  'About the job',
  'Join the company that is building the telemetry infrastructure for the AI era.',
  'Remote, Full-time',
].join('\n');

/** The posting the extension sends for the Soylent req, as connectorCapture builds it. */
const capturePosting = (over: Partial<NormalizedPosting> = {}): NormalizedPosting => ({
  company: 'Soylent',
  title: TITLE,
  descriptionMd: PAGE,
  postingUrl: 'https://www.linkedin.com/jobs/view/1000000001',
  externalId: 'linkedin:1000000001',
  location: 'United States',
  ...over,
});

async function seedLead(
  app: FastifyInstance,
  ctx: UserCtx,
  kind: 'alert_email' | 'manual',
  over: Partial<NormalizedPosting> = {},
  resolution: 'needs_capture' | 'full' = 'needs_capture',
): Promise<DiscoveryResultView> {
  const source = await ensureChannelSource(app.db, ctx, kind);
  const run = await createRun(app.db, ctx, { sourceId: source.id });
  const posting: NormalizedPosting = {
    company: 'Soylent',
    title: TITLE,
    location: 'United States',
    postingUrl: 'https://www.linkedin.com/jobs/view/1000000001/',
    externalId: '1000000001',
    ...over,
  };
  return await insertResult(app.db, ctx, {
    runId: run.id,
    posting,
    dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
    resolution,
  });
}

const resolve = (app: FastifyInstance, ctx: UserCtx, over: Partial<NormalizedPosting> = {}) =>
  resolveCapture(app.db, ctx, {
    posting: capturePosting(over),
    captureText: PAGE,
    siteId: 'linkedin',
  });

const pendingCount = async (app: FastifyInstance, ctx: UserCtx): Promise<number> =>
  (await listResults(app.db, ctx, { disposition: 'pending', limit: 50, offset: 0 })).items.length;

const activityBodies = async (app: FastifyInstance, ctx: UserCtx, oppId: string) =>
  (await listActivities(app.db, ctx, oppId, { limit: 50, offset: 0 })).items.map(
    (a) => a.bodyMd ?? '',
  );

const queuedKinds = async (app: FastifyInstance): Promise<string[]> =>
  (await queryAll<{ kind: string }>(app, 'SELECT kind FROM jobs')).map((r) => r.kind);

async function seedOpportunity(
  app: FastifyInstance,
  ctx: UserCtx,
  over: Partial<Parameters<typeof createOpportunity>[2]> = {},
): Promise<OpportunityView> {
  return await createOpportunity(app.db, ctx, {
    companyName: 'Soylent',
    title: TITLE,
    location: 'United States',
    sourceKind: 'manual',
    ...over,
  });
}

describe('resolveCapture', () => {
  it('completes a pending needs_capture lead instead of storing a twin', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const lead = await seedLead(app, ctx, 'alert_email');

    const out = await resolve(app, ctx);

    expect(out.resultId).toBe(lead.id);
    expect(await pendingCount(app, ctx)).toBe(0);
    const stored = await getResult(app.db, ctx, lead.id);
    expect(stored.disposition).toBe('accepted');
    expect(stored.resolution).toBe('full');
    expect(stored.posting.descriptionMd).toContain('telemetry infrastructure');
    expect(stored.opportunityId).toBe(out.opportunityId);
  });

  it('matches on posting identity when AI was unavailable, so the dedupe keys differ', async () => {
    // Review Focus 1. No refine step means no location, so dedupeKey cannot match.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const lead = await seedLead(app, ctx, 'alert_email');

    const out = await resolve(app, ctx, { location: null });

    expect(out.resultId).toBe(lead.id);
    expect(await pendingCount(app, ctx)).toBe(0);
  });

  it('creates the opportunity at interested when nothing matches', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);

    const out = await resolve(app, ctx);

    expect(out.createdOpportunity).toBe(true);
    const opp = await getOpportunity(app.db, ctx, out.opportunityId);
    expect(opp.stage).toBe('interested');
    expect(opp.descriptionMd).toContain('telemetry infrastructure');
    expect(opp.sourceKind).toBe('discovery');
    expect(opp.sourceRef).toBe(out.resultId);
  });

  it.each([
    ['discovered', 'interested', true],
    ['interested', 'interested', false],
    ['preparing', 'preparing', false],
    ['applied', 'applied', false],
    ['in_process', 'in_process', false],
    ['offer', 'offer', false],
    ['closed', 'closed', false],
  ] as const)('leaves %s at %s', async (from, expected, moved) => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedOpportunity(app, ctx, { postingUrl: capturePosting().postingUrl });
    if (from !== 'discovered') {
      if (from === 'closed') {
        await transitionOpportunity(app.db, ctx, opp.id, {
          to: 'closed',
          closedReason: 'withdrawn',
        });
      } else {
        await transitionOpportunity(app.db, ctx, opp.id, { to: from });
      }
    }

    const out = await resolve(app, ctx);

    expect(out.opportunityId).toBe(opp.id);
    expect((await getOpportunity(app.db, ctx, opp.id)).stage).toBe(expected);
    expect(out.stageMovedTo).toBe(moved ? 'interested' : null);
  });

  it('revives a dismissed opportunity through the reopen path', async () => {
    // Review Focus 4: leaving a terminal stage needs `reopen`, and must write stage history.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedOpportunity(app, ctx, { postingUrl: capturePosting().postingUrl });
    await transitionOpportunity(app.db, ctx, opp.id, { to: 'dismissed', dismissedReason: 'other' });

    const out = await resolve(app, ctx);

    expect(out.stageMovedTo).toBe('interested');
    expect((await getOpportunity(app.db, ctx, opp.id)).stage).toBe('interested');
    const history = await queryAll<{ from_stage: string; to_stage: string }>(
      app,
      'SELECT from_stage, to_stage FROM stage_history WHERE opportunity_id = ? ORDER BY at',
      opp.id,
    );
    expect(history.at(-1)).toMatchObject({ from_stage: 'dismissed', to_stage: 'interested' });
  });

  it('links every other matching lead rather than stranding it pending', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const alert = await seedLead(app, ctx, 'alert_email');
    const board = await seedLead(app, ctx, 'manual', { externalId: null });

    const out = await resolve(app, ctx);

    expect(out.resultId).toBe(alert.id);
    expect(out.linkedLeadIds).toEqual([board.id]);
    const linked = await getResult(app.db, ctx, board.id);
    expect(linked.disposition).toBe('accepted');
    expect(linked.opportunityId).toBe(out.opportunityId);
    expect(await pendingCount(app, ctx)).toBe(0);

    // Final review, Important 4. Folding a lead in silently leaves no record of which lead
    // was eaten, which is what D20 leaned on to call the key-collision case reversible.
    const titles = (
      await listActivities(app.db, ctx, out.opportunityId, { limit: 50, offset: 0 })
    ).items.map((a) => a.title);
    expect(titles).toContainEqual(expect.stringMatching(/also posted via/i));
  });

  it('records a lead folded into an opportunity that already existed', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedOpportunity(app, ctx, { postingUrl: capturePosting().postingUrl });
    await seedLead(app, ctx, 'alert_email');

    await resolve(app, ctx);

    const titles = (await listActivities(app.db, ctx, opp.id, { limit: 50, offset: 0 })).items.map(
      (a) => a.title,
    );
    expect(titles).toContainEqual(expect.stringMatching(/also posted via a job alert email/i));
  });

  it('does not call a lead "also posted" when the opportunity was created from it', async () => {
    // The lead is the opportunity's origin, not a second sighting of it: that provenance is
    // the sourceRef, and an "Also posted via" entry there would be actively misleading.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const lead = await seedLead(app, ctx, 'alert_email');

    const out = await resolve(app, ctx);

    expect(out.createdOpportunity).toBe(true);
    expect((await getOpportunity(app.db, ctx, out.opportunityId)).sourceRef).toBe(lead.id);
    const titles = (
      await listActivities(app.db, ctx, out.opportunityId, { limit: 50, offset: 0 })
    ).items.map((a) => a.title);
    expect(titles).not.toContainEqual(expect.stringMatching(/also posted via/i));
  });

  it('never overwrites a description it did not write', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedOpportunity(app, ctx, {
      postingUrl: capturePosting().postingUrl,
      descriptionMd: 'my own notes',
    });

    await resolve(app, ctx);

    expect((await getOpportunity(app.db, ctx, opp.id)).descriptionMd).toBe('my own notes');
  });

  it('keeps the full captured text on the timeline even when it writes no description', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedOpportunity(app, ctx, {
      postingUrl: capturePosting().postingUrl,
      descriptionMd: 'my own notes',
    });

    await resolve(app, ctx);

    expect(await activityBodies(app, ctx, opp.id)).toContainEqual(
      expect.stringContaining('telemetry infrastructure'),
    );
  });

  it('fingerprints a description it wrote, so a later merge can tell it from a user edit', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);

    const out = await resolve(app, ctx);

    const opp = await getOpportunity(app.db, ctx, out.opportunityId);
    expect(opp.descriptionFingerprint).toBe(descriptionFingerprint(opp.descriptionMd as string));
  });

  it('enqueues one reconcile job and sets searching', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);

    const out = await resolve(app, ctx);

    expect(await queuedKinds(app)).toContain('posting.reconcile');
    expect((await getOpportunity(app.db, ctx, out.opportunityId)).postingState).toBe('searching');
  });

  it('never replaces a confirmed ATS description with the captured page text', async () => {
    // Final review, Critical 1. isSystemWritten means "the system wrote this", not "this is
    // replaceable": the reconcile job's own merged output matches its fingerprint, so a
    // re-capture was overwriting the employer's copy and then skipping the re-search that
    // would have restored it. D4 says the ATS copy wins every conflict.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const ats = 'The employer copy. Comp: $200k base.';
    const opp = await seedOpportunity(app, ctx, {
      postingUrl: capturePosting().postingUrl,
      descriptionMd: ats,
    });
    await updateOpportunity(app.db, ctx, opp.id, {
      descriptionFingerprint: descriptionFingerprint(ats),
    });
    const { setPostingState } = await import('../src/repos/opportunities');
    await setPostingState(app.db, ctx, opp.id, {
      postingState: 'confirmed',
      postingStateDetail: null,
    });

    await resolve(app, ctx);

    expect((await getOpportunity(app.db, ctx, opp.id)).descriptionMd).toBe(ats);
  });

  it('does not re-search a posting already confirmed, and fills only what is missing', async () => {
    // Design D15.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedOpportunity(app, ctx, {
      postingUrl: capturePosting().postingUrl,
      descriptionMd: 'the ATS copy',
    });
    await updateOpportunity(app.db, ctx, opp.id, { compNote: null });
    const { setPostingState } = await import('../src/repos/opportunities');
    await setPostingState(app.db, ctx, opp.id, {
      postingState: 'confirmed',
      postingStateDetail: null,
    });

    await resolve(app, ctx, { compNote: '$200k base' });

    const after = await getOpportunity(app.db, ctx, opp.id);
    expect(after.postingState).toBe('confirmed');
    expect(after.compNote).toBe('$200k base');
    expect(await queuedKinds(app)).not.toContain('posting.reconcile');
  });

  it('matches a different seniority of the same role only when no posting id says otherwise', async () => {
    // Review Focus 2: stripSeniority makes "Staff PM" and "PM" share a dedupe key. With ids on
    // both sides they are kept apart; with neither, the key is all there is.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const other = await seedLead(app, ctx, 'alert_email', {
      title: 'Principal Product Manager',
      externalId: '9999999999',
      postingUrl: 'https://www.linkedin.com/jobs/view/9999999999/',
    });

    const out = await resolve(app, ctx);

    // Not consumed and not linked: a different req is the user's decision, taken in the queue
    // through the existing duplicate dialog, not something a capture settles silently.
    expect(out.resultId).not.toBe(other.id);
    expect(out.linkedLeadIds).toEqual([]);
    expect((await getResult(app.db, ctx, other.id)).disposition).toBe('pending');
  });

  it('completes a lead whose key a different live opportunity already holds', async () => {
    // Final review, Important 5. Matching by identity can find a lead whose dedupe key is not
    // the capture's (the alert digest says "United States", the refine step says "Remote,
    // United States"). createOpportunity then claims the lead's key, and a live holder made it
    // throw 409 after the lead had already been flipped to `full`: a half-landed capture with
    // no reconcile queued.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const lead = await seedLead(app, ctx, 'alert_email', { location: 'Remote, United States' });
    const holder = await seedOpportunity(app, ctx, { location: 'Remote, United States' });

    const out = await resolve(app, ctx);

    expect(out.opportunityId).toBe(holder.id);
    expect((await getResult(app.db, ctx, lead.id)).disposition).toBe('accepted');
    expect((await getOpportunity(app.db, ctx, holder.id)).postingState).toBe('searching');
  });

  it('refuses to touch another user’s lead', async () => {
    const { app, a, b } = await boot();
    const lead = await seedLead(app, ctxOf(a), 'alert_email');

    const out = await resolve(app, ctxOf(b));

    expect(out.resultId).not.toBe(lead.id);
    expect((await getResult(app.db, ctxOf(a), lead.id)).disposition).toBe('pending');
  });
});
