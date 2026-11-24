// The end of a Discovery card whose posting is captured, on LinkedIn and on Indeed, in one
// capture (https://github.com/bgoleno/opportun/issues/968, qa's cases 12 and 23 on
// https://github.com/bgoleno/opportun/issues/967): one opportunity at Interested with the captured
// description, nothing left to review, and another user's card of the same posting untouched.
// Every posting is made up.
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { discoveryResults, opportunities } from '../src/db/schema';
import { resolveCapture } from '../src/lib/captureResolve';
import { createRun, ensureChannelSource, insertResult } from '../src/repos/discovery';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

const JOB = { company: 'Initech', title: 'Platform Engineer' };
const PAGE = 'Own the platform, as the page has it.';
const HERE = 'Austin, TX';
const THERE = 'Boston, MA';

/** Each site as its alert parser stores a posting, and as the extension captures it. */
type Site = readonly [siteId: string, id: string, url: string];
const SITES: readonly Site[] = [
  ['linkedin', '1000000001', 'https://www.linkedin.com/jobs/view/1000000001'],
  ['indeed', 'abc123def4567890', 'https://www.indeed.com/viewjob?jk=abc123def4567890'],
];

async function card(
  app: FastifyInstance,
  c: TestClient,
  [, id, url]: Site,
  location: string | null,
): Promise<string> {
  const ctx = ctxOf(c);
  const source = await ensureChannelSource(app.db, ctx, 'alert_email');
  const run = await createRun(app.db, ctx, { sourceId: source.id });
  const posting: NormalizedPosting = { ...JOB, location, postingUrl: url, externalId: id };
  const result = await insertResult(app.db, ctx, {
    runId: run.id,
    posting,
    dedupeKey: dedupeKey(posting.company, posting.title, location),
    resolution: 'needs_capture',
  });
  return result.id;
}

const capture = (
  app: FastifyInstance,
  c: TestClient,
  [siteId, id, url]: Site,
  location: string | null,
) =>
  resolveCapture(app.db, ctxOf(c), {
    posting: {
      ...JOB,
      location,
      descriptionMd: PAGE,
      postingUrl: url,
      externalId: `${siteId}:${id}`,
    },
    captureText: PAGE,
    siteId,
  });

const list = async (c: TestClient, query: string) =>
  (await c.request({ method: 'GET', url: `/api/v1/discovery/results?${query}` })).json();

/** A user's results and opportunities, whole. */
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

describe.each(SITES)('a card captured once on %s', (...site) => {
  it.each([
    [HERE, null, HERE],
    [HERE, HERE, HERE],
    [HERE, THERE, HERE],
    [null, null, null],
    [null, HERE, HERE],
    [null, THERE, THERE],
  ])(
    'location on the card %s, on the page %s: one at Interested, at %s',
    async (on, read, kept) => {
      const { app, a } = await boot();
      const id = await card(app, a, site, on);
      expect((await list(a, 'disposition=pending')).total).toBe(1);

      await capture(app, a, site, read);

      const rows = await rowsOf(app, a);
      expect(rows.opportunities).toHaveLength(1);
      const opp = rows.opportunities[0]!;
      expect(opp).toMatchObject({ stage: 'interested', descriptionMd: PAGE, location: kept });
      expect(rows.results.map((r) => [r.id, r.disposition, r.opportunityId])).toEqual([
        [id, 'accepted', opp.id],
      ]);
      expect(await list(a, 'disposition=pending')).toEqual({ items: [], total: 0 });
      // What the open page asks (useQueueWatch): the capture is the latest accepted result.
      const latest = await list(a, 'disposition=accepted&sort=-updatedAt&limit=1');
      expect([latest.total, latest.items[0]?.id]).toEqual([1, id]);
    },
  );

  it("another user's card of the same posting is untouched", async () => {
    const { app, a, b } = await boot();
    await card(app, a, site, HERE);
    const theirs = await card(app, b, site, HERE);
    const before = await rowsOf(app, b);

    await capture(app, a, site, null);

    expect((await list(a, 'disposition=pending')).total).toBe(0);
    expect(await rowsOf(app, b)).toEqual(before);
    expect((await list(b, 'disposition=pending')).items.map((r: { id: string }) => r.id)).toEqual([
      theirs,
    ]);
    expect((await list(b, 'disposition=accepted&sort=-updatedAt&limit=1')).total).toBe(0);
  });
});
