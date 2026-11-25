// A capture and a decision on the Discovery page that meet on one result leave one opportunity
// for it, and neither undoes the other (https://github.com/bgoleno/opportun/issues/968). Accept
// read the result and then created or attached with nothing around the two, and dismiss waited
// for nothing, so a capture landing between made Accept answer that the job matched another
// opportunity (its own), Create anyway make a second one, and Dismiss turn an accepted row
// dismissed. Each order is built here with a race point. Every posting is made up.
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { discoveryResults, dismissalFeedback, opportunities } from '../src/db/schema';
import { resolveCapture } from '../src/lib/captureResolve';
import type { UserCtx } from '../src/repos/base';
import { createRun, ensureChannelSource, getResult, insertResult } from '../src/repos/discovery';
import { createOpportunity, getOpportunity } from '../src/repos/opportunities';
import { onSlowTransaction } from '../src/db/gate';
import { useApi } from './api';
import { testDialect } from './db';
import type { TestClient } from './isolation';
import { heldApart, pauseAt, whileParked } from './race';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

const PAGE = 'Own the platform, as the page has it.';
const lead = (n: number): NormalizedPosting => ({
  company: 'Initech',
  title: `Platform Engineer ${'abcdefghijklmnopqrstuvwxyz'.charAt(n)}`,
  location: 'Example City, EX',
  postingUrl: `https://www.linkedin.com/jobs/view/${1_000_000_001 + n}/`,
  externalId: String(1_000_000_001 + n),
});

/** A card from a job alert email: no description. */
async function card(app: FastifyInstance, c: TestClient, n = 0): Promise<string> {
  const ctx = ctxOf(c);
  const source = await ensureChannelSource(app.db, ctx, 'alert_email');
  const run = await createRun(app.db, ctx, { sourceId: source.id });
  const posting = lead(n);
  const result = await insertResult(app.db, ctx, {
    runId: run.id,
    posting,
    dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
    resolution: 'needs_capture',
  });
  return result.id;
}

/** The extension's capture of the card's posting; it has no location (no AI key). */
const capture = (app: FastifyInstance, c: TestClient, n = 0) =>
  resolveCapture(app.db, ctxOf(c), {
    posting: {
      ...lead(n),
      location: null,
      descriptionMd: PAGE,
      externalId: `linkedin:${1_000_000_001 + n}`,
    },
    captureText: PAGE,
    siteId: 'linkedin',
  });

const other = (app: FastifyInstance, c: TestClient) =>
  createOpportunity(app.db, ctxOf(c), {
    companyName: 'Globex',
    title: 'Data Analyst',
    sourceKind: 'manual',
  });

type Decide = (c: TestClient, id: string, otherId: string) => ReturnType<TestClient['request']>;
const post = (c: TestClient, url: string, payload: Record<string, unknown>) =>
  c.request({ method: 'POST', url: `/api/v1/discovery/results/${url}`, payload });

const WAYS: readonly (readonly [string, Decide])[] = [
  ['accept', (c, id) => post(c, `${id}/accept`, {})],
  ['attach', (c, id, otherId) => post(c, `${id}/accept`, { attachTo: otherId })],
  ['create anyway', (c, id) => post(c, `${id}/accept`, { force: true })],
  ['dismiss', (c, id) => post(c, `${id}/dismiss`, { reason: 'stale' })],
  ['a bulk accept item', (c, id) => post(c, 'bulk-accept', { ids: [id] })],
  ['a bulk dismiss item', (c, id) => post(c, 'bulk-dismiss', { ids: [id], reason: 'stale' })],
];
const isDismiss = (name: string): boolean => name.includes('dismiss');

const opportunityIds = async (app: FastifyInstance, c: TestClient): Promise<string[]> =>
  (
    await app.db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.userId, c.userId))
      .all()
  ).map((r) => r.id);

const feedbackOf = (app: FastifyInstance, id: string) =>
  app.db.select().from(dismissalFeedback).where(eq(dismissalFeedback.resultId, id)).all();

describe('a capture and a decision on one result (#968)', () => {
  it.each(WAYS)(
    'the capture first: %s is told it is decided, and changes nothing',
    async (name, decide) => {
      const { app, a } = await boot();
      const id = await card(app, a);
      const elsewhere = await other(app, a);

      const [captured, res] = await heldApart(
        app,
        'captureResolve.matched.locked',
        () => capture(app, a),
        () => decide(a, id, elsewhere.id),
      );

      const decidedIn = { disposition: 'accepted', opportunityId: captured.opportunityId };
      expect(captured.resultId).toBe(id);
      expect(await getResult(app.db, ctxOf(a), id)).toMatchObject(decidedIn);
      if (name.startsWith('a bulk')) {
        expect(res.json().results).toEqual([
          { id, outcome: 'already_decided', existingId: captured.opportunityId },
        ]);
      } else {
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error).toMatchObject({
          code: 'already_decided',
          disposition: 'accepted',
          existingId: captured.opportunityId,
        });
      }
      expect((await opportunityIds(app, a)).sort()).toEqual(
        [elsewhere.id, captured.opportunityId].sort(),
      );
      expect(await feedbackOf(app, id)).toEqual([]);
      expect((await getOpportunity(app.db, ctxOf(a), captured.opportunityId)).stage).toBe(
        'interested',
      );
    },
  );

  it.each(WAYS)('%s first: the capture goes where the decision put it', async (name, decide) => {
    const { app, a } = await boot();
    const id = await card(app, a);
    const elsewhere = await other(app, a);

    const [res, captured] = await heldApart(
      app,
      'discovery.decide.locked',
      () => decide(a, id, elsewhere.id),
      () => capture(app, a),
    );

    expect(res.statusCode, res.body).toBe(200);
    const row = await getResult(app.db, ctxOf(a), id);
    const all = await opportunityIds(app, a);
    if (isDismiss(name)) {
      // The user said no to the card and then captured the posting: the capture is its own
      // opportunity, and the card stays dismissed.
      expect(row).toMatchObject({ disposition: 'dismissed', opportunityId: null });
      expect(captured.resultId).not.toBe(id);
      expect(await feedbackOf(app, id)).toHaveLength(1);
    } else {
      expect(row).toMatchObject({
        disposition: 'accepted',
        opportunityId: captured.opportunityId,
      });
      expect(captured).toMatchObject({ resultId: id, createdOpportunity: false });
    }
    expect(all.sort()).toEqual([...new Set([elsewhere.id, captured.opportunityId])].sort());
    if (name === 'attach') expect(captured.opportunityId).toBe(elsewhere.id);
    const opp = await getOpportunity(app.db, ctxOf(a), captured.opportunityId);
    expect(opp).toMatchObject({ stage: 'interested', descriptionMd: PAGE });
  });

  it('create anyway on a pending result that matches another opportunity, then the capture: two, and no third', async () => {
    const { app, a } = await boot();
    const id = await card(app, a);
    const p = lead(0);
    const tracked = await createOpportunity(app.db, ctxOf(a), {
      companyName: p.company,
      title: p.title,
      location: p.location ?? null,
      sourceKind: 'manual',
    });
    const [res, captured] = await heldApart(
      app,
      'discovery.decide.locked',
      () => post(a, `${id}/accept`, { force: true }),
      () => capture(app, a),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(captured.opportunityId).toBe(res.json().opportunityId);
    expect((await opportunityIds(app, a)).sort()).toEqual(
      [tracked.id, captured.opportunityId].sort(),
    );
  });

  it('the capture first, of a card whose locations a bulk accept holds: all of them are decided', async () => {
    const { app, a } = await boot();
    const id = await card(app, a);
    const ctx = ctxOf(a);
    const source = await ensureChannelSource(app.db, ctx, 'manual');
    const run = await createRun(app.db, ctx, { sourceId: source.id });
    const posting = {
      ...lead(0),
      location: 'Another City, EX',
      postingUrl: 'https://boards.example.com/initech/9',
      externalId: 'gh-9',
    };
    const elsewhere = await insertResult(app.db, ctx, {
      runId: run.id,
      posting,
      dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
      resolution: 'full',
    });

    const [captured, res] = await heldApart(
      app,
      'captureResolve.matched.locked',
      () => capture(app, a),
      () => post(a, 'bulk-accept', { ids: [id, elsewhere.id] }),
    );

    expect(res.json().results).toEqual([
      { id, outcome: 'already_decided', existingId: captured.opportunityId },
      { id: elsewhere.id, outcome: 'already_decided', existingId: captured.opportunityId },
    ]);
    expect(await opportunityIds(app, a)).toEqual([captured.opportunityId]);
  });

  it('two undos with an Accept between them: the accepted row stays accepted', async () => {
    const { app, a } = await boot();
    const id = await card(app, a);
    expect((await post(a, `${id}/dismiss`, { reason: 'stale' })).statusCode).toBe(200);
    const undo = () => post(a, 'bulk-undo-dismiss', { ids: [id] });
    const [first, second] = await heldApart(app, 'discovery.undo.locked', undo, async () => {
      const again = await undo();
      const accepted = await post(a, `${id}/accept`, {});
      expect(accepted.statusCode, accepted.body).toBe(200);
      return again;
    });
    expect(first.json().results).toEqual([{ id, outcome: 'restored' }]);
    expect(second.json().results).toEqual([{ id, outcome: 'already_decided' }]);
    expect((await getResult(app.db, ctxOf(a), id)).disposition).toBe('accepted');
  });

  // https://github.com/bgoleno/opportun/issues/1008: unsuppress decides from the row and writes it
  // under the user's lock, so what an undo or a delete makes of the row is never written over.
  describe('unsuppress', () => {
    const unsuppress = (c: TestClient, id: string) => post(c, `${id}/unsuppress`, {});
    const undo = (c: TestClient, id: string) => post(c, 'bulk-undo-dismiss', { ids: [id] });

    it('an undo first: refused, and the result pending again has its key', async () => {
      const { app, a } = await boot();
      const id = await card(app, a);
      const { dedupeKey: key } = await getResult(app.db, ctxOf(a), id);
      expect((await post(a, `${id}/dismiss`, {})).statusCode).toBe(200);
      const [undone, res] = await heldApart(
        app,
        'discovery.undo.locked',
        () => undo(a, id),
        () => unsuppress(a, id),
      );
      expect(undone.json().results).toEqual([{ id, outcome: 'restored' }]);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('already_pending');
      expect(await getResult(app.db, ctxOf(a), id)).toMatchObject({
        disposition: 'pending',
        dedupeKey: key,
      });
    });

    it('before an undo: each does its own', async () => {
      const { app, a } = await boot();
      const id = await card(app, a);
      expect((await post(a, `${id}/dismiss`, {})).statusCode).toBe(200);
      const [res, undone] = await heldApart(
        app,
        'discovery.unsuppress.locked',
        () => unsuppress(a, id),
        () => undo(a, id),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ disposition: 'dismissed', dedupeKey: null });
      expect(undone.json().results).toEqual([{ id, outcome: 'restored' }]);
    });

    it('an undo and an accept first: refused, and the accepted result keeps its key', async () => {
      const { app, a } = await boot();
      const id = await card(app, a);
      const { dedupeKey: key } = await getResult(app.db, ctxOf(a), id);
      expect((await post(a, `${id}/dismiss`, {})).statusCode).toBe(200);
      expect((await undo(a, id)).statusCode).toBe(200);
      const [accepted, res] = await heldApart(
        app,
        'discovery.decide.locked',
        () => post(a, `${id}/accept`, {}),
        () => unsuppress(a, id),
      );
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('opportunity_still_active');
      expect((await getResult(app.db, ctxOf(a), id)).dedupeKey).toBe(key);
    });

    async function acceptedCard(app: FastifyInstance, a: TestClient) {
      const id = await card(app, a);
      const accepted = await post(a, `${id}/accept`, {});
      const { opportunityId } = accepted.json<{ opportunityId: string }>();
      const remove = () =>
        a.request({ method: 'DELETE', url: `/api/v1/opportunities/${opportunityId}` });
      return { id, opportunityId, remove };
    }

    it('a delete first: its key is let go', async () => {
      const { app, a } = await boot();
      const { id, remove } = await acceptedCard(app, a);
      const [removed, res] = await heldApart(app, 'opportunities.delete.locked', remove, () =>
        unsuppress(a, id),
      );
      expect(removed.statusCode, removed.body).toBe(204);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ opportunityId: null, dedupeKey: null });
    });

    it('before a delete: refused as the opportunity is there, and the key stays', async () => {
      const { app, a } = await boot();
      const { id, remove } = await acceptedCard(app, a);
      const [res, removed] = await heldApart(
        app,
        'discovery.unsuppress.locked',
        () => unsuppress(a, id),
        remove,
      );
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('opportunity_still_active');
      expect(removed.statusCode, removed.body).toBe(204);
      const after = await getResult(app.db, ctxOf(a), id);
      expect(after.opportunityId).toBeNull();
      expect(after.dedupeKey).not.toBeNull();
    });

    it('before a delete of a dismissed opportunity: both go through', async () => {
      const { app, a } = await boot();
      const { id, opportunityId, remove } = await acceptedCard(app, a);
      const dismissed = await a.request({
        method: 'POST',
        url: `/api/v1/opportunities/${opportunityId}/stage`,
        payload: { to: 'dismissed' },
      });
      expect(dismissed.statusCode, dismissed.body).toBe(200);
      const [res, removed] = await heldApart(
        app,
        'discovery.unsuppress.locked',
        () => unsuppress(a, id),
        remove,
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(removed.statusCode, removed.body).toBe(204);
      expect(await getResult(app.db, ctxOf(a), id)).toMatchObject({
        opportunityId: null,
        dedupeKey: null,
      });
    });

    // A writer that does not take the user's lock (the dedupe-key repair, the purge, one to come).
    // Only on Postgres can it write between the read and the UPDATE; SQLite's gate keeps it out.
    describe.runIf(testDialect === 'postgres')('a row changed meanwhile is not written', () => {
      it.each([
        ['another key', { dedupeKey: 'another key' }],
        ['pending', { disposition: 'pending' }],
        ['an opportunity', { opportunityId: 'another' }],
      ] as const)('%s', async (_what, changed) => {
        const { app, a } = await boot();
        const id = await card(app, a);
        expect((await post(a, `${id}/dismiss`, {})).statusCode).toBe(200);
        const change =
          'opportunityId' in changed ? { opportunityId: (await other(app, a)).id } : changed;
        onSlowTransaction(() => undefined);
        const pause = pauseAt('discovery.unsuppress.locked');
        const asked = unsuppress(a, id);
        await whileParked(
          pause,
          async () =>
            await app.db
              .update(discoveryResults)
              .set(change)
              .where(eq(discoveryResults.id, id))
              .run(),
        );
        const before = await getResult(app.db, ctxOf(a), id);
        const res = await asked;
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error).toEqual({
          code: 'result_changed',
          message:
            'This result changed while it was being unsuppressed, so nothing was changed. Try again.',
        });
        expect(await getResult(app.db, ctxOf(a), id)).toEqual(before);
        expect(before.dedupeKey).not.toBeNull();
      });

      it('gone', async () => {
        const { app, a } = await boot();
        const id = await card(app, a);
        expect((await post(a, `${id}/dismiss`, {})).statusCode).toBe(200);
        onSlowTransaction(() => undefined);
        const pause = pauseAt('discovery.unsuppress.locked');
        const asked = unsuppress(a, id);
        await whileParked(
          pause,
          async () =>
            await app.db.delete(discoveryResults).where(eq(discoveryResults.id, id)).run(),
        );
        expect((await asked).statusCode).toBe(404);
      });
    });
  });

  // Unparked, all at once: whatever the order, no request fails (a deadlock is a 500 here), and
  // each card ends decided once.
  it.each(WAYS)(
    'many at once, the capture against %s: none fails, each card is decided once',
    async (name, decide) => {
      const { app, a } = await boot();
      const elsewhere = await other(app, a);
      const cards: string[] = [];
      for (let n = 0; n < 8; n++) cards.push(await card(app, a, n));
      const answers = await Promise.all(
        cards.flatMap((id, n) => [
          decide(a, id, elsewhere.id).then((res) => {
            expect([200, 409], res.body).toContain(res.statusCode);
            if (res.statusCode === 409) expect(res.json().error.code).toBe('already_decided');
            const item = res.json().results?.[0];
            if (item !== undefined) expect(item.outcome).not.toBe('error');
            return null;
          }),
          capture(app, a, n),
        ]),
      );
      const captured = answers.filter((x) => x !== null);
      for (const [n, id] of cards.entries()) {
        const row = await getResult(app.db, ctxOf(a), id);
        const feedback = await feedbackOf(app, id);
        if (row.disposition === 'dismissed') {
          expect(isDismiss(name)).toBe(true);
          expect(feedback).toHaveLength(1);
        } else {
          expect(row).toMatchObject({
            disposition: 'accepted',
            opportunityId: captured[n]?.opportunityId,
          });
          expect(feedback).toEqual([]);
        }
      }
      const expected = new Set([elsewhere.id, ...captured.map((r) => r.opportunityId)]);
      expect((await opportunityIds(app, a)).sort()).toEqual([...expected].sort());
      const rows = await app.db
        .select({ d: discoveryResults.disposition })
        .from(discoveryResults)
        .where(eq(discoveryResults.userId, a.userId))
        .all();
      expect(rows.every((r) => r.d !== 'pending')).toBe(true);
    },
  );
});
