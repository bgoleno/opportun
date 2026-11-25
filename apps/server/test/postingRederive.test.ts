// Re-deriving a description from a stored capture (issue #264): the other half of #246 and
// #255. #246 stopped a fresh LinkedIn capture from swallowing the recommended rail; #255 added
// Refetch for a company with a readable board. Neither helps an opportunity whose description
// was corrupted by something else (#238) once it reaches `confirmed`, or whose company simply
// has no board at all -- this is the path back, from the raw capture text already on the
// opportunity's own timeline.
import type { NormalizedPosting, PostingStateDetail } from '@opportun/core';
import { runStructured } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rederivePosting } from '../src/lib/postingRederive';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import type { BoardLookup } from '../src/lib/postingSearch';
import type { safeFetch } from '../src/lib/safeFetch';
import { createActivity, listActivities } from '../src/repos/activities';
import { createCompany } from '../src/repos/companies';
import {
  createOpportunity,
  deleteOpportunity,
  getOpportunity,
  setPostingState,
  updateOpportunity,
} from '../src/repos/opportunities';
import type { UserCtx } from '../src/repos/base';
import { setRaceHook } from '../src/lib/racePoints';
import { onSlowTransaction } from '../src/db/gate';
import { useApi } from './api';
import { testDialect } from './db';
import type { TestClient } from './isolation';
import { pauseAt, whileParked } from './race';

vi.mock('@opportun/ai', async (orig) => ({
  ...(await orig<typeof import('@opportun/ai')>()),
  runStructured: vi.fn(),
}));

const boot = useApi();
afterEach(() => setRaceHook(undefined));
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

const TITLE = 'Staff Product Manager';
const ATS_BODY =
  'Join the company that is building the telemetry infrastructure for the AI era. Comp: $200k base.';

/** A realistic raw capture: a real "About the job"/"About the company" job view, plus a
 *  trailing recommended rail (#246), the way an un-narrowed pre-#246 capture still looks. */
const RAW_CAPTURE = [
  'About the job',
  'Join the company that is building the telemetry infrastructure for the AI era.',
  'Remote, Full-time',
  'About the company',
  'Soylent is a company.',
  'Promoted',
  'Account Executive, EMEA',
  'Set alert for similar jobs',
].join('\n');

/** No "About the job" marker at all: nothing a deterministic extraction can find. */
const NO_MARKER_CAPTURE = ['Some unrelated noise.', 'Nothing resembling a job page.'].join('\n');

/** A raw, un-narrowed capture with no "About the company"/"similar jobs" boundary at all
 *  between the real posting and the rail (issue #264): the way descriptionOf's own end markers
 *  were confirmed (read-only, against the owner's real stored GitHub capture) not to be
 *  trustworthy alone. Only cutTrailingNoise stops this before the rail. */
const RAW_CAPTURE_NO_BOUNDARY = [
  'About the job',
  'Join the company that is building the telemetry infrastructure for the AI era.',
  'We need a Staff Product Manager to own the metrics and tracing roadmap end to end.',
  'Responsibilities include driving adoption of distributed tracing across the platform.',
  'Remote, Full-time, Comp: $200k base.',
  'Promoted',
  'Account Executive, EMEA',
  'Growth Marketer, Remote',
].join('\n');

const missingFetch = (async () => ({
  status: 404,
  headers: new Headers(),
  body: Buffer.from(''),
})) as unknown as typeof safeFetch;

const log = { warn: () => {}, info: () => {}, error: () => {} } as never;

function atsPosting(over: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    company: 'Soylent',
    title: TITLE,
    descriptionMd: ATS_BODY,
    postingUrl: 'https://job-boards.greenhouse.io/soylent/jobs/1000000001',
    location: 'Remote, United States',
    externalId: '1000000001',
    ...over,
  };
}

const boardWith =
  (postings: NormalizedPosting[]): BoardLookup =>
  async () =>
    postings;
const noBoards: BoardLookup = async () => [];

async function seed(
  app: FastifyInstance,
  ctx: UserCtx,
  over: {
    companyName?: string;
    descriptionMd?: string | null;
    captureText?: string | null;
    postingState?: 'confirmed' | 'needs_review' | null;
    postingStateDetail?: PostingStateDetail | null;
  } = {},
) {
  const companyName = over.companyName ?? 'Soylent';
  if (companyName === 'Soylent') {
    await createCompany(app.db, ctx, {
      name: 'Soylent',
      atsKind: 'ats_greenhouse',
      atsRef: 'soylent',
      atsVerifiedAt: Date.now(),
    });
  }
  const descriptionMd = over.descriptionMd === undefined ? ATS_BODY : over.descriptionMd;
  const opp = await createOpportunity(app.db, ctx, {
    companyName,
    title: TITLE,
    descriptionMd,
    location: 'United States',
    sourceKind: 'discovery',
  });
  if (descriptionMd != null) {
    await updateOpportunity(app.db, ctx, opp.id, {
      descriptionFingerprint: descriptionFingerprint(descriptionMd),
    });
  }
  if (over.captureText !== null) {
    await createActivity(app.db, ctx, opp.id, {
      kind: 'capture',
      title: 'Captured from LinkedIn',
      bodyMd: over.captureText ?? RAW_CAPTURE,
      occurredAt: Date.now(),
      participants: [],
      externalUrl: 'https://www.linkedin.com/jobs/view/1000000001',
    });
  }
  await setPostingState(app.db, ctx, opp.id, {
    postingState: over.postingState ?? 'confirmed',
    postingStateDetail: over.postingStateDetail ?? null,
  });
  return await getOpportunity(app.db, ctx, opp.id);
}

const run = (
  app: FastifyInstance,
  ctx: UserCtx,
  id: string,
  board: BoardLookup,
  opts: { force?: boolean; replaceAgreed?: string } = {},
) => rederivePosting(app.db, ctx, id, { fetch: missingFetch, log }, { ...opts, board });

describe('rederivePosting', () => {
  it('blocks a user-written description without force (issue #264 design Q2)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx);
    await updateOpportunity(app.db, ctx, opp.id, { descriptionMd: 'my own notes' });

    await expect(run(app, ctx, opp.id, noBoards)).rejects.toMatchObject({
      statusCode: 409,
      code: 'already_described',
    });

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toBe('my own notes');
  });

  it('overwrites a user-written description when forced, over that text (#1010)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx);
    await updateOpportunity(app.db, ctx, opp.id, { descriptionMd: 'my own notes' });

    const outcome = await run(app, ctx, opp.id, noBoards, {
      force: true,
      replaceAgreed: descriptionFingerprint('my own notes'),
    });

    expect(outcome.kind).toBe('capture_only');
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toContain('telemetry infrastructure');
  });

  it('blocks a posting the user confirmed themselves without force (issue #250)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx, {
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });

    await expect(run(app, ctx, opp.id, boardWith([atsPosting()]))).rejects.toMatchObject({
      statusCode: 409,
      code: 'user_confirmed',
    });

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect([out.postingState, out.postingStateDetail]).toEqual(['confirmed', 'user_confirmed']);
  });

  it('overrides a user confirmation when forced', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx, {
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });

    const outcome = await run(app, ctx, opp.id, boardWith([atsPosting()]), { force: true });

    expect(outcome.kind).toBe('merged');
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect([out.postingState, out.postingStateDetail]).toEqual(['confirmed', null]);
  });

  it('refuses when there is no stored capture to re-derive from', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx, { captureText: null });

    await expect(run(app, ctx, opp.id, noBoards)).rejects.toMatchObject({
      statusCode: 409,
      code: 'no_capture',
    });
  });

  it("merges the board's copy when a confident match exists, the same way reconcile does (design Q3)", async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    // GitHub's actual shape: confirmed via a hand-pasted URL, no detail, description since
    // corrupted by an unrelated bug -- exactly what a forced re-derive must repair.
    const opp = await seed(app, ctx, {
      descriptionMd: '{"json": "noise"}'.repeat(50),
      postingState: 'confirmed',
      postingStateDetail: null,
    });
    vi.mocked(runStructured).mockResolvedValue({ passages: ['Remote, Full-time'] });

    const outcome = await run(app, ctx, opp.id, boardWith([atsPosting()]), { force: true });

    expect(outcome.kind).toBe('merged');
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toContain('Comp: $200k base.');
    expect(out.descriptionMd).toContain('Remote, Full-time');
    expect([out.postingState, out.postingStateDetail]).toEqual(['confirmed', null]);
    expect(out.postingUrl).toBe('https://job-boards.greenhouse.io/soylent/jobs/1000000001');

    const { items } = await listActivities(app.db, ctx, opp.id, { limit: 50, offset: 0 });
    expect(items.some((i) => i.title === 'Description re-derived from capture')).toBe(true);
    expect(items.some((i) => i.title === "Posting confirmed on the company's board")).toBe(true);
  });

  it('derives the description from the capture alone when no board match exists (design Q3)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    // The GitHub record's actual situation (#255, #264): a company with no readable board at
    // all. Nothing left to merge with, so the capture is the whole answer.
    const opp = await seed(app, ctx, {
      companyName: 'Brand New Co',
      descriptionMd: '{"json": "noise"}'.repeat(50),
      postingState: 'confirmed',
      postingStateDetail: null,
    });

    const outcome = await run(app, ctx, opp.id, noBoards, { force: true });

    expect(outcome.kind).toBe('capture_only');
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toBe(
      'Join the company that is building the telemetry infrastructure for the AI era.\nRemote, Full-time',
    );
    expect(out.descriptionFingerprint).toBe(descriptionFingerprint(out.descriptionMd as string));
    // A board search genuinely ran and found nothing, but re-derive does not relitigate the
    // user's own decision to consider this posting confirmed (it only replaces the text).
    expect([out.postingState, out.postingStateDetail]).toEqual(['confirmed', null]);
  });

  it('narrows an old, un-narrowed capture before extracting, so it does not reproduce #246 (issue #264)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx, {
      companyName: 'Brand New Co',
      descriptionMd: '{"json": "noise"}'.repeat(50),
      captureText: RAW_CAPTURE_NO_BOUNDARY,
      postingState: 'confirmed',
      postingStateDetail: null,
    });

    const outcome = await run(app, ctx, opp.id, noBoards, { force: true });

    expect(outcome.kind).toBe('capture_only');
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toContain('distributed tracing across the platform');
    expect(out.descriptionMd).not.toContain('Promoted');
    expect(out.descriptionMd).not.toContain('Account Executive');
    expect(out.descriptionMd).not.toContain('Growth Marketer');
  });

  it('falls back to the capture alone when the board returns only ambiguous candidates', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx, {
      descriptionMd: '{"json": "noise"}'.repeat(50),
      postingState: 'confirmed',
      postingStateDetail: null,
    });

    const outcome = await run(
      app,
      ctx,
      opp.id,
      boardWith([
        atsPosting({ externalId: '1', descriptionMd: 'Metrics pipeline ownership.' }),
        atsPosting({ externalId: '2', descriptionMd: 'Tracing and span storage.' }),
      ]),
      { force: true },
    );

    expect(outcome.kind).toBe('capture_only');
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toContain('telemetry infrastructure');
  });

  it('uses the latest capture when the opportunity has more than one', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx, { companyName: 'Brand New Co', captureText: null });
    await createActivity(app.db, ctx, opp.id, {
      kind: 'capture',
      title: 'Captured from LinkedIn',
      bodyMd: ['About the job', 'An older, stale capture.', 'About the company', 'x'].join('\n'),
      occurredAt: Date.now() - 10_000,
      participants: [],
      externalUrl: 'https://www.linkedin.com/jobs/view/1',
    });
    await createActivity(app.db, ctx, opp.id, {
      kind: 'capture',
      title: 'Captured from LinkedIn',
      bodyMd: RAW_CAPTURE,
      occurredAt: Date.now(),
      participants: [],
      externalUrl: 'https://www.linkedin.com/jobs/view/1000000001',
    });

    const outcome = await run(app, ctx, opp.id, noBoards, { force: true });

    expect(outcome.kind).toBe('capture_only');
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toContain('telemetry infrastructure');
    expect(out.descriptionMd).not.toContain('older, stale capture');
  });

  it('reports nothing found, and changes nothing, when the capture has no recognizable description', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seed(app, ctx, {
      companyName: 'Brand New Co',
      descriptionMd: '{"json": "noise"}'.repeat(50),
      captureText: NO_MARKER_CAPTURE,
      postingState: 'confirmed',
      postingStateDetail: null,
    });

    const outcome = await run(app, ctx, opp.id, noBoards, { force: true });

    expect(outcome).toEqual({ kind: 'no_description_found' });
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toBe(opp.descriptionMd);
  });

  // #858: the search can take seconds, and a description the user saves meanwhile is theirs, forced
  // or not. A user who confirmed the posting themselves keeps that too, whichever write was refused.
  describe('a description saved while the board is read (#858)', () => {
    const SAVED = 'Saved during the re-derive.';
    const KEPT_NOTE = 'Posting check: description kept';

    /** A forced re-derive that waits on its board, with `SAVED` saved meanwhile. */
    async function savedMeanwhile(
      postings: NormalizedPosting[],
      state: {
        postingState: 'confirmed' | 'needs_review';
        postingStateDetail: PostingStateDetail | null;
      },
    ) {
      const { app, a } = await boot();
      const ctx = ctxOf(a);
      vi.mocked(runStructured).mockResolvedValue({ passages: [] });
      const opp = await seed(app, ctx, state);
      let release: () => void = () => undefined;
      const held = new Promise<void>((r) => (release = r));
      let reading: () => void = () => undefined;
      const started = new Promise<void>((r) => (reading = r));
      const board: BoardLookup = async () => {
        reading();
        await held;
        return postings;
      };
      const rederive = run(app, ctx, opp.id, board, { force: true });
      let saved;
      try {
        await started;
        saved = await a.request({
          method: 'PATCH',
          url: `/api/v1/opportunities/${opp.id}`,
          payload: { descriptionMd: SAVED },
        });
      } finally {
        release();
      }
      expect(saved.statusCode, saved.body).toBe(200);
      const outcome = await rederive;
      const { items } = await listActivities(app.db, ctx, opp.id, { limit: 50, offset: 0 });
      return {
        outcome,
        before: opp,
        after: await getOpportunity(app.db, ctx, opp.id),
        notes: items.filter((n) => n.kind === 'note'),
      };
    }

    const STATES = [
      ['confirmed', null],
      ['confirmed', 'user_confirmed'],
      ['needs_review', 'edited'],
      ['needs_review', 'none_found'],
    ] as const;

    it.each(STATES)(
      'with no match on the board, at %s / %s, it is kept, and so is the state',
      async (postingState, postingStateDetail) => {
        const { outcome, before, after, notes } = await savedMeanwhile([], {
          postingState,
          postingStateDetail,
        });
        expect(outcome).toMatchObject({
          kind: 'left_alone',
          opportunity: { descriptionMd: SAVED },
        });
        expect(after).toMatchObject({
          descriptionMd: SAVED,
          descriptionFingerprint: before.descriptionFingerprint,
          descriptionIsUserWritten: true,
          postingState,
          postingStateDetail,
        });
        expect(notes.map((n) => [n.title, n.bodyMd])).toEqual([
          [
            KEPT_NOTE,
            'The description changed while it was being re-derived from the capture, so it was left as it is.',
          ],
        ]);
      },
    );

    it.each(STATES)(
      'with a match on the board, at %s / %s, it is kept, and the note says so',
      async (postingState, postingStateDetail) => {
        const { outcome, before, after, notes } = await savedMeanwhile([atsPosting()], {
          postingState,
          postingStateDetail,
        });
        expect(outcome).toMatchObject({ kind: 'left_alone' });
        expect(after).toMatchObject({
          descriptionMd: SAVED,
          postingUrl: before.postingUrl,
          location: before.location,
          // What the user settled, or was already asked about, stays; a flag says the rest.
          ...(postingState === 'confirmed'
            ? { postingState, postingStateDetail }
            : { postingState: 'needs_review', postingStateDetail: 'edited' }),
        });
        expect(notes.map((n) => [n.title, n.bodyMd])).toEqual([
          [
            KEPT_NOTE,
            'The description changed while the board was being checked, so the board search left it as it is.',
          ],
        ]);
      },
    );

    it('a write that fails for another reason is that failure', async () => {
      const { app, a } = await boot();
      const ctx = ctxOf(a);
      const opp = await seed(app, ctx);
      setRaceHook((point) => {
        if (point === 'opportunities.update.locked') throw new Error('the disk is full');
      });
      await expect(run(app, ctx, opp.id, noBoards, { force: true })).rejects.toThrow(
        'the disk is full',
      );
      expect((await getOpportunity(app.db, ctx, opp.id)).descriptionMd).toBe(opp.descriptionMd);
    });

    // Deleted between the write's read and its UPDATE, which finds no row. On SQLite the gate holds
    // the delete back until the write is done.
    it.runIf(testDialect === 'postgres')(
      'an opportunity deleted meanwhile is not found',
      async () => {
        const { app, a } = await boot();
        const ctx = ctxOf(a);
        const opp = await seed(app, ctx);
        onSlowTransaction(() => undefined);
        const pause = pauseAt('opportunities.update.locked');
        const outcome = run(app, ctx, opp.id, noBoards, { force: true }).then(
          () => null,
          (err: unknown) => err,
        );
        await whileParked(pause, () => deleteOpportunity(app.db, ctx, opp.id));
        expect(await outcome).toMatchObject({ statusCode: 404 });
      },
    );
  });
});
