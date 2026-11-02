// Capture resolution across capture sites (https://github.com/bgoleno/opportun/issues/73).
//
// With Indeed a capture site, an Indeed alert-email lead has a posting identity
// (`indeed:<jk>`) for the first time. Two consequences are pinned here:
// - an Indeed capture finds the pending alert lead for the same job key by identity, so it
//   completes it even when the dedupe keys differ (no AI, so no location on the capture);
// - identities only contradict each other on the same site. A LinkedIn capture of the same req
//   as a pending Indeed alert lead key-matched it before Indeed had an identity, and must still
//   do so: a LinkedIn id and an Indeed job key say nothing about each other.
//
// Every company, title and job key here is invented.
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { useApi } from './api';
import { queryAll } from './db';
import type { TestClient } from './isolation';
import { resolveCapture } from '../src/lib/captureResolve';
import { listActivities } from '../src/repos/activities';
import type { UserCtx } from '../src/repos/base';
import {
  createRun,
  ensureChannelSource,
  getResult,
  insertResult,
  listResults,
  type DiscoveryResultView,
} from '../src/repos/discovery';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

const COMPANY = 'Example Corp';
const TITLE = 'Senior Example Engineer';
const LOCATION = 'Remote';
/** Obviously fake Indeed job keys (hex, as the alert parser and the site accept). */
const JK = '0000000000000a01';
const OTHER_JK = '0000000000000a02';
const PAGE = ['Full job description', 'Lorem ipsum dolor sit amet, example duties.'].join('\n');

const indeedUrl = (jk: string) => `https://www.indeed.com/viewjob?jk=${jk}`;

/** A pending lead shaped as lib/alertParsers/indeed.ts stores one: bare job key. */
async function seedIndeedAlertLead(
  app: FastifyInstance,
  ctx: UserCtx,
  over: Partial<NormalizedPosting> = {},
  kind: 'alert_email' | 'manual' = 'alert_email',
): Promise<DiscoveryResultView> {
  const source = await ensureChannelSource(app.db, ctx, kind);
  const run = await createRun(app.db, ctx, { sourceId: source.id });
  const posting: NormalizedPosting = {
    company: COMPANY,
    title: TITLE,
    location: LOCATION,
    postingUrl: indeedUrl(JK),
    externalId: JK,
    ...over,
  };
  return await insertResult(app.db, ctx, {
    runId: run.id,
    posting,
    dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
    resolution: 'needs_capture',
  });
}

/** An Indeed capture as the route builds it when the refine step does not run. */
const indeedCapture = (over: Partial<NormalizedPosting> = {}): NormalizedPosting => ({
  company: COMPANY,
  title: TITLE,
  location: null,
  compNote: null,
  descriptionMd: PAGE,
  postingUrl: indeedUrl(JK),
  externalId: `indeed:${JK}`,
  ...over,
});

/** A LinkedIn capture of the same req, refined (it has the location the key needs). */
const linkedInCapture = (): NormalizedPosting => ({
  company: COMPANY,
  title: TITLE,
  location: LOCATION,
  descriptionMd: PAGE,
  postingUrl: 'https://www.linkedin.com/jobs/view/1000000001',
  externalId: 'linkedin:1000000001',
});

const resolve = (app: FastifyInstance, ctx: UserCtx, posting: NormalizedPosting, siteId: string) =>
  resolveCapture(app.db, ctx, { posting, captureText: PAGE, siteId });

const pendingCount = async (app: FastifyInstance, ctx: UserCtx): Promise<number> =>
  (await listResults(app.db, ctx, { disposition: 'pending', limit: 50, offset: 0 })).items.length;

const resultCount = async (app: FastifyInstance, ctx: UserCtx): Promise<number> =>
  (await listResults(app.db, ctx, { limit: 50, offset: 0 })).items.length;

const opportunityCount = async (app: FastifyInstance, ctx: UserCtx): Promise<number> =>
  (
    await queryAll<{ id: string }>(
      app,
      'SELECT id FROM opportunities WHERE user_id = ?',
      ctx.userId,
    )
  ).length;

describe('resolveCapture: Indeed', () => {
  it('completes the pending Indeed alert lead for the same job key, by identity', async () => {
    // No refine step, so no location, so the capture's dedupe key is not the lead's.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const lead = await seedIndeedAlertLead(app, ctx);
    expect(dedupeKey(COMPANY, TITLE, null)).not.toBe(lead.dedupeKey);

    const out = await resolve(app, ctx, indeedCapture(), 'indeed');

    expect(out.resultId).toBe(lead.id);
    expect(out.createdOpportunity).toBe(true);
    expect(await pendingCount(app, ctx)).toBe(0);
    const stored = await getResult(app.db, ctx, lead.id);
    expect(stored).toMatchObject({
      disposition: 'accepted',
      resolution: 'full',
      opportunityId: out.opportunityId,
    });
    expect(stored.posting.descriptionMd).toContain('example duties');
    expect(stored.posting.postingUrl).toBe(indeedUrl(JK));
  });

  it('a second capture of the same job adds no opportunity and no lead', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await seedIndeedAlertLead(app, ctx);

    const first = await resolve(app, ctx, indeedCapture(), 'indeed');
    const again = await resolve(app, ctx, indeedCapture(), 'indeed');

    expect(again.opportunityId).toBe(first.opportunityId);
    expect(again.resultId).toBe(first.resultId);
    expect(again.createdOpportunity).toBe(false);
    expect(await opportunityCount(app, ctx)).toBe(1);
    expect(await resultCount(app, ctx)).toBe(1);
  });

  it('keeps two Indeed job keys that share a dedupe key apart', async () => {
    // stripSeniority gives "Senior" and "Principal" one key; the job keys say they are two reqs.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const other = await seedIndeedAlertLead(app, ctx, {
      title: 'Principal Example Engineer',
      postingUrl: indeedUrl(OTHER_JK),
      externalId: OTHER_JK,
    });
    expect(other.dedupeKey).toBe(dedupeKey(COMPANY, TITLE, LOCATION));

    const out = await resolve(app, ctx, indeedCapture({ location: LOCATION }), 'indeed');

    expect(out.resultId).not.toBe(other.id);
    expect(out.linkedLeadIds).toEqual([]);
    expect((await getResult(app.db, ctx, other.id)).disposition).toBe('pending');
  });
});

describe('resolveCapture: Indeed, once the first job is an opportunity', () => {
  // Review point 3 on https://github.com/bgoleno/opportun/pull/77. An Indeed capture has no
  // location, so "Senior" and "Principal" at one company (or one title in two cities) share a
  // dedupe key on every capture. The first one's opportunity holds that key; the second must
  // not be filed under it, because the lead behind it is a different job key on the same site.
  const principal = (over: Partial<NormalizedPosting> = {}) =>
    indeedCapture({
      title: 'Principal Example Engineer',
      postingUrl: indeedUrl(OTHER_JK),
      externalId: `indeed:${OTHER_JK}`,
      ...over,
    });

  const activityTitles = async (app: FastifyInstance, ctx: UserCtx, oppId: string) =>
    (await listActivities(app.db, ctx, oppId, { limit: 50, offset: 0 })).items.map((a) => a.title);

  it('gives the second job key its own opportunity, flagged as a possible duplicate', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const first = await resolve(app, ctx, indeedCapture(), 'indeed');
    expect(dedupeKey(COMPANY, 'Principal Example Engineer', null)).toBe(
      dedupeKey(COMPANY, TITLE, null),
    );

    const second = await resolve(app, ctx, principal(), 'indeed');

    expect(second.createdOpportunity).toBe(true);
    expect(second.opportunityId).not.toBe(first.opportunityId);
    expect(await opportunityCount(app, ctx)).toBe(2);
    const [row] = await queryAll<{ possible_duplicate_of: string | null }>(
      app,
      'SELECT possible_duplicate_of FROM opportunities WHERE id = ?',
      second.opportunityId,
    );
    expect(row?.possible_duplicate_of).toBe(first.opportunityId);
    // Nothing of the second job lands on the first one's timeline.
    const firstTitles = await activityTitles(app, ctx, first.opportunityId);
    expect(firstTitles.filter((t) => /captured from/i.test(t))).toHaveLength(1);
    expect(await activityTitles(app, ctx, second.opportunityId)).toContainEqual(
      expect.stringMatching(/kept apart from a different indeed posting/i),
    );

    // Each job still finds its own opportunity again.
    expect((await resolve(app, ctx, indeedCapture(), 'indeed')).opportunityId).toBe(
      first.opportunityId,
    );
    expect((await resolve(app, ctx, principal(), 'indeed')).opportunityId).toBe(
      second.opportunityId,
    );
    expect(await opportunityCount(app, ctx)).toBe(2);
  });

  it('completes a pending alert lead for the second job key into its own opportunity', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const first = await resolve(app, ctx, indeedCapture(), 'indeed');
    const lead = await seedIndeedAlertLead(app, ctx, {
      title: 'Principal Example Engineer',
      postingUrl: indeedUrl(OTHER_JK),
      externalId: OTHER_JK,
      location: null,
    });

    const second = await resolve(app, ctx, principal(), 'indeed');

    expect(second.resultId).toBe(lead.id);
    expect(second.opportunityId).not.toBe(first.opportunityId);
    expect((await getResult(app.db, ctx, lead.id)).opportunityId).toBe(second.opportunityId);
    expect(await opportunityCount(app, ctx)).toBe(2);
  });

  it('still attaches to an opportunity under the key that no lead contradicts', async () => {
    // D20's residual case is unchanged: an opportunity the user made by hand has no lead, so
    // nothing says it is a different job.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const { createOpportunity } = await import('../src/repos/opportunities');
    const manual = await createOpportunity(app.db, ctx, {
      companyName: COMPANY,
      title: TITLE,
      location: null,
      sourceKind: 'manual',
    });

    const out = await resolve(app, ctx, indeedCapture(), 'indeed');

    expect(out.opportunityId).toBe(manual.id);
    expect(await opportunityCount(app, ctx)).toBe(1);
  });
});

describe('resolveCapture: Indeed leads from other sources', () => {
  it('completes a lead that stored its own id beside the Indeed URL', async () => {
    // Review point 4. A user-mapped MCP source stores its own opaque externalId; the URL's job
    // key is the identity, so the capture of that job key completes the lead.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const lead = await seedIndeedAlertLead(
      app,
      ctx,
      { externalId: 'mcp-job-123', location: null },
      'manual',
    );

    const out = await resolve(app, ctx, indeedCapture(), 'indeed');

    expect(out.resultId).toBe(lead.id);
    expect(await pendingCount(app, ctx)).toBe(0);
    expect(await opportunityCount(app, ctx)).toBe(1);
  });
});

describe('resolveCapture: across sites', () => {
  it('a LinkedIn capture still consumes a pending Indeed alert lead for the same req', async () => {
    // The behaviour on main before Indeed had an identity: the dedupe key matched and nothing
    // contradicted it. A LinkedIn id and an Indeed job key are not a contradiction.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const lead = await seedIndeedAlertLead(app, ctx);

    const out = await resolve(app, ctx, linkedInCapture(), 'linkedin');

    expect(out.resultId).toBe(lead.id);
    expect(await pendingCount(app, ctx)).toBe(0);
    expect((await getResult(app.db, ctx, lead.id)).opportunityId).toBe(out.opportunityId);
    expect(await opportunityCount(app, ctx)).toBe(1);
  });
});
