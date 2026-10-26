// posting.reconcile (design D4 to D8, D11, D21, D25, D26, D27): after a capture puts the page
// text on an opportunity, this looks the same job up on the company's own ATS board. A
// confident match makes the employer's copy authoritative and keeps the capture's extras; any
// other outcome changes nothing and raises a flag the user can act on.
import type { NormalizedPosting } from '@opportun/core';
import { describe, expect, it, vi } from 'vitest';
import { runStructured } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import { reconcilePosting } from '../src/jobs/postingReconcile';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import type { BoardLookup } from '../src/lib/postingSearch';
import type { safeFetch } from '../src/lib/safeFetch';
import { createActivity, listActivities } from '../src/repos/activities';
import { createCompany } from '../src/repos/companies';
import {
  createOpportunity,
  getOpportunity,
  setPostingState,
  updateOpportunity,
} from '../src/repos/opportunities';
import type { UserCtx } from '../src/repos/base';
import { useApi } from './api';
import type { TestClient } from './isolation';

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
    expect(notes[0]).toMatchObject({ title: 'Posting check skipped: description already edited' });
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
