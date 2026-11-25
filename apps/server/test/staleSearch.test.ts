// A posting check or Find posting started before the user changed the company, the title or the posting
// link attaches nothing it found for the old values (https://github.com/bgoleno/opportun/issues/892).
import { runStructured } from '@opportun/ai';
import { newId, type NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { lockScope, withTransaction } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import {
  activities,
  applicationSubmissions,
  auditLog,
  companies,
  jobs,
  opportunities,
  resumes,
} from '../src/db/schema';
import { reconcilePosting } from '../src/jobs/postingReconcile';
import { attachPosting } from '../src/lib/postingAttach';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import { setRaceHook } from '../src/lib/racePoints';
import type { safeFetch } from '../src/lib/safeFetch';
import { createActivity } from '../src/repos/activities';
import { createCompany, updateCompany } from '../src/repos/companies';
import {
  createOpportunity,
  getOpportunity,
  SearchBasisChanged,
  searchBasisOf,
  updateOpportunity,
} from '../src/repos/opportunities';
import { insertResume } from '../src/repos/resumes';
import { createSubmissionDraft } from '../src/repos/submissions';
import { useApi } from './api';
import { testDialect } from './db';
import type { TestClient } from './isolation';
import { pauseAt, someoneBlocked, whileParked } from './race';

vi.mock('@opportun/ai', async (orig) => ({
  ...(await orig<typeof import('@opportun/ai')>()),
  runStructured: vi.fn(),
}));

/** Runs while a request is out, and whether Greenhouse has the job it is asked for. */
let asked: (() => Promise<unknown>) | undefined;
let hasJob = false;
const fetch = (async (url: string) => {
  const now = asked;
  asked = undefined;
  await now?.();
  const has = hasJob && url.includes('/examplecorp/');
  return {
    status: has ? 200 : 404,
    headers: new Headers(),
    body: Buffer.from(has ? JSON.stringify({ id: Number(JID) }) : '{}'),
  };
}) as unknown as typeof safeFetch;
const JID = '8136554';
const CAREERS = `https://careers.examplecorp.example/jobs?gh_jid=${JID}`;
const boot = useApi(() => ({ build: { sourceFetch: fetch } }));
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const sctx = { fetch, log: { warn() {}, info() {}, error() {} } as never };

const TITLE = 'Staff Platform Engineer';
const OTHER_TITLE = 'Office Manager';
const CAPTURED = 'What the captured page said.';
const jobUrl = (org: string, id: string) => `https://boards.greenhouse.io/${org}/jobs/${id}`;
const OLD_LINK = 'https://www.linkedin.com/jobs/view/1000000001';
const NEW_LINK = jobUrl('othercorp', '9000009');

const posting = (over: Partial<NormalizedPosting> = {}): NormalizedPosting => ({
  company: 'Example Corp',
  title: TITLE,
  descriptionMd: 'What the board says of the old job, at length.',
  postingUrl: jobUrl('examplecorp', '1000001'),
  location: 'Remote',
  compNote: '$200k',
  externalId: '1000001',
  ...over,
});

/** The companies' boards; `held` runs while one is being read. */
let onBoard: Record<string, NormalizedPosting[]> = {};
let held: (() => Promise<unknown>) | undefined;
let boardReads = 0;
let boardFails = false;
const boards: DiscoverySource = {
  kind: 'ats_greenhouse',
  async *fetchPostings(sourceCtx: { config: Record<string, unknown> }) {
    boardReads += 1;
    const now = held;
    held = undefined;
    const said = new Map(Object.entries(onBoard)).get(JSON.stringify(sourceCtx.config));
    await now?.();
    if (boardFails) throw new Error('the board does not answer');
    for (const p of said ?? onBoard.examplecorp ?? []) yield { posting: p, nextCursor: null };
  },
} as unknown as DiscoverySource;

beforeEach(() => {
  onBoard = { examplecorp: [posting()] };
  held = undefined;
  asked = undefined;
  hasJob = false;
  boardReads = 0;
  boardFails = false;
  registerSource(boards);
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockResolvedValue({ passages: [] });
});
afterEach(() => resetSources());

async function seed(
  app: FastifyInstance,
  c: TestClient,
  over: Record<string, unknown> = {},
): Promise<string> {
  for (const [name, org] of [
    ['Example Corp', 'examplecorp'],
    ['Other Corp', 'othercorp'],
  ] as const) {
    const there = await app.db
      .select()
      .from(companies)
      .where(and(eq(companies.userId, c.userId), eq(companies.name, name)))
      .get();
    if (there !== undefined) continue;
    await createCompany(app.db, ctxOf(c), {
      name,
      atsKind: 'ats_greenhouse',
      atsRef: org,
      atsVerifiedAt: 1,
    });
  }
  const { id } = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Example Corp',
    title: typeof over.title === 'string' ? over.title : TITLE,
    sourceKind: 'discovery',
    postingUrl: OLD_LINK,
  });
  await app.db
    .update(opportunities)
    .set({
      descriptionMd: CAPTURED,
      descriptionFingerprint: descriptionFingerprint(CAPTURED),
      postingState: 'searching',
      ...over,
    })
    .where(eq(opportunities.id, id))
    .run();
  return id;
}

const save = async (c: TestClient, id: string, payload: Record<string, unknown>) => {
  const res = await c.request({ method: 'PATCH', url: `/api/v1/opportunities/${id}`, payload });
  expect(res.statusCode, res.body).toBe(200);
};
const find = (c: TestClient, id: string) =>
  c.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });
const check = (app: FastifyInstance, c: TestClient, id: string) =>
  reconcilePosting(app.db, ctxOf(c), id, sctx);

/** A live application of the opportunity's job. */
async function draft(app: FastifyInstance, c: TestClient, id: string): Promise<string> {
  const resume = await insertResume(app.db, ctxOf(c), {
    kind: 'base',
    title: 'Resume',
    store: 'local_file',
    docRef: `resumes/${newId()}.txt`,
    opportunityId: null,
    parentResumeId: null,
  });
  await app.db.update(resumes).set({ status: 'final' }).where(eq(resumes.id, resume.id)).run();
  const { submission } = await createSubmissionDraft(app.db, ctxOf(c), id, {
    idempotencyKey: newId(),
    resumeId: resume.id,
  });
  return submission.id;
}

/** A row as it compares with another user's: no ids or times, and the company by its name. */
async function factsOf(app: FastifyInstance, id: string) {
  const row = (await app.db.select().from(opportunities).where(eq(opportunities.id, id)).get())!;
  const company = (await app.db
    .select()
    .from(companies)
    .where(eq(companies.id, row.companyId))
    .get())!;
  const facts = {
    ...row,
    id: '',
    userId: '',
    companyId: company.name,
    createdAt: 0,
    updatedAt: 0,
    postingState: null,
    postingStateDetail: null,
  };
  return facts;
}
const stateOf = async (app: FastifyInstance, id: string) => {
  const row = (await app.db.select().from(opportunities).where(eq(opportunities.id, id)).get())!;
  return [row.postingState, row.postingStateDetail];
};
const entriesOf = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(activities).where(eq(activities.opportunityId, id)).all()).filter(
    (e) => e.kind === 'note' || e.kind === 'link',
  );

const STOPPED = 'Posting check stopped: the opportunity changed';
type Change = [what: string, patch: Record<string, unknown>, named: string];
const CHANGES: Change[] = [
  ['the company', { companyName: 'Other Corp' }, 'company'],
  ['the title', { title: OTHER_TITLE }, 'title'],
  ['the title, by case alone', { title: TITLE.toUpperCase() }, 'title'],
  ['the link', { postingUrl: NEW_LINK }, 'posting link'],
  ['the link, taken off', { postingUrl: null }, 'posting link'],
  [
    'the company and the link',
    { companyName: 'Other Corp', postingUrl: NEW_LINK },
    'company and posting link',
  ],
];

const otherCompanyId = async (app: FastifyInstance, c: TestClient): Promise<string> =>
  (await app.db
    .select()
    .from(companies)
    .where(and(eq(companies.userId, c.userId), eq(companies.name, 'Other Corp')))
    .get())!.id;
/** A patch as a save writes it, without the save's own locks. */
const rawOf = (patch: Record<string, unknown>, otherId: string): Record<string, unknown> =>
  'companyName' in patch ? { companyId: otherId } : patch;

/** The same change made to another user's, with no search beside it: what a search must leave. */
async function twinOf(
  app: FastifyInstance,
  b: TestClient,
  patch: Record<string, unknown>,
  over: Record<string, unknown> = {},
) {
  const id = await seed(app, b, over);
  await save(b, id, patch);
  return await factsOf(app, id);
}
async function expectLeft(
  app: FastifyInstance,
  b: TestClient,
  id: string,
  patch: Record<string, unknown>,
  named: string,
  over: Record<string, unknown> = {},
) {
  expect(await factsOf(app, id)).toEqual(await twinOf(app, b, patch, over));
  const entries = await entriesOf(app, id);
  expect(entries.map((e) => e.title)).toEqual([STOPPED]);
  expect(entries[0]!.bodyMd).toContain(`The ${named} `);
}

describe('a posting check', () => {
  describe.each(CHANGES)('%s changed', (_what, patch, named) => {
    it('while the board is read', async () => {
      const { app, a, b } = await boot();
      const id = await seed(app, a);
      held = () => save(a, id, patch);
      const outcome = await check(app, a, id);
      expect(boardReads).toBe(1);
      await expectLeft(app, b, id, patch, named);
      expect(await stateOf(app, id)).toEqual(['needs_review', 'failed']);
      expect(outcome).toMatchObject({ status: 'needs_review', detail: 'failed', stopped: true });
    });

    it('between its last read and its write', async () => {
      const { app, a, b } = await boot();
      const id = await seed(app, a);
      const pause = pauseAt('posting.confirm');
      const [outcome] = await Promise.all([
        check(app, a, id),
        whileParked(pause, () => save(a, id, patch)),
      ]);
      await expectLeft(app, b, id, patch, named);
      expect(await stateOf(app, id)).toEqual(['needs_review', 'failed']);
      expect(outcome).toMatchObject({ status: 'needs_review', detail: 'failed', stopped: true });
    });
  });
});

describe('Find posting', () => {
  describe.each(CHANGES)('%s changed', (_what, patch, named) => {
    it('while the board is read', async () => {
      const { app, a, b } = await boot();
      const over = { postingState: null };
      const id = await seed(app, a, over);
      held = () => save(a, id, patch);
      const res = await find(a, id);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: 'opportunity_changed' } });
      expect(boardReads).toBe(1);
      await expectLeft(app, b, id, patch, named, over);
      expect(await stateOf(app, id)).toEqual([null, null]);
    });
  });
});

const SMALL = CHANGES.filter(([what]) => ['the company', 'the title', 'the link'].includes(what));
/** What a search can find, beside one match. */
const ANSWERS: [what: string, arrange: () => void][] = [
  [
    'several',
    () => {
      onBoard.examplecorp = [
        posting({ title: `${TITLE}, Payments` }),
        posting({
          title: `${TITLE}, Search`,
          externalId: '1000002',
          postingUrl: jobUrl('examplecorp', '1000002'),
        }),
      ];
    },
  ],
  ['none', () => (onBoard.examplecorp = [posting({ title: 'Chef' })])],
  ['a board that does not answer', () => (boardFails = true)],
];

describe('whatever was found', () => {
  describe.each(ANSWERS)('%s', (_answer, arrange) => {
    it.each(SMALL)('a check, %s changed', async (_what, patch, named) => {
      const { app, a, b } = await boot();
      const id = await seed(app, a);
      arrange();
      held = () => save(a, id, patch);
      expect(await check(app, a, id)).toMatchObject({ detail: 'failed', stopped: true });
      boardFails = false;
      await expectLeft(app, b, id, patch, named);
      expect(await stateOf(app, id)).toEqual(['needs_review', 'failed']);
    });

    it.each(SMALL)('Find posting, %s changed: no result is shown', async (_what, patch, named) => {
      const { app, a, b } = await boot();
      const over = { postingState: 'needs_review', postingStateDetail: 'none_found' };
      const id = await seed(app, a, over);
      arrange();
      held = () => save(a, id, patch);
      const res = await find(a, id);
      expect([res.statusCode, res.json<{ error: { code: string } }>().error.code]).toEqual([
        409,
        'opportunity_changed',
      ]);
      await expectLeft(app, b, id, patch, named, over);
      expect(await stateOf(app, id)).toEqual(['needs_review', 'failed']);
    });

    it('control: nothing changed', async () => {
      const { app, a } = await boot();
      const id = await seed(app, a, { postingState: null });
      arrange();
      expect((await find(a, id)).statusCode).toBe(200);
      await check(app, a, id);
      expect((await entriesOf(app, id)).map((e) => e.title)).not.toContain(STOPPED);
    });
  });

  it.each(SMALL)('no board, %s changed while one is looked for', async (_what, patch, named) => {
    const { app, a, b } = await boot();
    const noBoard = async (c: TestClient) => {
      const id = await seed(app, c);
      await app.db
        .update(companies)
        .set({ atsKind: null, atsRef: null })
        .where(eq(companies.name, 'Example Corp'))
        .run();
      return id;
    };
    const id = await noBoard(a);
    asked = () => save(a, id, patch);
    const res = await find(a, id);
    expect(res.statusCode, res.body).toBe(409);
    const twin = await noBoard(b);
    await save(b, twin, patch);
    expect(await factsOf(app, id)).toEqual(await factsOf(app, twin));
    const [entry, ...more] = await entriesOf(app, id);
    expect([entry?.title, more.length]).toEqual([STOPPED, 0]);
    expect(entry!.bodyMd).toContain(`The ${named} `);
  });

  it('a company renamed on its own page is the same one, said by its new name', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    onBoard.examplecorp = [posting({ title: 'Chef' })];
    const { companyId } = (await app.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, id))
      .get())!;
    held = () => updateCompany(app.db, ctxOf(a), companyId, { name: 'Renamed Corp' });
    expect(await check(app, a, id)).toEqual({ status: 'needs_review', detail: 'none_found' });
    const [note] = await entriesOf(app, id);
    expect(note!.bodyMd).toContain('Renamed Corp');
    expect(note!.bodyMd).not.toContain('Example Corp');
  });
});

describe('what is no change', () => {
  const HARMLESS: [
    string,
    (app: FastifyInstance, c: TestClient, id: string) => Promise<unknown>,
  ][] = [
    [
      'the company written otherwise',
      (_app, c, id) => save(c, id, { companyName: ' EXAMPLE corp ' }),
    ],
    ['the same link', (_app, c, id) => save(c, id, { postingUrl: OLD_LINK })],
    [
      'a place, remote and pay',
      (_app, c, id) => save(c, id, { location: 'Austin, TX', remote: false, compNote: '$1' }),
    ],
    [
      'the title, put back',
      async (_app, c, id) => {
        await save(c, id, { title: OTHER_TITLE });
        await save(c, id, { title: TITLE });
      },
    ],
    [
      'the company and the link, put back',
      async (_app, c, id) => {
        await save(c, id, { companyName: 'Other Corp', postingUrl: NEW_LINK });
        await save(c, id, { companyName: 'Example Corp', postingUrl: OLD_LINK });
      },
    ],
  ];
  it.each(HARMLESS)(
    '%s: a check confirms, while the board is read or just before the write',
    async (_what, act) => {
      for (const point of ['board', 'posting.confirm']) {
        const { app, a } = await boot();
        const id = await seed(app, a);
        let outcome;
        if (point === 'board') {
          held = () => act(app, a, id);
          outcome = await check(app, a, id);
        } else {
          const pause = pauseAt(point);
          [outcome] = await Promise.all([
            check(app, a, id),
            whileParked(pause, () => act(app, a, id)),
          ]);
        }
        expect(outcome).toEqual({ status: 'confirmed', detail: null });
        expect((await factsOf(app, id)).postingUrl).toBe(jobUrl('examplecorp', '1000001'));
      }
    },
  );
  it.each(HARMLESS)('%s: Find posting attaches', async (_what, act) => {
    const { app, a } = await boot();
    const id = await seed(app, a, { postingState: null });
    held = () => act(app, a, id);
    const res = await find(a, id);
    expect(res.json()).toMatchObject({ outcome: 'attached' });
    expect(await stateOf(app, id)).toEqual(['confirmed', null]);
  });

  it.each([null, OLD_LINK])(
    'with the link %s all along: confirms, and one saved stops it',
    async (link) => {
      for (const changes of [false, true]) {
        const { app, a } = await boot();
        const id = await seed(app, a, { postingUrl: link });
        if (changes) held = () => save(a, id, { postingUrl: NEW_LINK });
        const outcome = await check(app, a, id);
        expect(outcome.status).toBe(changes ? 'needs_review' : 'confirmed');
        expect((await factsOf(app, id)).postingUrl).toBe(
          changes ? NEW_LINK : jobUrl('examplecorp', '1000001'),
        );
      }
    },
  );
});

describe('what is left as it was', () => {
  it.each([
    ['confirmed', null],
    ['confirmed', 'user_confirmed'],
    ['needs_review', 'edited'],
    ['needs_review', 'failed'],
    [null, null],
  ] as const)('the state %s / %s', async (postingState, postingStateDetail) => {
    const { app, a } = await boot();
    const mine = postingState === 'needs_review' && postingStateDetail === 'edited';
    const id = await seed(app, a, {
      postingState,
      postingStateDetail,
      ...(mine ? { descriptionMd: 'Mine.' } : {}),
    });
    held = () => save(a, id, { title: OTHER_TITLE });
    expect((await find(a, id)).statusCode).toBe(409);
    expect(await stateOf(app, id)).toEqual([postingState, postingStateDetail]);
    expect((await entriesOf(app, id)).map((e) => e.title)).toEqual([STOPPED]);
  });

  it.each(['ambiguous', 'none_found', 'no_board'])(
    'but not needs_review / %s, which a search was what it waited for',
    async (postingStateDetail) => {
      const { app, a } = await boot();
      const id = await seed(app, a, { postingState: 'needs_review', postingStateDetail });
      held = () => save(a, id, { title: OTHER_TITLE });
      expect((await find(a, id)).statusCode).toBe(409);
      expect(await stateOf(app, id)).toEqual(['needs_review', 'failed']);
    },
  );

  it.each(SMALL)(
    'a confirmed posting under the user’s own words, a match only offered: %s changed, it is not',
    async (_what, patch) => {
      const { app, a } = await boot();
      const id = await seed(app, a, { postingState: 'confirmed', descriptionMd: 'My own words.' });
      expect((await find(a, id)).json()).toMatchObject({ outcome: 'candidates' });
      held = () => save(a, id, patch);
      expect((await find(a, id)).statusCode).toBe(409);
      expect(await stateOf(app, id)).toEqual(['confirmed', null]);
    },
  );

  it('a state that another request settled meanwhile', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    held = async () => {
      await save(a, id, { title: OTHER_TITLE });
      await app.db
        .update(opportunities)
        .set({ postingState: 'confirmed', postingStateDetail: 'user_confirmed' })
        .where(eq(opportunities.id, id))
        .run();
    };
    expect(await check(app, a, id)).toEqual({
      status: 'left_alone',
      detail: 'user_confirmed',
      stopped: true,
    });
    expect(await stateOf(app, id)).toEqual(['confirmed', 'user_confirmed']);
  });

  it.each(SMALL)(
    'the user’s own description and the rest, %s changed: Find posting',
    async (_what, patch, named) => {
      const { app, a, b } = await boot();
      const over = { descriptionMd: 'My own words.', postingState: null };
      const id = await seed(app, a, over);
      held = () => save(a, id, patch);
      expect((await find(a, id)).statusCode).toBe(409);
      await expectLeft(app, b, id, patch, named, over);
    },
  );

  it('a description saved with the company: the company is what is said', async () => {
    for (const how of ['check', 'find']) {
      const { app, a, b } = await boot();
      const id = await seed(app, a, how === 'find' ? { postingState: null } : {});
      const patch = { companyName: 'Other Corp', descriptionMd: 'My own words.' };
      held = () => save(a, id, patch);
      if (how === 'check') await check(app, a, id);
      else
        expect((await find(a, id)).json()).toMatchObject({
          error: { code: 'opportunity_changed' },
        });
      await expectLeft(app, b, id, patch, 'company', how === 'find' ? { postingState: null } : {});
    }
  });

  it('a description alone is as before: kept, and said as that', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    held = () => save(a, id, { descriptionMd: 'My own words.' });
    expect(await check(app, a, id)).toEqual({ status: 'needs_review', detail: 'edited' });
  });

  it('nothing is searched again by itself', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    held = () => save(a, id, { title: OTHER_TITLE });
    const before = await app.db.select().from(jobs).all();
    await check(app, a, id);
    expect(await app.db.select().from(jobs).all()).toEqual(before);
    expect(boardReads).toBe(1);
    // And can be, for what it is now.
    onBoard.examplecorp = [posting({ title: OTHER_TITLE })];
    expect((await find(a, id)).json()).toMatchObject({ outcome: 'attached' });
  });

  it('a second one says its own, in the one note', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    held = () => save(a, id, { title: OTHER_TITLE });
    await check(app, a, id);
    held = () => save(a, id, { companyName: 'Other Corp' });
    await check(app, a, id);
    const entries = await entriesOf(app, id);
    expect(entries.map((e) => e.title)).toEqual([STOPPED]);
    expect(entries[0]!.bodyMd).toContain('The company changed');
    expect(entries[0]!.bodyMd).not.toContain('title');
  });

  it('a live application is not told that its posting changed, and is told once when it did', async () => {
    const { app, a } = await boot();
    for (const stopped of [true, false]) {
      const ref = {
        kind: 'ats_greenhouse' as const,
        org: 'examplecorp',
        externalId: '7',
        url: jobUrl('examplecorp', '7'),
      };
      const id = await seed(app, a, {
        title: `${TITLE}${stopped ? '' : ' II'}`,
        postingState: 'confirmed',
        atsJobRef: ref,
        postingUrl: ref.url,
        stage: 'interested',
      });
      onBoard.examplecorp = [
        posting({ title: `${TITLE}${stopped ? '' : ' II'}`, externalId: '7', postingUrl: ref.url }),
      ];
      const submissionId = await draft(app, a, id);
      // The board names another job for it now, under another link.
      onBoard.examplecorp = [posting({ title: `${TITLE}${stopped ? '' : ' II'}` })];
      await app.db
        .update(opportunities)
        .set({ atsJobRef: null, postingUrl: OLD_LINK })
        .where(eq(opportunities.id, id))
        .run();
      if (stopped) held = () => save(a, id, { title: OTHER_TITLE });
      const outcome = await check(app, a, id);
      expect(outcome.status).toBe(stopped ? 'left_alone' : 'confirmed');
      const row = await app.db
        .select()
        .from(applicationSubmissions)
        .where(eq(applicationSubmissions.id, submissionId))
        .get();
      expect(row?.postingChangedAt === null).toBe(stopped);
      const said = await app.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.event, 'submission.posting_changed'))
        .all();
      expect(said).toHaveLength(stopped ? 0 : 1);
    }
  });
});

describe('the write itself', () => {
  const basisOf = async (app: FastifyInstance, c: TestClient, id: string) =>
    searchBasisOf(await getOpportunity(app.db, ctxOf(c), id));
  const ended = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: unknown) => (e instanceof SearchBasisChanged ? e.fields : (e as { code?: string }).code),
    );

  it.each([
    ['nothing', {}, 'ok'],
    [
      'the company and the title',
      { companyName: 'Other Corp', title: OTHER_TITLE },
      ['company', 'title'],
    ],
    ['the link', { postingUrl: NEW_LINK }, ['posting link']],
    ['the link, taken off', { postingUrl: null }, ['posting link']],
  ])('%s changed: with a settle and without', async (_what, patch, expected) => {
    for (const link of [OLD_LINK, null]) {
      for (const settles of [false, true]) {
        const { app, a } = await boot();
        const id = await seed(app, a, { postingUrl: link });
        const ifBasis = await basisOf(app, a, id);
        if (Object.keys(patch).length > 0) await save(a, id, patch);
        const same =
          JSON.stringify(expected) === '["posting link"]' &&
          link === null &&
          'postingUrl' in patch &&
          patch.postingUrl === null;
        const settle = vi.fn(() => ({ postingState: 'confirmed' as const, atsJobRef: null }));
        const got = await ended(
          updateOpportunity(
            app.db,
            ctxOf(a),
            id,
            { compNote: 'written' },
            {
              ifBasis,
              ...(settles ? { settle } : {}),
            },
          ),
        );
        expect(got).toEqual(same ? 'ok' : expected);
        const ok = got === 'ok';
        expect((await factsOf(app, id)).compNote).toBe(ok ? 'written' : null);
        // Made from the row it replaces, so not from one it does not.
        expect(settle).toHaveBeenCalledTimes(settles && ok ? 1 : 0);
      }
    }
  });

  it('an opportunity that is gone is not found, and one that is another user’s', async () => {
    const { app, a, b } = await boot();
    const id = await seed(app, a);
    const ifBasis = await basisOf(app, a, id);
    const write = (c: TestClient) =>
      ended(updateOpportunity(app.db, ctxOf(c), id, { compNote: 'x' }, { ifBasis }));
    expect(await write(b)).toBe('not_found');
    expect(
      (await a.request({ method: 'DELETE', url: `/api/v1/opportunities/${id}` })).statusCode,
    ).toBe(204);
    expect(await write(a)).toBe('not_found');
  });

  it('an attach of what was found for another asks nobody and writes nothing', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { postingUrl: null });
    const ifBasis = await basisOf(app, a, id);
    await save(a, id, { title: OTHER_TITLE });
    const before = await factsOf(app, id);
    let requests = 0;
    asked = async () => void (requests += 1);
    const got = await ended(
      attachPosting(
        app.db,
        ctxOf(a),
        id,
        posting({ postingUrl: CAREERS }),
        'board',
        undefined,
        { sctx },
        { ifBasis },
      ),
    );
    expect([got, requests]).toEqual([['title'], 0]);
    expect(await factsOf(app, id)).toEqual(before);
  });
});

describe('one statement', () => {
  /** The race points passed on the way. */
  const points = async (act: () => Promise<unknown>) => {
    const seen: string[] = [];
    setRaceHook((point) => void seen.push(point));
    await act();
    setRaceHook(undefined);
    return seen.filter((x) => x.startsWith('opportunities.'));
  };
  it('writes a check’s link, identity and state, and an attach’s', async () => {
    const { app, a } = await boot();
    const one = await seed(app, a);
    const ONCE = ['opportunities.update.attemptLocked', 'opportunities.update.locked'];
    expect(await points(() => check(app, a, one))).toEqual(ONCE);
    expect(await factsOf(app, one)).toMatchObject({ atsJobRef: { externalId: '1000001' } });
    expect(await stateOf(app, one)).toEqual(['confirmed', null]);
    const two = await seed(app, a, { title: 'Two', postingState: null, postingUrl: null });
    onBoard.examplecorp = [posting({ title: 'Two', location: 'Denver, CO' })];
    expect(await points(() => find(a, two))).toEqual(ONCE);
    expect(await factsOf(app, two)).toMatchObject({ atsJobRef: { externalId: '1000001' } });
    expect(await stateOf(app, two)).toEqual(['confirmed', null]);
  });

  // The row is held from the judgement to the write, so a save is before both or after both.
  describe.runIf(testDialect === 'postgres')('beside a save', () => {
    it.each(SMALL)('%s, before it has the row: nothing is written', async (_what, patch, named) => {
      onSlowTransaction(() => undefined); // parked on purpose
      const { app, a } = await boot();
      const id = await seed(app, a);
      const pause = pauseAt('opportunities.update.attemptLocked');
      const [outcome] = await Promise.all([
        check(app, a, id),
        whileParked(pause, async () =>
          app.db
            .update(opportunities)
            .set(rawOf(patch, await otherCompanyId(app, a)))
            .where(eq(opportunities.id, id))
            .run(),
        ),
      ]);
      expect(outcome).toMatchObject({ stopped: true });
      expect((await entriesOf(app, id)).map((e) => e.title)).toEqual([STOPPED]);
      expect((await entriesOf(app, id))[0]!.bodyMd).toContain(`The ${named} `);
      expect((await factsOf(app, id)).descriptionMd).toBe(CAPTURED);
    });

    it.each(SMALL)(
      '%s, once it has the row: waits, and lands on what was confirmed',
      async (_what, patch) => {
        onSlowTransaction(() => undefined);
        const { app, a } = await boot();
        const id = await seed(app, a);
        const pause = pauseAt('opportunities.update.locked');
        const checking = check(app, a, id);
        await pause.reached;
        const saving = save(a, id, patch);
        const blocked = await someoneBlocked(app);
        pause.release();
        expect((await checking).status).toBe('confirmed');
        await saving;
        expect(blocked).toBe(true);
        expect(await factsOf(app, id)).toMatchObject({
          descriptionMd: posting().descriptionMd,
          ...('title' in patch ? patch : {}),
          ...('postingUrl' in patch ? patch : {}),
        });
      },
    );
  });

  it.runIf(testDialect === 'postgres')(
    'takes the live application’s lock before the row',
    async () => {
      onSlowTransaction(() => undefined);
      const { app, a } = await boot();
      const id = await seed(app, a);
      const ref = {
        kind: 'ats_greenhouse' as const,
        org: 'examplecorp',
        externalId: '7',
        url: jobUrl('examplecorp', '7'),
      };
      await app.db
        .update(opportunities)
        .set({
          stage: 'interested',
          postingState: 'confirmed',
          atsJobRef: ref,
          postingUrl: ref.url,
        })
        .where(eq(opportunities.id, id))
        .run();
      const submissionId = await draft(app, a, id);
      onBoard.examplecorp = [posting({ externalId: '7', postingUrl: jobUrl('examplecorp', '7') })];
      let go!: () => void;
      const gate = new Promise<void>((r) => (go = r));
      let has!: () => void;
      const reached = new Promise<void>((r) => (has = r));
      const other = withTransaction(app.db, async (tx) => {
        await lockScope(tx, `submission:${submissionId}`);
        has();
        await gate;
        await tx
          .update(opportunities)
          .set({ compNote: 'its own' })
          .where(eq(opportunities.id, id))
          .run();
      });
      await reached;
      const checking = check(app, a, id);
      const blocked = await someoneBlocked(app);
      go();
      await other;
      expect((await checking).status).toBe('confirmed');
      expect(blocked).toBe(true);
    },
  );
});

describe('Find posting, between what it found and its write', () => {
  describe.each(['posting.found', 'posting.attach'])('%s', (point) => {
    it.each(SMALL)('%s changed', async (_what, patch, named) => {
      const { app, a, b } = await boot();
      const over = { postingState: null };
      const id = await seed(app, a, over);
      const pause = pauseAt(point);
      const [res] = await Promise.all([find(a, id), whileParked(pause, () => save(a, id, patch))]);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: 'opportunity_changed' } });
      await expectLeft(app, b, id, patch, named, over);
    });
  });

  it('a Refetch says what it changed itself, and not someone else’s edit', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, { postingState: null, postingUrl: null });
    expect((await find(a, id)).json()).toMatchObject({ outcome: 'attached' });
    const pause = pauseAt('posting.attach');
    const [res] = await Promise.all([
      find(a, id),
      whileParked(pause, () => save(a, id, { location: 'Denver, CO', compNote: '$1' })),
    ]);
    expect(res.json()).toMatchObject({ outcome: 'attached', unchanged: true });
    expect(await stateOf(app, id)).toEqual(['confirmed', null]);
  });
});

describe('a row picked from what was found', () => {
  const attach = (c: TestClient, id: string, payload: Record<string, unknown>) =>
    c.request({ method: 'POST', url: `/api/v1/opportunities/${id}/posting`, payload });
  const found = async (app: FastifyInstance, c: TestClient, title = TITLE) => {
    const id = await seed(app, c, {
      title,
      postingState: 'needs_review',
      postingStateDetail: 'ambiguous',
    });
    onBoard.examplecorp = [
      posting({ title: `${title}, Payments` }),
      posting({
        title: `${title}, Search`,
        externalId: '1000002',
        postingUrl: jobUrl('examplecorp', '1000002'),
      }),
    ];
    const res = await find(c, id);
    expect(res.json()).toMatchObject({ outcome: 'candidates', searchedFor: expect.any(String) });
    return {
      id,
      searchedFor: res.json<{ searchedFor: string }>().searchedFor,
      posting: onBoard.examplecorp[0]!,
    };
  };

  it('attached while nothing changed, or what did was put back', async () => {
    for (const back of [false, true]) {
      const { app, a } = await boot();
      const { id, ...picked } = await found(app, a);
      if (back) {
        await save(a, id, { title: OTHER_TITLE });
        await save(a, id, { title: TITLE });
      }
      const res = await attach(a, id, picked);
      expect(res.statusCode, res.body).toBe(200);
      expect(await stateOf(app, id)).toEqual(['confirmed', null]);
    }
  });

  it.each(CHANGES)('refused once it did: %s', async (_what, patch) => {
    const { app, a } = await boot();
    const { id, ...picked } = await found(app, a);
    await save(a, id, patch);
    const before = [await factsOf(app, id), await stateOf(app, id), await entriesOf(app, id)];
    const res = await attach(a, id, picked);
    expect([res.statusCode, res.json<{ error: { code: string } }>().error.code]).toEqual([
      409,
      'opportunity_changed',
    ]);
    // The person is told on the spot: nothing is written of it.
    expect([await factsOf(app, id), await stateOf(app, id), await entriesOf(app, id)]).toEqual(
      before,
    );
  });

  it.each(SMALL)('refused when it does as it is attached: %s', async (_what, patch) => {
    const { app, a } = await boot();
    const { id, ...picked } = await found(app, a);
    const pause = pauseAt('posting.attach');
    const [res] = await Promise.all([
      attach(a, id, picked),
      whileParked(pause, () => save(a, id, patch)),
    ]);
    expect(res.statusCode, res.body).toBe(409);
    expect(await entriesOf(app, id)).toEqual([]);
    expect(await stateOf(app, id)).toEqual(['needs_review', 'ambiguous']);
  });

  it('with none, as from a page from before: attached', async () => {
    const { app, a } = await boot();
    const { id, posting: row } = await found(app, a);
    await save(a, id, { title: OTHER_TITLE });
    expect((await attach(a, id, { posting: row })).statusCode).toBe(200);
  });

  it('with one that is not the answer’s: refused, never an error', async () => {
    const { app, a } = await boot();
    const { id, posting: row } = await found(app, a);
    const other = await found(app, a, 'Another Role');
    for (const searchedFor of ['', 'x', 'z'.repeat(20_000), '{}', other.searchedFor]) {
      const res = await attach(a, id, { posting: row, searchedFor });
      expect([searchedFor.length, res.statusCode]).toEqual([searchedFor.length, 409]);
    }
    expect((await attach(a, id, { posting: row, searchedFor: 7 })).statusCode).toBe(400);
  });

  it('pasted text is the user’s own, whatever changed', async () => {
    const { app, a } = await boot();
    const { id, searchedFor } = await found(app, a);
    await save(a, id, { title: OTHER_TITLE });
    expect((await attach(a, id, { text: 'Pasted.', searchedFor })).statusCode).toBe(200);
    expect((await factsOf(app, id)).descriptionMd).toBe('Pasted.');
  });
});

describe('a careers link that Greenhouse is asked about', () => {
  const AT = (over: Record<string, unknown> = {}) => ({
    postingUrl: CAREERS,
    postingState: null,
    ...over,
  });
  const MINE = { descriptionMd: 'My own words.' };
  beforeEach(() => {
    hasJob = true;
    onBoard.examplecorp = [posting({ title: 'Chef' })];
  });

  it('control: identified, with the user’s description and without', async () => {
    for (const over of [MINE, {}]) {
      const { app, a } = await boot();
      const id = await seed(app, a, AT(over));
      expect((await find(a, id)).json()).toMatchObject({ outcome: 'identified' });
      expect((await factsOf(app, id)).atsJobRef).toMatchObject({ externalId: JID });
    }
  });

  it.each([
    ['the link', { postingUrl: NEW_LINK }],
    [
      'the link, for one that names no job',
      { postingUrl: 'https://careers.examplecorp.example/about' },
    ],
    ['the company', { companyName: 'Other Corp' }],
  ])('%s changed meanwhile: no identity and no confirmation', async (_what, patch) => {
    for (const over of [MINE, {}]) {
      const { app, a, b } = await boot();
      const id = await seed(app, a, AT(over));
      asked = () => save(a, id, patch);
      hasJob = true;
      await find(a, id);
      const { atsJobRef } = await factsOf(app, id);
      hasJob = false;
      expect(atsJobRef).toEqual((await twinOf(app, b, patch, AT(over))).atsJobRef);
      expect(await stateOf(app, id)).toEqual([null, null]);
    }
  });

  it('the title changed meanwhile: not confirmed', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, AT(MINE));
    asked = () => save(a, id, { title: OTHER_TITLE });
    const res = await find(a, id);
    expect(res.statusCode, res.body).toBe(409);
    expect(await stateOf(app, id)).toEqual([null, null]);
    expect((await entriesOf(app, id)).map((e) => e.title)).toEqual([STOPPED]);
  });

  it('the title changed while it is asked after the search: no result is shown', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a, AT());
    hasJob = false;
    asked = () => save(a, id, { title: OTHER_TITLE });
    expect((await find(a, id)).statusCode).toBe(409);
  });
});

describe('a check, beside what else it reads', () => {
  const withPage = async (app: FastifyInstance, c: TestClient) => {
    const id = await seed(app, c);
    await createActivity(app.db, ctxOf(c), id, {
      kind: 'capture',
      title: 'Captured from LinkedIn',
      bodyMd: 'What only the page says of the team.',
      occurredAt: 1,
      participants: [],
      externalUrl: OLD_LINK,
    });
    return id;
  };

  it('changed while the board was read: the model is not asked', async () => {
    const { app, a } = await boot();
    const id = await withPage(app, a);
    held = () => save(a, id, { title: OTHER_TITLE });
    await check(app, a, id);
    expect(runStructured).not.toHaveBeenCalled();
  });

  it('changed while the model is asked, and the description too: that is what is said', async () => {
    const { app, a } = await boot();
    const id = await withPage(app, a);
    vi.mocked(runStructured).mockImplementation(async () => {
      await save(a, id, { title: OTHER_TITLE, descriptionMd: 'My own words.' });
      return { passages: [] } as never;
    });
    expect(await check(app, a, id)).toMatchObject({ stopped: true });
    expect((await factsOf(app, id)).descriptionMd).toBe('My own words.');
  });

  it('a company renamed meanwhile is named by its new name in what is merged', async () => {
    const { app, a } = await boot();
    const id = await withPage(app, a);
    vi.mocked(runStructured).mockResolvedValue({
      passages: ['What only the page says of the team.'],
    });
    const { companyId } = await getOpportunity(app.db, ctxOf(a), id);
    held = () => updateCompany(app.db, ctxOf(a), companyId, { name: 'Renamed Corp' });
    expect(await check(app, a, id)).toEqual({ status: 'confirmed', detail: null });
    const { descriptionMd } = await factsOf(app, id);
    expect(descriptionMd).toContain('Renamed Corp');
    expect(descriptionMd).not.toContain('Example Corp');
  });

  it('changed before the search reads it: the new ones are what is searched', async () => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    onBoard.examplecorp = [
      posting(),
      posting({
        title: OTHER_TITLE,
        externalId: '1000003',
        postingUrl: jobUrl('examplecorp', '1000003'),
      }),
    ];
    const pause = pauseAt('posting.search');
    const [outcome] = await Promise.all([
      check(app, a, id),
      whileParked(pause, () => save(a, id, { title: OTHER_TITLE })),
    ]);
    expect(outcome).toEqual({ status: 'confirmed', detail: null });
    expect((await factsOf(app, id)).postingUrl).toBe(jobUrl('examplecorp', '1000003'));
  });

  it.each(SMALL)('no board, %s changed while one is looked for', async (_what, patch, named) => {
    const { app, a } = await boot();
    const id = await seed(app, a);
    await app.db
      .update(companies)
      .set({ atsKind: null, atsRef: null })
      .where(eq(companies.name, 'Example Corp'))
      .run();
    asked = () => save(a, id, patch);
    expect(await check(app, a, id)).toMatchObject({ detail: 'failed', stopped: true });
    const entries = await entriesOf(app, id);
    expect(entries.map((e) => e.title)).toEqual([STOPPED]);
    expect(entries[0]!.bodyMd).toContain(`The ${named} `);
  });

  // The same link, or none: only the identity changes, and with it what a live application is of.
  it('a match with no link of its own marks a live application of another job, once', async () => {
    const { app, a } = await boot();
    const link = jobUrl('examplecorp', '1000001');
    const ref = {
      kind: 'ats_greenhouse' as const,
      org: 'examplecorp',
      externalId: '7',
      url: jobUrl('examplecorp', '7'),
    };
    const id = await seed(app, a, {
      stage: 'interested',
      postingState: 'confirmed',
      atsJobRef: ref,
      postingUrl: link,
    });
    const submissionId = await draft(app, a, id);
    onBoard.examplecorp = [posting({ postingUrl: null, externalId: '7' })];
    expect(await check(app, a, id)).toEqual({ status: 'confirmed', detail: null });
    expect((await factsOf(app, id)).atsJobRef).toMatchObject({ externalId: '1000001' });
    const row = await app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, submissionId))
      .get();
    expect(row?.postingChangedAt).not.toBeNull();
    const said = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'submission.posting_changed'))
      .all();
    expect(said).toHaveLength(1);
  });

  it.runIf(testDialect === 'postgres')(
    'and one started meanwhile: the write starts over',
    async () => {
      onSlowTransaction(() => undefined);
      const { app, a } = await boot();
      const ref = {
        kind: 'ats_greenhouse' as const,
        org: 'examplecorp',
        externalId: '7',
        url: jobUrl('examplecorp', '7'),
      };
      const id = await seed(app, a, {
        stage: 'interested',
        postingState: 'confirmed',
        atsJobRef: ref,
        postingUrl: jobUrl('examplecorp', '1000001'),
      });
      onBoard.examplecorp = [posting({ postingUrl: null, externalId: '7' })];
      const pause = pauseAt('opportunities.update.attemptLocked');
      let submissionId = '';
      const [outcome] = await Promise.all([
        check(app, a, id),
        whileParked(pause, async () => {
          submissionId = await draft(app, a, id);
        }),
      ]);
      expect(outcome).toEqual({ status: 'confirmed', detail: null });
      const row = await app.db
        .select()
        .from(applicationSubmissions)
        .where(eq(applicationSubmissions.id, submissionId))
        .get();
      expect(row?.postingChangedAt).not.toBeNull();
      expect(pause.arrived()).toBe(2);
    },
  );
});

describe('Re-derive', () => {
  const rederive = (c: TestClient, id: string) =>
    c.request({ method: 'POST', url: `/api/v1/opportunities/${id}/posting/rederive`, payload: {} });
  const captured = async (app: FastifyInstance, c: TestClient) => {
    const id = await seed(app, c, {
      postingState: 'needs_review',
      postingStateDetail: 'none_found',
    });
    await createActivity(app.db, ctxOf(c), id, {
      kind: 'capture',
      title: 'Captured from LinkedIn',
      bodyMd: ['About the job', 'What the page says.', 'About the company', 'A company.'].join(
        '\n',
      ),
      occurredAt: 1,
      participants: [],
      externalUrl: OLD_LINK,
    });
    return id;
  };

  it.each(SMALL)(
    'a match, %s changed: refused, and nothing is merged',
    async (_what, patch, named) => {
      const { app, a } = await boot();
      const id = await captured(app, a);
      held = () => save(a, id, patch);
      const res = await rederive(a, id);
      expect([res.statusCode, res.json<{ error: { code: string } }>().error.code]).toEqual([
        409,
        'opportunity_changed',
      ]);
      expect((await factsOf(app, id)).descriptionMd).toBe(CAPTURED);
      const entries = (await entriesOf(app, id)).map((e) => [e.title, e.bodyMd]);
      expect(entries).toEqual([[STOPPED, expect.stringContaining(`The ${named} `)]]);
      expect(await stateOf(app, id)).toEqual(['needs_review', 'failed']);
    },
  );

  it('no match: the captured page is not for a company or title', async () => {
    const { app, a } = await boot();
    const id = await captured(app, a);
    onBoard.examplecorp = [];
    held = () => save(a, id, { title: OTHER_TITLE });
    expect((await rederive(a, id)).json()).toMatchObject({ outcome: 'capture_only' });
    expect((await factsOf(app, id)).descriptionMd).toBe('What the page says.');
  });
});

describe('the user’s own confirm', () => {
  const confirm = (c: TestClient, id: string) =>
    c.request({ method: 'POST', url: `/api/v1/opportunities/${id}/posting/confirm` });

  it.each([
    ['the link', { postingUrl: NEW_LINK }, 409],
    ['the title', { title: OTHER_TITLE }, 200],
    ['the company', { companyName: 'Other Corp' }, 200],
  ])('%s saved meanwhile', async (_what, patch, status) => {
    const { app, a, b } = await boot();
    const over = { postingState: 'needs_review', postingStateDetail: 'none_found' };
    const id = await seed(app, a, over);
    const pause = pauseAt('posting.userConfirm');
    const [res] = await Promise.all([confirm(a, id), whileParked(pause, () => save(a, id, patch))]);
    expect(res.statusCode, res.body).toBe(status);
    if (status === 200) return;
    expect(res.json()).toMatchObject({ error: { code: 'opportunity_changed' } });
    expect(await factsOf(app, id)).toEqual(await twinOf(app, b, patch, over));
    expect(await stateOf(app, id)).toEqual(['needs_review', 'none_found']);
    expect(await entriesOf(app, id)).toEqual([]);
  });
});
