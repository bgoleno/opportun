// A message rejected in another tab or session is gone (https://github.com/bgoleno/opportun/issues/895):
// it can't be linked or reclassified, which would put an entry with no subject or text
// on an opportunity's timeline, and a move it suggested is refused with the reason.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { onSlowTransaction } from '../src/db/gate';
import { communications, dismissalFeedback, stageHistory } from '../src/db/schema';
import { setRaceHook } from '../src/lib/racePoints';
import { reclassify, upsertInbound } from '../src/repos/communications';
import { createOpportunity } from '../src/repos/opportunities';
import { rejectCommunication } from '../src/repos/reject';
import { useApi } from './api';
import { testDialect } from './db';
import type { TestClient } from './isolation';
import { pauseAt } from './race';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

let seq = 0;
async function message(app: FastifyInstance, a: TestClient): Promise<string> {
  seq += 1;
  const { id } = await upsertInbound(app.db, ctxOf(a), 'gmail', {
    externalId: `gone-${seq}`,
    threadKey: `gone-${seq}`,
    from: 'Riley Recruiter <riley@acme.example>',
    to: ['me@example.com'],
    subject: `Subject ${seq}`,
    snippet: 'A snippet',
    bodyText: 'A body',
    sentAt: Date.now() - 1000 * seq,
  });
  return id;
}

const opportunity = (app: FastifyInstance, a: TestClient, title: string) =>
  createOpportunity(app.db, ctxOf(a), { companyName: 'Initech', title, sourceKind: 'manual' });

const row = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(communications).where(eq(communications.id, id)).get())!;

const classify = (a: TestClient, id: string, payload: Record<string, unknown>) =>
  a.request({ method: 'POST', url: `/api/v1/communications/${id}/classify`, payload });

const accept = (a: TestClient, id: string) =>
  a.request({ method: 'POST', url: `/api/v1/communications/${id}/accept-transition`, payload: {} });

const timeline = async (a: TestClient, oppId: string) => {
  const res = await a.request({ method: 'GET', url: `/api/v1/opportunities/${oppId}/timeline` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: { kind: string }[] }).items;
};

const REFUSED = {
  code: 'message_rejected',
  message: 'This message has been rejected, so it was left as it is.',
};

describe('a rejected message (#895)', () => {
  it('cannot be linked: refused with the reason, nothing written, no timeline entry', async () => {
    const { app, a } = await boot();
    const opp = await opportunity(app, a, 'Engineer');
    const id = await message(app, a);
    await rejectCommunication(app.db, ctxOf(a), id, {
      reason: 'spam',
      expectedOpportunityId: null,
    });
    const before = JSON.stringify(await row(app, id));
    const feedback = (await app.db.select().from(dismissalFeedback).all()).length;

    const res = await classify(a, id, { opportunityId: opp.id });

    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: object }).error).toMatchObject(REFUSED);
    expect(JSON.stringify(await row(app, id))).toBe(before);
    expect((await app.db.select().from(dismissalFeedback).all()).length).toBe(feedback);
    expect((await timeline(a, opp.id)).filter((i) => i.kind === 'communication')).toEqual([]);
  });

  it.each([
    ['reclassified', { classification: 'networking' }],
    ['marked not spam', { classification: 'solicitation', outreachKind: 'targeted' }],
  ])('cannot be %s either', async (_, payload) => {
    const { app, a } = await boot();
    const opp = await opportunity(app, a, 'Engineer');
    const id = await message(app, a);
    await app.db
      .update(communications)
      .set({ opportunityId: opp.id })
      .where(eq(communications.id, id))
      .run();
    await rejectCommunication(app.db, ctxOf(a), id, {
      reason: 'spam',
      expectedOpportunityId: opp.id,
    });
    const before = JSON.stringify(await row(app, id));
    const res = await classify(a, id, payload);
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: object }).error).toMatchObject(REFUSED);
    expect(JSON.stringify(await row(app, id))).toBe(before);
  });

  it('can still be unlinked, and only that', async () => {
    const { app, a } = await boot();
    const opp = await opportunity(app, a, 'Engineer');
    const id = await message(app, a);
    expect((await classify(a, id, { opportunityId: opp.id })).statusCode).toBe(200);
    await rejectCommunication(app.db, ctxOf(a), id, {
      reason: 'spam',
      expectedOpportunityId: opp.id,
    });
    const before = JSON.stringify(await row(app, id));
    for (const more of [{ classification: 'networking' }, { outreachKind: null }]) {
      const res = await classify(a, id, { opportunityId: null, ...more });
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: object }).error).toMatchObject(REFUSED);
    }
    expect(JSON.stringify(await row(app, id))).toBe(before);

    const res = await classify(a, id, { opportunityId: null });
    expect(res.statusCode, res.body).toBe(200);
    const after = await row(app, id);
    expect(after.opportunityId).toBeNull();
    expect(after.rejectedAt).not.toBeNull();
  });

  it('a message that was never there is still not found, and one that is there still links', async () => {
    const { app, a, b } = await boot();
    const opp = await opportunity(app, a, 'Engineer');
    const id = await message(app, a);
    expect((await classify(a, 'no-such-message', { opportunityId: opp.id })).statusCode).toBe(404);
    expect((await classify(b, id, { classification: 'networking' })).statusCode).toBe(404);
    expect((await classify(a, id, { opportunityId: opp.id })).statusCode).toBe(200);
    expect((await timeline(a, opp.id)).filter((i) => i.kind === 'communication')).toHaveLength(1);
  });

  // SQLite runs one writing transaction at a time, so there the read inside the link's transaction
  // cannot be overtaken; on Postgres it can, and the condition is in the UPDATE itself.
  it.runIf(testDialect === 'postgres')(
    'rejected between the link reading it and writing it: the reject stands',
    async () => {
      const { app, a } = await boot();
      const opp = await opportunity(app, a, 'Engineer');
      const id = await message(app, a);
      // The link is parked inside its transaction on purpose.
      onSlowTransaction(() => undefined);
      const pause = pauseAt('reclassify.read');
      const linking = reclassify(app.db, ctxOf(a), id, { opportunityId: opp.id }).then(
        () => 'linked',
        (err: { code?: string }) => err.code ?? 'error',
      );
      try {
        await pause.reached;
        await rejectCommunication(app.db, ctxOf(a), id, {
          reason: 'spam',
          expectedOpportunityId: null,
        });
        pause.release();
        expect(await linking).toBe('message_rejected');
      } finally {
        pause.release();
        setRaceHook(undefined);
      }
      const after = await row(app, id);
      expect(after.rejectedAt).not.toBeNull();
      expect(after.opportunityId).toBeNull();
      expect((await app.db.select().from(dismissalFeedback).all()).map((f) => f.kind)).toEqual([
        'rejection',
      ]);
    },
  );
});

describe('a suggested move that is no longer there says why (#895)', () => {
  async function proposed(app: FastifyInstance, a: TestClient) {
    const opp = await opportunity(app, a, 'Engineer');
    const id = await message(app, a);
    await app.db
      .update(communications)
      .set({ opportunityId: opp.id, proposedTransition: 'in_process' })
      .where(eq(communications.id, id))
      .run();
    return { opp, id };
  }

  async function refused(app: FastifyInstance, a: TestClient, id: string, why: string) {
    const moves = (await app.db.select().from(stageHistory).all()).length;
    const res = await accept(a, id);
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: object }).error).toEqual({ code: 'no_proposal', message: why });
    expect((await app.db.select().from(stageHistory).all()).length).toBe(moves);
  }

  it('rejected since', async () => {
    const { app, a } = await boot();
    const { opp, id } = await proposed(app, a);
    await rejectCommunication(app.db, ctxOf(a), id, {
      reason: 'spam',
      expectedOpportunityId: opp.id,
    });
    await refused(app, a, id, 'This message has been rejected, and its suggestion with it.');
  });

  it('unlinked since', async () => {
    const { app, a } = await boot();
    const { id } = await proposed(app, a);
    expect((await classify(a, id, { opportunityId: null })).statusCode).toBe(200);
    await refused(
      app,
      a,
      id,
      'This message is no longer linked to an opportunity, so there is nothing to move.',
    );
  });

  it.each(['used', 'ignored', 'linked to another opportunity'])('%s since', async (how) => {
    const { app, a } = await boot();
    const { id } = await proposed(app, a);
    if (how === 'used') {
      expect((await accept(a, id)).statusCode).toBe(200);
    } else if (how === 'ignored') {
      const url = `/api/v1/communications/${id}/proposed-transition`;
      expect((await a.request({ method: 'DELETE', url })).statusCode).toBe(200);
    } else {
      const other = await opportunity(app, a, 'Analyst');
      expect((await classify(a, id, { opportunityId: other.id })).statusCode).toBe(200);
    }
    await refused(
      app,
      a,
      id,
      'This suggestion is no longer there: it was used, ignored or changed since you saw it.',
    );
  });
});
