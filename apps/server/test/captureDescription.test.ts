// Whose description an opportunity has after one capture of its posting
// (https://github.com/bgoleno/opportun/issues/967, W6; tl's table,
// https://github.com/bgoleno/opportun/issues/967#issuecomment-7119770290; qa's cases 24 to 31). One
// question decides: is the text there that of this very posting (the same id on the same site)? Then
// the page replaces a stand-in for it. Another's text, the employer's own and the user's are kept, and
// the page is on the timeline either way. Every posting is made up.
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { resolveCapture } from '../src/lib/captureResolve';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import { setRaceHook } from '../src/lib/racePoints';
import { listActivities } from '../src/repos/activities';
import { createRun, ensureChannelSource, getResult, insertResult } from '../src/repos/discovery';
import { createOpportunity, getOpportunity, updateOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

const PAGE = 'Own the platform, as the page has it.';
const SNIPPET = 'Own the platform, in short.';
const JOB = { company: 'Initech', title: 'Platform Engineer', location: 'Austin, TX' };
type Site = readonly [siteId: string, id: string, url: string];
const LINKEDIN: Site = ['linkedin', '1000000001', 'https://www.linkedin.com/jobs/view/1000000001'];
const INDEED: Site = [
  'indeed',
  '0000000000000a01',
  'https://www.indeed.com/viewjob?jk=0000000000000a01',
];
const SITES = [LINKEDIN, INDEED];

async function card(
  app: FastifyInstance,
  c: TestClient,
  [, id, url]: Site,
  over: Partial<NormalizedPosting> = {},
  resolution: 'needs_capture' | 'full' | 'resolved_ats' = 'full',
): Promise<string> {
  const ctx = ctxOf(c);
  const source = await ensureChannelSource(app.db, ctx, 'alert_email');
  const run = await createRun(app.db, ctx, { sourceId: source.id });
  const posting: NormalizedPosting = { ...JOB, postingUrl: url, externalId: id, ...over };
  return (
    await insertResult(app.db, ctx, {
      runId: run.id,
      posting,
      dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
      resolution,
    })
  ).id;
}

const capture = (app: FastifyInstance, c: TestClient, [siteId, id, url]: Site) =>
  resolveCapture(app.db, ctxOf(c), {
    posting: { ...JOB, descriptionMd: PAGE, postingUrl: url, externalId: `${siteId}:${id}` },
    captureText: PAGE,
    siteId,
  });

const accept = async (c: TestClient, id: string): Promise<string> => {
  const res = await c.request({
    method: 'POST',
    url: `/api/v1/discovery/results/${id}/accept`,
    payload: {},
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().opportunityId;
};

/** The page is on the timeline, whole, once. */
async function expectPageOnTimeline(app: FastifyInstance, c: TestClient, id: string) {
  const { items } = await listActivities(app.db, ctxOf(c), id, { limit: 50, offset: 0 });
  expect(items.filter((i) => i.kind === 'capture').map((i) => i.bodyMd)).toEqual([PAGE]);
}

async function expectPage(app: FastifyInstance, c: TestClient, id: string) {
  expect(await getOpportunity(app.db, ctxOf(c), id)).toMatchObject({
    descriptionMd: PAGE,
    descriptionFingerprint: descriptionFingerprint(PAGE),
  });
  await expectPageOnTimeline(app, c, id);
}

async function expectKept(app: FastifyInstance, c: TestClient, id: string, text: string) {
  expect((await getOpportunity(app.db, ctxOf(c), id)).descriptionMd).toBe(text);
  await expectPageOnTimeline(app, c, id);
}

describe.each(SITES)('a card on %s', (...site) => {
  it('with no text: the page', async () => {
    const { app, a } = await boot();
    await card(app, a, site, {}, 'needs_capture');
    const done = await capture(app, a, site);
    await expectPage(app, a, done.opportunityId);
    // It was created with it: nothing was there for it to be added to.
    expect(done.description).toBeUndefined();
  });

  it.each(['needs_capture', 'full'] as const)(
    "with this posting's own text (%s): the page replaces it",
    async (resolution) => {
      const { app, a } = await boot();
      const id = await card(app, a, site, { descriptionMd: SNIPPET }, resolution);
      const done = await capture(app, a, site);
      expect(done.resultId).toBe(id);
      await expectPage(app, a, done.opportunityId);
      expect((await getResult(app.db, ctxOf(a), id)).posting.descriptionMd).toBe(PAGE);
      expect(done.description).toBeUndefined();
    },
  );

  it("with the employer's own text, found on its board: kept", async () => {
    const { app, a } = await boot();
    await card(app, a, site, { descriptionMd: SNIPPET }, 'resolved_ats');
    const done = await capture(app, a, site);
    await expectKept(app, a, done.opportunityId, SNIPPET);
    expect(done.description).toBe('kept');
  });

  it('accepted with its snippet, which nobody edited: the page replaces it', async () => {
    const { app, a } = await boot();
    const opp = await accept(a, await card(app, a, site, { descriptionMd: SNIPPET }));
    const done = await capture(app, a, site);
    expect(done).toMatchObject({ opportunityId: opp, createdOpportunity: false });
    await expectPage(app, a, opp);
    expect(done.description).toBe('added');
  });

  it("accepted with the employer's own text: kept", async () => {
    const { app, a } = await boot();
    const opp = await accept(
      a,
      await card(app, a, site, { descriptionMd: SNIPPET }, 'resolved_ats'),
    );
    const done = await capture(app, a, site);
    await expectKept(app, a, opp, SNIPPET);
    expect(done.description).toBe('kept');
  });

  it.each([
    ['another text', 'My own words.'],
    ['the same with one space more', `${SNIPPET} `],
    ['the same in capitals', SNIPPET.toUpperCase()],
  ])('accepted, then edited by the user to %s: never replaced', async (_what, text) => {
    const { app, a } = await boot();
    const opp = await accept(a, await card(app, a, site, { descriptionMd: SNIPPET }));
    await updateOpportunity(app.db, ctxOf(a), opp, { descriptionMd: text });
    const stored = (await getOpportunity(app.db, ctxOf(a), opp)).descriptionMd!;
    const done = await capture(app, a, site);
    await expectKept(app, a, opp, stored);
    expect(done.description).toBe('kept');
  });
});

describe("text that is not this posting's", () => {
  it('a card matched by its key alone (another site): kept', async () => {
    const { app, a } = await boot();
    await card(app, a, INDEED, { descriptionMd: SNIPPET });
    const done = await capture(app, a, LINKEDIN);
    await expectKept(app, a, done.opportunityId, SNIPPET);
    expect(done.description).toBe('kept');
  });

  it("a card matched by its key alone, whose alert id is another's: kept", async () => {
    const { app, a } = await boot();
    await card(app, a, LINKEDIN, {
      descriptionMd: SNIPPET,
      postingUrl: 'https://boards.example.com/initech/1',
      externalId: '2000000002',
    });
    const done = await capture(app, a, LINKEDIN);
    expect(done.createdOpportunity).toBe(true);
    await expectKept(app, a, done.opportunityId, SNIPPET);
  });

  it('an opportunity accepted from a card matched by its key alone: kept', async () => {
    const { app, a } = await boot();
    const opp = await accept(a, await card(app, a, INDEED, { descriptionMd: SNIPPET }));
    const done = await capture(app, a, LINKEDIN);
    expect(done.opportunityId).toBe(opp);
    await expectKept(app, a, opp, SNIPPET);
    expect(done.description).toBe('kept');
  });

  it("the user's own, on an opportunity made by hand: kept", async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(app.db, ctxOf(a), {
      companyName: JOB.company,
      title: JOB.title,
      location: JOB.location,
      descriptionMd: 'My own words.',
      sourceKind: 'manual',
    });
    const done = await capture(app, a, LINKEDIN);
    await expectKept(app, a, opp.id, 'My own words.');
    expect(done.description).toBe('kept');
  });

  it("the user's own, which happens to be a snippet's, on a text the system wrote since: kept", async () => {
    const { app, a } = await boot();
    const opp = await accept(a, await card(app, a, LINKEDIN, { descriptionMd: SNIPPET }));
    // A board or an earlier capture wrote it: it has a fingerprint, of this text or of another.
    await updateOpportunity(app.db, ctxOf(a), opp, {
      descriptionFingerprint: descriptionFingerprint('Something else.'),
    });
    const done = await capture(app, a, LINKEDIN);
    await expectKept(app, a, opp, SNIPPET);
    expect(done.description).toBe('kept');
  });

  it('what a capture or a board wrote: kept', async () => {
    const { app, a } = await boot();
    const first = await capture(app, a, LINKEDIN);
    await updateOpportunity(app.db, ctxOf(a), first.opportunityId, {
      descriptionMd: 'As the board has it.',
      descriptionFingerprint: descriptionFingerprint('As the board has it.'),
    });
    const done = await capture(app, a, LINKEDIN);
    expect((await getOpportunity(app.db, ctxOf(a), first.opportunityId)).descriptionMd).toBe(
      'As the board has it.',
    );
    expect(done.description).toBe('kept');
  });
});

describe('what is said of it', () => {
  it('an opportunity with none: added', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(app.db, ctxOf(a), {
      companyName: JOB.company,
      title: JOB.title,
      location: JOB.location,
      sourceKind: 'manual',
    });
    const done = await capture(app, a, LINKEDIN);
    await expectPage(app, a, opp.id);
    expect(done.description).toBe('added');
  });

  it('the same page again: nothing', async () => {
    const { app, a } = await boot();
    await capture(app, a, LINKEDIN);
    expect((await capture(app, a, LINKEDIN)).description).toBeUndefined();
  });
});

describe('an edit saved while the capture is filling in', () => {
  const save = (app: FastifyInstance, c: TestClient, id: string) =>
    setRaceHook(async (point) => {
      if (point !== 'captureResolve.recorded') return;
      setRaceHook(undefined);
      await updateOpportunity(app.db, ctxOf(c), id, { descriptionMd: 'Saved just now.' });
    });

  it.each([
    ['a snippet nobody had edited', SNIPPET],
    ['no description', null],
  ] as const)('over %s: the edit wins, and the rest is filled', async (_what, text) => {
    const { app, a } = await boot();
    const id = await card(app, a, LINKEDIN, { descriptionMd: text, location: null });
    const opp = await accept(a, id);
    save(app, a, opp);
    const done = await capture(app, a, LINKEDIN);
    expect(await getOpportunity(app.db, ctxOf(a), opp)).toMatchObject({
      descriptionMd: 'Saved just now.',
      location: JOB.location,
      stage: 'interested',
    });
    expect(done).toMatchObject({ filled: true, description: 'kept' });
  });
});
