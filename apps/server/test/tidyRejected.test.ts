// The job that tidies the messages rejected before a reject cleared all it clears now
// (jobs/tidyRejected.ts): once, after a backup, with counts only of what it did.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { onSlowTransaction } from '../src/db/gate';
import { listBackups } from '../src/jobs/backup';
import {
  activities,
  auditLog,
  communications,
  dismissalFeedback,
  jobs,
  settings,
  stageHistory,
} from '../src/db/schema';
import {
  enqueueTidyRejectedOnce,
  TIDY_REJECTED_KIND,
  TIDY_REJECTED_MARKER_KEY,
  tidyRejectedMessages,
  type TidyDeps,
} from '../src/jobs/tidyRejected';
import { CLASSIFY_JOB_KIND, enqueueClassify } from '../src/lib/mailClassifyQueue';
import { setRaceHook } from '../src/lib/racePoints';
import { applyClassification, reclassify, upsertInbound } from '../src/repos/communications';
import { createOpportunity } from '../src/repos/opportunities';
import { rejectCommunication } from '../src/repos/reject';
import { indexCommunication, search } from '../src/repos/search';
import { useApi } from './api';
import { queuedBodyOf } from './classifyPayload';
import { sqliteOnly } from './db';
import { testApp } from './helpers';
import type { TestClient } from './isolation';
import { pauseAt, someoneBlocked } from './race';

const boot = useApi();
afterEach(() => setRaceHook(undefined));
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const T = 1_790_000_000_000;
const FROM = 'Priya Shah <priya@initech.example>';
const SUBJECT = 'Staff engineer at Initech';

let seq = 0;
async function message(app: FastifyInstance, c: TestClient, subject = SUBJECT) {
  seq += 1;
  const { id } = await upsertInbound(app.db, ctxOf(c), 'gmail', {
    externalId: `msg-${seq}`,
    threadKey: `thread-${seq}`,
    from: FROM,
    to: ['me@example.com'],
    subject,
    snippet: 'We are hiring.',
    bodyText: 'See https://boards.greenhouse.io/initech/jobs/1234567',
    sentAt: T + seq,
  });
  return id;
}
const rowOf = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(communications).where(eq(communications.id, id)).get())!;
const set = (app: FastifyInstance, id: string, over: Partial<typeof communications.$inferInsert>) =>
  app.db.update(communications).set(over).where(eq(communications.id, id)).run();

/** Every column a reject clears, as it leaves it: written out, not taken from the code. */
const CLEARED = {
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
};
/** And every one of them set. */
const FULL = {
  subject: SUBJECT,
  snippet: 'We are hiring.',
  bodyRef: 'b',
  atsJobRefs: [
    { kind: 'ats_greenhouse', org: 'initech', externalId: '1', url: 'https://x.example' },
  ],
  classification: 'solicitation' as const,
  outreachKind: 'irrelevant' as const,
  mismatchReason: 'why',
  confidence: 0.4,
  bodySource: 'payload' as const,
  needsReview: true,
  proposedTransition: 'in_process' as const,
} satisfies Pick<typeof communications.$inferInsert, keyof typeof CLEARED>;
/** As a message was left by the reject of an earlier release. */
const LEFT = {
  rejectedAt: T,
  rejectionReason: 'spam',
  subject: null,
  snippet: null,
  bodyRef: null,
  needsReview: false,
  proposedTransition: null,
  classification: 'solicitation',
  outreachKind: 'targeted',
  confidence: 0.9,
  bodySource: 'payload',
} as const;

/** A message that made an opportunity, with the entry that came with it, and its note. */
async function made(app: FastifyInstance, c: TestClient, title = 'Staff Engineer') {
  const id = await message(app, c);
  const out = await applyClassification(
    app.db,
    ctxOf(c),
    id,
    {
      classification: 'solicitation',
      outreachKind: 'targeted',
      mismatchReason: null,
      opportunityMatch: { company: 'Initech', title },
      proposedTransition: null,
      confidence: 0.9,
      hardConstraintViolation: null,
    },
    'payload',
  );
  const entry = (await entries(app, c)).find((e) => e.opportunityId === out!.createdOpportunityId)!;
  return { id, oppId: out!.createdOpportunityId!, entry };
}
const entries = (app: FastifyInstance, c: TestClient) =>
  app.db
    .select()
    .from(activities)
    .where(and(eq(activities.userId, c.userId), eq(activities.kind, 'message_ref')))
    .all();

function deps(over: Partial<TidyDeps> = {}) {
  const info = vi.fn();
  const warn = vi.fn();
  const backup = vi.fn(() => Promise.resolve({}));
  return { info, warn, backup, deps: { backup, log: { info, warn }, ...over } as TidyDeps };
}
const audited = (app: FastifyInstance) =>
  app.db.select().from(auditLog).where(eq(auditLog.event, 'mail.rejected_tidied')).all();
const marked = async (app: FastifyInstance) =>
  (await app.db.select().from(settings).where(eq(settings.key, TIDY_REJECTED_MARKER_KEY)).all())
    .length === 1;
const TOTALS = (over: Record<string, number>) => ({
  'opportun.count.messages': 0,
  'opportun.count.entries_blanked': 0,
  'opportun.count.entries_left': 0,
  'opportun.count.notes_cleared': 0,
  'opportun.count.stage_notes_left': 0,
  ...over,
});

describe('a message rejected by an earlier release', () => {
  it.each(Object.keys(CLEARED) as (keyof typeof CLEARED)[])(
    'that still holds only its %s loses it',
    async (field) => {
      const { app, a } = await boot();
      const id = await message(app, a);
      await set(app, id, { ...CLEARED, rejectedAt: T, [field]: FULL[field] });
      const before = await rowOf(app, id);
      const d = deps();
      await tidyRejectedMessages(app.db, d.deps);
      expect(await rowOf(app, id)).toEqual({
        ...before,
        ...CLEARED,
        updatedAt: expect.any(Number),
      });
      expect(d.backup).toHaveBeenCalledTimes(1);
      expect(d.info).toHaveBeenCalledWith(
        TOTALS({ 'opportun.count.messages': 1 }),
        'rejected messages tidied',
      );
    },
  );

  it('loses everything at once, and keeps what it is', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Globex',
      title: 'Engineer',
      sourceKind: 'manual',
    });
    const id = await message(app, a);
    await set(app, id, {
      ...FULL,
      rejectedAt: T,
      rejectionReason: 'spam',
      opportunityId: opp.id,
      triageDecision: 'passed',
      triageRule: 'r',
    });
    const before = await rowOf(app, id);
    await indexCommunication(app.db, ctxOf(a), { id, subject: 'Zebra', snippet: null });
    await tidyRejectedMessages(app.db, deps().deps);
    expect(await rowOf(app, id)).toEqual({
      ...before,
      ...CLEARED,
      updatedAt: expect.any(Number),
    });
    await set(app, id, { rejectedAt: null });
    const hits = await search(app.db, ctxOf(a), 'zebra', { limit: 5, offset: 0 });
    expect(hits.items).toEqual([]);
  });

  it('loses its copies: the note of a correction, the queued body, the entry', async () => {
    const { app, a } = await boot();
    const { id, entry } = await made(app, a);
    await reclassify(app.db, ctxOf(a), id, { classification: 'networking' });
    await app.db
      .update(dismissalFeedback)
      .set({ note: 'x' })
      .where(eq(dismissalFeedback.communicationId, id));
    await enqueueClassify(app.db, ctxOf(a), id, 'The whole body');
    await set(app, id, LEFT);
    const d = deps();
    await tidyRejectedMessages(app.db, d.deps);
    expect(await entries(app, a)).toEqual([
      { ...entry, title: 'Message (rejected)', bodyMd: null },
    ]);
    expect((await app.db.select().from(dismissalFeedback).all()).map((f) => f.note)).toEqual([
      null,
    ]);
    const job = await app.db.select().from(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).get();
    expect(queuedBodyOf(app, job?.payload)).toBeUndefined();
    expect(d.info).toHaveBeenCalledWith(
      TOTALS({
        'opportun.count.messages': 1,
        'opportun.count.entries_blanked': 1,
        'opportun.count.notes_cleared': 1,
      }),
      'rejected messages tidied',
    );
  });

  it('keeps an entry the user edited, which is counted', async () => {
    const { app, a } = await boot();
    const { id, entry } = await made(app, a);
    await app.db
      .update(activities)
      .set({ title: 'My own', updatedAt: entry.createdAt + 1 })
      .where(eq(activities.id, entry.id));
    const before = await entries(app, a);
    await set(app, id, LEFT);
    const d = deps();
    await tidyRejectedMessages(app.db, d.deps);
    expect(await entries(app, a)).toEqual(before);
    expect(d.info).toHaveBeenCalledWith(
      TOTALS({ 'opportun.count.messages': 1, 'opportun.count.entries_left': 1 }),
      'rejected messages tidied',
    );
  });
});

describe('an entry that may be another message of the same sender and moment', () => {
  it.each<[string, boolean]>([
    ['not rejected: it is left, and counted', false],
    ['rejected as well: it is blanked, once', true],
  ])('that is %s', async (_what, both) => {
    const { app, a } = await boot();
    const { id, entry } = await made(app, a);
    const other = await message(app, a);
    await set(app, other, { sentAt: (await rowOf(app, id)).sentAt });
    const keep = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Globex',
      title: 'Kept',
      sourceKind: 'manual',
    });
    await app.db
      .update(activities)
      .set({ opportunityId: keep.id })
      .where(eq(activities.id, entry.id));
    await set(app, other, LEFT);
    if (both) await set(app, id, LEFT);
    const d = deps();
    await tidyRejectedMessages(app.db, d.deps);
    expect((await entries(app, a))[0]).toMatchObject(
      both
        ? { title: 'Message (rejected)', bodyMd: null }
        : { title: SUBJECT, bodyMd: 'We are hiring.' },
    );
    expect(d.info).toHaveBeenCalledWith(
      TOTALS(
        both
          ? { 'opportun.count.messages': 2, 'opportun.count.entries_blanked': 1 }
          : { 'opportun.count.messages': 1, 'opportun.count.entries_left': 1 },
      ),
      'rejected messages tidied',
    );
  });
});

it("an entry that is another message's of the same sender and moment is not counted as left", async () => {
  const { app, a } = await boot();
  const { id } = await made(app, a);
  const other = await made(app, a, 'Designer');
  const sentAt = (await rowOf(app, id)).sentAt;
  await set(app, other.id, { sentAt });
  await app.db
    .update(activities)
    .set({ occurredAt: sentAt })
    .where(eq(activities.id, other.entry.id));
  await set(app, id, LEFT);
  const d = deps();
  await tidyRejectedMessages(app.db, d.deps);
  expect(d.info).toHaveBeenCalledWith(
    TOTALS({ 'opportun.count.messages': 1, 'opportun.count.entries_blanked': 1 }),
    'rejected messages tidied',
  );
  expect((await entries(app, a)).map((e) => e.title).sort()).toEqual([
    'Message (rejected)',
    SUBJECT,
  ]);
});

describe('what is not touched', () => {
  it('a message not rejected, with every one of those columns set; a filtered one; its copies', async () => {
    const { app, a, b } = await boot();
    const gone = await message(app, a);
    await set(app, gone, LEFT);
    const kept = await made(app, a);
    const filtered = await message(app, a);
    await set(app, kept.id, FULL);
    await set(app, filtered, { ...FULL, triageDecision: 'filtered' });
    const theirs = await made(app, b);
    await set(app, theirs.id, FULL);
    const before = [
      await rowOf(app, kept.id),
      await rowOf(app, filtered),
      await rowOf(app, theirs.id),
      await entries(app, a),
      await entries(app, b),
    ];
    const d = deps();
    await tidyRejectedMessages(app.db, d.deps);
    expect([
      await rowOf(app, kept.id),
      await rowOf(app, filtered),
      await rowOf(app, theirs.id),
      await entries(app, a),
      await entries(app, b),
    ]).toEqual(before);
    expect((await audited(app)).map((r) => r.userId)).toEqual([a.userId]);
  });

  it("another user's rejected message is tidied as theirs, and their copies alone", async () => {
    const { app, a, b } = await boot();
    const mine = await made(app, a);
    const theirs = await made(app, b);
    await set(app, theirs.id, LEFT);
    await tidyRejectedMessages(app.db, deps().deps);
    expect(await entries(app, a)).toEqual([mine.entry]);
    expect((await entries(app, b))[0]).toMatchObject({ title: 'Message (rejected)' });
    expect((await audited(app)).map((r) => [r.userId, r.detail])).toEqual([
      [
        b.userId,
        { messages: 1, entriesBlanked: 1, entriesLeft: 0, notesCleared: 0, stageNotesLeft: 0 },
      ],
    ]);
  });
});

describe('the notes of stage changes', () => {
  const note = (app: FastifyInstance, userId: string, opportunityId: string, text: string | null) =>
    app.db
      .insert(stageHistory)
      .values({
        id: `h-${(seq += 1)}`,
        userId,
        opportunityId,
        fromStage: 'discovered',
        toStage: 'interested',
        note: text,
        at: T,
      })
      .run();

  it('are left, and those that may say what a rejected message said are counted', async () => {
    const { app, a, b } = await boot();
    const opp = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Globex',
      title: 'Engineer',
      sourceKind: 'manual',
    });
    const theirs = await createOpportunity(app.db, ctxOf(b), {
      companyName: 'Globex',
      title: 'Engineer',
      sourceKind: 'manual',
    });
    const gone = await message(app, a, 'Gone');
    await set(app, gone, LEFT);
    const long = `  Kept ${'x'.repeat(200)}`;
    await message(app, a, long);
    await message(app, a, 'Live');
    const other = await message(app, a, 'Other rejected');
    // Rejected, its subject not cleared: not a message that is there.
    await set(app, other, { rejectedAt: T });
    for (const text of [
      'Proposed by message: Gone', // counted
      'Proposed by message: Other rejected', // counted
      'Proposed by message: Live',
      `Proposed by message: ${long.trim().slice(0, 120)}`,
      'Proposed by a message',
      'Asked by message: Gone',
      null,
    ]) {
      await note(app, a.userId, opp.id, text);
    }
    // No message of this user's is rejected: none of their notes can be about one.
    await message(app, b, 'Theirs');
    await note(app, b.userId, theirs.id, 'Proposed by message: Gone');
    const before = await app.db.select().from(stageHistory).all();
    const d = deps();
    await tidyRejectedMessages(app.db, d.deps);
    expect(await app.db.select().from(stageHistory).all()).toEqual(before);
    expect(d.info).toHaveBeenCalledWith(
      TOTALS({ 'opportun.count.messages': 2, 'opportun.count.stage_notes_left': 2 }),
      'rejected messages tidied',
    );
    expect((await audited(app)).map((r) => [r.userId, r.detail])).toEqual([
      [
        a.userId,
        { messages: 2, entriesBlanked: 0, entriesLeft: 0, notesCleared: 0, stageNotesLeft: 2 },
      ],
    ]);
  });
});

describe('when it runs', () => {
  async function left(app: FastifyInstance, c: TestClient) {
    const id = await message(app, c);
    await set(app, id, LEFT);
    return id;
  }
  const tidied = async (app: FastifyInstance, id: string) =>
    (await rowOf(app, id)).classification === null;

  it('only after a backup: one that fails changes nothing, says so once, and is not the end', async () => {
    const { app, a } = await boot();
    const id = await left(app, a);
    const before = await rowOf(app, id);
    const failing = deps({ backup: () => Promise.reject(new Error('pg_dump said: secret')) });
    expect(await tidyRejectedMessages(app.db, failing.deps)).toMatchObject({
      status: 'backup_failed',
    });
    expect(await rowOf(app, id)).toEqual(before);
    expect(await audited(app)).toEqual([]);
    expect(await marked(app)).toBe(false);
    expect(failing.info).not.toHaveBeenCalled();
    expect(failing.warn).toHaveBeenCalledTimes(1);
    expect(failing.warn.mock.calls).toEqual([
      [
        { err: expect.any(Error) },
        'rejected messages not tidied, as the backup before it failed: tried again at the next start',
      ],
    ]);

    const order: string[] = [];
    const working = deps({
      backup: async () => {
        order.push((await tidied(app, id)) ? 'after' : 'before');
      },
    });
    expect(await tidyRejectedMessages(app.db, working.deps)).toMatchObject({ status: 'done' });
    expect(order).toEqual(['before']);
    expect(await tidied(app, id)).toBe(true);
    expect(await marked(app)).toBe(true);
  });

  it('a fault that stays: one backup at each start, no marker, and the next users as they were', async () => {
    const { app, a, b } = await boot();
    const ids = [await left(app, a), await left(app, b)];
    const fault = () => {
      let locks = 0;
      setRaceHook((point) => {
        if (point === 'tidy.locked' && (locks += 1) > 1) throw new Error('a fault: secret');
        return Promise.resolve();
      });
    };
    let backups = 0;
    for (let start = 1; start <= 3; start += 1) {
      fault();
      const d = deps({ backup: () => Promise.resolve((backups += 1)) });
      expect(await tidyRejectedMessages(app.db, d.deps)).toEqual({ status: 'failed' });
      expect(backups).toBe(start);
      expect(d.info).not.toHaveBeenCalled();
      expect(d.warn.mock.calls).toEqual([
        [
          { err: expect.any(Error) },
          'rejected messages not all tidied: tried again at the next start',
        ],
      ]);
      // The first user's is done, and stays so; the second one's is as it was.
      expect((await Promise.all(ids.map((id) => tidied(app, id)))).sort()).toEqual([false, true]);
      expect(await marked(app)).toBe(false);
    }
    expect(await audited(app)).toHaveLength(1);
  });

  it('a fault between two batches of one user: the first is done, and on the trail', async () => {
    const { app, a } = await boot();
    await many(app, a, 150);
    let locks = 0;
    setRaceHook((point) => {
      if (point === 'tidy.locked' && (locks += 1) > 1) throw new Error('a fault');
      return Promise.resolve();
    });
    expect(await tidyRejectedMessages(app.db, deps().deps)).toEqual({ status: 'failed' });
    expect(await remaining(app)).toHaveLength(50);
    expect((await audited(app)).map((r) => (r.detail as { messages: number }).messages)).toEqual([
      100,
    ]);
  });

  it('a job that fails so is not tried again before the next start', async () => {
    const { app, a } = await boot();
    await left(app, a);
    setRaceHook((point) => {
      if (point === 'tidy.locked') throw new Error('a fault');
      return Promise.resolve();
    });
    await enqueueTidyRejectedOnce(app.db);
    await app.jobs.drain();
    const rows = await app.db.select().from(jobs).where(eq(jobs.kind, TIDY_REJECTED_KIND)).all();
    expect(rows).toMatchObject([{ status: 'done', attempts: 1 }]);
    if (sqliteOnly) expect(await listBackups(app.storage)).toHaveLength(1);
    expect(await marked(app)).toBe(false);
    // And the next start queues it.
    expect(await enqueueTidyRejectedOnce(app.db)).toBe(true);
  });

  it('a second run changes nothing, and takes no second backup', async () => {
    const { app, a } = await boot();
    await left(app, a);
    await made(app, a);
    await tidyRejectedMessages(app.db, deps().deps);
    const before = [
      await app.db.select().from(communications).all(),
      await app.db.select().from(activities).all(),
      await audited(app),
    ];
    const again = deps();
    await tidyRejectedMessages(app.db, again.deps);
    expect(again.backup).not.toHaveBeenCalled();
    expect([
      await app.db.select().from(communications).all(),
      await app.db.select().from(activities).all(),
      await audited(app),
    ]).toEqual(before);
  });

  it('stopped halfway, what is done stays done, and the rest is done the next time', async () => {
    const { app, a, b } = await boot();
    const ids = [await left(app, a), await left(app, b)];
    let asked = 0;
    const stopped = deps({ stopping: () => (asked += 1) > 1 });
    expect(await tidyRejectedMessages(app.db, stopped.deps)).toMatchObject({ status: 'stopped' });
    expect((await Promise.all(ids.map((id) => tidied(app, id)))).sort()).toEqual([false, true]);
    expect(await marked(app)).toBe(false);
    expect(stopped.info).not.toHaveBeenCalled();
    await tidyRejectedMessages(app.db, deps().deps);
    expect(await Promise.all(ids.map((id) => tidied(app, id)))).toEqual([true, true]);
    expect(await marked(app)).toBe(true);
  });

  /** More than one batch of one user's. */
  async function many(app: FastifyInstance, c: TestClient, n: number) {
    const rows = Array.from({ length: n }, (_, i) => ({
      ...LEFT,
      id: `many-${String(i).padStart(4, '0')}`,
      userId: c.userId,
      channel: 'gmail' as const,
      externalId: `many-${i}`,
      from: FROM,
      to: [],
      sentAt: T - i,
      createdAt: T,
      updatedAt: T,
    }));
    await app.db.insert(communications).values(rows).run();
  }
  const remaining = async (app: FastifyInstance) =>
    (await app.db.select().from(communications).all())
      .filter((r) => r.classification !== null)
      .map((r) => r.id)
      .sort();

  it('a hundred at a time: a stop between leaves the rest for the next run', async () => {
    const { app, a } = await boot();
    await many(app, a, 250);
    let asked = 0;
    const stopped = deps({ stopping: () => (asked += 1) > 2 });
    expect(await tidyRejectedMessages(app.db, stopped.deps)).toMatchObject({ status: 'stopped' });
    const left = await remaining(app);
    expect(left).toHaveLength(50);
    expect(left[0]).toBe('many-0200');
    expect(await marked(app)).toBe(false);
    const d = deps();
    await tidyRejectedMessages(app.db, d.deps);
    expect(await remaining(app)).toEqual([]);
    expect(d.info).toHaveBeenCalledWith(
      TOTALS({ 'opportun.count.messages': 50 }),
      'rejected messages tidied',
    );
    // One row of the trail for what each run did of this user's.
    expect((await audited(app)).map((r) => (r.detail as { messages: number }).messages)).toEqual([
      200, 50,
    ]);
  });

  it("a hundred of another user's do not keep theirs from being tidied", async () => {
    const { app, a, b } = await boot();
    // Theirs is the first user done, and their one message's id comes after a hundred of the other's.
    expect(a.userId < b.userId).toBe(true);
    await many(app, b, 101);
    const theirs = await left(app, a);
    await app.db
      .update(communications)
      .set({ id: 'many-0099-after' })
      .where(eq(communications.id, theirs));
    await tidyRejectedMessages(app.db, deps().deps);
    expect(await tidied(app, 'many-0099-after')).toBe(true);
    expect(await remaining(app)).toEqual([]);
    expect(await marked(app)).toBe(true);
  });

  it('in all, one row of the trail for a user, with the sum of their batches', async () => {
    const { app, a } = await boot();
    await many(app, a, 250);
    const d = deps();
    await tidyRejectedMessages(app.db, d.deps);
    expect(await remaining(app)).toEqual([]);
    expect((await audited(app)).map((r) => (r.detail as { messages: number }).messages)).toEqual([
      250,
    ]);
    expect(d.backup).toHaveBeenCalledTimes(1);
  });

  it('what waits for the user meanwhile gets its turn between two batches', async () => {
    const { app, a } = await boot();
    await many(app, a, 150);
    onSlowTransaction(() => undefined);
    let batches = 0;
    let done = false;
    let doneAtSecond = false;
    let arrived!: () => void;
    let go!: () => void;
    const first = new Promise<void>((r) => (arrived = r));
    const released = new Promise<void>((r) => (go = r));
    setRaceHook(async (point) => {
      if (point !== 'tidy.locked') return;
      batches += 1;
      if (batches === 1) {
        arrived();
        await released;
      } else if (batches === 2) {
        // Time for its answer to arrive, were it done: it cannot begin now, the lock being held.
        await new Promise((r) => setTimeout(r, 100));
        doneAtSecond = done;
      }
    });
    const tidying = tidyRejectedMessages(app.db, deps().deps);
    await first;
    const saving = createOpportunity(app.db, ctxOf(a), {
      companyName: 'Globex',
      title: 'Engineer',
      sourceKind: 'manual',
    }).then(() => (done = true));
    const waited = await someoneBlocked(app);
    go();
    await tidying;
    await saving;
    expect(waited).toBe(true);
    expect(batches).toBeGreaterThanOrEqual(2);
    expect(doneAtSecond).toBe(true);
  });

  it('nothing to tidy: no backup, and it is done for good', async () => {
    const { app, a } = await boot();
    await message(app, a);
    const d = deps();
    expect(await tidyRejectedMessages(app.db, d.deps)).toMatchObject({ status: 'done' });
    expect(d.backup).not.toHaveBeenCalled();
    expect(await marked(app)).toBe(true);
    expect(await audited(app)).toEqual([]);
  });

  it('says nothing but counts, anywhere', async () => {
    const { app, a } = await boot();
    const { id } = await made(app, a);
    await set(app, id, { ...FULL, rejectedAt: T });
    const d = deps();
    const result = await tidyRejectedMessages(app.db, d.deps);
    const said = JSON.stringify([
      result,
      d.info.mock.calls,
      (await audited(app)).map((r) => r.detail),
    ]);
    for (const word of [SUBJECT, 'hiring', 'priya', 'Initech', id, a.userId]) {
      expect(said).not.toContain(word);
    }
  });

  const queued = (app: FastifyInstance) =>
    app.db.select().from(jobs).where(eq(jobs.kind, TIDY_REJECTED_KIND)).all();

  it('is queued at a start once there are users, until it is done', async () => {
    const { app } = await testApp();
    try {
      expect(await enqueueTidyRejectedOnce(app.db)).toBe(false);
      expect(await queued(app)).toEqual([]);
      expect(await marked(app)).toBe(false);
    } finally {
      await app.close();
    }
    const { app: used, a } = await boot();
    const id = await left(used, a);
    expect(await enqueueTidyRejectedOnce(used.db)).toBe(true);
    expect(await enqueueTidyRejectedOnce(used.db)).toBe(true);
    expect(await queued(used)).toHaveLength(1);
    expect((await queued(used))[0]).toMatchObject({ userId: null, payload: {} });
    await used.jobs.drain();
    expect(await queued(used)).toMatchObject([{ status: 'done', result: { status: 'done' } }]);
    expect(await tidied(used, id)).toBe(true);
    expect(await enqueueTidyRejectedOnce(used.db)).toBe(false);
  });
});

// Postgres gives a test no database to start twice on, and the start is the same.
it.runIf(sqliteOnly)('a server that starts queues it, once it has a user', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'opportun-tidy-'));
  const cfg = {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    sqliteDir: dataDir,
    baseUrl: 'http://localhost:3000',
    masterKey: randomBytes(32),
    logLevel: 'silent',
    db: { dialect: 'sqlite' as const },
    demo: false,
    aiAllowLoopbackHttp: false,
    telemetryAllowPrivate: false,
    trustedProxies: [],
  };
  const start = async (use: (app: FastifyInstance) => Promise<void>) => {
    const app = await buildApp(cfg, { jobRunner: false });
    try {
      await use(app);
    } finally {
      await app.close();
    }
  };
  const queued = async (app: FastifyInstance) =>
    (await app.db.select().from(jobs).where(eq(jobs.kind, TIDY_REJECTED_KIND)).all()).length;
  try {
    await start(async (app) => {
      expect(await queued(app)).toBe(0);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          displayName: 'Jane Example',
          email: 'jane@example.com',
          password: 'correct horse battery staple',
        },
      });
      expect(res.statusCode, res.body).toBe(201);
    });
    await start(async (app) => expect(await queued(app)).toBe(1));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

describe('a reject beside it', () => {
  const reject = async (app: FastifyInstance, c: TestClient, id: string) =>
    rejectCommunication(app.db, ctxOf(c), id, {
      reason: 'spam',
      expectedOpportunityId: (await rowOf(app, id)).opportunityId,
    });

  it.each<[string, string]>([
    ['it first', 'tidy.locked'],
    ['the reject first', 'reject.erased'],
  ])('%s: the other waits, and both are whole', async (_what, point) => {
    const { app, a } = await boot();
    const old = await message(app, a);
    await set(app, old, LEFT);
    const { id } = await made(app, a);
    onSlowTransaction(() => undefined);
    const d = deps();
    const pause = pauseAt(point);
    const run = {
      tidy: () => tidyRejectedMessages(app.db, d.deps),
      reject: () => reject(app, a, id),
    };
    const first = point === 'tidy.locked' ? run.tidy() : run.reject();
    await pause.reached;
    const second = point === 'tidy.locked' ? run.reject() : run.tidy();
    const waited = await someoneBlocked(app);
    pause.release();
    await first;
    await second;
    expect(waited).toBe(true);
    for (const m of [old, id]) {
      expect(await rowOf(app, m)).toMatchObject({
        ...CLEARED,
        rejectedAt: expect.any(Number),
      });
    }
    expect((await entries(app, a)).map((e) => e.title)).toEqual(['Message (rejected)']);
    expect(d.info).toHaveBeenCalledWith(
      TOTALS({ 'opportun.count.messages': 1 }),
      'rejected messages tidied',
    );
  });
});
