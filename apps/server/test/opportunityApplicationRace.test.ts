// A merge or a delete beside an application or a resume
// (https://github.com/bgoleno/opportun/issues/944): each answers what happened, 404 or 409 and never
// 500, with nothing written; and no attempt is moved or deleted without its lock. The overlaps are
// Postgres's; SQLite's write gate runs the two one after the other, and the same outcomes hold.
import { AsyncResource } from 'node:async_hooks';
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { lockScope, withTransaction } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import {
  applicationSubmissions,
  nextSteps,
  opportunities,
  resumes,
  resumeSends,
} from '../src/db/schema';
import { setRaceHook } from '../src/lib/racePoints';
import { createNextStep } from '../src/repos/activities';
import type { Exec, UserCtx } from '../src/repos/base';
import { upsertInbound } from '../src/repos/communications';
import {
  createOpportunity,
  deleteOpportunity,
  mergeOpportunities,
} from '../src/repos/opportunities';
import { insertResume, updateResume } from '../src/repos/resumes';
import { recordResumeSend } from '../src/repos/resumeSends';
import { confirmFromEmail } from '../src/repos/submissionConfirm';
import { createSubmissionDraft } from '../src/repos/submissions';
import { useApi } from './api';
import { testDialect } from './db';
import type { TestClient } from './isolation';
import { heldOpen, pauseAt, someoneBlocked } from './race';
import { requisition } from './submissionFixtures';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
const LOCKED = 'opportunities.merge.locked';
const MERGING = 'opportunities.merge.moved';
const DELETING = 'opportunities.delete.locked';
const GONE = '404 not_found';

interface Pair {
  app: FastifyInstance;
  ctx: UserCtx;
  keep: string;
  other: string;
  /** A base resume, final, of neither. */
  resumeId: string;
}

/** Two opportunities an application can be started on, and a resume to send. */
async function pair(): Promise<Pair> {
  const { app, a } = await boot();
  const ctx = ctxOf(a);
  const create = async (title: string) => {
    const { id } = await createOpportunity(app.db, ctx, {
      companyName: 'Example Corp',
      title,
      sourceKind: 'manual',
    });
    await app.db
      .update(opportunities)
      .set({ stage: 'interested', atsJobRef: requisition(), postingState: 'confirmed' })
      .where(eq(opportunities.id, id))
      .run();
    return id;
  };
  const keep = await create('Pastry Baker');
  const other = await create('Warehouse Manager');
  const p = { app, ctx, keep, other, resumeId: '' };
  const resume = await resumeOf(p, null);
  await app.db.update(resumes).set({ status: 'final' }).where(eq(resumes.id, resume)).run();
  // Transactions are parked on purpose.
  onSlowTransaction(() => undefined);
  return { ...p, resumeId: resume };
}
const resumeOf = async ({ app, ctx }: Pair, opportunityId: string | null, exec?: Exec) =>
  (
    await insertResume((exec ?? app.db) as never, ctx, {
      kind: opportunityId === null ? 'base' : 'tailored',
      title: 'Resume',
      store: 'local_file',
      docRef: `resumes/${newId()}.txt`,
      opportunityId,
      parentResumeId: null,
    })
  ).id;
const start = (p: Pair, opportunityId: string, exec?: Exec) =>
  createSubmissionDraft((exec ?? p.app.db) as never, p.ctx, opportunityId, {
    idempotencyKey: newId(),
    resumeId: p.resumeId,
  });

/** What a call ends as: `ok`, or the status and code it is refused with. */
const ended = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: unknown) => {
      const err = e as { statusCode?: number; code?: string; cause?: { code?: string } };
      return `${err.statusCode ?? 500} ${err.statusCode === undefined ? (err.cause?.code ?? String(e)) : err.code}`;
    },
  );

/** Parks `first` at `point`, starts `second`, sees it wait, lets both go. */
async function beside(
  p: Pair,
  point: string,
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<[string, string]> {
  const pause = pauseAt(point);
  const one = ended(first());
  await pause.reached;
  const two = ended(second());
  const blocked = await someoneBlocked(p.app);
  pause.release();
  const out: [string, string] = [await one, await two];
  expect(blocked).toBe(true);
  return out;
}

const merge = (p: Pair) => mergeOpportunities(p.app.db, p.ctx, p.keep, p.other);
const remove = (p: Pair) => deleteOpportunity(p.app.db, p.ctx, p.other);
const attemptsOf = async ({ app }: Pair, id: string) =>
  (
    await app.db
      .select({ id: applicationSubmissions.id })
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.opportunityId, id))
      .all()
  ).map((r) => r.id);
/** What there is of each kind, and of which opportunity. */
async function written({ app }: Pair) {
  const of = async (table: typeof resumes | typeof resumeSends | typeof applicationSubmissions) =>
    (await app.db.select({ id: table.id, at: table.opportunityId }).from(table).all())
      .map((r) => `${r.id} ${r.at ?? 'none'}`)
      .sort();
  return {
    resumes: await of(resumes),
    sends: await of(resumeSends),
    attempts: await of(applicationSubmissions),
  };
}

/** A submitted attempt, which is not live, so there can be several. */
async function attemptOn(p: Pair, opportunityId: string, followupNextStepId?: string) {
  const id = newId();
  await p.app.db
    .insert(applicationSubmissions)
    .values({
      id,
      userId: p.ctx.userId,
      opportunityId,
      resumeId: p.resumeId,
      atsKind: 'ats_greenhouse',
      atsRef: 'examplecorp',
      atsExternalId: newId(),
      destinationUrl: 'https://boards.greenhouse.io/examplecorp/jobs/1000001',
      status: 'submitted',
      handedOffAt: 1,
      submittedAt: 1,
      submittedBasis: 'user_attested',
      idempotencyKey: newId(),
      fields: {},
      answers: [],
      followupNextStepId: followupNextStepId ?? null,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  return id;
}

describe('an application started on the kept one while a merge moves a live one to it', () => {
  const CONFLICT = (submissionId: string) => ({
    statusCode: 409,
    code: 'live_submission_conflict',
    details: { submissionId },
    userMessage: 'Both opportunities have an open application. Cancel one of them before merging.',
  });
  /** The merge, or what it was refused with. */
  const merged = (p: Pair) =>
    merge(p).then(
      () => 'ok' as const,
      (e: unknown) => e,
    );

  // Not committed when the merge reads the live ones, so only the index tells it.
  it.runIf(testDialect === 'postgres')(
    'in the making: the start is done, and the merge is refused as that conflict, with nothing merged',
    async () => {
      const p = await pair();
      const { submission: there } = await start(p, p.other);
      const held = heldOpen(p.app, (tx) => start(p, p.keep, tx));
      await held.reached;
      const merging = merged(p);
      const blocked = await someoneBlocked(p.app);
      held.go();
      await held.done;
      expect(await merging).toMatchObject(CONFLICT(there.id));
      expect(blocked).toBe(true);
      expect(await attemptsOf(p, p.other)).toEqual([there.id]);
      expect(await attemptsOf(p, p.keep)).toHaveLength(1);
    },
  );

  it.runIf(testDialect === 'postgres').each([
    ['the other one', 'other'],
    ['the kept one', 'keep'],
  ] as const)(
    'in the making, and the one on %s given up before the merge reads again: 409, with nothing merged',
    async (_what, which) => {
      const p = await pair();
      const { submission: there } = await start(p, p.other);
      const give = AsyncResource.bind(() =>
        p.app.db
          .update(applicationSubmissions)
          .set({ status: 'abandoned' })
          .where(eq(applicationSubmissions.opportunityId, p[which]))
          .run(),
      );
      setRaceHook(async (point) => {
        if (point === 'opportunities.merge.indexMet') await give();
      });
      const held = heldOpen(p.app, (tx) => start(p, p.keep, tx));
      await held.reached;
      const merging = ended(merge(p));
      const blocked = await someoneBlocked(p.app);
      held.go();
      await held.done;
      const outcome = await merging;
      setRaceHook(undefined);
      expect(outcome).toBe('409 conflict');
      expect(blocked).toBe(true);
      expect(await attemptsOf(p, p.other)).toEqual([there.id]);
      expect(await attemptsOf(p, p.keep)).toHaveLength(1);
    },
  );

  it.runIf(testDialect === 'postgres')('made before it reads: the same', async () => {
    const p = await pair();
    const { submission: there } = await start(p, p.other);
    const pause = pauseAt(LOCKED);
    const merging = merged(p);
    await pause.reached;
    const started = await ended(start(p, p.keep));
    pause.release();
    expect(started).toBe('ok');
    expect(await merging).toMatchObject(CONFLICT(there.id));
    expect(await attemptsOf(p, p.other)).toEqual([there.id]);
    expect(await attemptsOf(p, p.keep)).toHaveLength(1);
  });

  it.each(['the kept one', 'the other one'])(
    'control: a finished one on %s is no conflict with a live one',
    async (which) => {
      const p = await pair();
      const [live, done] = which === 'the kept one' ? [p.other, p.keep] : [p.keep, p.other];
      const finished = await attemptOn(p, done);
      const { submission } = await start(p, live);
      expect(await merged(p)).toBe('ok');
      expect((await attemptsOf(p, p.keep)).sort()).toEqual([finished, submission.id].sort());
    },
  );

  it('after it: the start meets the one that was moved', async () => {
    const p = await pair();
    const { submission: there } = await start(p, p.other);
    expect(await merged(p)).toBe('ok');
    expect(await ended(start(p, p.keep))).toMatch(/^409 /);
    expect(await attemptsOf(p, p.keep)).toEqual([there.id]);
  });
});

type Write = [string, (p: Pair, exec?: Exec) => Promise<unknown>];
const WRITES: Write[] = [
  [
    'a resume sent for it',
    (p, exec) =>
      recordResumeSend((exec ?? p.app.db) as never, p.ctx, p.other, {
        resumeId: p.resumeId,
        sentVia: 'email',
      } as never),
  ],
  ['a resume made for it', (p, exec) => resumeOf(p, p.other, exec)],
  [
    'a resume moved to it',
    async (p, exec) => {
      const id = (await (exec ?? p.app.db)
        .select({ id: resumes.id })
        .from(resumes)
        .where(eq(resumes.opportunityId, p.keep))
        .get())!.id;
      return updateResume(exec ?? p.app.db, p.ctx, id, { opportunityId: p.other });
    },
  ],
  ['an application started on it', (p, exec) => start(p, p.other, exec)],
];
describe('beside a merge or a delete, what names the one that goes', () => {
  it.each(
    WRITES.flatMap(([what, write]) => [
      [`${what}, the merge first`, MERGING, merge, write] as const,
      [`${what}, the delete first`, DELETING, remove, write] as const,
    ]),
  )('%s: it waits, and is not found, with nothing written', async (_w, point, first, write) => {
    const p = await pair();
    await resumeOf(p, p.keep);
    const before = await written(p);
    expect(
      await beside(
        p,
        point,
        () => first(p),
        () => write(p),
      ),
    ).toEqual(['ok', GONE]);
    expect(await written(p)).toEqual(before);
  });

  /** How often a merge or a delete takes the locks of the attempts there are. */
  function countTries(): () => number {
    let tries = 0;
    setRaceHook((point) => {
      if (point === 'opportunities.attempts.locked') tries += 1;
      return Promise.resolve();
    });
    return () => {
      setRaceHook(undefined);
      return tries;
    };
  }

  it.each(
    WRITES.flatMap(([what, write]) => [
      [`${what} first, then a merge`, merge, write, what] as const,
      [`${what} first, then a delete`, remove, write, what] as const,
    ]),
  )('%s: it waits, and it goes with it', async (_w, going, write, what) => {
    const p = await pair();
    await resumeOf(p, p.keep);
    const held = heldOpen(p.app, (tx) => write(p, tx));
    await held.reached;
    const tries = countTries();
    const outcome = ended(going(p));
    const blocked = await someoneBlocked(p.app);
    held.go();
    await held.done;
    expect(await outcome).toBe('ok');
    expect(blocked).toBe(true);
    // An application was not there when the locks of the attempts were taken, and is when the row is
    // had: only once more has its lock. On SQLite the first look is after it.
    const started = what === 'an application started on it' && testDialect === 'postgres';
    expect(tries()).toBe(started ? 2 : 1);
    const after = await written(p);
    expect(JSON.stringify(after)).not.toContain(p.other);
    const n = [after.resumes.length, after.sends.length, after.attempts.length];
    const merged = going === merge;
    expect(n).toEqual(
      {
        'a resume sent for it': [2, merged ? 1 : 0, 0],
        'a resume made for it': [3, 0, 0],
        'a resume moved to it': [2, 0, 0],
        'an application started on it': [2, 0, merged ? 1 : 0],
      }[what],
    );
  });

  it.each(WRITES)('control: %s with nothing beside it', async (_w, write) => {
    const p = await pair();
    await resumeOf(p, p.keep);
    expect(await ended(write(p))).toBe('ok');
  });
  it.each(WRITES)('control: %s, when there is none', async (_w, write) => {
    const p = await pair();
    await resumeOf(p, p.keep);
    const before = await written(p);
    expect(await ended(write({ ...p, other: '01a00000-0000-7000-8000-000000000000' }))).toBe(GONE);
    expect(await written(p)).toEqual(before);
  });
});

describe.runIf(testDialect === 'postgres')(
  'a resume moved to it waits, and the merge is refused',
  () => {
    it.each(['in_review', 'final'] as const)(
      'a status saved meanwhile (%s) stays',
      async (status) => {
        const p = await pair();
        const id = await resumeOf(p, p.keep);
        await start(p, p.keep);
        await start(p, p.other);
        const pause = pauseAt(LOCKED);
        const merging = ended(merge(p));
        await pause.reached;
        const moving = ended(updateResume(p.app.db, p.ctx, id, { opportunityId: p.other }));
        const blocked = await someoneBlocked(p.app);
        await updateResume(p.app.db, p.ctx, id, { status, title: 'Renamed' });
        pause.release();
        expect([await merging, await moving]).toEqual(['409 live_submission_conflict', 'ok']);
        expect(blocked).toBe(true);
        const row = await p.app.db.select().from(resumes).where(eq(resumes.id, id)).get();
        expect(row).toMatchObject({ opportunityId: p.other, status, title: 'Renamed' });
      },
    );
  },
);

// The merge and the delete take the locks of the attempts there are, and then the user's. One made in
// between has a lock they don't hold.
describe('an attempt made after the locks on attempts were taken', () => {
  /** Holds the user's lock while `going` waits for it, and makes a handed-off attempt meanwhile. */
  async function madeMeanwhile(p: Pair, going: () => Promise<unknown>) {
    const held = heldOpen(p.app, (tx) => lockScope(tx, `user:${p.ctx.userId}`));
    await held.reached;
    const outcome = ended(going());
    expect(await someoneBlocked(p.app)).toBe(true);
    const step = await createNextStep(p.app.db, p.ctx, p.other, {
      action: 'Check whether it arrived',
    });
    const id = await attemptOn(p, p.other, step.id);
    return { held, outcome, id, stepId: step.id };
  }
  /** Parks the confirmation with the attempt's row; counts the tries of what goes from then on. */
  function parkConfirmation() {
    let tries = 0;
    let arrived!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => (arrived = r));
    const gate = new Promise<void>((r) => (release = r));
    setRaceHook(async (point) => {
      if (point === 'opportunities.attempts.locked') tries += 1;
      if (point !== 'submissions.confirm.updated') return;
      arrived();
      await gate;
    });
    return { reached, release, tries: () => tries };
  }
  /** As inbound mail confirms it: the attempt's lock, its row, then its step. */
  async function confirm(p: Pair, id: string) {
    const { id: commId } = await upsertInbound(p.app.db, p.ctx, 'gmail', {
      externalId: newId(),
      threadKey: newId(),
      from: 'no-reply@example.com',
      to: ['me@example.com'],
      subject: 'Received',
      snippet: 's',
      bodyText: 'b',
      sentAt: 1,
    });
    return withTransaction(p.app.db, async (tx) => {
      await lockScope(tx, `submission:${id}`);
      return await confirmFromEmail(tx, p.ctx, id, commId, [] as never, Date.now());
    });
  }

  // SQLite: nothing is made while the merge waits at the gate.
  it.runIf(testDialect === 'postgres').each([
    ['a merge', merge],
    ['a delete', remove],
  ])('%s beside its confirmation: both are done, and the attempt is whole', async (what, going) => {
    const p = await pair();
    const { held, outcome, id, stepId } = await madeMeanwhile(p, () => going(p));
    const parked = parkConfirmation();
    const confirming = ended(confirm(p, id));
    await parked.reached;
    held.go();
    await held.done;
    // The merge or the delete comes to wait for the confirmation.
    const blocked = await someoneBlocked(p.app);
    parked.release();
    expect([await confirming, await outcome]).toEqual(['ok', 'ok']);
    expect(blocked).toBe(true);
    // Started over with its lock, not gone on without it.
    expect(parked.tries()).toBe(1);
    const row = await p.app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, id))
      .get();
    const step = await p.app.db.select().from(nextSteps).where(eq(nextSteps.id, stepId)).get();
    if (what === 'a merge') {
      expect(row).toMatchObject({ opportunityId: p.keep, status: 'confirmed' });
      expect(step).toMatchObject({ opportunityId: p.keep, doneAt: expect.any(Number) });
    } else {
      expect([row, step]).toEqual([undefined, undefined]);
    }
  });

  it.runIf(testDialect === 'postgres').each([
    ['a merge', merge, 1, 'ok'],
    ['a merge', merge, 2, 'ok'],
    ['a merge', merge, 3, '409 conflict'],
    ['a delete', remove, 2, 'ok'],
    ['a delete', remove, 3, '409 conflict'],
  ] as const)('%s starts over for one made meanwhile (%#)', async (_w, going, made, expected) => {
    const p = await pair();
    const before = await p.app.db.select().from(opportunities).all();
    // Another request's, so not in the transaction the point is reached in.
    const make = AsyncResource.bind(() => attemptOn(p, p.other));
    let tries = 0;
    setRaceHook(async (point) => {
      if (point !== 'opportunities.attempts.locked') return;
      tries += 1;
      if (tries <= made) await make();
    });
    const outcome = await ended(going(p));
    setRaceHook(undefined);
    expect(outcome).toBe(expected);
    expect(tries).toBe(Math.min(made + 1, 3));
    const there = await attemptsOf(p, p.other);
    const kept = await attemptsOf(p, p.keep);
    if (expected !== 'ok') {
      expect([there.length, kept.length]).toEqual([made, 0]);
      expect(await p.app.db.select().from(opportunities).all()).toEqual(before);
    } else {
      expect([there.length, kept.length]).toEqual([0, going === merge ? made : 0]);
    }
  });

  it.runIf(testDialect === 'postgres')('one made on the kept one is not waited for', async () => {
    const p = await pair();
    const make = AsyncResource.bind(() => attemptOn(p, p.keep));
    let tries = 0;
    setRaceHook(async (point) => {
      if (point !== 'opportunities.attempts.locked') return;
      tries += 1;
      await make();
    });
    const outcome = await ended(merge(p));
    setRaceHook(undefined);
    expect([outcome, tries]).toEqual(['ok', 1]);
  });
});
