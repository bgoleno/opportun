// Undo of a dismissal whose result was unsuppressed takes the key back
// (https://github.com/bgoleno/opportun/issues/1020). Unsuppress lets the key go, so undoing the
// dismissal afterwards left a pending result with no key, which a repost's card did not group with:
// two cards of one job. Where a card or an opportunity of the job is there by then, the result stays
// dismissed and the answer says so. Every posting is made up.
import { cardKey, dedupeKey, type NormalizedPosting } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { registerSource, resetSources } from '../src/adapters/discoverySource';
import { onSlowTransaction } from '../src/db/gate';
import { discoveryResults, dismissalFeedback } from '../src/db/schema';
import { enqueue } from '../src/lib/jobQueue';
import { DISCOVERY_RUN_KIND } from '../src/lib/jobKinds';
import {
  createRun,
  createSource,
  getResult,
  insertResult,
  listResults,
  listRuns,
  setDisposition,
} from '../src/repos/discovery';
import { createOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import { testDialect } from './db';
import type { TestClient } from './isolation';
import { heldApart, pauseAt, settledOrWaiting, whileParked } from './race';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
afterEach(() => resetSources());

const JOB: NormalizedPosting = {
  company: 'Initech',
  title: 'Staff Platform Engineer',
  descriptionMd: 'Build the platform.',
  postingUrl: 'https://boards.example.com/initech/1',
  location: 'Austin, TX',
  externalId: 'gh-1',
};
const KEY = dedupeKey(JOB.company, JOB.title, JOB.location);

async function setup() {
  const { app, a, b } = await boot();
  const ctx = ctxOf(a);
  let externalId = 'gh-1';
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      yield { posting: { ...JOB, externalId }, nextCursor: null };
    },
  });
  const src = await createSource(app.db, ctx, { kind: 'ats_lever', config: { org: 'initech' } });
  const manual = await createSource(app.db, ctx, { kind: 'manual', config: {} });
  const send = (url: string, payload: Record<string, unknown> = {}) =>
    a.request({ method: 'POST', url: `/api/v1${url}`, payload });
  /** A result of the job (or like it), pending. */
  const result = async (over: Partial<NormalizedPosting> = {}) => {
    const run = await createRun(app.db, ctx, { sourceId: manual.id });
    const posting = { ...JOB, externalId: `seed-${Math.random()}`, ...over };
    return (
      await insertResult(app.db, ctx, {
        runId: run.id,
        posting,
        dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
        resolution: 'full',
      })
    ).id;
  };
  const dismiss = async (id: string) => {
    const res = await send(`/discovery/results/${id}/dismiss`, { reason: 'stale' });
    expect(res.statusCode, res.body).toBe(200);
  };
  const unsuppress = async (id: string) => {
    const res = await send(`/discovery/results/${id}/unsuppress`);
    expect(res.statusCode, res.body).toBe(200);
  };
  const undo = async (...ids: string[]) => {
    const res = await send('/discovery/results/bulk-undo-dismiss', { ids });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ results: Record<string, unknown>[] }>();
    return body.results;
  };
  return {
    app,
    a,
    b,
    ctx,
    send,
    result,
    dismiss,
    unsuppress,
    undo,
    /** A dismissed result that has let its key go. */
    keyless: async (over: Partial<NormalizedPosting> = {}) => {
      const id = await result(over);
      await dismiss(id);
      await unsuppress(id);
      return id;
    },
    read: (id: string) => getResult(app.db, ctx, id),
    /** The job, posted again as another requisition. */
    repost: async (as = 'gh-2') => {
      externalId = as;
      await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
      await app.jobs.drain();
      const [last] = (await listRuns(app.db, ctx, src.id, { limit: 1, offset: 0 })).items;
      return last!.stats as { inserted: number; duplicates: number };
    },
    pending: async () =>
      (await listResults(app.db, ctx, { limit: 50, offset: 0, disposition: 'pending' })).items,
    feedback: async (id: string) =>
      await app.db
        .select({ reason: dismissalFeedback.reason })
        .from(dismissalFeedback)
        .where(eq(dismissalFeedback.resultId, id))
        .all(),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Never a pending result with no key, and one card for the job, however many rows it has. */
async function oneCard(s: Setup) {
  const rows = await s.pending();
  expect(rows.filter((r) => r.dedupeKey === null)).toEqual([]);
  const cards = new Set(
    rows.map((r) => cardKey(r.dedupeKey ?? r.id, r.posting.company, r.posting.title)),
  );
  expect(cards.size).toBe(1);
}

/** A held one: dismissed as it was, its feedback too, with no key. */
async function stillDismissed(s: Setup, id: string) {
  expect(await s.read(id)).toMatchObject({ disposition: 'dismissed', dedupeKey: null });
  expect(await s.feedback(id)).toEqual([{ reason: 'stale' }]);
}

const make = async (s: Setup, over: { title?: string; location?: string } = {}) =>
  (
    await createOpportunity(s.app.db, s.ctx, {
      companyName: JOB.company,
      title: JOB.title,
      location: 'Austin, TX',
      sourceKind: 'manual',
      ...over,
    })
  ).id;
const move = async (s: Setup, id: string, to: 'closed' | 'dismissed') => {
  const res = await s.send(`/opportunities/${id}/stage`, {
    to,
    ...(to === 'closed' ? { closedReason: 'withdrawn' } : {}),
  });
  expect(res.statusCode, res.body).toBe(200);
};

describe('undo of a dismissal whose result was unsuppressed (#1020)', () => {
  it('takes the key back, and a repost then is no second card', async () => {
    const s = await setup();
    const id = await s.keyless();
    expect(await s.undo(id)).toEqual([{ id, outcome: 'restored' }]);
    expect(await s.read(id)).toMatchObject({ disposition: 'pending', dedupeKey: KEY });
    expect(await s.feedback(id)).toEqual([]);
    await s.repost();
    await oneCard(s);
  });

  it('one that kept its key is restored as before, a repost there or not', async () => {
    const s = await setup();
    const id = await s.result();
    await s.dismiss(id);
    expect(await s.repost()).toMatchObject({ inserted: 0 });
    await make(s);
    expect(await s.undo(id)).toEqual([{ id, outcome: 'restored' }]);
    expect(await s.read(id)).toMatchObject({ disposition: 'pending', dedupeKey: KEY });
  });

  describe('it stays dismissed, and the answer says the job is there', () => {
    it("with a repost's card in the queue", async () => {
      const s = await setup();
      const id = await s.keyless();
      expect(await s.repost()).toMatchObject({ inserted: 1 });
      expect(await s.undo(id)).toEqual([{ id, outcome: 'duplicate' }]);
      await stillDismissed(s, id);
      await oneCard(s);
      expect(await s.pending()).toHaveLength(1);
    });

    it.each(['there', 'closed'] as const)('with an opportunity of the job, %s', async (how) => {
      const s = await setup();
      const id = await s.keyless();
      const opp = await make(s);
      if (how === 'closed') await move(s, opp, 'closed');
      expect(await s.undo(id)).toEqual([{ id, outcome: 'duplicate', existingId: opp }]);
      await stillDismissed(s, id);
    });

    it.each(['there', 'closed'] as const)(
      'with a repost attached to an opportunity of another name, %s',
      async (how) => {
        const s = await setup();
        const id = await s.keyless();
        const other = await make(s, { title: 'Data Analyst' });
        const repost = await s.result();
        const attached = await s.send(`/discovery/results/${repost}/accept`, { attachTo: other });
        expect(attached.statusCode, attached.body).toBe(200);
        if (how === 'closed') await move(s, other, 'closed');
        expect(await s.undo(id)).toEqual([{ id, outcome: 'duplicate', existingId: other }]);
        await stillDismissed(s, id);
      },
    );

    it('with both, the opportunity is the one named', async () => {
      const s = await setup();
      const id = await s.keyless();
      await s.result();
      const opp = await make(s);
      expect(await s.undo(id)).toEqual([{ id, outcome: 'duplicate', existingId: opp }]);
    });

    it('of several, each by itself', async () => {
      const s = await setup();
      const free = await s.keyless({ location: 'Boston, MA' });
      const held = await s.keyless();
      const opp = await make(s);
      expect(await s.undo(free, held, 'nothing')).toEqual([
        { id: free, outcome: 'restored' },
        { id: held, outcome: 'duplicate', existingId: opp },
        { id: 'nothing', outcome: 'not_found' },
      ]);
    });
  });

  describe('it is restored', () => {
    it.each(['dismissed', 'deleted'] as const)(
      'where the opportunity an accepted repost became was %s',
      async (how) => {
        const s = await setup();
        const id = await s.keyless();
        const repost = await s.result();
        const accept = await s.send(`/discovery/results/${repost}/accept`);
        const opp = accept.json<{ opportunityId: string }>().opportunityId;
        if (how === 'dismissed') await move(s, opp, 'dismissed');
        else await s.a.request({ method: 'DELETE', url: `/api/v1/opportunities/${opp}` });
        expect(await s.undo(id)).toEqual([{ id, outcome: 'restored' }]);
        expect((await s.read(id)).dedupeKey).toBe(KEY);
      },
    );

    it('where a repost was dismissed too', async () => {
      const s = await setup();
      const id = await s.keyless();
      await s.dismiss(await s.result());
      expect(await s.undo(id)).toEqual([{ id, outcome: 'restored' }]);
      expect((await s.read(id)).dedupeKey).toBe(KEY);
    });

    it('where ingest linked one to a role since closed (#990)', async () => {
      const s = await setup();
      const id = await s.keyless();
      const opp = await make(s, { title: 'Data Analyst' });
      const linked = await s.result();
      await setDisposition(s.app.db, s.ctx, linked, 'accepted', opp);
      await s.app.db
        .update(discoveryResults)
        .set({ rankSkipReason: 'linked' })
        .where(eq(discoveryResults.id, linked))
        .run();
      expect(await s.undo(id)).toEqual([{ id, outcome: 'duplicate', existingId: opp }]);
      await move(s, opp, 'closed');
      expect(await s.undo(id)).toEqual([{ id, outcome: 'restored' }]);
    });

    // The key strips a level; another level is another job (#967).
    it.each(['a card', 'an opportunity'] as const)('beside %s of another level', async (what) => {
      const s = await setup();
      const id = await s.keyless();
      if (what === 'a card') await s.result({ title: 'Senior Platform Engineer' });
      else await make(s, { title: 'Senior Platform Engineer' });
      expect(await s.undo(id)).toEqual([{ id, outcome: 'restored' }]);
      expect((await s.read(id)).dedupeKey).toBe(KEY);
    });

    it("beside another user's card and opportunity of the job", async () => {
      const s = await setup();
      const id = await s.keyless();
      const other = ctxOf(s.b);
      await createOpportunity(s.app.db, other, {
        companyName: JOB.company,
        title: JOB.title,
        location: 'Austin, TX',
        sourceKind: 'manual',
      });
      const source = await createSource(s.app.db, other, { kind: 'manual', config: {} });
      const run = await createRun(s.app.db, other, { sourceId: source.id });
      await insertResult(s.app.db, other, {
        runId: run.id,
        posting: JOB,
        dedupeKey: KEY,
        resolution: 'full',
      });
      expect(await s.undo(id)).toEqual([{ id, outcome: 'restored' }]);
      expect((await s.read(id)).dedupeKey).toBe(KEY);
    });
  });

  // They were one card, and are one again.
  it('two of one card in one request: both restored', async () => {
    const s = await setup();
    const [x, y] = [await s.result(), await s.result()];
    for (const id of [x, y]) await s.dismiss(id);
    for (const id of [x, y]) await s.unsuppress(id);
    expect(await s.undo(x, y)).toEqual([
      { id: x, outcome: 'restored' },
      { id: y, outcome: 'restored' },
    ]);
    await oneCard(s);
    expect(await s.pending()).toHaveLength(2);
  });

  // sec on #1030: one of the request that it did not put there counts, as any card does.
  it('beside one of its own request that was pending before it: there already', async () => {
    const s = await setup();
    const id = await s.keyless();
    const there = await s.result();
    expect(await s.undo(id, there)).toEqual([
      { id, outcome: 'duplicate' },
      { id: there, outcome: 'already_decided' },
    ]);
    await stillDismissed(s, id);
    expect(await s.undo(there, id)).toEqual([
      { id: there, outcome: 'already_decided' },
      { id, outcome: 'duplicate' },
    ]);
  });

  it('two of one card in two requests: the second is there already', async () => {
    const s = await setup();
    const [x, y] = [await s.result(), await s.result()];
    for (const id of [x, y]) await s.dismiss(id);
    for (const id of [x, y]) await s.unsuppress(id);
    expect(await s.undo(x)).toEqual([{ id: x, outcome: 'restored' }]);
    expect(await s.undo(y)).toEqual([{ id: y, outcome: 'duplicate' }]);
    await stillDismissed(s, y);
    await oneCard(s);
  });

  describe('against what comes at the same moment', () => {
    // tl on #1030: a writer without the user's lock is not written over. Only on Postgres can it write
    // there; SQLite's gate keeps it out.
    it.runIf(testDialect === 'postgres')(
      'one that kept its key keeps what such a writer makes of it meanwhile',
      async () => {
        const s = await setup();
        const id = await s.result();
        await s.dismiss(id);
        onSlowTransaction(() => undefined);
        const pause = pauseAt('discovery.undo.locked');
        const undoing = s.undo(id);
        await whileParked(
          pause,
          async () =>
            await s.app.db
              .update(discoveryResults)
              .set({ dedupeKey: 'another key' })
              .where(eq(discoveryResults.id, id))
              .run(),
        );
        expect(await undoing).toEqual([{ id, outcome: 'restored' }]);
        expect(await s.read(id)).toMatchObject({
          disposition: 'pending',
          dedupeKey: 'another key',
        });
      },
    );

    it("an Accept of the repost's card first: held by its opportunity", async () => {
      const s = await setup();
      const id = await s.keyless();
      const repost = await s.result();
      const [accepted, undone] = await heldApart(
        s.app,
        'discovery.decide.locked',
        () => s.send(`/discovery/results/${repost}/accept`),
        () => s.undo(id),
      );
      const { opportunityId } = accepted.json<{ opportunityId: string }>();
      expect(undone).toEqual([{ id, outcome: 'duplicate', existingId: opportunityId }]);
      await stillDismissed(s, id);
    });

    it("the undo first: held by the repost's card, which is accepted then", async () => {
      const s = await setup();
      const id = await s.keyless();
      const repost = await s.result();
      const [undone, accepted] = await heldApart(
        s.app,
        'discovery.undo.locked',
        () => s.undo(id),
        () => s.send(`/discovery/results/${repost}/accept`),
      );
      expect(undone).toEqual([{ id, outcome: 'duplicate' }]);
      expect(accepted.statusCode, accepted.body).toBe(200);
      await stillDismissed(s, id);
    });

    // Undo does not take the ingest lock, so on Postgres neither waits for the other; on SQLite the
    // gate has them one at a time. Whichever it is, one card.
    const waits = testDialect === 'postgres' ? 'settled' : 'waiting';

    it("a run that has checked the repost's key first: one card", async () => {
      const s = await setup();
      const id = await s.keyless();
      onSlowTransaction(() => undefined);
      const pause = pauseAt('discovery.ingest.locked');
      const polled = s.repost();
      const [undoing, seen] = await whileParked(pause, async () => {
        const sent = s.undo(id);
        return [[sent], await settledOrWaiting(s.app, sent)] as const;
      });
      expect(seen).toBe(waits);
      const [undone] = await Promise.all([undoing[0], polled]);
      expect(undone).toEqual([
        testDialect === 'postgres' ? { id, outcome: 'restored' } : { id, outcome: 'duplicate' },
      ]);
      await oneCard(s);
    });

    it('the undo first: one card', async () => {
      const s = await setup();
      const id = await s.keyless();
      onSlowTransaction(() => undefined);
      const pause = pauseAt('discovery.undo.locked');
      const undoing = s.undo(id);
      const [polled, seen] = await whileParked(pause, async () => {
        const sent = s.repost();
        return [[sent], await settledOrWaiting(s.app, sent)] as const;
      });
      expect(seen).toBe(waits);
      const [undone] = await Promise.all([undoing, polled[0]]);
      expect(undone).toEqual([
        testDialect === 'postgres' ? { id, outcome: 'duplicate' } : { id, outcome: 'restored' },
      ]);
      await oneCard(s);
    });
  });
});
