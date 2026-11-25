// Guarding posting writes on authorship rather than presence (design D10, D11).
//
// FR-O1 keeps an opportunity's fields editable by hand, and before this branch that was
// enforced by refusing Find posting and attach whenever a description existed at all. A
// capture makes that permanently true, so the button that resolves a needs-review flag would
// vanish exactly when it is needed. The guard now asks who wrote the text.
import { runStructured } from '@opportun/ai';
import { sha256Hex, type NormalizedPosting } from '@opportun/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { registerSource, resetSources } from '../src/adapters/discoverySource';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import { createCompany } from '../src/repos/companies';
import {
  createOpportunity,
  getOpportunity,
  setPostingState,
  updateOpportunity,
} from '../src/repos/opportunities';
import type { UserCtx } from '../src/repos/base';

vi.mock('@opportun/ai', async (orig) => ({
  ...(await orig<typeof import('@opportun/ai')>()),
  runStructured: vi.fn(),
}));
afterEach(resetSources);

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

async function opportunity(
  app: FastifyInstance,
  ctx: UserCtx,
  descriptionMd: string,
  writtenBySystem: boolean,
) {
  await createCompany(app.db, ctx, { name: 'Soylent' });
  const opp = await createOpportunity(app.db, ctx, {
    companyName: 'Soylent',
    title: 'Staff Product Manager',
    descriptionMd,
    sourceKind: 'discovery',
  });
  if (writtenBySystem) {
    await updateOpportunity(app.db, ctx, opp.id, {
      descriptionFingerprint: descriptionFingerprint(descriptionMd),
    });
  }
  return opp;
}

const find = (c: TestClient, id: string) =>
  c.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });

const attach = (c: TestClient, id: string, payload: Record<string, unknown>) =>
  c.request({ method: 'POST', url: `/api/v1/opportunities/${id}/posting`, payload });

describe('posting writes are guarded on authorship', () => {
  it('lets Find posting run again on a description the capture wrote', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await opportunity(app, ctx, 'the captured page text', true);
    await setPostingState(app.db, ctx, opp.id, {
      postingState: 'needs_review',
      postingStateDetail: 'none_found',
    });

    const res = await find(a, opp.id);

    // No board is registered, so the search itself finds nothing; what matters is that it ran
    // rather than being refused before it started.
    expect(res.statusCode, res.body).toBe(200);
  });

  // #756: refused once its posting is confirmed; before that, Find posting may confirm it from
  // the board while keeping the description (test/opportunityPosting.test.ts).
  it('Find posting on a description the user wrote, once its posting is confirmed, keeps the description (#812)', async () => {
    const { app, a } = await boot();
    const opp = await opportunity(app, ctxOf(a), 'my own notes', false);
    await setPostingState(app.db, ctxOf(a), opp.id, {
      postingState: 'confirmed',
      postingStateDetail: null,
    });

    const res = await find(a, opp.id);

    expect(res.statusCode, res.body).toBe(200);
    expect((await getOpportunity(app.db, ctxOf(a), opp.id)).descriptionMd).toBe('my own notes');
  });

  // #756 (tl): once the user edited what the capture wrote, Find posting may still confirm an
  // unconfirmed posting, the edit kept; with the posting confirmed it is refused as before.
  it('Find posting on a description the user edited: kept while unconfirmed, and once confirmed (#812)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await opportunity(app, ctx, 'the captured page text', true);
    await updateOpportunity(app.db, ctx, opp.id, { descriptionMd: 'my own notes' });

    expect((await find(a, opp.id)).statusCode).toBe(200);
    expect((await getOpportunity(app.db, ctx, opp.id)).descriptionMd).toBe('my own notes');

    await setPostingState(app.db, ctx, opp.id, {
      postingState: 'confirmed',
      postingStateDetail: null,
    });
    expect((await find(a, opp.id)).statusCode).toBe(200);
    expect((await getOpportunity(app.db, ctx, opp.id)).descriptionMd).toBe('my own notes');
  });

  // The reconcile job raises `edited` precisely because the description is the user's, so the board's
  // copy may replace it, but only when the user agreed to lose the text they were shown (#858): the
  // request names it by its fingerprint. Without that, or for older text, it is kept.
  describe('at edited, a replace needs the agreement to lose this text (#858)', () => {
    // Not ASCII only: the page's own hash has to be the one the server works out.
    const MINE = 'my own notes: café, 東京 🚀';
    const OLDER = 'an earlier version of my notes';
    const PAGE_TEXT = 'Own the metrics and tracing roadmap.';
    const BOARD_TEXT = 'What We Do: the board copy.';
    const ROW = {
      company: 'Soylent',
      title: 'Staff Product Manager',
      descriptionMd: BOARD_TEXT,
      postingUrl: 'https://job-boards.greenhouse.io/soylent/jobs/123',
      location: null,
      externalId: '123',
    };

    async function edited(descriptionMd = MINE) {
      const { app, a } = await boot();
      const ctx = ctxOf(a);
      // The page behind a pasted link, read and extracted as a manual capture is.
      app.jobs.services.sourceFetch = (async () => ({
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: Buffer.from(PAGE_TEXT),
      })) as unknown as typeof app.jobs.services.sourceFetch;
      vi.mocked(runStructured).mockResolvedValue({
        companyName: null,
        title: null,
        descriptionMd: PAGE_TEXT,
        postingUrl: null,
        location: null,
        remote: null,
        compNote: null,
      });
      await createCompany(app.db, ctx, {
        name: 'Soylent',
        atsKind: 'ats_greenhouse',
        atsRef: 'soylent',
        atsVerifiedAt: Date.now(),
      });
      registerSource({
        kind: 'ats_greenhouse',
        async *fetchPostings() {
          yield { posting: ROW as NormalizedPosting, nextCursor: null };
        },
      });
      const opp = await createOpportunity(app.db, ctx, {
        companyName: 'Soylent',
        title: 'Staff Product Manager',
        descriptionMd,
        sourceKind: 'discovery',
      });
      await setPostingState(app.db, ctx, opp.id, {
        postingState: 'needs_review',
        postingStateDetail: 'edited',
      });
      return { app, a, id: opp.id, read: () => getOpportunity(app.db, ctx, opp.id) };
    }

    const search = (c: TestClient, id: string, agreed: string | undefined) =>
      c.request({
        method: 'POST',
        url: `/api/v1/opportunities/${id}/find-posting${agreed === undefined ? '' : `?replaceDescription=${sha256Hex(agreed)}`}`,
      });
    const hand = (
      c: TestClient,
      id: string,
      payload: Record<string, unknown>,
      agreed: string | undefined,
    ) =>
      attach(c, id, {
        ...payload,
        ...(agreed === undefined ? {} : { replaceDescription: sha256Hex(agreed) }),
      });

    describe.each([
      ['no agreement', undefined],
      ['an agreement for older text', OLDER],
    ])('with %s', (_what, agreed) => {
      it('Find posting keeps the description and says so', async () => {
        const { a, id, read } = await edited();
        const res = await search(a, id, agreed);
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toMatchObject({ outcome: 'attached', keptDescription: true });
        expect(await read()).toMatchObject({
          descriptionMd: MINE,
          postingState: 'confirmed',
          postingStateDetail: 'user_confirmed',
          postingUrl: ROW.postingUrl,
        });
      });

      it('a picked row keeps the description', async () => {
        const { a, id, read } = await edited();
        const res = await hand(a, id, { posting: ROW }, agreed);
        expect(res.statusCode, res.body).toBe(200);
        expect(await read()).toMatchObject({
          descriptionMd: MINE,
          postingState: 'confirmed',
          postingStateDetail: 'user_confirmed',
        });
      });

      it('a paste is refused, and nothing is written', async () => {
        const { a, id, read } = await edited();
        const before = await read();
        const res = await hand(a, id, { text: 'pasted text' }, agreed);
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error.code).toBe('already_described');
        expect(await read()).toEqual(before);
      });

      it('a pasted link is refused, and nothing is written', async () => {
        const { a, id, read } = await edited();
        const before = await read();
        const res = await hand(a, id, { url: 'https://careers.soylent.example/jobs/1' }, agreed);
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error.code).toBe('already_described');
        expect(await read()).toEqual(before);
      });
    });

    describe('with the agreement for this text', () => {
      it.each([
        ['Find posting', (a: TestClient, id: string) => search(a, id, MINE), BOARD_TEXT],
        [
          'a picked row',
          (a: TestClient, id: string) => hand(a, id, { posting: ROW }, MINE),
          BOARD_TEXT,
        ],
        [
          'a paste',
          (a: TestClient, id: string) => hand(a, id, { text: 'pasted text' }, MINE),
          'pasted text',
        ],
        [
          'a pasted link',
          (a: TestClient, id: string) =>
            hand(a, id, { url: 'https://careers.soylent.example/jobs/1' }, MINE),
          PAGE_TEXT,
        ],
      ])('%s replaces it', async (_what, act, text) => {
        const { a, id, read } = await edited();
        const res = await act(a, id);
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().keptDescription).toBeUndefined();
        expect(await read()).toMatchObject({
          descriptionMd: text,
          descriptionIsUserWritten: false,
          postingState: 'confirmed',
          postingStateDetail: null,
        });
      });
    });

    // The agreement is to lose an edit the check flagged: in any other state it changes nothing.
    it.each([
      ['needs_review', 'none_found'],
      ['confirmed', 'user_confirmed'],
      [null, null],
    ] as const)('at %s / %s the agreement replaces nothing', async (postingState, detail) => {
      const { app, a, id, read } = await edited();
      await setPostingState(app.db, ctxOf(a), id, { postingState, postingStateDetail: detail });
      expect((await hand(a, id, { text: 'pasted text' }, MINE)).statusCode).toBe(409);
      expect((await hand(a, id, { posting: ROW }, MINE)).statusCode).toBe(200);
      expect((await read()).descriptionMd).toBe(MINE);
    });

    it.each(['', 'x', 'A'.repeat(64), `${'a'.repeat(64)}0`])(
      'a fingerprint that is not one is refused: %s',
      async (bad) => {
        const { a, id, read } = await edited();
        const before = await read();
        expect((await attach(a, id, { posting: ROW, replaceDescription: bad })).statusCode).toBe(
          400,
        );
        const found = await a.request({
          method: 'POST',
          url: `/api/v1/opportunities/${id}/find-posting?replaceDescription=${bad}`,
        });
        expect(found.statusCode).toBe(400);
        expect(await read()).toEqual(before);
      },
    );
  });

  // #756: on a flagged, unconfirmed posting, Find posting runs and keeps the user's text; pasted
  // text is still refused over it.
  it('on a flagged opportunity, Find posting keeps the description and pasted text is still refused', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await opportunity(app, ctx, 'my own notes', false);
    await setPostingState(app.db, ctx, opp.id, {
      postingState: 'needs_review',
      postingStateDetail: 'none_found',
    });

    expect((await find(a, opp.id)).statusCode).toBe(200);
    expect((await getOpportunity(app.db, ctx, opp.id)).descriptionMd).toBe('my own notes');
    expect((await attach(a, opp.id, { text: 'the board copy' })).statusCode).toBe(409);
  });

  // #756: a row picked from the board's candidates confirms an unconfirmed posting the user
  // described, the description kept and the posting marked as the user's own.
  it('a picked board row confirms the posting and keeps the description the user wrote', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await opportunity(app, ctx, 'my own notes', false);
    const res = await attach(a, opp.id, {
      posting: {
        company: 'Soylent',
        title: 'Staff Product Manager',
        descriptionMd: 'the board copy',
        postingUrl: 'https://job-boards.greenhouse.io/soylent/jobs/123',
        location: null,
        externalId: '123',
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await getOpportunity(app.db, ctx, opp.id)).toMatchObject({
      descriptionMd: 'my own notes',
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
      postingUrl: 'https://job-boards.greenhouse.io/soylent/jobs/123',
    });
  });

  it('attaching pasted text replaces a system description and refreshes the fingerprint', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await opportunity(app, ctx, 'the captured page text', true);

    const res = await attach(a, opp.id, { text: 'the board copy' });

    expect(res.statusCode, res.body).toBe(200);
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toBe('the board copy');
    expect(out.descriptionFingerprint).toBe(descriptionFingerprint('the board copy'));
    // A posting the user attached by hand is settled, not waiting on a board.
    expect(out.postingState).toBe('confirmed');
  });

  it('still refuses to attach over a description the user wrote', async () => {
    const { app, a } = await boot();
    const opp = await opportunity(app, ctxOf(a), 'my own notes', false);

    const res = await attach(a, opp.id, { text: 'the board copy' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_described');
  });

  it('attaches to an opportunity with no description at all, as it always did', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, { name: 'Soylent' });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Soylent',
      title: 'Staff Product Manager',
      sourceKind: 'manual',
    });

    expect((await attach(a, opp.id, { text: 'the board copy' })).statusCode).toBe(200);
  });
});
