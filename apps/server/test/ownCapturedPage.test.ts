// The captured page the posting check and Re-derive read is of the opportunity's own posting, where
// another posting's has joined it since (https://github.com/bgoleno/opportun/issues/1063).
import { runStructured } from '@opportun/ai';
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activities, discoveryResults, opportunities } from '../src/db/schema';
import { reconcilePosting } from '../src/jobs/postingReconcile';
import { resolveCapture } from '../src/lib/captureResolve';
import { insertLeads } from '../src/lib/discoveryIngest';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import { capturedPage } from '../src/lib/postingReconcile';
import { rederivePosting } from '../src/lib/postingRederive';
import type { BoardLookup } from '../src/lib/postingSearch';
import type { safeFetch } from '../src/lib/safeFetch';
import { createActivity } from '../src/repos/activities';
import { createCompany } from '../src/repos/companies';
import { createRun, ensureChannelSource, insertResult } from '../src/repos/discovery';
import { createOpportunity, getOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (orig) => ({
  ...(await orig<typeof import('@opportun/ai')>()),
  runStructured: vi.fn(),
}));

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockResolvedValue({ passages: [] });
});

const JOB = { company: 'Initech', title: 'Platform Engineer' };
const HERE = 'Austin, TX';
const RESPELLED = 'Austin, Texas, United States';
const THERE = 'Boston, MA';
const ELSEWHERE = 'Denver, CO';
const SITES = ['linkedin', 'indeed'] as const;
const LABEL = { linkedin: 'LinkedIn', indeed: 'Indeed' } as const;
type At = readonly [site: (typeof SITES)[number], n: number];
const idOf = ([site, n]: At) =>
  site === 'linkedin' ? String(1_000_000_000 + n) : `abc123def45678${String(n).padStart(2, '0')}`;
const urlOf = (at: At) =>
  at[0] === 'linkedin'
    ? `https://www.linkedin.com/jobs/view/${idOf(at)}`
    : `https://www.indeed.com/viewjob?jk=${idOf(at)}`;

/** A sentence that only the page captured as `tag` has. */
const sentence = (tag: string) => `Only the page ${tag} says that the team sits on floor ${tag}.`;
const textOf = (site: At[0], tag: string) =>
  site === 'linkedin'
    ? ['About the job', `The role. ${sentence(tag)}`, 'About the company', 'Initech.'].join('\n')
    : [JOB.title, JOB.company, 'Full job description', `The role. ${sentence(tag)}`].join('\n');
const tagIn = (text: string | null | undefined) => /Only the page (\w+) says/.exec(text ?? '')?.[1];

const postingAt = (
  at: At,
  location: string | null,
  tag: string,
  over: Partial<NormalizedPosting> = {},
): NormalizedPosting => ({
  ...JOB,
  location,
  descriptionMd: `The role. ${sentence(tag)}`,
  postingUrl: urlOf(at),
  externalId: `${at[0]}:${idOf(at)}`,
  ...over,
});
/** The page of `at`, captured as `tag`; the opportunity it went to. */
async function capture(
  app: FastifyInstance,
  c: TestClient,
  at: At,
  location: string | null,
  tag: string,
  over: Partial<NormalizedPosting> = {},
): Promise<string> {
  await new Promise((r) => setTimeout(r, 3)); // an entry's time is in milliseconds
  const done = await resolveCapture(app.db, ctxOf(c), {
    posting: postingAt(at, location, tag, over),
    captureText: textOf(at[0], tag),
    siteId: at[0],
  });
  return done.opportunityId;
}

const missingFetch = (async () => ({
  status: 404,
  headers: new Headers(),
  body: Buffer.from(''),
})) as unknown as typeof safeFetch;
const sctx = { fetch: missingFetch, log: { warn() {}, info() {}, error() {} } as never };
const ATS = 'The board says what the role is, at length and in its own words.';
const board =
  (over: Partial<NormalizedPosting> = {}): BoardLookup =>
  async () => [
    {
      ...JOB,
      descriptionMd: ATS,
      postingUrl: 'https://job-boards.greenhouse.io/initech/jobs/1000000001',
      externalId: '1000000001',
      ...over,
    },
  ];
const onBoard = (app: FastifyInstance, c: TestClient) =>
  createCompany(app.db, ctxOf(c), {
    name: JOB.company,
    atsKind: 'ats_greenhouse',
    atsRef: 'initech',
    atsVerifiedAt: Date.now(),
  });

/** The page the posting check merged from. */
async function checked(
  app: FastifyInstance,
  c: TestClient,
  id: string,
  over: Partial<NormalizedPosting> = {},
) {
  vi.mocked(runStructured).mockClear();
  const outcome = await reconcilePosting(app.db, ctxOf(c), id, sctx, { board: board(over) });
  expect(outcome.status).toBe('confirmed');
  expect(runStructured).toHaveBeenCalledTimes(1);
  return tagIn((vi.mocked(runStructured).mock.calls[0]![2] as { system: string }).system);
}
async function rederive(app: FastifyInstance, c: TestClient, id: string, lookup: BoardLookup) {
  const { descriptionMd } = await getOpportunity(app.db, ctxOf(c), id);
  return await rederivePosting(app.db, ctxOf(c), id, sctx, {
    force: true,
    replaceAgreed: descriptionFingerprint(descriptionMd ?? ''),
    board: lookup,
  });
}
/** The page Re-derive took the description from, with nothing on the board. */
async function rederived(app: FastifyInstance, c: TestClient, id: string) {
  const outcome = await rederive(app, c, id, async () => []);
  expect(outcome.kind).toBe('capture_only');
  return tagIn((await getOpportunity(app.db, ctxOf(c), id)).descriptionMd);
}
/** The page each of them reads. */
const reads = async (app: FastifyInstance, c: TestClient, id: string) => [
  await rederived(app, c, id),
  await checked(app, c, id),
];
const both = (tag: string) => [tag, tag];

const send = (
  c: TestClient,
  method: 'POST' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) => c.request({ method, url: `/api/v1${url}`, ...(payload === undefined ? {} : { payload }) });
const set = (app: FastifyInstance, id: string, patch: Record<string, unknown>) =>
  app.db.update(opportunities).set(patch).where(eq(opportunities.id, id)).run();
const noteOf = async (app: FastifyInstance, id: string, title: string) =>
  (await app.db
    .select()
    .from(activities)
    .where(and(eq(activities.opportunityId, id), eq(activities.title, title)))
    .orderBy(desc(activities.occurredAt))
    .get())!;

async function cardOf(
  app: FastifyInstance,
  c: TestClient,
  at: At,
  location: string | null,
): Promise<string> {
  const source = await ensureChannelSource(app.db, ctxOf(c), 'alert_email');
  const run = await createRun(app.db, ctxOf(c), { sourceId: source.id });
  const posting = postingAt(at, location, 'card', { externalId: idOf(at) });
  return (
    await insertResult(app.db, ctxOf(c), {
      runId: run.id,
      posting,
      dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
      resolution: 'full',
    })
  ).id;
}
const accept = async (c: TestClient, id: string, payload: Record<string, unknown> = {}) => {
  const res = await send(c, 'POST', `/discovery/results/${id}/accept`, payload);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ opportunityId: string }>().opportunityId;
};
const byHand = async (app: FastifyInstance, c: TestClient, over: Record<string, unknown> = {}) =>
  (
    await createOpportunity(app.db, ctxOf(c), {
      companyName: JOB.company,
      title: JOB.title,
      location: HERE,
      sourceKind: 'manual',
      ...over,
    })
  ).id;

/** A capture entry with no link. */
const bare = (app: FastifyInstance, c: TestClient, id: string, text: string | null) =>
  createActivity(app.db, ctxOf(c), id, {
    kind: 'capture',
    title: text?.startsWith(JOB.title) === true ? 'Captured from Indeed' : 'Captured from LinkedIn',
    bodyMd: text,
    occurredAt: Date.now(),
    participants: [],
    externalUrl: null,
  });

/** How the opportunity of the role came to be; its own posting is `own`, then captured at HERE. */
const ORIGINS = {
  'by the capture': async () => undefined,
  'by an Accept': async (app: FastifyInstance, c: TestClient, own: At) =>
    await accept(c, await cardOf(app, c, own, HERE)),
  'by hand': (app: FastifyInstance, c: TestClient) => byHand(app, c),
  'from mail': (app: FastifyInstance, c: TestClient) =>
    byHand(app, c, { location: null, sourceKind: 'communication' }),
  'by Create anyway': async (app: FastifyInstance, c: TestClient, own: At) => {
    const asked = await byHand(app, c);
    const id = await accept(c, await cardOf(app, c, own, HERE), { force: true });
    expect((await send(c, 'DELETE', `/opportunities/${asked}`)).statusCode).toBe(204);
    return id;
  },
};
const ORIGIN_NAMES = Object.keys(ORIGINS) as (keyof typeof ORIGINS)[];

describe.each(SITES)('the captured page that is read, on %s', (site) => {
  const OWN: At = [site, 1];
  const BOSTON: At = [site, 2];
  const OTHER_ID: At = [site, 3];
  const other = site === 'linkedin' ? 'indeed' : 'linkedin';

  describe.each(ORIGIN_NAMES)('of one made %s', (origin) => {
    const start = async (app: FastifyInstance, a: TestClient) => {
      await onBoard(app, a);
      const made = await ORIGINS[origin](app, a, OWN);
      const id = await capture(app, a, OWN, HERE, 'own1');
      if (made !== undefined) expect(id).toBe(made);
      return id;
    };

    it('its own, whatever joined since, and its own again', async () => {
      const { app, a } = await boot();
      const id = await start(app, a);
      expect(await capture(app, a, BOSTON, THERE, 'boston1')).toBe(id);
      expect(await reads(app, a, id)).toEqual(both('own1'));
      expect(await capture(app, a, OTHER_ID, HERE, 'other1')).toBe(id);
      expect(await reads(app, a, id)).toEqual(both('own1'));
      expect(await capture(app, a, OWN, HERE, 'own2')).toBe(id);
      expect(await reads(app, a, id)).toEqual(both('own2'));
      await capture(app, a, BOSTON, THERE, 'boston2');
      await capture(app, a, OTHER_ID, HERE, 'other2');
      expect(await reads(app, a, id)).toEqual(both('own2'));
    });

    // What a check merged is not lost by the next one, though the place the board writes is another
    // spelling of the page's.
    it.each(['the board', 'the user'])('its place respelled by %s in between', async (who) => {
      const { app, a } = await boot();
      const id = await start(app, a);
      await capture(app, a, BOSTON, THERE, 'boston1');
      if (who === 'the user') await set(app, id, { location: 'Remote' });
      const over = who === 'the board' ? { location: RESPELLED } : {};
      vi.mocked(runStructured).mockResolvedValue({ passages: [sentence('own1')] });
      for (let i = 0; i < 2; i += 1) {
        expect(await checked(app, a, id, over)).toBe('own1');
        const { descriptionMd, location } = await getOpportunity(app.db, ctxOf(a), id);
        expect(descriptionMd).toContain(ATS);
        expect(descriptionMd).toContain(sentence('own1'));
        expect(location).toBe(who === 'the board' ? RESPELLED : 'Remote');
      }
      expect(await rederived(app, a, id)).toBe('own1');
    });
  });

  describe('of one with no page of its own', () => {
    it('of the posting captured first, its newest', async () => {
      const { app, a } = await boot();
      await onBoard(app, a);
      const id = await byHand(app, a);
      expect(await capture(app, a, BOSTON, THERE, 'boston1')).toBe(id);
      expect(await capture(app, a, OTHER_ID, ELSEWHERE, 'denver1')).toBe(id);
      expect(await reads(app, a, id)).toEqual(both('boston1'));
      await capture(app, a, BOSTON, THERE, 'boston2');
      expect(await reads(app, a, id)).toEqual(both('boston2'));
      await capture(app, a, OTHER_ID, ELSEWHERE, 'denver2');
      expect(await reads(app, a, id)).toEqual(both('boston2'));
    });
  });

  it('a page with no id is its own, captured first or not', async () => {
    const { app, a } = await boot();
    await onBoard(app, a);
    const id = await byHand(app, a);
    await capture(app, a, BOSTON, THERE, 'boston1');
    await new Promise((r) => setTimeout(r, 3));
    await bare(app, a, id, textOf(site, 'bare1'));
    await capture(app, a, BOSTON, THERE, 'boston2');
    expect(await reads(app, a, id)).toEqual(both('bare1'));
  });

  it.each(['', null])('an entry with no text (%j) is no page', async (text) => {
    const { app, a } = await boot();
    await onBoard(app, a);
    const id = await capture(app, a, OWN, HERE, 'own1');
    await new Promise((r) => setTimeout(r, 3));
    await bare(app, a, id, text);
    expect(await reads(app, a, id)).toEqual(both('own1'));
  });

  it('the result it came from is its own, though its page came later and its place is respelled', async () => {
    const { app, a } = await boot();
    await onBoard(app, a);
    const id = await accept(a, await cardOf(app, a, OWN, HERE));
    expect(await capture(app, a, BOSTON, THERE, 'boston1')).toBe(id);
    await capture(app, a, OWN, HERE, 'own1');
    await set(app, id, { location: 'Remote' });
    await capture(app, a, BOSTON, THERE, 'boston2');
    expect(await reads(app, a, id)).toEqual(both('own1'));
  });

  it.each([
    ['unsuppressed since', () => ({ disposition: 'pending' as const, opportunityId: null })],
    ['dismissed since', () => ({ disposition: 'dismissed' as const })],
    ['another opportunity’s since', (another: string) => ({ opportunityId: another })],
  ])('one that no result of this opportunity’s knows is its own: %s', async (_what, patch) => {
    const { app, a } = await boot();
    await onBoard(app, a);
    const id = await capture(app, a, OWN, HERE, 'own1');
    await capture(app, a, BOSTON, THERE, 'boston1');
    expect((await capturedPage(app.db, ctxOf(a), id))?.text).toBe(textOf(site, 'own1'));
    const another = await byHand(app, a, { title: 'Another Role' });
    await app.db
      .update(discoveryResults)
      .set(patch(another))
      .where(eq(discoveryResults.dedupeKey, dedupeKey(JOB.company, JOB.title, THERE)))
      .run();
    expect(await reads(app, a, id)).toEqual(both('boston1'));
  });

  it('a posting Discovery linked, its page captured later: another’s', async () => {
    const { app, a } = await boot();
    await onBoard(app, a);
    const id = await capture(app, a, OWN, HERE, 'own1');
    const source = await ensureChannelSource(app.db, ctxOf(a), 'alert_email');
    const linked = postingAt(BOSTON, THERE, 'card', { externalId: idOf(BOSTON) });
    await insertLeads(app.db, ctxOf(a), [linked], source.id);
    expect(await capture(app, a, BOSTON, THERE, 'boston1')).toBe(id);
    expect(await reads(app, a, id)).toEqual(both('own1'));
  });

  it('what a merge brings is judged as what joined', async () => {
    const { app, a } = await boot();
    await onBoard(app, a);
    const id = await capture(app, a, OWN, HERE, 'own1');
    const merged = await capture(app, a, BOSTON, THERE, 'boston1', { title: 'Another Role' });
    expect(merged).not.toBe(id);
    const res = await send(a, 'POST', `/opportunities/${id}/merge`, { otherId: merged });
    expect(res.statusCode, res.body).toBe(200);
    expect(await reads(app, a, id)).toEqual(both('own1'));
    expect(await capture(app, a, BOSTON, THERE, 'boston2')).toBe(id);
    expect(await reads(app, a, id)).toEqual(both('own1'));
  });

  it('merged into another one, it is that one’s rule', async () => {
    const { app, a } = await boot();
    await onBoard(app, a);
    const into = await byHand(app, a, { title: 'Another Role', location: THERE });
    const id = await capture(app, a, OWN, HERE, 'own1');
    const res = await send(a, 'POST', `/opportunities/${into}/merge`, { otherId: id });
    expect(res.statusCode, res.body).toBe(200);
    await capture(app, a, BOSTON, THERE, 'boston1', { title: 'Another Role' });
    expect((await capturedPage(app.db, ctxOf(a), into))?.text).toBe(textOf(site, 'boston1'));
    await capture(app, a, OWN, HERE, 'own2');
    expect((await capturedPage(app.db, ctxOf(a), into))?.text).toBe(textOf(site, 'boston1'));
  });

  it('more than fifty entries later too', async () => {
    const { app, a } = await boot();
    await onBoard(app, a);
    const id = await capture(app, a, OWN, HERE, 'own1');
    await capture(app, a, BOSTON, THERE, 'boston1');
    for (let i = 0; i < 60; i += 1) {
      await createActivity(app.db, ctxOf(a), id, {
        kind: 'note',
        title: `note ${i}`,
        bodyMd: 'x',
        occurredAt: Date.now() + 1000,
        participants: [],
        externalUrl: null,
      });
    }
    expect(await reads(app, a, id)).toEqual(both('own1'));
  });

  it('another user’s results and pages say nothing', async () => {
    const { app, a, b } = await boot();
    await onBoard(app, a);
    const theirs = await capture(app, b, BOSTON, HERE, 'theirs1');
    const id = await capture(app, a, OWN, HERE, 'own1');
    await capture(app, a, BOSTON, THERE, 'boston1');
    expect(await reads(app, a, id)).toEqual(both('own1'));
    expect((await capturedPage(app.db, ctxOf(b), theirs))?.text).toBe(textOf(site, 'theirs1'));
    await expect(capturedPage(app.db, ctxOf(b), id)).rejects.toMatchObject({ code: 'not_found' });
  });

  describe('what is said', () => {
    const FROM = `the page captured from ${LABEL[site]}, already on this timeline`;
    const REDERIVED = 'Description re-derived from capture';
    const CONFIRMED = "Posting confirmed on the company's board";

    it.each([false, true])('Re-derive names the page; another posting’s there: %s', async (two) => {
      const { app, a } = await boot();
      await onBoard(app, a);
      const id = await capture(app, a, OWN, HERE, 'own1');
      if (two) await capture(app, a, [other, 2], THERE, 'boston1');
      await rederived(app, a, id);
      expect(await noteOf(app, id, REDERIVED)).toMatchObject({
        bodyMd:
          'No confident match was found on the company’s board, so the board was left out of ' +
          `this change: the description came from ${FROM}.`,
        externalUrl: urlOf(OWN),
      });
      await new Promise((r) => setTimeout(r, 3));
      expect((await rederive(app, a, id, board())).kind).toBe('merged');
      expect(await noteOf(app, id, REDERIVED)).toMatchObject({
        bodyMd: `A confident match on the company's board took priority, merged as usual with ${FROM}.`,
        externalUrl: urlOf(OWN),
      });
    });

    it.each([
      [false, "Merged the board's copy with details only the captured page had."],
      [true, `Merged the board's copy with details only the captured page (${LABEL[site]}) had.`],
    ])('the check; another posting’s page there: %s', async (two, said) => {
      const { app, a } = await boot();
      await onBoard(app, a);
      const id = await capture(app, a, OWN, HERE, 'own1');
      await capture(app, a, OWN, HERE, 'own2');
      if (two) await capture(app, a, [other, 2], THERE, 'boston1');
      vi.mocked(runStructured).mockResolvedValue({ passages: [sentence('own2')] });
      expect(await checked(app, a, id)).toBe('own2');
      const note = await noteOf(app, id, CONFIRMED);
      expect(note.bodyMd).toContain(said);
      expect(note.externalUrl).toBeNull();
    });

    it.each([['javascript:alert(1)'], [null]])('no link for a page of %j', async (url) => {
      const { app, a } = await boot();
      const id = await byHand(app, a);
      await createActivity(app.db, ctxOf(a), id, {
        kind: 'capture',
        title: `Captured from ${LABEL[site]}`,
        bodyMd: textOf(site, 'bare1'),
        occurredAt: Date.now(),
        participants: [],
        externalUrl: url,
      });
      expect(await rederived(app, a, id)).toBe('bare1');
      expect((await noteOf(app, id, REDERIVED)).externalUrl).toBeNull();
    });
  });
});
