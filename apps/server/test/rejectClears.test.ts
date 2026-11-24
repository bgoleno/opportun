// What a reject clears, what it keeps, and what still meets a message once it is rejected.
import { runStructured } from '@opportun/ai';
import { newId } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processAlertDigest, DEFAULT_ALERT_SENDERS } from '../src/adapters/sources/alertEmail';
import type { Db } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import {
  activities,
  communications,
  discoveryResults,
  dismissalFeedback,
  jobs,
  opportunities,
  stageHistory,
} from '../src/db/schema';
import { classifyCommunication } from '../src/jobs/classify';
import { backfillClassify } from '../src/jobs/classifyBackfill';
import { CLASSIFY_JOB_KIND, enqueueClassify } from '../src/lib/mailClassifyQueue';
import { setRaceHook } from '../src/lib/racePoints';
import {
  acceptProposal,
  applyClassification,
  dismissProposal,
  markAlertDigest,
  reclassify,
  upsertInbound,
  type ClassifyResult,
} from '../src/repos/communications';
import { createOpportunity } from '../src/repos/opportunities';
import { rejectCommunication } from '../src/repos/reject';
import { search } from '../src/repos/search';
import { updateActivity } from '../src/repos/activities';
import { useApi } from './api';
import { queuedBodyOf } from './classifyPayload';
import type { TestClient } from './isolation';
import { heldOpen, pauseAt, someoneBlocked } from './race';

// Mocked, so that a call is counted (none is made otherwise).
vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const T = 1_790_000_000_000;
const FROM = 'Priya Shah <priya@initech.example>';
const SUBJECT = 'Staff engineer at Initech';
const SNIPPET = 'We are hiring a staff engineer.';

const TARGETED: ClassifyResult = {
  classification: 'solicitation',
  outreachKind: 'targeted',
  mismatchReason: null,
  opportunityMatch: { company: 'Initech', title: 'Staff Engineer' },
  proposedTransition: null,
  confidence: 0.9,
  hardConstraintViolation: null,
};

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockResolvedValue(TARGETED);
});
afterEach(() => setRaceHook(undefined));

let seq = 0;
async function message(app: FastifyInstance, c: TestClient, over: { from?: string } = {}) {
  seq += 1;
  const { id } = await upsertInbound(app.db, ctxOf(c), 'gmail', {
    externalId: `msg-${seq}`,
    threadKey: `thread-${seq}`,
    from: over.from ?? FROM,
    to: ['me@example.com'],
    subject: SUBJECT,
    snippet: SNIPPET,
    bodyText: 'See https://boards.greenhouse.io/initech/jobs/1234567',
    sentAt: T,
  });
  return id;
}
const rowOf = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(communications).where(eq(communications.id, id)).get())!;
const opportunity = (app: FastifyInstance, c: TestClient, title = 'Engineer') =>
  createOpportunity(app.db, ctxOf(c), { companyName: 'Globex', title, sourceKind: 'manual' });
const reject = async (app: FastifyInstance, c: TestClient, id: string) =>
  rejectCommunication(app.db, ctxOf(c), id, {
    reason: 'not_job_related',
    note: 'my own words',
    expectedOpportunityId: (await rowOf(app, id)).opportunityId,
  });
const apply = (app: FastifyInstance, c: TestClient, id: string, out = TARGETED) =>
  applyClassification(app.db, ctxOf(c), id, out, 'payload');
const entriesOf = (app: FastifyInstance, c: TestClient) =>
  app.db
    .select()
    .from(activities)
    .where(and(eq(activities.userId, c.userId), eq(activities.kind, 'message_ref')))
    .all();
const found = async (app: FastifyInstance, c: TestClient, q: string) =>
  (await search(app.db, ctxOf(c), q, { limit: 50, offset: 0 })).items.map((h) => h.entityId);
/** What a call ends as: `done`, or the code it is refused with. */
const ended = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'done',
    (err: { code?: string }) => err.code ?? String(err),
  );

/** Every column a reject clears, set. */
const FULL = {
  bodyRef: 'b',
  classification: 'solicitation' as const,
  outreachKind: 'irrelevant' as const,
  mismatchReason: 'why',
  confidence: 0.4,
  bodySource: 'payload' as const,
  needsReview: true,
  proposedTransition: 'in_process' as const,
};

describe('the row', () => {
  it('loses what it said and what was said of it, and keeps what it is', async () => {
    const { app, a } = await boot();
    const opp = await opportunity(app, a);
    const id = await message(app, a);
    const other = await message(app, a);
    for (const m of [id, other]) {
      await app.db
        .update(communications)
        .set({ ...FULL, opportunityId: opp.id, triageDecision: 'passed', triageRule: 'r' })
        .where(eq(communications.id, m));
    }
    const before = await rowOf(app, id);
    const untouched = await rowOf(app, other);
    expect(before.atsJobRefs).toHaveLength(1);
    await reject(app, a, id);
    expect(await rowOf(app, id)).toEqual({
      ...before,
      subject: null,
      snippet: null,
      bodyRef: null,
      atsJobRefs: null,
      classification: null,
      outreachKind: null,
      mismatchReason: null,
      confidence: null,
      bodySource: null,
      needsReview: false,
      proposedTransition: null,
      rejectedAt: expect.any(Number),
      rejectionReason: 'not_job_related',
      updatedAt: expect.any(Number),
    });
    expect(await rowOf(app, other)).toEqual(untouched);
    expect(await found(app, a, 'staff')).toEqual([other]);
  });
});

describe('its copies', () => {
  it("the note of the user's correction, and no other note", async () => {
    const { app, a } = await boot();
    const id = await message(app, a);
    const other = await message(app, a);
    for (const m of [id, other]) {
      await reclassify(app.db, ctxOf(a), m, { classification: 'networking' });
    }
    await reject(app, a, id);
    const rows = await app.db.select().from(dismissalFeedback).all();
    const of = (m: string, kind: string) =>
      rows.filter((r) => r.communicationId === m && r.kind === kind).map((r) => r.note);
    expect(of(id, 'classification')).toEqual([null]);
    expect(of(id, 'rejection')).toEqual(['my own words']);
    expect(of(other, 'classification')).toEqual([SUBJECT]);
  });

  it.each(['pending', 'running'] as const)(
    'the body in a classification that is %s, and nothing else of it',
    async (status) => {
      const { app, a } = await boot();
      const id = await message(app, a);
      const other = await message(app, a);
      for (const m of [id, other]) await enqueueClassify(app.db, ctxOf(a), m, 'The whole body');
      await app.db.update(jobs).set({ status }).where(eq(jobs.kind, CLASSIFY_JOB_KIND));
      const jobOf = async (m: string) =>
        (await app.db.select().from(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).all()).find(
          (j) => (j.payload as { communicationId: string }).communicationId === m,
        )!;
      const before = await jobOf(id);
      expect(queuedBodyOf(app, before.payload)).toBe('The whole body');
      await reject(app, a, id);
      const { updatedAt, ...after } = await jobOf(id);
      void updatedAt;
      const { updatedAt: was, ...rest } = before;
      void was;
      expect(after).toEqual({ ...rest, payload: { communicationId: id } });
      expect(queuedBodyOf(app, (await jobOf(other)).payload)).toBe('The whole body');
    },
  );

  it('a body queued by an earlier release', async () => {
    const { app, a } = await boot();
    const id = await message(app, a);
    await enqueueClassify(app.db, ctxOf(a), id);
    await app.db
      .update(jobs)
      .set({ payload: { communicationId: id, body: 'The whole body' } })
      .where(eq(jobs.kind, CLASSIFY_JOB_KIND));
    await reject(app, a, id);
    const job = await app.db.select().from(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).get();
    expect(job?.payload).toEqual({ communicationId: id });
  });

  describe('its entry on the timeline', () => {
    /** A message and the opportunity it made, with the entry that came with it. */
    async function made(app: FastifyInstance, c: TestClient) {
      const id = await message(app, c);
      const out = await apply(app, c, id);
      const entries = await entriesOf(app, c);
      expect(entries).toHaveLength(1);
      return {
        id,
        oppId: (out as { createdOpportunityId: string }).createdOpportunityId,
        entry: entries[0]!,
      };
    }

    it('is blanked, not deleted, and is not found by what it said', async () => {
      const { app, a } = await boot();
      const { id, entry } = await made(app, a);
      expect(entry).toMatchObject({ title: SUBJECT, bodyMd: SNIPPET });
      expect(await found(app, a, 'hiring')).toContain(entry.id);
      await reject(app, a, id);
      expect(await entriesOf(app, a)).toEqual([
        { ...entry, title: 'Message (rejected)', bodyMd: null },
      ]);
      expect(await found(app, a, 'hiring')).not.toContain(entry.id);
      expect(await found(app, a, 'staff')).not.toContain(entry.id);
      expect(await found(app, a, 'rejected')).toContain(entry.id);
    });

    it('is blanked on the opportunity it was merged into', async () => {
      const { app, a } = await boot();
      const { id, entry } = await made(app, a);
      const keep = await opportunity(app, a, 'Kept');
      await app.db
        .update(activities)
        .set({ opportunityId: keep.id })
        .where(eq(activities.id, entry.id));
      await reject(app, a, id);
      expect((await entriesOf(app, a))[0]).toMatchObject({ title: 'Message (rejected)' });
    });

    it('is left when the user edited it', async () => {
      const { app, a } = await boot();
      const { id, entry } = await made(app, a);
      await app.db
        .update(activities)
        .set({ createdAt: 1, updatedAt: 1 })
        .where(eq(activities.id, entry.id));
      const edited = await updateActivity(app.db, ctxOf(a), entry.id, { title: 'My own title' });
      await reject(app, a, id);
      expect(await entriesOf(app, a)).toEqual([edited]);
      expect(await found(app, a, 'own')).toContain(entry.id);
    });

    it('is left when the user is editing it as the reject arrives', async () => {
      const { app, a } = await boot();
      const { id, entry } = await made(app, a);
      onSlowTransaction(() => undefined);
      const edit = heldOpen(app, (tx) =>
        updateActivity(tx as Db, ctxOf(a), entry.id, { title: 'My own title' }),
      );
      await edit.reached;
      const rejecting = reject(app, a, id);
      const waited = await someoneBlocked(app);
      edit.go();
      await edit.done;
      await rejecting;
      expect(waited).toBe(true);
      expect((await entriesOf(app, a))[0]).toMatchObject({
        title: 'My own title',
        bodyMd: SNIPPET,
      });
      expect(await found(app, a, 'own')).toContain(entry.id);
      expect((await rowOf(app, id)).rejectedAt).not.toBeNull();
    });

    // Merged: the entry's opportunity names neither message as its own.
    it.each<[string, boolean]>([
      ['stays while the other message of that sender and moment is there', false],
      ['is blanked once the other one is rejected too', true],
    ])('that of one of two messages, merged into another opportunity, %s', async (_what, both) => {
      const { app, a } = await boot();
      const { id, entry } = await made(app, a);
      const other = await message(app, a);
      const keep = await opportunity(app, a, 'Kept');
      await app.db
        .update(activities)
        .set({ opportunityId: keep.id })
        .where(eq(activities.id, entry.id));
      await reject(app, a, other);
      expect((await entriesOf(app, a))[0]).toMatchObject({ title: SUBJECT, bodyMd: SNIPPET });
      if (!both) return;
      await reject(app, a, id);
      expect((await entriesOf(app, a))[0]).toMatchObject({
        title: 'Message (rejected)',
        bodyMd: null,
      });
    });

    it.each<[string, Partial<typeof communications.$inferInsert>]>([
      ['of another sender', { from: 'Someone Else <else@globex.example>' }],
      ['of another moment', { sentAt: T + 1 }],
    ])(
      'merged into another opportunity, is blanked whatever message %s is there',
      async (_what, over) => {
        const { app, a } = await boot();
        const { id, entry } = await made(app, a);
        const other = await message(app, a);
        await app.db.update(communications).set(over).where(eq(communications.id, other));
        const keep = await opportunity(app, a, 'Kept');
        await app.db
          .update(activities)
          .set({ opportunityId: keep.id })
          .where(eq(activities.id, entry.id));
        await reject(app, a, id);
        expect((await entriesOf(app, a))[0]).toMatchObject({ title: 'Message (rejected)' });
      },
    );

    it.each<[string, Partial<typeof activities.$inferInsert>]>([
      ['a link', { externalUrl: 'https://example.com/m' }],
      ['another kind', { kind: 'note' }],
      ['another date', { occurredAt: T + 1 }],
      ['another participant', { participants: ['Someone Else <else@globex.example>'] }],
      ['one more participant', { participants: [FROM, 'me@example.com'] }],
    ])('one with %s is another entry, and stays', async (_what, over) => {
      const { app, a } = await boot();
      const { id, entry } = await made(app, a);
      await app.db.update(activities).set(over).where(eq(activities.id, entry.id));
      await reject(app, a, id);
      const [after] = await app.db
        .select()
        .from(activities)
        .where(eq(activities.id, entry.id))
        .all();
      expect(after).toMatchObject({ title: SUBJECT, bodyMd: SNIPPET });
    });

    it("another user's, alike in everything, stays", async () => {
      const { app, a, b } = await boot();
      const mine = await made(app, a);
      const theirs = await made(app, b);
      await reject(app, a, mine.id);
      expect(await entriesOf(app, b)).toEqual([theirs.entry]);
    });

    it('that of another message of the same sender and moment stays', async () => {
      const { app, a } = await boot();
      const { id } = await made(app, a);
      const other = await message(app, a);
      await apply(app, a, other, {
        ...TARGETED,
        opportunityMatch: { company: 'Hooli', title: 'Designer' },
      });
      expect(await entriesOf(app, a)).toHaveLength(2);
      await reject(app, a, id);
      expect((await entriesOf(app, a)).map((e) => e.title).sort()).toEqual([
        'Message (rejected)',
        SUBJECT,
      ]);
      // Rejected too, it goes as well.
      await reject(app, a, other);
      expect((await entriesOf(app, a)).map((e) => e.title)).toEqual([
        'Message (rejected)',
        'Message (rejected)',
      ]);
    });
  });
});

describe('what meets a rejected message', () => {
  const nothingMade = async (app: FastifyInstance, c: TestClient) => {
    expect(
      await app.db.select().from(opportunities).where(eq(opportunities.userId, c.userId)).all(),
    ).toEqual([]);
    expect(await entriesOf(app, c)).toEqual([]);
  };

  it('a classification: skipped, and nothing is written', async () => {
    const { app, a } = await boot();
    const id = await message(app, a);
    await reject(app, a, id);
    const before = await rowOf(app, id);
    expect(await classifyCommunication(app.db, ctxOf(a), app.storage, id, 'The body')).toEqual({
      status: 'skipped',
      reason: 'rejected',
    });
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
    expect(await rowOf(app, id)).toEqual(before);
    await nothingMade(app, a);
  });

  it('a classification already answered: not applied, and nothing is made', async () => {
    const { app, a } = await boot();
    const id = await message(app, a);
    await reject(app, a, id);
    const before = await rowOf(app, id);
    expect(await apply(app, a, id)).toBeNull();
    expect(await rowOf(app, id)).toEqual(before);
    await nothingMade(app, a);
  });

  it('a classification rejected while it runs: skipped, and nothing is made', async () => {
    const { app, a } = await boot();
    const id = await message(app, a);
    vi.mocked(runStructured).mockImplementationOnce(async () => {
      await reject(app, a, id);
      return TARGETED;
    });
    expect(await classifyCommunication(app.db, ctxOf(a), app.storage, id, 'The body')).toEqual({
      status: 'skipped',
      reason: 'rejected',
    });
    expect(await rowOf(app, id)).toMatchObject({ classification: null, opportunityId: null });
    await nothingMade(app, a);
  });

  it('a digest: not read, and marked as nothing', async () => {
    const { app, a } = await boot();
    const id = await message(app, a, { from: DEFAULT_ALERT_SENDERS[0]! });
    await reject(app, a, id);
    const before = await rowOf(app, id);
    expect(await processAlertDigest(app.db, ctxOf(a), app.storage, id, 'x')).toEqual({
      status: 'skipped',
      reason: 'rejected',
    });
    expect(await app.db.select().from(discoveryResults).all()).toEqual([]);
    await markAlertDigest(app.db, ctxOf(a), id);
    expect(await rowOf(app, id)).toEqual(before);
  });

  it('a suggestion ignored: refused', async () => {
    const { app, a } = await boot();
    const id = await message(app, a);
    await reject(app, a, id);
    const before = await rowOf(app, id);
    expect(await ended(dismissProposal(app.db, ctxOf(a), id))).toBe('message_rejected');
    expect(await rowOf(app, id)).toEqual(before);
    expect(await ended(dismissProposal(app.db, ctxOf(a), newId()))).toBe('not_found');
  });

  it('the backfill: not queued, as one that is not rejected is', async () => {
    const { app, a } = await boot();
    const id = await message(app, a);
    const other = await message(app, a);
    await reject(app, a, id);
    expect(await backfillClassify(app.db, ctxOf(a))).toBe(1);
    const queued = await app.db.select().from(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).all();
    expect(queued.map((j) => j.payload)).toEqual([{ communicationId: other }]);
  });

  it('an unlink: writes the link only', async () => {
    const { app, a } = await boot();
    const opp = await opportunity(app, a);
    const id = await message(app, a);
    await reclassify(app.db, ctxOf(a), id, { opportunityId: opp.id });
    await reject(app, a, id);
    const before = await rowOf(app, id);
    expect(before.opportunityId).toBe(opp.id);
    await reclassify(app.db, ctxOf(a), id, { opportunityId: null });
    expect(await rowOf(app, id)).toEqual({
      ...before,
      opportunityId: null,
      updatedAt: expect.any(Number),
    });
    const said = (await app.db.select().from(dismissalFeedback).all())
      .filter((f) => f.kind === 'classification' && f.opportunityId === null)
      .map((f) => [f.reason, f.note]);
    expect(said).toEqual([['unlinked', null]]);
  });
});

describe('a reject beside what it meets', () => {
  /** Parks `first` at `point`, starts `second` beside it, and says whether `second` waited. */
  async function beside(
    app: FastifyInstance,
    point: string,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ) {
    onSlowTransaction(() => undefined);
    const pause = pauseAt(point);
    const one = ended(first());
    await pause.reached;
    const two = ended(second());
    const waited = await someoneBlocked(app);
    pause.release();
    const out = [await one, await two];
    expect(waited).toBe(true);
    return out;
  }
  /** Parks `first` at `point`, outside any transaction, and runs `second` whole meanwhile. */
  async function within(
    point: string,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ) {
    const pause = pauseAt(point);
    const one = ended(first());
    await pause.reached;
    const two = await ended(second());
    pause.release();
    return [await one, two];
  }
  const unseen = (app: FastifyInstance, c: TestClient, id: string) => () =>
    rejectCommunication(app.db, ctxOf(c), id, {
      reason: 'not_job_related',
      expectedOpportunityId: null,
    });

  it('a classification first: the reject waits, and is refused as changed', async () => {
    const { app, a } = await boot();
    const id = await message(app, a);
    expect(
      await beside(app, 'classify.apply.locked', () => apply(app, a, id), unseen(app, a, id)),
    ).toEqual(['done', 'message_changed']);
    expect((await rowOf(app, id)).rejectedAt).toBeNull();
    expect(await entriesOf(app, a)).toHaveLength(1);
  });

  it('a classification within the reject: the reject is refused as changed', async () => {
    const { app, a } = await boot();
    const id = await message(app, a);
    expect(await within('reject.read', unseen(app, a, id), () => apply(app, a, id))).toEqual([
      'message_changed',
      'done',
    ]);
    expect(await rowOf(app, id)).toMatchObject({ rejectedAt: null, subject: SUBJECT });
  });

  it('the reject first: the classification finds it rejected, and makes nothing', async () => {
    const { app, a } = await boot();
    const id = await message(app, a);
    const pause = pauseAt('classify.apply.read');
    const classifying = apply(app, a, id);
    await pause.reached;
    await unseen(app, a, id)();
    const before = await rowOf(app, id);
    pause.release();
    expect(await classifying).toBeNull();
    expect(await rowOf(app, id)).toEqual(before);
    expect(before).toMatchObject({ classification: null, opportunityId: null, subject: null });
    expect(await entriesOf(app, a)).toEqual([]);
    expect(await app.db.select().from(opportunities).all()).toEqual([]);
  });

  it('the reject under way: the classification waits for it, and makes nothing', async () => {
    const { app, a } = await boot();
    const id = await message(app, a);
    expect(await beside(app, 'reject.erased', unseen(app, a, id), () => apply(app, a, id))).toEqual(
      ['done', 'done'],
    );
    expect(await rowOf(app, id)).toMatchObject({ classification: null, opportunityId: null });
    expect(await app.db.select().from(opportunities).all()).toEqual([]);
  });

  async function proposed(app: FastifyInstance, c: TestClient) {
    const opp = await opportunity(app, c);
    const id = await message(app, c);
    await app.db
      .update(communications)
      .set({ opportunityId: opp.id, proposedTransition: 'in_process' })
      .where(eq(communications.id, id));
    return { opp, id };
  }
  const moves = async (app: FastifyInstance) =>
    (await app.db.select().from(stageHistory).all()).filter((h) => h.fromStage !== null);

  it('an accepted suggestion: one move, whose note does not say what the message said', async () => {
    const { app, a } = await boot();
    const { id } = await proposed(app, a);
    await acceptProposal(app.db, ctxOf(a), id, {});
    const [move] = await moves(app);
    expect(move).toMatchObject({ toStage: 'in_process', note: 'Proposed by a message' });
    expect((await rowOf(app, id)).proposedTransition).toBeNull();
  });

  it('an accepted suggestion first: the reject waits, then goes through', async () => {
    const { app, a } = await boot();
    const { id } = await proposed(app, a);
    expect(
      await beside(
        app,
        'proposal.accept.locked',
        () => acceptProposal(app.db, ctxOf(a), id, {}),
        () => reject(app, a, id),
      ),
    ).toEqual(['done', 'done']);
    expect(await moves(app)).toHaveLength(1);
    expect(await rowOf(app, id)).toMatchObject({ subject: null, proposedTransition: null });
  });

  it('the reject first: the suggestion is gone, and nothing moves', async () => {
    const { app, a } = await boot();
    const { id, opp } = await proposed(app, a);
    const [accepted, rejected] = await within(
      'proposal.accept.read',
      () => acceptProposal(app.db, ctxOf(a), id, {}),
      () => reject(app, a, id),
    );
    expect([accepted, rejected]).toEqual(['no_proposal', 'done']);
    expect(await moves(app)).toEqual([]);
    const after = await app.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opp.id))
      .get();
    expect(after?.stage).toBe('discovered');
  });
});
