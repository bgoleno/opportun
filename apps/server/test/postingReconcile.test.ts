// posting.reconcile (design D4 to D8, D11, D21, D25, D26, D27): after a capture puts the page
// text on an opportunity, this looks the same job up on the company's own ATS board. A
// confident match makes the employer's copy authoritative and keeps the capture's extras; any
// other outcome changes nothing and raises a flag the user can act on.
import type { NormalizedPosting } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { runStructured } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import { reconcilePosting } from '../src/jobs/postingReconcile';
import { POSTING_RECONCILE_KIND } from '../src/lib/jobKinds';
import { enqueue } from '../src/lib/jobQueue';
import { rederivePosting } from '../src/lib/postingRederive';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import type { BoardLookup } from '../src/lib/postingSearch';
import type { safeFetch } from '../src/lib/safeFetch';
import { createActivity, listActivities } from '../src/repos/activities';
import { createCompany } from '../src/repos/companies';
import { opportunities } from '../src/db/schema';
import {
  createOpportunity,
  getOpportunity,
  setPostingState,
  updateOpportunity,
} from '../src/repos/opportunities';
import type { UserCtx } from '../src/repos/base';
import { search } from '../src/repos/search';
import { onSlowTransaction } from '../src/db/gate';
import { useApi } from './api';
import { testDialect } from './db';
import type { TestClient } from './isolation';
import { heldOpen, pauseAt, settledOrWaiting, someoneBlocked, whileParked } from './race';

vi.mock('@opportun/ai', async (orig) => ({
  ...(await orig<typeof import('@opportun/ai')>()),
  runStructured: vi.fn(),
}));

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

const TITLE = 'Staff Product Manager';
const CAPTURE = [
  'Join the company that is building the telemetry infrastructure for the AI era.',
  'Remote, Full-time',
].join('\n');
const ATS_BODY =
  'Join the company that is building the telemetry infrastructure for the AI era. Comp: $200k base.';

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

/** An opportunity in the state a capture leaves it in: text, fingerprint, searching. */
async function seedCaptured(
  app: FastifyInstance,
  ctx: UserCtx,
  over: { companyName?: string; descriptionMd?: string; captureText?: string | null } = {},
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
  const descriptionMd = over.descriptionMd ?? CAPTURE;
  const opp = await createOpportunity(app.db, ctx, {
    companyName,
    title: TITLE,
    descriptionMd,
    location: 'United States',
    sourceKind: 'discovery',
  });
  await updateOpportunity(app.db, ctx, opp.id, {
    descriptionFingerprint: descriptionFingerprint(descriptionMd),
  });
  if (over.captureText !== null) {
    await createActivity(app.db, ctx, opp.id, {
      kind: 'capture',
      title: 'Captured from LinkedIn',
      bodyMd: over.captureText ?? CAPTURE,
      occurredAt: Date.now(),
      participants: [],
      externalUrl: 'https://www.linkedin.com/jobs/view/1000000001',
    });
  }
  await setPostingState(app.db, ctx, opp.id, {
    postingState: 'searching',
    postingStateDetail: null,
  });
  return opp;
}

const run = (app: FastifyInstance, ctx: UserCtx, id: string, board: BoardLookup) =>
  reconcilePosting(app.db, ctx, id, { fetch: missingFetch, log }, { board });

describe('reconcilePosting', () => {
  it('merges the ATS copy over the capture and confirms', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: ['Remote, Full-time'] });
    const opp = await seedCaptured(app, ctx);

    await run(app, ctx, opp.id, boardWith([atsPosting()]));

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.postingState).toBe('confirmed');
    expect(out.postingStateDetail).toBeNull();
    expect(out.descriptionMd).toContain('Comp: $200k base.');
    expect(out.descriptionMd).toContain('Remote, Full-time');
    expect(out.descriptionMd?.indexOf('Comp: $200k')).toBeLessThan(
      out.descriptionMd?.indexOf('Also on the LinkedIn') as number,
    );
    expect(out.atsJobRef).toMatchObject({ kind: 'ats_greenhouse', externalId: '1000000001' });
    expect(out.postingUrl).toBe('https://job-boards.greenhouse.io/soylent/jobs/1000000001');
  });

  // #852 (qa's regression pass 3): Find posting clicked while the background check reads the
  // board wrote a second attach, recorded as a Refetch. While the posting is searching, Find
  // posting is refused, so the check's own result is the one attach.
  it('Find posting while the check reads the board is refused; the check attaches once (#852)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const opp = await seedCaptured(app, ctx);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let reading: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      reading = r;
    });
    const board: BoardLookup = async (...args) => {
      reading();
      await held;
      return boardWith([atsPosting()])(...args);
    };

    // The check's own job row, unfinished while it runs, as captureResolve queues it.
    await enqueue(
      app.db,
      POSTING_RECONCILE_KIND,
      { opportunityId: opp.id },
      {
        dedupeKey: `${POSTING_RECONCILE_KIND}:${opp.id}`,
        userId: a.userId,
        runAt: Date.now() + 3_600_000,
      },
    );
    const check = run(app, ctx, opp.id, board);
    await started;
    const click = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${opp.id}/find-posting`,
    });
    expect(click.statusCode).toBe(409);
    expect(click.json().error).toMatchObject({ code: 'posting_searching' });
    release();
    await check;

    expect((await getOpportunity(app.db, ctx, opp.id)).postingState).toBe('confirmed');
    const { items } = await listActivities(app.db, ctx, opp.id, { limit: 50, offset: 0 });
    expect(items.filter((i) => i.title === 'Job posting attached')).toEqual([]);
  });

  // tl on #865: 'searching' left behind by a check that died, or whose job row is gone, must not
  // take Find posting away: with no unfinished check, it runs.
  it('searching with no unfinished check: Find posting runs (#852)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx);
    expect((await getOpportunity(app.db, ctx, opp.id)).postingState).toBe('searching');
    const click = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${opp.id}/find-posting`,
    });
    expect(click.statusCode, click.body).toBe(200);
  });

  // qa on #865: a click just as the check ends found the posting confirmed and refetched it, a
  // second attach. The page says what state it saw; a posting confirmed since is left alone.
  it('a click that saw the check running, landing just after it confirmed, changes nothing (#852)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const opp = await seedCaptured(app, ctx);
    await run(app, ctx, opp.id, boardWith([atsPosting()]));
    const confirmed = await getOpportunity(app.db, ctx, opp.id);
    expect(confirmed.postingState).toBe('confirmed');

    const click = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${opp.id}/find-posting?seen=searching`,
    });
    expect(click.statusCode, click.body).toBe(200);
    expect(click.json()).toMatchObject({ outcome: 'already_confirmed' });
    const { items } = await listActivities(app.db, ctx, opp.id, { limit: 50, offset: 0 });
    expect(items.filter((i) => i.title === 'Job posting attached')).toEqual([]);
    expect(await getOpportunity(app.db, ctx, opp.id)).toMatchObject({
      descriptionMd: confirmed.descriptionMd,
      updatedAt: confirmed.updatedAt,
    });

    // A Refetch the user asked for on a confirmed posting still runs.
    const refetch = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${opp.id}/find-posting?seen=confirmed`,
    });
    expect(refetch.json().outcome).not.toBe('already_confirmed');
  });

  // #851 (qa's regression pass 3): the board read is held, and the user saves a description
  // meanwhile; the check must not then replace it with the board's copy.
  it('a description the user saves while the board is being read is kept (#851)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const opp = await seedCaptured(app, ctx);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let reading: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      reading = r;
    });
    const board: BoardLookup = async (...args) => {
      reading();
      await held;
      return boardWith([atsPosting()])(...args);
    };

    const check = run(app, ctx, opp.id, board);
    await started;
    const saved = await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${opp.id}`,
      payload: { descriptionMd: 'My own notes, saved while the check ran.' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    release();
    await check;

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toBe('My own notes, saved while the check ran.');
    expect(out.postingState).not.toBe('confirmed');
  });

  // #856: the save lands after the check's own re-read, so only a condition on the write itself
  // can keep it. Characters a careless comparison or rewrite would lose: trailing spaces, CRLF, a
  // blank line, a combining accent. (The route trims the ends.)
  const SAVED = 'Mine, kept exactly.  \r\n\r\n  Café, not Café.';

  const save = (a: TestClient, id: string) =>
    a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${id}`,
      payload: { descriptionMd: SAVED },
    });

  /** The opportunities the index has the word for. */
  const found = async (app: FastifyInstance, ctx: UserCtx, word: string) =>
    (await search(app.db, ctx, word, { limit: 20, offset: 0 })).items
      .filter((h) => h.entityKind === 'opportunity')
      .map((h) => h.entityId);

  const reconcileNotes = async (app: FastifyInstance, ctx: UserCtx, id: string) =>
    (await listActivities(app.db, ctx, id, { limit: 50, offset: 0 })).items
      .filter((i) => i.kind === 'note')
      .map((i) => i.title);

  /** What a check that skipped leaves: the saved text to the byte, nothing else of the board's. */
  async function expectSkipped(
    app: FastifyInstance,
    ctx: UserCtx,
    before: Awaited<ReturnType<typeof getOpportunity>>,
  ) {
    const out = await getOpportunity(app.db, ctx, before.id);
    expect(Buffer.from(out.descriptionMd ?? '')).toEqual(Buffer.from(SAVED));
    expect(out).toMatchObject({
      descriptionFingerprint: before.descriptionFingerprint,
      descriptionIsUserWritten: true,
      postingUrl: before.postingUrl,
      location: before.location,
      compNote: before.compNote,
      dedupeKey: before.dedupeKey,
      atsJobRef: before.atsJobRef,
      postingState: 'needs_review',
      postingStateDetail: 'edited',
    });
    expect(await reconcileNotes(app, ctx, before.id)).toEqual(['Posting check: description kept']);
  }

  it('a save between the re-read and the write is kept, and the skip is recorded (#856)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const { id } = await seedCaptured(app, ctx);
    const before = await getOpportunity(app.db, ctx, id);
    const pause = pauseAt('posting.confirm');

    const check = run(app, ctx, id, boardWith([atsPosting({ compNote: '$200k' })]));
    const saved = await whileParked(pause, () => save(a, id));
    expect(saved.statusCode, saved.body).toBe(200);

    const outcome = await check;
    await expectSkipped(app, ctx, before);
    expect(outcome).toEqual({ status: 'needs_review', detail: 'edited' });
  });

  // The same, with no description to start from: "unchanged" then means "still none".
  it('a first description saved between the re-read and the write is kept (#856)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const { id } = await seedCaptured(app, ctx);
    await updateOpportunity(app.db, ctx, id, { descriptionMd: null, descriptionFingerprint: null });
    const before = await getOpportunity(app.db, ctx, id);
    const pause = pauseAt('posting.confirm');

    const check = run(app, ctx, id, boardWith([atsPosting()]));
    const saved = await whileParked(pause, () => save(a, id));
    expect(saved.statusCode, saved.body).toBe(200);

    const outcome = await check;
    await expectSkipped(app, ctx, before);
    expect(outcome).toEqual({ status: 'needs_review', detail: 'edited' });
  });

  it('an opportunity with no description and no save still takes the board copy (#856)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const { id } = await seedCaptured(app, ctx);
    await updateOpportunity(app.db, ctx, id, { descriptionMd: null, descriptionFingerprint: null });

    await run(app, ctx, id, boardWith([atsPosting()]));

    const out = await getOpportunity(app.db, ctx, id);
    expect(out).toMatchObject({ postingState: 'confirmed', descriptionIsUserWritten: false });
    expect(out.descriptionMd).toContain('Comp: $200k base.');
  });

  // The board's location would take a key another live opportunity holds, so the check writes
  // again without it: that second write must keep the save too.
  it('a save before the write that gives up the location is kept (#856)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const { id } = await seedCaptured(app, ctx);
    await createOpportunity(app.db, ctx, {
      companyName: 'Soylent',
      title: TITLE,
      location: 'Remote, United States',
      sourceKind: 'manual',
    });
    const before = await getOpportunity(app.db, ctx, id);
    const pause = pauseAt('posting.confirm');

    const check = run(app, ctx, id, boardWith([atsPosting()]));
    const saved = await whileParked(pause, () => save(a, id));
    expect(saved.statusCode, saved.body).toBe(200);

    const outcome = await check;
    await expectSkipped(app, ctx, before);
    expect(outcome).toEqual({ status: 'needs_review', detail: 'edited' });
  });

  // Parked inside the write's own transaction, after its first read and before it has the row. On
  // Postgres the save commits meanwhile, so a check read in that transaction would be stale and only
  // the UPDATE's own WHERE sees it. On SQLite the write gate holds the save back until the check
  // commits; it then lands on top, so the text is kept either way. From the row on, a save waits, below.
  it("a save that lands inside the write's transaction is kept (#856)", async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const { id } = await seedCaptured(app, ctx);
    const { postingUrl } = atsPosting();
    await app.db.update(opportunities).set({ postingUrl }).where(eq(opportunities.id, id)).run();
    const before = await getOpportunity(app.db, ctx, id);
    onSlowTransaction(() => undefined);
    const pause = pauseAt('opportunities.update.attemptLocked');

    const check = run(app, ctx, id, boardWith([atsPosting()]));
    const [saving, seen] = await whileParked(pause, async () => {
      const sent = save(a, id);
      // In an array: a promise returned bare would be waited for, and on SQLite it waits for the check.
      return [[sent], await settledOrWaiting(app, sent)] as const;
    });
    expect(seen).toBe(testDialect === 'postgres' ? 'settled' : 'waiting');

    const [, saved] = await Promise.all([check, saving[0]]);
    expect(saved.statusCode, saved.body).toBe(200);
    if (testDialect === 'postgres') return await expectSkipped(app, ctx, before);
    const out = await getOpportunity(app.db, ctx, id);
    expect(Buffer.from(out.descriptionMd ?? '')).toEqual(Buffer.from(SAVED));
  });

  // A check holds the row from there on, for what it settles with it (#892), as one that changes the link
  // did against an application being started (#913). A save waits, on Postgres too, and lands on top.
  it.each([
    ['that changes the link', undefined],
    ['that does not', atsPosting().postingUrl],
  ])('a save beside a write %s waits for it, and is kept', async (_what, postingUrl) => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const { id } = await seedCaptured(app, ctx);
    if (postingUrl !== undefined)
      await app.db.update(opportunities).set({ postingUrl }).where(eq(opportunities.id, id)).run();
    onSlowTransaction(() => undefined);
    const pause = pauseAt('opportunities.update.locked');

    const check = run(app, ctx, id, boardWith([atsPosting()]));
    await pause.reached;
    const saving = save(a, id);
    const blocked = await someoneBlocked(app);
    pause.release();

    const [, saved] = await Promise.all([check, saving]);
    expect(blocked).toBe(true);
    expect(saved.statusCode, saved.body).toBe(200);
    const out = await getOpportunity(app.db, ctx, id);
    expect(Buffer.from(out.descriptionMd ?? '')).toEqual(Buffer.from(SAVED));
    expect(out).toMatchObject({
      postingUrl: atsPosting().postingUrl,
      descriptionIsUserWritten: true,
    });
    // The index has the text that is kept, and not the check's.
    expect(await found(app, ctx, 'exactly')).toEqual([id]);
    expect(await found(app, ctx, 'telemetry')).toEqual([]);
  });

  // The other way round: the save has written the row and not committed when the check comes to it.
  it('a save that has the row first makes the check wait, and it is left alone', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const { id } = await seedCaptured(app, ctx);
    const before = await getOpportunity(app.db, ctx, id);
    onSlowTransaction(() => undefined);
    const held = heldOpen(app, (tx) =>
      updateOpportunity(tx as never, ctx, id, { descriptionMd: SAVED }),
    );
    await held.reached;
    const checking = run(app, ctx, id, boardWith([atsPosting()]));
    const blocked = await someoneBlocked(app);
    held.go();
    await held.done;
    await checking;
    expect(blocked).toBe(true);
    await expectSkipped(app, ctx, before);
  });

  // qa on #855: a forced re-derive whose confirm() left a description saved meanwhile alone must
  // say so, not answer "merged" and log that it merged with the captured page.
  it('a re-derive racing a save answers left_alone, with no "merged" note (#851)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const opp = await seedCaptured(app, ctx);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let reading: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      reading = r;
    });
    const board: BoardLookup = async (...args) => {
      reading();
      await held;
      return boardWith([atsPosting()])(...args);
    };

    const rederive = rederivePosting(
      app.db,
      ctx,
      opp.id,
      { fetch: missingFetch, log },
      { force: true, board },
    );
    await started;
    const saved = await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${opp.id}`,
      payload: { descriptionMd: 'Saved during the re-derive.' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    release();
    const out = await rederive;

    expect(out.kind).toBe('left_alone');
    expect((await getOpportunity(app.db, ctx, opp.id)).descriptionMd).toBe(
      'Saved during the re-derive.',
    );
    const { items } = await listActivities(app.db, ctx, opp.id, { limit: 50, offset: 0 });
    expect(items.some((i) => (i.bodyMd ?? '').includes('merged with the captured page'))).toBe(
      false,
    );
  });

  it('a board that cannot be read is a check that did not finish, not "found nothing" (#835)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx);
    const broken: BoardLookup = async () => {
      throw new Error('fetch failed: ETIMEDOUT');
    };
    await run(app, ctx, opp.id, broken);
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out).toMatchObject({ postingState: 'needs_review', postingStateDetail: 'failed' });
    expect(out.descriptionMd).toBe(opp.descriptionMd);
  });

  it('re-fingerprints what it wrote, so its own text is not read as a user edit', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const opp = await seedCaptured(app, ctx);

    await run(app, ctx, opp.id, boardWith([atsPosting()]));

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionFingerprint).toBe(descriptionFingerprint(out.descriptionMd as string));
  });

  it('flags ambiguity and changes nothing', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx);

    await run(
      app,
      ctx,
      opp.id,
      // Three genuinely different reqs, not one req in three locations: same-titled postings
      // whose descriptions differ are separate candidates (lib/postingCandidates).
      boardWith([
        atsPosting({ externalId: '1', descriptionMd: 'Metrics pipeline ownership.' }),
        atsPosting({ externalId: '2', descriptionMd: 'Tracing and span storage.' }),
        atsPosting({ externalId: '3', descriptionMd: 'Search federation across lakes.' }),
      ]),
    );

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect([out.postingState, out.postingStateDetail]).toEqual(['needs_review', 'ambiguous']);
    expect(out.descriptionMd).toBe(CAPTURE);
    expect(out.atsJobRef).toBeNull();
  });

  it('flags a board that carries no match for this job', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx);

    await run(app, ctx, opp.id, boardWith([atsPosting({ title: 'Account Executive' })]));

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect([out.postingState, out.postingStateDetail]).toEqual(['needs_review', 'none_found']);
    expect(out.descriptionMd).toBe(CAPTURE);
  });

  it('lands no_board for a company with no detectable board', async () => {
    // Review Focus 3: the company was created by the capture and has no careers URL, so ATS
    // detection runs against nothing. It must flag, not throw.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx, { companyName: 'Brand New Co' });

    await run(app, ctx, opp.id, noBoards);

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect([out.postingState, out.postingStateDetail]).toEqual(['needs_review', 'no_board']);
  });

  it('a search for a board that could not finish is a check that did not, not "no board" (#866)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx, { companyName: 'Vandelay Industries' });
    const downFetch = (async () => ({
      status: 503,
      headers: new Headers(),
      body: Buffer.from(''),
    })) as unknown as typeof safeFetch;

    await reconcilePosting(app.db, ctx, opp.id, { fetch: downFetch, log }, { board: noBoards });

    expect(await getOpportunity(app.db, ctx, opp.id)).toMatchObject({
      postingState: 'needs_review',
      postingStateDetail: 'failed',
      descriptionMd: CAPTURE,
    });
    const { items } = await listActivities(app.db, ctx, opp.id, { limit: 50, offset: 0 });
    expect(items.find((i) => i.title === 'Posting check failed')?.bodyMd).toBe(
      "Couldn't read Vandelay Industries' board just now, so nothing was checked. Try Find posting again.",
    );
  });

  it("a name ending in s takes an apostrophe alone in the check's note (#866)", async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, {
      name: 'Vandelay Industries',
      atsKind: 'ats_greenhouse',
      atsRef: 'vandelay',
      atsVerifiedAt: Date.now(),
    });
    const opp = await seedCaptured(app, ctx, { companyName: 'Vandelay Industries' });

    await run(app, ctx, opp.id, noBoards);

    const { items } = await listActivities(app.db, ctx, opp.id, { limit: 50, offset: 0 });
    expect(
      items.find((i) => i.title === "Posting not found on the company's board")?.bodyMd,
    ).toContain("Checked Vandelay Industries' board and found no posting");
  });

  it('refuses to overwrite a description the user edited after the capture', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx);
    await updateOpportunity(app.db, ctx, opp.id, { descriptionMd: 'my own notes' });

    await run(app, ctx, opp.id, boardWith([atsPosting()]));

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toBe('my own notes');
    expect([out.postingState, out.postingStateDetail]).toEqual(['needs_review', 'edited']);
  });

  it('never undoes a user confirmation (issue #250): a real board match changes nothing', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx);
    await setPostingState(app.db, ctx, opp.id, {
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });
    const before = await getOpportunity(app.db, ctx, opp.id);

    // A board that would otherwise confirm it for real: the guard has to fire before
    // findPosting ever runs, not just before the write.
    const outcome = await run(app, ctx, opp.id, boardWith([atsPosting()]));

    expect(outcome).toEqual({ status: 'confirmed', detail: 'user_confirmed' });
    const after = await getOpportunity(app.db, ctx, opp.id);
    expect(after.descriptionMd).toBe(before.descriptionMd);
    expect(after.postingUrl).toBe(before.postingUrl);
    expect([after.postingState, after.postingStateDetail]).toEqual(['confirmed', 'user_confirmed']);
  });

  it('confirms with a null ats_job_ref when no req id can be derived', async () => {
    // Design D25: confirmed is a statement about the description, the ref about addressability.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const opp = await seedCaptured(app, ctx);

    await run(
      app,
      ctx,
      opp.id,
      boardWith([atsPosting({ postingUrl: 'https://soylent.io/careers/staff-pm' })]),
    );

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.postingState).toBe('confirmed');
    expect(out.atsJobRef).toBeNull();
    expect(out.descriptionMd).toContain('Comp: $200k base.');
  });

  it('stores the ATS text alone when AI is unavailable', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const { AiUnavailableError } = await import('@opportun/ai');
    vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
    const opp = await seedCaptured(app, ctx);

    await run(app, ctx, opp.id, boardWith([atsPosting()]));

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.postingState).toBe('confirmed');
    expect(out.descriptionMd).toBe(ATS_BODY);
  });

  it('stores the ATS text alone when there is no capture to merge', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx, { captureText: null });

    await run(app, ctx, opp.id, boardWith([atsPosting()]));

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.postingState).toBe('confirmed');
    expect(out.descriptionMd).toBe(ATS_BODY);
    expect(runStructured).not.toHaveBeenCalled();
  });

  it('never leaves the opportunity stuck on searching when something throws', async () => {
    // Final review, Important 5. `searching` renders a spinner with no action, so a throw that
    // escapes the handler is a permanent dead end: three attempts, job dead, banner spinning
    // forever. The dedupe-key claim in updateOpportunity is the realistic thrower, since a
    // confirm patches `location` and so recomputes the key on almost every success.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx);
    const exploding: BoardLookup = async () => {
      throw new Error('board adapter blew up');
    };

    await expect(run(app, ctx, opp.id, exploding)).resolves.toMatchObject({
      status: 'needs_review',
    });
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.postingState).toBe('needs_review');
    expect(out.descriptionMd).toBe(CAPTURE);
  });

  it('does not fail the capture when the ATS location collides with a tracked opportunity', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx);
    // A live opportunity already holding the key the ATS location would move this one to.
    await createOpportunity(app.db, ctx, {
      companyName: 'Soylent',
      title: TITLE,
      location: 'Remote, United States',
      sourceKind: 'manual',
    });
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });

    await run(app, ctx, opp.id, boardWith([atsPosting()]));

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.postingState).not.toBe('searching');
    // The description is what the user came for; the location is not worth losing it over.
    expect(out.descriptionMd).toContain('Comp: $200k base.');
  });

  it('fills a missing field from the capture and never blanks one the ATS lacks', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const opp = await seedCaptured(app, ctx);
    await updateOpportunity(app.db, ctx, opp.id, { compNote: '$190k from the capture' });

    await run(app, ctx, opp.id, boardWith([atsPosting({ compNote: null })]));

    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.compNote).toBe('$190k from the capture');
    // The ATS states a location, so the ATS value wins (design D7).
    expect(out.location).toBe('Remote, United States');
  });
});

describe('reconcilePosting: timeline entries (issue #247)', () => {
  const notesOf = async (app: FastifyInstance, ctx: UserCtx, opportunityId: string) => {
    const { items } = await listActivities(app.db, ctx, opportunityId, { limit: 50, offset: 0 });
    return items.filter((a) => a.kind === 'note');
  };

  it('names the board, the URL and that the description was replaced, on confirm', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const opp = await seedCaptured(app, ctx, { captureText: null });

    await run(app, ctx, opp.id, boardWith([atsPosting()]));

    const notes = await notesOf(app, ctx, opp.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: "Posting confirmed on the company's board" });
    expect(notes[0]!.bodyMd).toContain('Greenhouse');
    expect(notes[0]!.bodyMd).toContain(atsPosting().postingUrl);
    expect(notes[0]!.bodyMd).toContain('Replaced the description');
  });

  it('says merged, not replaced, when the capture carried something the board did not', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: ['Remote, Full-time'] });
    const opp = await seedCaptured(app, ctx);

    await run(app, ctx, opp.id, boardWith([atsPosting()]));

    const notes = await notesOf(app, ctx, opp.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.bodyMd).toContain('Merged');
  });

  it('names the fields taken from the board beyond the description', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    const opp = await seedCaptured(app, ctx);

    await run(app, ctx, opp.id, boardWith([atsPosting({ compNote: '$210k' })]));

    const notes = await notesOf(app, ctx, opp.id);
    expect(notes[0]!.bodyMd).toContain('location');
    expect(notes[0]!.bodyMd).toContain('compensation');
  });

  it.each([
    [
      'ambiguous' as const,
      undefined,
      [
        atsPosting({ externalId: '1', descriptionMd: 'A.' }),
        atsPosting({ externalId: '2', descriptionMd: 'B.' }),
        atsPosting({ externalId: '3', descriptionMd: 'C.' }),
      ],
    ],
    ['none_found' as const, undefined, [atsPosting({ title: 'Account Executive' })]],
    // no_board needs a company with no ATS detected at all, not just an empty board listing:
    // Soylent (seedCaptured's default) already has one configured, so an empty board there is
    // none_found, not no_board (the same distinction the pre-existing no_board test draws).
    ['no_board' as const, 'Brand New Co', []],
  ])('writes a dated note for the %s outcome', async (detail, companyName, postings) => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx, companyName === undefined ? {} : { companyName });

    await run(app, ctx, opp.id, boardWith(postings));

    const notes = await notesOf(app, ctx, opp.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.bodyMd?.length).toBeGreaterThan(0);
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.postingStateDetail).toBe(detail);
  });

  it('writes a note when the description was already edited, naming why nothing changed', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx);
    await updateOpportunity(app.db, ctx, opp.id, { descriptionMd: 'my own notes' });

    await run(app, ctx, opp.id, boardWith([atsPosting()]));

    const notes = await notesOf(app, ctx, opp.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: 'Posting check: description kept' });
  });

  // #858: the note said "skipped" before; the same outcome refreshes it, title included.
  it('refreshes a note with the old title in place, and gives it the new one', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx);
    await updateOpportunity(app.db, ctx, opp.id, { descriptionMd: 'my own notes' });
    const old = await createActivity(app.db, ctx, opp.id, {
      kind: 'note',
      title: 'Posting check skipped: description already edited',
      bodyMd: 'as it was written before',
      occurredAt: 1,
      participants: [],
      externalUrl: null,
    });

    await run(app, ctx, opp.id, boardWith([atsPosting()]));

    const notes = await notesOf(app, ctx, opp.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: old.id, title: 'Posting check: description kept' });
    expect(notes[0]!.bodyMd).toContain('You have edited');
    expect(notes[0]!.occurredAt).toBeGreaterThan(1);
  });

  it('an old-titled note is still that outcome: another outcome is written beside it (#858)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx);
    const old = await createActivity(app.db, ctx, opp.id, {
      kind: 'note',
      title: 'Posting check skipped: description already edited',
      bodyMd: 'as it was written before',
      occurredAt: 1,
      participants: [],
      externalUrl: null,
    });

    await run(app, ctx, opp.id, boardWith([atsPosting({ title: 'Account Executive' })]));

    const notes = await notesOf(app, ctx, opp.id);
    expect(notes.map((n) => n.title)).toContain("Posting not found on the company's board");
    expect(notes.find((n) => n.id === old.id)).toMatchObject({
      title: 'Posting check skipped: description already edited',
      bodyMd: 'as it was written before',
    });
  });

  // reconcilePosting's outer catch (-> flag(..., 'failed', ...)) is not independently exercised
  // here: findPosting already catches a throwing board lookup internally and reports a normal
  // outcome (none/no_board) rather than letting it escape, confirmed empirically rather than
  // assumed -- the pre-existing "never leaves stuck on searching" test's own exploding
  // BoardLookup lands on needs_review by that route, not the outer catch. Forcing a genuine
  // escape from findPosting's own defensive handling, just to exercise one call to the same
  // flag() every other case in this block already covers, would need invasive module mocking
  // for a one-line call site; not worth it for what it would prove.

  it('refreshes the same note in place on a repeat run that lands on the same outcome, instead of piling up duplicates', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx);

    await run(app, ctx, opp.id, boardWith([atsPosting({ title: 'Account Executive' })]));
    const first = await notesOf(app, ctx, opp.id);
    expect(first).toHaveLength(1);
    const firstOccurredAt = first[0]!.occurredAt;

    await new Promise((r) => setTimeout(r, 2));
    await run(app, ctx, opp.id, boardWith([atsPosting({ title: 'Account Executive' })]));

    const second = await notesOf(app, ctx, opp.id);
    expect(second).toHaveLength(1); // still one, not two
    expect(second[0]!.id).toBe(first[0]!.id); // the same row, refreshed
    expect(second[0]!.occurredAt).toBeGreaterThan(firstOccurredAt);
  });

  it('writes a fresh note on a real transition to a different outcome, keeping the old one', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await seedCaptured(app, ctx);

    // First run: a board exists (Soylent's Greenhouse) but carries no match for this title.
    await run(app, ctx, opp.id, boardWith([atsPosting({ title: 'Account Executive' })]));
    const afterFirst = await notesOf(app, ctx, opp.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ title: "Posting not found on the company's board" });

    // Second run: now the board resolves and confirms.
    vi.mocked(runStructured).mockResolvedValue({ passages: [] });
    await run(app, ctx, opp.id, boardWith([atsPosting()]));

    const afterSecond = await notesOf(app, ctx, opp.id);
    expect(afterSecond).toHaveLength(2); // the transition is kept, not collapsed
    expect(afterSecond.map((n) => n.title)).toEqual(
      expect.arrayContaining([
        "Posting not found on the company's board",
        "Posting confirmed on the company's board",
      ]),
    );
  });
});
