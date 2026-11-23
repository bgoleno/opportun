// Merging and deleting beside everything that writes or names two opportunities, or a message and
// its opportunity (https://github.com/bgoleno/opportun/issues/920): nothing deadlocks or fails on a
// foreign key, and nothing that was answered is lost. The overlaps are Postgres's; SQLite's write gate
// runs the two one after the other, and the same outcomes hold.
import { eq, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { newId } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { onSlowTransaction } from '../src/db/gate';
import {
  activities,
  applicationSubmissions,
  attachments,
  communications,
  dismissalFeedback,
  nextSteps,
  opportunities,
  opportunityDedupeCandidates,
  stageHistory,
} from '../src/db/schema';
import { createActivity, createNextStep, updateActivity } from '../src/repos/activities';
import { createAttachment } from '../src/repos/attachments';
import type { Exec, UserCtx } from '../src/repos/base';
import { reclassify, upsertInbound } from '../src/repos/communications';
import {
  createOpportunity,
  deleteOpportunity,
  dismissPossibleDuplicate,
  mergeOpportunities,
  reorderOpportunities,
  transitionOpportunityIn,
  updateOpportunity,
} from '../src/repos/opportunities';
import { rejectCommunication } from '../src/repos/reject';
import { insertResume } from '../src/repos/resumes';
import { useApi } from './api';
import { queryAll, testDialect } from './db';
import type { TestClient } from './isolation';
import { heldOpen, pauseAt, someoneBlocked } from './race';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
const MERGING = 'opportunities.merge.moved';
const DELETING = 'opportunities.delete.locked';
const NOTE = {
  kind: 'note' as const,
  title: 'A note',
  bodyMd: 'noted',
  occurredAt: 1,
  participants: [],
  externalUrl: null,
};
const FILE = {
  filename: 'offer.pdf',
  mime: 'application/pdf',
  bytes: 3,
  sha256: 'a'.repeat(64),
  storedPath: 'attachments/a',
};

interface Pair {
  app: FastifyInstance;
  ctx: UserCtx;
  keep: string;
  other: string;
  noteId: string;
}
/** Two opportunities of one company, alike enough for a save of one to name the other. */
async function pair(): Promise<Pair & { a: TestClient; b: TestClient }> {
  const { app, a, b } = await boot();
  const ctx = ctxOf(a);
  const create = (title: string) =>
    createOpportunity(app.db, ctx, {
      companyName: 'Initech',
      title,
      descriptionMd: 'What the job is.',
      sourceKind: 'manual',
    });
  const keep = (await create('Baker')).id;
  const other = (await create('Warehouse Manager')).id;
  const note = await createActivity(app.db, ctx, other, NOTE);
  // Transactions are parked on purpose.
  onSlowTransaction(() => undefined);
  return { app, a, b, ctx, keep, other, noteId: note.id };
}

let seq = 0;
async function message({ app, ctx }: Pair, opportunityId: string | null): Promise<string> {
  seq += 1;
  const { id } = await upsertInbound(app.db, ctx, 'gmail', {
    externalId: `merge-${seq}`,
    threadKey: `merge-${seq}`,
    from: 'Riley Recruiter <riley@acme.example>',
    to: ['me@example.com'],
    subject: `Subject ${seq}`,
    snippet: 'A snippet',
    bodyText: 'A body',
    sentAt: Date.now() - 1000 * seq,
  });
  await app.db.update(communications).set({ opportunityId }).where(eq(communications.id, id)).run();
  return id;
}
const messageRow = async ({ app }: Pair, id: string) =>
  (await app.db.select().from(communications).where(eq(communications.id, id)).get())!;

/** What a call ends as: `ok`, or the status and code it is refused with. */
const ended = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: unknown) => {
      const err = e as { statusCode?: number; code?: string; cause?: { code?: string } };
      return `${err.statusCode ?? 500} ${err.statusCode === undefined ? (err.cause?.code ?? String(e)) : err.code}`;
    },
  );
const GONE = '404 not_found';

/** Parks `first` at `point`, starts `second`, sees it wait, lets both go. */
async function beside(
  app: FastifyInstance,
  point: string,
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<[string, string]> {
  const pause = pauseAt(point);
  const one = ended(first());
  await pause.reached;
  const two = ended(second());
  const blocked = await someoneBlocked(app);
  pause.release();
  const out: [string, string] = [await one, await two];
  expect(blocked).toBe(true);
  return out;
}
/** Holds `first` open in its transaction, starts `second`, sees it wait, lets both go. */
async function after(
  app: FastifyInstance,
  first: (tx: Exec) => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<string> {
  const held = heldOpen(app, first);
  await held.reached;
  const two = ended(second());
  const blocked = await someoneBlocked(app);
  held.go();
  await held.done;
  const out = await two;
  expect(blocked).toBe(true);
  return out;
}

const merge = (p: Pair) => mergeOpportunities(p.app.db, p.ctx, p.keep, p.other);
const remove = (p: Pair, id: string) => deleteOpportunity(p.app.db, p.ctx, id);

/** Nothing names the opportunity any more, and the search rows are those of what there is. */
async function expectGone({ app, ctx }: Pair, id: string): Promise<void> {
  for (const table of [
    activities,
    nextSteps,
    attachments,
    stageHistory,
    communications,
    dismissalFeedback,
    applicationSubmissions,
  ] as const) {
    expect(
      await app.db.select({ id: table.id }).from(table).where(eq(table.opportunityId, id)).all(),
    ).toEqual([]);
  }
  expect(
    await app.db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(or(eq(opportunities.id, id), eq(opportunities.possibleDuplicateOf, id)))
      .all(),
  ).toEqual([]);
  expect(
    await app.db
      .select({ id: opportunityDedupeCandidates.id })
      .from(opportunityDedupeCandidates)
      .where(
        or(
          eq(opportunityDedupeCandidates.opportunityIdA, id),
          eq(opportunityDedupeCandidates.opportunityIdB, id),
        ),
      )
      .all(),
  ).toEqual([]);
  const ids = async (kind: 'opportunity' | 'activity') =>
    (
      await queryAll<{ entity_id: string }>(
        app,
        'SELECT entity_id FROM search_index WHERE user_id = ? AND entity_kind = ? ORDER BY entity_id',
        ctx.userId,
        kind,
      )
    ).map((r) => r.entity_id);
  const of = async (table: typeof opportunities | typeof activities) =>
    (await app.db.select({ id: table.id }).from(table).where(eq(table.userId, ctx.userId)).all())
      .map((r) => r.id)
      .sort();
  expect(await ids('opportunity')).toEqual(await of(opportunities));
  expect(await ids('activity')).toEqual(await of(activities));
}
const activityOwner = async ({ app }: Pair, id: string) =>
  (await app.db.select().from(activities).where(eq(activities.id, id)).get())?.opportunityId;

describe('what is added to the merged-away one meanwhile is never answered and then lost', () => {
  const count = async (
    { app, keep }: Pair,
    table: typeof activities | typeof nextSteps | typeof attachments,
  ) =>
    (await app.db.select({ id: table.id }).from(table).where(eq(table.opportunityId, keep)).all())
      .length;
  type Add = [
    string,
    typeof activities | typeof nextSteps | typeof attachments,
    (exec: Exec, p: Pair) => Promise<unknown>,
  ];
  const ADDS: Add[] = [
    [
      'a next step',
      nextSteps,
      (exec, p) => createNextStep(exec, p.ctx, p.other, { action: 'Call' }),
    ],
    ['an activity', activities, (exec, p) => createActivity(exec, p.ctx, p.other, NOTE)],
    ['a file', attachments, (exec, p) => createAttachment(exec as never, p.ctx, p.other, FILE)],
  ];
  it.each(ADDS)('%s, the merge first: it waits, and is not found', async (_w, table, add) => {
    const p = await pair();
    const before = await count(p, table);
    expect(
      await beside(
        p.app,
        MERGING,
        () => merge(p),
        () => add(p.app.db, p),
      ),
    ).toEqual(['ok', GONE]);
    // The merge's own note, and the note it moved.
    expect(await count(p, table)).toBe(before + (table === activities ? 2 : 0));
    await expectGone(p, p.other);
  });
  it.each(ADDS)('%s first: the merge waits, and moves it', async (_w, table, add) => {
    const p = await pair();
    expect(
      await after(
        p.app,
        (tx) => add(tx, p),
        () => merge(p),
      ),
    ).toBe('ok');
    expect(await count(p, table)).toBe(1 + (table === activities ? 2 : 0));
    await expectGone(p, p.other);
  });

  it('a message linked to it, the merge first: the link waits, and is not found', async () => {
    const p = await pair();
    const id = await message(p, null);
    expect(
      await beside(
        p.app,
        MERGING,
        () => merge(p),
        () => reclassify(p.app.db, p.ctx, id, { opportunityId: p.other }),
      ),
    ).toEqual(['ok', GONE]);
    expect((await messageRow(p, id)).opportunityId).toBeNull();
    expect(await p.app.db.select().from(dismissalFeedback).all()).toEqual([]);
    await expectGone(p, p.other);
  });
  it('a message linked to it first: the merge waits, and moves the link', async () => {
    const p = await pair();
    const id = await message(p, null);
    expect(
      await beside(
        p.app,
        'reclassify.read',
        () => reclassify(p.app.db, p.ctx, id, { opportunityId: p.other }),
        () => merge(p),
      ),
    ).toEqual(['ok', 'ok']);
    expect((await messageRow(p, id)).opportunityId).toBe(p.keep);
    await expectGone(p, p.other);
  });
});

describe('beside a merge', () => {
  const similar = 'Warehouse Manager Nights';
  type Second = [string, (p: Pair) => Promise<unknown>, string];
  const SECOND: Second[] = [
    [
      'a description save of the merged-away one',
      (p) => updateOpportunity(p.app.db, p.ctx, p.other, { descriptionMd: 'new' }),
      GONE,
    ],
    [
      'a title save of the merged-away one, which names the kept one',
      (p) => updateOpportunity(p.app.db, p.ctx, p.other, { title: 'Baker Nights' }),
      GONE,
    ],
    [
      'a title save of the kept one, which names the merged-away one',
      (p) => updateOpportunity(p.app.db, p.ctx, p.keep, { title: similar }),
      'ok',
    ],
    ['the delete of the merged-away one', (p) => remove(p, p.other), GONE],
    ['the crossed merge', (p) => mergeOpportunities(p.app.db, p.ctx, p.other, p.keep), GONE],
    [
      'a reorder of both, the merged-away one first',
      (p) =>
        reorderOpportunities(p.app.db, p.ctx, [
          { id: p.other, sortOrder: 1 },
          { id: p.keep, sortOrder: 2 },
        ]),
      'ok',
    ],
    [
      '"not a duplicate" for the two',
      (p) => dismissPossibleDuplicate(p.app.db, p.ctx, p.keep, p.other),
      GONE,
    ],
    [
      'an edit of a moved activity',
      (p) => updateActivity(p.app.db, p.ctx, p.noteId, { title: 'edited' }),
      'ok',
    ],
  ];
  it.each(SECOND)('%s', async (_w, second, expected) => {
    const p = await pair();
    expect(
      await beside(
        p.app,
        MERGING,
        () => merge(p),
        () => second(p),
      ),
    ).toEqual(['ok', expected]);
    expect(await activityOwner(p, p.noteId)).toBe(p.keep);
    await expectGone(p, p.other);
  });

  it('the delete of the kept one: both are done, and all of it goes', async () => {
    const p = await pair();
    expect(
      await beside(
        p.app,
        MERGING,
        () => merge(p),
        () => remove(p, p.keep),
      ),
    ).toEqual(['ok', 'ok']);
    await expectGone(p, p.other);
    await expectGone(p, p.keep);
  });

  it('a title save of a third that names the merged-away one', async () => {
    const p = await pair();
    const third = await createOpportunity(p.app.db, p.ctx, {
      companyName: 'Initech',
      title: 'Cook',
      sourceKind: 'manual',
    });
    await p.app.db
      .update(opportunities)
      .set({ possibleDuplicateOf: p.other })
      .where(eq(opportunities.id, third.id))
      .run();
    expect(
      await beside(
        p.app,
        MERGING,
        () => merge(p),
        () => updateOpportunity(p.app.db, p.ctx, third.id, { title: similar }),
      ),
    ).toEqual(['ok', 'ok']);
    await expectGone(p, p.other);
  });

  it('a correction of a message it moved: it is of the kept one', async () => {
    const p = await pair();
    const id = await message(p, p.other);
    expect(
      await beside(
        p.app,
        MERGING,
        () => merge(p),
        () => reclassify(p.app.db, p.ctx, id, { classification: 'other' }),
      ),
    ).toEqual(['ok', 'ok']);
    expect((await messageRow(p, id)).opportunityId).toBe(p.keep);
    const [row] = await p.app.db.select().from(dismissalFeedback).all();
    expect(row).toMatchObject({
      kind: 'classification',
      communicationId: id,
      opportunityId: p.keep,
      reason: expect.not.stringContaining('linked'),
    });
    await expectGone(p, p.other);
  });

  it('a reject of a message it moved: refused as changed, and nothing is written', async () => {
    const p = await pair();
    const id = await message(p, p.other);
    expect(
      await beside(
        p.app,
        MERGING,
        () => merge(p),
        () =>
          rejectCommunication(p.app.db, p.ctx, id, {
            expectedOpportunityId: p.other,
            reason: 'spam',
          }),
      ),
    ).toEqual(['ok', '409 message_changed']);
    expect(await messageRow(p, id)).toMatchObject({
      opportunityId: p.keep,
      rejectedAt: null,
      snippet: 'A snippet',
    });
    expect(await p.app.db.select().from(dismissalFeedback).all()).toEqual([]);
    await expectGone(p, p.other);
  });

  it('a correction first: the merge waits, and moves the message and its feedback', async () => {
    const p = await pair();
    const id = await message(p, p.other);
    expect(
      await beside(
        p.app,
        'reclassify.read',
        () => reclassify(p.app.db, p.ctx, id, { classification: 'other' }),
        () => merge(p),
      ),
    ).toEqual(['ok', 'ok']);
    expect((await messageRow(p, id)).opportunityId).toBe(p.keep);
    await expectGone(p, p.other);
  });

  const FIRST: [string, (tx: Exec, p: Pair) => Promise<unknown>][] = [
    [
      'a description save of the merged-away one',
      (tx, p) => updateOpportunity(tx as never, p.ctx, p.other, { descriptionMd: 'new' }),
    ],
    [
      'a title save of the merged-away one, which names the kept one',
      (tx, p) => updateOpportunity(tx as never, p.ctx, p.other, { title: 'Baker Nights' }),
    ],
    [
      'a reorder of both, the merged-away one first',
      (tx, p) =>
        reorderOpportunities(tx as never, p.ctx, [
          { id: p.other, sortOrder: 1 },
          { id: p.keep, sortOrder: 2 },
        ]),
    ],
    [
      'an edit of its activity',
      (tx, p) => updateActivity(tx as never, p.ctx, p.noteId, { title: 'edited' }),
    ],
  ];
  it.each(FIRST)('%s first: the merge waits and is done', async (_w, first) => {
    const p = await pair();
    expect(
      await after(
        p.app,
        (tx) => first(tx, p),
        () => merge(p),
      ),
    ).toBe('ok');
    expect(await activityOwner(p, p.noteId)).toBe(p.keep);
    await expectGone(p, p.other);
  });

  it.runIf(testDialect === 'postgres')("another user's merge does not wait", async () => {
    const p = await pair();
    const ctxB = ctxOf(p.b);
    const mine = (title: string) =>
      createOpportunity(p.app.db, ctxB, { companyName: 'Initech', title, sourceKind: 'manual' });
    const k = (await mine('Baker')).id;
    const o = (await mine('Cook')).id;
    const pause = pauseAt(MERGING);
    const first = ended(merge(p));
    await pause.reached;
    const second = await ended(mergeOpportunities(p.app.db, ctxB, k, o));
    pause.release();
    expect([await first, second]).toEqual(['ok', 'ok']);
  });
});

describe('a merge decides from what there is once it has its locks', () => {
  it('a stage and a title changed while it waited are the ones merged', async () => {
    const p = await pair();
    expect(
      await after(
        p.app,
        async (tx) => {
          await transitionOpportunityIn(tx, p.ctx, p.other, { to: 'interested' });
          await updateOpportunity(tx as never, p.ctx, p.other, { title: 'Night Manager' });
        },
        () => merge(p),
      ),
    ).toBe('ok');
    const row = await p.app.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, p.keep))
      .get();
    expect(row?.stage).toBe('interested');
    const notes = await p.app.db
      .select()
      .from(activities)
      .where(eq(activities.opportunityId, p.keep))
      .all();
    expect(notes.map((n) => n.title)).toContain('Merged duplicate: Initech, Night Manager');
    await expectGone(p, p.other);
  });

  it('a live attempt made while it waited is refused, and nothing is merged', async () => {
    const p = await pair();
    const resume = await insertResume(p.app.db, p.ctx, {
      kind: 'base',
      title: 'Resume',
      store: 'local_file',
      docRef: `resumes/${newId()}.txt`,
      opportunityId: null,
      parentResumeId: null,
    });
    const attempt = (exec: Exec, opportunityId: string) =>
      exec
        .insert(applicationSubmissions)
        .values({
          id: newId(),
          userId: p.ctx.userId,
          opportunityId,
          resumeId: resume.id,
          atsKind: 'ats_greenhouse',
          atsRef: 'initech',
          atsExternalId: newId(),
          destinationUrl: 'https://boards.greenhouse.io/initech/jobs/1000001',
          status: 'draft',
          idempotencyKey: newId(),
          fields: {},
          answers: [],
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
    await attempt(p.app.db, p.keep);
    expect(
      await after(
        p.app,
        (tx) => attempt(tx, p.other),
        () => merge(p),
      ),
    ).toBe('409 live_submission_conflict');
    expect(await activityOwner(p, p.noteId)).toBe(p.other);
  });
});

describe('beside a delete', () => {
  it('a title save of one that names it, and points at it: both are done', async () => {
    const p = await pair();
    await p.app.db
      .update(opportunities)
      .set({ possibleDuplicateOf: p.other })
      .where(eq(opportunities.id, p.keep))
      .run();
    expect(
      await beside(
        p.app,
        DELETING,
        () => remove(p, p.other),
        () => updateOpportunity(p.app.db, p.ctx, p.keep, { title: 'Warehouse Manager Nights' }),
      ),
    ).toEqual(['ok', 'ok']);
    await expectGone(p, p.other);
  });
  it('that save first: the delete waits and is done', async () => {
    const p = await pair();
    await p.app.db
      .update(opportunities)
      .set({ possibleDuplicateOf: p.other })
      .where(eq(opportunities.id, p.keep))
      .run();
    expect(
      await after(
        p.app,
        (tx) =>
          updateOpportunity(tx as never, p.ctx, p.keep, { title: 'Warehouse Manager Nights' }),
        () => remove(p, p.other),
      ),
    ).toBe('ok');
    await expectGone(p, p.other);
  });
  it('a reorder of one that points at it, then it', async () => {
    const p = await pair();
    await p.app.db
      .update(opportunities)
      .set({ possibleDuplicateOf: p.other })
      .where(eq(opportunities.id, p.keep))
      .run();
    expect(
      await beside(
        p.app,
        DELETING,
        () => remove(p, p.other),
        () =>
          reorderOpportunities(p.app.db, p.ctx, [
            { id: p.keep, sortOrder: 1 },
            { id: p.other, sortOrder: 2 },
          ]),
      ),
    ).toEqual(['ok', 'ok']);
    const row = await p.app.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, p.keep))
      .get();
    expect(row?.sortOrder).toBe(1);
    await expectGone(p, p.other);
  });
  it('"not a duplicate", the pair having no row yet', async () => {
    const p = await pair();
    await p.app.db
      .update(opportunities)
      .set({ possibleDuplicateOf: p.other })
      .where(eq(opportunities.id, p.keep))
      .run();
    expect(
      await beside(
        p.app,
        DELETING,
        () => remove(p, p.other),
        () => dismissPossibleDuplicate(p.app.db, p.ctx, p.keep, p.other),
      ),
    ).toEqual(['ok', GONE]);
    await expectGone(p, p.other);
  });
  it('"not a duplicate" first: the delete waits and is done', async () => {
    const p = await pair();
    await p.app.db
      .update(opportunities)
      .set({ possibleDuplicateOf: p.other })
      .where(eq(opportunities.id, p.keep))
      .run();
    expect(
      await after(
        p.app,
        (tx) => dismissPossibleDuplicate(tx as never, p.ctx, p.keep, p.other),
        () => remove(p, p.other),
      ),
    ).toBe('ok');
    await expectGone(p, p.other);
  });
  it.each([
    ['the merge of it into another', (p: Pair) => merge(p)],
    [
      'the merge of another into it',
      (p: Pair) => mergeOpportunities(p.app.db, p.ctx, p.other, p.keep),
    ],
  ])('%s: not found', async (_w, second) => {
    const p = await pair();
    expect(
      await beside(
        p.app,
        DELETING,
        () => remove(p, p.other),
        () => second(p),
      ),
    ).toEqual(['ok', GONE]);
    expect(
      (await p.app.db.select().from(opportunities).where(eq(opportunities.id, p.keep)).all())
        .length,
    ).toBe(1);
    await expectGone(p, p.other);
  });

  it('a correction of its message: done, and the message is of none', async () => {
    const p = await pair();
    const id = await message(p, p.other);
    expect(
      await beside(
        p.app,
        DELETING,
        () => remove(p, p.other),
        () => reclassify(p.app.db, p.ctx, id, { classification: 'other' }),
      ),
    ).toEqual(['ok', 'ok']);
    expect((await messageRow(p, id)).opportunityId).toBeNull();
    const [row] = await p.app.db.select().from(dismissalFeedback).all();
    expect(row).toMatchObject({ kind: 'classification', opportunityId: null });
    await expectGone(p, p.other);
  });
  it('a correction first: the delete waits and is done', async () => {
    const p = await pair();
    const id = await message(p, p.other);
    expect(
      await beside(
        p.app,
        'reclassify.read',
        () => reclassify(p.app.db, p.ctx, id, { classification: 'other' }),
        () => remove(p, p.other),
      ),
    ).toEqual(['ok', 'ok']);
    expect((await messageRow(p, id)).opportunityId).toBeNull();
    await expectGone(p, p.other);
  });
  it('a link of a message to it: not found, and nothing is written', async () => {
    const p = await pair();
    const id = await message(p, p.keep);
    expect(
      await beside(
        p.app,
        DELETING,
        () => remove(p, p.other),
        () => reclassify(p.app.db, p.ctx, id, { opportunityId: p.other }),
      ),
    ).toEqual(['ok', GONE]);
    expect((await messageRow(p, id)).opportunityId).toBe(p.keep);
    expect(await p.app.db.select().from(dismissalFeedback).all()).toEqual([]);
    await expectGone(p, p.other);
  });
  it('a reject of its message: refused as changed, and nothing is written', async () => {
    const p = await pair();
    const id = await message(p, p.other);
    expect(
      await beside(
        p.app,
        DELETING,
        () => remove(p, p.other),
        () =>
          rejectCommunication(p.app.db, p.ctx, id, {
            expectedOpportunityId: p.other,
            reason: 'spam',
          }),
      ),
    ).toEqual(['ok', '409 message_changed']);
    expect(await messageRow(p, id)).toMatchObject({
      opportunityId: null,
      rejectedAt: null,
      snippet: 'A snippet',
    });
    expect(await p.app.db.select().from(dismissalFeedback).all()).toEqual([]);
    await expectGone(p, p.other);
  });
  it('a reject of its message first: the delete waits and is done', async () => {
    const p = await pair();
    const id = await message(p, p.other);
    expect(
      await after(
        p.app,
        (tx) =>
          rejectCommunication(tx as never, p.ctx, id, {
            expectedOpportunityId: p.other,
            reason: 'spam',
          }),
        () => remove(p, p.other),
      ),
    ).toBe('ok');
    expect(await messageRow(p, id)).toMatchObject({
      opportunityId: null,
      rejectedAt: expect.any(Number),
    });
    await expectGone(p, p.other);
  });
});
