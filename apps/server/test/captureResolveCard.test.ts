// Which card a capture completes when the card's own link does not name the posting the plain way
// (https://github.com/bgoleno/opportun/issues/967, W5; tl's ruling,
// https://github.com/bgoleno/opportun/issues/967#issuecomment-7120119028; qa's cases 13 to 18). The
// bound on all of it: the same id on the same site, or a card with no id at all for the same company
// and whole title. A different job is never merged. Every posting is made up.
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { discoveryResults, opportunities } from '../src/db/schema';
import { resolveCapture } from '../src/lib/captureResolve';
import {
  createRun,
  createSource,
  ensureChannelSource,
  insertResult,
  setDisposition,
} from '../src/repos/discovery';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

const PAGE = 'Own the platform, as the page has it.';
const LI = '1000000001';
const JK = '0000000000000a01';
const SITES = [
  ['linkedin', LI, `https://www.linkedin.com/jobs/view/${LI}`],
  ['indeed', JK, `https://www.indeed.com/viewjob?jk=${JK}`],
] as const;

type Kind = 'alert_email' | 'manual' | 'extension' | 'mcp' | 'ats_lever';

async function sourceOf(app: FastifyInstance, c: TestClient, kind: Kind) {
  const ctx = ctxOf(c);
  if (kind === 'mcp') {
    return await createSource(app.db, ctx, {
      kind,
      config: {
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        tool: 'jobs',
        queryArgs: {},
        mapping: { company: 'company', title: 'title' },
        itemsPath: '',
      },
    });
  }
  if (kind === 'ats_lever')
    return await createSource(app.db, ctx, { kind, config: { org: 'initech' } });
  return await ensureChannelSource(app.db, ctx, kind);
}

/** A card at Austin; the captures below carry no location unless they say so. */
async function card(
  app: FastifyInstance,
  c: TestClient,
  over: Partial<NormalizedPosting> = {},
  opts: { kind?: Kind; resolution?: 'needs_capture' | 'full' | 'resolved_ats' } = {},
): Promise<string> {
  const ctx = ctxOf(c);
  const source = await sourceOf(app, c, opts.kind ?? 'alert_email');
  const run = await createRun(app.db, ctx, { sourceId: source.id });
  const posting: NormalizedPosting = {
    company: 'Initech',
    title: 'Senior Platform Engineer',
    location: 'Austin, TX',
    postingUrl: null,
    ...over,
  };
  const result = await insertResult(app.db, ctx, {
    runId: run.id,
    posting,
    dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
    resolution: opts.resolution ?? 'needs_capture',
  });
  return result.id;
}

const capture = (
  app: FastifyInstance,
  c: TestClient,
  siteId: 'linkedin' | 'indeed' = 'linkedin',
  over: Partial<NormalizedPosting> = {},
) => {
  const [, id, url] = SITES.find(([s]) => s === siteId)!;
  return resolveCapture(app.db, ctxOf(c), {
    posting: {
      company: 'Initech',
      title: 'Senior Platform Engineer',
      location: null,
      descriptionMd: PAGE,
      postingUrl: url,
      externalId: `${siteId}:${id}`,
      ...over,
    },
    captureText: PAGE,
    siteId,
  });
};

const rowsOf = async (app: FastifyInstance, c: TestClient) => ({
  results: await app.db
    .select()
    .from(discoveryResults)
    .where(eq(discoveryResults.userId, c.userId))
    .all(),
  opportunities: await app.db
    .select()
    .from(opportunities)
    .where(eq(opportunities.userId, c.userId))
    .all(),
});

/** The card was completed and accepted into the one opportunity, at Interested. */
async function expectTaken(app: FastifyInstance, c: TestClient, id: string) {
  const { results, opportunities: opps } = await rowsOf(app, c);
  expect(opps).toHaveLength(1);
  expect(opps[0]).toMatchObject({ stage: 'interested', descriptionMd: PAGE });
  expect(results.map((r) => [r.id, r.disposition, r.opportunityId])).toEqual([
    [id, 'accepted', opps[0]!.id],
  ]);
}

/** The card is as it was, and the capture made an opportunity of its own. */
async function expectLeft(app: FastifyInstance, c: TestClient, id: string) {
  const { results, opportunities: opps } = await rowsOf(app, c);
  expect(opps).toHaveLength(1);
  const row = results.find((r) => r.id === id)!;
  expect([row.disposition, row.opportunityId]).toEqual(['pending', null]);
  expect(results).toHaveLength(2);
}

describe('a card whose stored link is another address of the posting', () => {
  it.each([
    ['linkedin', `https://www.linkedin.com/comm/jobs/view/${LI}/?trackingId=x`],
    ['linkedin', `https://www.linkedin.com/jobs/view/senior-platform-engineer-at-initech-${LI}/`],
    ['linkedin', `https://www.linkedin.com/jobs/search/?currentJobId=${LI}`],
    ['indeed', `https://www.indeed.com/rc/clk?jk=${JK}&bb=x`],
    ['indeed', `https://www.indeed.com/pagead/clk?mo=r&jk=${JK.toUpperCase()}`],
    ['indeed', `https://www.indeed.com/m/viewjob?jk=${JK}`],
    ['indeed', `https://www.indeed.com/jobs?vjk=${JK}`],
  ] as const)(
    '%s: %s, beside an opaque id, with no location on the capture',
    async (site, link) => {
      const { app, a } = await boot();
      const id = await card(app, a, { postingUrl: link, externalId: 'opaque-1' }, { kind: 'mcp' });
      await capture(app, a, site);
      await expectTaken(app, a, id);
    },
  );

  it('the same address with the id of another job is not it', async () => {
    const { app, a } = await boot();
    const id = await card(
      app,
      a,
      { postingUrl: 'https://www.linkedin.com/jobs/view/senior-platform-engineer-2000000002/' },
      { kind: 'mcp' },
    );
    await capture(app, a);
    await expectLeft(app, a, id);
  });

  it('two that key-matched only because one had no readable id are now kept apart', async () => {
    const { app, a } = await boot();
    const id = await card(
      app,
      a,
      { postingUrl: 'https://www.linkedin.com/comm/jobs/view/2000000002/', externalId: 'opaque-1' },
      { kind: 'mcp' },
    );
    await capture(app, a, 'linkedin', { location: 'Austin, TX' });
    await expectLeft(app, a, id);
  });
});

describe("an alert's card that holds the site's bare id beside no link to the site", () => {
  it.each(SITES)('%s: the board link a resolved lead has', async (site, id) => {
    const { app, a } = await boot();
    const lead = await card(
      app,
      a,
      { postingUrl: 'https://boards.greenhouse.io/initech/jobs/1', externalId: id },
      { resolution: 'resolved_ats' },
    );
    await capture(app, a, site);
    await expectTaken(app, a, lead);
  });

  it.each(SITES)('%s: no link at all', async (site, id) => {
    const { app, a } = await boot();
    const lead = await card(app, a, { externalId: id.toUpperCase() });
    await capture(app, a, site);
    await expectTaken(app, a, lead);
  });

  it('another id is another job', async () => {
    const { app, a } = await boot();
    const lead = await card(
      app,
      a,
      { postingUrl: 'https://boards.greenhouse.io/initech/jobs/1', externalId: '2000000002' },
      { resolution: 'resolved_ats' },
    );
    await capture(app, a);
    await expectLeft(app, a, lead);
  });

  it.each(['mcp', 'ats_lever', 'manual'] as const)(
    'the same digits from %s are opaque: not that job',
    async (kind) => {
      const { app, a } = await boot();
      const lead = await card(
        app,
        a,
        { postingUrl: 'https://boards.greenhouse.io/initech/jobs/1', externalId: LI },
        { kind, resolution: kind === 'mcp' ? 'resolved_ats' : 'full' },
      );
      await capture(app, a);
      await expectLeft(app, a, lead);
    },
  );

  it('already accepted into an opportunity: the capture goes there', async () => {
    const { app, a } = await boot();
    const lead = await card(
      app,
      a,
      { postingUrl: 'https://boards.greenhouse.io/initech/jobs/1', externalId: LI },
      { resolution: 'resolved_ats' },
    );
    const accepted = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${lead}/accept`,
      payload: {},
    });
    const { opportunityId } = await capture(app, a);
    expect(opportunityId).toBe(accepted.json().opportunityId);
    await expectTaken(app, a, lead);
  });
});

describe('a card with no id that can be read', () => {
  const SHORT = { postingUrl: 'https://lnkd.example/abc', externalId: 'opaque-1' };

  it.each([
    ['a short link', 'mcp', SHORT],
    [
      'a sponsored link with no key',
      'alert_email',
      { postingUrl: 'https://www.indeed.com/pagead/clk?mo=r' },
    ],
    ['an opaque id and no link', 'alert_email', { externalId: 'opaque-1' }],
  ] as const)(
    '%s: taken by company and whole title, whatever the location',
    async (_w, kind, over) => {
      const { app, a } = await boot();
      const id = await card(app, a, over, { kind });
      await capture(app, a, 'linkedin', { location: 'Boston, MA' });
      await expectTaken(app, a, id);
    },
  );

  it.each([
    ['another level', { ...SHORT, title: 'Principal Platform Engineer' }, {}],
    ['another title', { ...SHORT, title: 'Senior Data Engineer' }, {}],
    ['another company', { ...SHORT, company: 'Globex' }, {}],
    [
      "an id of its own (another site's)",
      { postingUrl: `https://www.indeed.com/viewjob?jk=${JK}` },
      {},
    ],
    ["an alert's bare id of another job", { externalId: '2000000002' }, {}],
    ['a board card', SHORT, { kind: 'ats_lever' }],
    ["the user's own paste", SHORT, { kind: 'manual' }],
    ['one resolved on a board', SHORT, { kind: 'mcp', resolution: 'resolved_ats' }],
  ] as const)('not taken: %s', async (_what, over, opts) => {
    const { app, a } = await boot();
    const id = await card(app, a, over, {
      kind: 'mcp',
      ...opts,
      ...(_what.startsWith('an alert') ? { kind: 'alert_email' } : {}),
    });
    await capture(app, a, 'linkedin', { location: 'Boston, MA' });
    await expectLeft(app, a, id);
  });

  it('a card found by id is taken first, and this one is left', async () => {
    const { app, a } = await boot();
    const short = await card(app, a, { ...SHORT, location: 'Denver, CO' }, { kind: 'mcp' });
    const byId = await card(app, a, { postingUrl: SITES[0][2], externalId: LI });
    const { resultId } = await capture(app, a);
    expect(resultId).toBe(byId);
    const { results } = await rowsOf(app, a);
    expect(results.find((r) => r.id === short)?.opportunityId).not.toBeUndefined();
  });

  it('a posting captured again does not take one that came later', async () => {
    const { app, a } = await boot();
    const first = await capture(app, a);
    const id = await card(app, a, SHORT, { kind: 'mcp' });
    const again = await capture(app, a);
    expect(again.opportunityId).toBe(first.opportunityId);
    const { results } = await rowsOf(app, a);
    expect(results.find((r) => r.id === id)?.disposition).toBe('pending');
  });

  it('a dismissed one stays dismissed', async () => {
    const { app, a } = await boot();
    const id = await card(app, a, SHORT, { kind: 'mcp' });
    await setDisposition(app.db, ctxOf(a), id, 'dismissed');
    await capture(app, a);
    const { results } = await rowsOf(app, a);
    expect(results.find((r) => r.id === id)).toMatchObject({
      disposition: 'dismissed',
      opportunityId: null,
    });
  });

  it("another user's is untouched", async () => {
    const { app, a, b } = await boot();
    const theirs = await card(app, b, SHORT, { kind: 'mcp' });
    const before = await rowsOf(app, b);
    await capture(app, a);
    expect(await rowsOf(app, b)).toEqual(before);
    expect(before.results.map((r) => r.id)).toEqual([theirs]);
  });
});
