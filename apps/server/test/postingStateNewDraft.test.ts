// The posting state and the one-time backfill write an opportunity's ATS identity beside an application
// being started, or moved to it by a merge (https://github.com/bgoleno/opportun/issues/961): the draft is
// marked as one that was there before is, or the start refused, as beside a save of the link
// (postingChangeNewDraft.test.ts). The overlaps are Postgres's; SQLite's write gate runs the two one
// after the other.
import { newId, type AtsJobRef } from '@opportun/core';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AsyncResource } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { lockScope, withTransaction } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import { applicationSubmissions, auditLog, opportunities, resumes } from '../src/db/schema';
import { backfillAtsJobRefs } from '../src/jobs/atsJobRefBackfill';
import { setRaceHook } from '../src/lib/racePoints';
import type { UserCtx } from '../src/repos/base';
import {
  createOpportunity,
  deleteOpportunity,
  mergeOpportunities,
  setPostingState,
} from '../src/repos/opportunities';
import { attestSubmission } from '../src/repos/submissionOutcome';
import { insertResume } from '../src/repos/resumes';
import { createSubmissionDraft } from '../src/repos/submissions';
import { useApi } from './api';
import { testDialect } from './db';
import { heldOpen, pauseAt, someoneBlocked } from './race';

const boot = useApi();
const refOf = (externalId: string): AtsJobRef => ({
  kind: 'ats_greenhouse',
  org: 'examplecorp',
  externalId,
  url: `https://boards.greenhouse.io/examplecorp/jobs/${externalId}`,
});
/** The job that a draft is started on, and the one the writer says it is. */
const OLD = refOf('1000001');
const NEW = refOf('2000002');

interface Scene {
  app: FastifyInstance;
  ctx: UserCtx;
  otherUserId: string;
  oppId: string;
  resumeId: string;
}
async function opportunity(app: FastifyInstance, ctx: UserCtx, title: string): Promise<string> {
  const opp = await createOpportunity(app.db, ctx, {
    companyName: 'Example Corp',
    title,
    sourceKind: 'manual',
  });
  // The link says the new job already, which is what the backfill goes by.
  await app.db
    .update(opportunities)
    .set({
      stage: 'interested',
      atsJobRef: OLD,
      postingUrl: NEW.url,
      postingState: 'confirmed',
      updatedAt: 1,
    })
    .where(eq(opportunities.id, opp.id))
    .run();
  return opp.id;
}
async function scene(): Promise<Scene> {
  const { app, a, b } = await boot();
  const ctx = { userId: a.userId, isAdmin: false };
  const oppId = await opportunity(app, ctx, 'Senior Example Engineer');
  const resume = await insertResume(app.db, ctx, {
    kind: 'base',
    title: 'Example Resume',
    store: 'local_file',
    docRef: `resumes/${newId()}.txt`,
    opportunityId: null,
    parentResumeId: null,
  });
  await app.db.update(resumes).set({ status: 'final' }).where(eq(resumes.id, resume.id)).run();
  onSlowTransaction(() => undefined); // parked on purpose
  return { app, ctx, otherUserId: b.userId, oppId, resumeId: resume.id };
}
const start = (s: Scene, oppId = s.oppId, exec: FastifyInstance['db'] = s.app.db) =>
  createSubmissionDraft(exec, s.ctx, oppId, { idempotencyKey: newId(), resumeId: s.resumeId }).then(
    (r) => r.submission.id,
  );
const ended = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: unknown) => {
      const err = e as { statusCode?: number; code?: string };
      return `${err.statusCode ?? 500} ${err.code ?? String(e)}`;
    },
  );
const end = (s: Scene, id: string) =>
  s.app.db
    .update(applicationSubmissions)
    .set({ status: 'abandoned' })
    .where(eq(applicationSubmissions.id, id))
    .run();
const rowOf = async (s: Scene, id: string) =>
  (await s.app.db
    .select()
    .from(applicationSubmissions)
    .where(eq(applicationSubmissions.id, id))
    .get())!;
const identityOf = async (s: Scene, id = s.oppId) =>
  (await s.app.db.select().from(opportunities).where(eq(opportunities.id, id)).get())?.atsJobRef
    ?.externalId;
const marks = async (s: Scene) => {
  const [said] = await s.app.db
    .select({ n: count() })
    .from(auditLog)
    .where(and(eq(auditLog.userId, s.ctx.userId), eq(auditLog.event, 'submission.posting_changed')))
    .all();
  return said?.n;
};
/** Every live draft that is on another job than its opportunity's is marked. */
async function expectNoneUnmarked(s: Scene): Promise<void> {
  const live = await s.app.db
    .select()
    .from(applicationSubmissions)
    .where(
      and(
        eq(applicationSubmissions.userId, s.ctx.userId),
        inArray(applicationSubmissions.status, ['draft', 'reviewed']),
      ),
    )
    .all();
  for (const a of live) {
    if (a.atsExternalId !== (await identityOf(s, a.opportunityId)))
      expect(a.postingChangedAt).not.toBeNull();
  }
}
const expectMarked = async (s: Scene, id: string): Promise<void> => {
  expect(await rowOf(s, id)).toMatchObject({
    status: 'draft',
    destinationUrl: OLD.url,
    postingChangedAt: expect.any(Number),
  });
  expect(await marks(s)).toBe(1);
};

const WRITERS = {
  'the posting state': {
    write: (s: Scene, exec: FastifyInstance['db'] = s.app.db) =>
      setPostingState(exec, s.ctx, s.oppId, {
        postingState: 'confirmed',
        postingStateDetail: null,
        atsJobRef: NEW,
      }) as Promise<unknown>,
    looked: 'opportunities.postingState.attemptLocked',
    locked: 'opportunities.postingState.locked',
    gone: '404 not_found',
  },
  'the backfill': {
    write: (s: Scene, exec: FastifyInstance['db'] = s.app.db) =>
      backfillAtsJobRefs(exec, s.ctx) as Promise<unknown>,
    looked: 'opportunities.backfillAtsJobRef.attemptLocked',
    locked: 'opportunities.backfillAtsJobRef.locked',
    gone: 'ok',
  },
} as const;
const NAMES = Object.keys(WRITERS) as (keyof typeof WRITERS)[];

describe.each(NAMES)('%s', (name) => {
  const { write, looked, locked, gone } = WRITERS[name];

  it('control: a draft that was there before is marked', async () => {
    const s = await scene();
    const id = await start(s);
    await write(s);
    expect(await identityOf(s)).toBe(NEW.externalId);
    await expectMarked(s, id);
  });

  describe.runIf(testDialect === 'postgres')('a draft started meanwhile', () => {
    it('between its look for one and its write: marked', async () => {
      const s = await scene();
      const pause = pauseAt(looked);
      const writing = ended(write(s));
      await pause.reached;
      const id = await start(s);
      pause.release();
      expect(await writing).toBe('ok');
      expect(await identityOf(s)).toBe(NEW.externalId);
      await expectMarked(s, id);
    });

    it('after the one it had locked was given up: the new one is marked, the old one is not', async () => {
      const s = await scene();
      const first = await start(s);
      const pause = pauseAt(looked);
      const writing = ended(write(s));
      await pause.reached;
      await end(s, first);
      const id = await start(s);
      pause.release();
      expect(await writing).toBe('ok');
      await expectMarked(s, id);
      expect(await rowOf(s, first)).toMatchObject({ status: 'abandoned', postingChangedAt: null });
    });

    it('in the making when it comes: waited for, and marked', async () => {
      const s = await scene();
      let id: string | undefined;
      const held = heldOpen(s.app, async (tx) => {
        id = await start(s, s.oppId, tx as never);
      });
      await held.reached;
      const writing = ended(write(s));
      const blocked = await someoneBlocked(s.app);
      held.go();
      await held.done;
      expect(await writing).toBe('ok');
      expect(await identityOf(s)).toBe(NEW.externalId);
      await expectMarked(s, id!);
      expect(blocked).toBe(true);
    });

    it('once it has the row: the start waits, and is refused', async () => {
      const s = await scene();
      const pause = pauseAt(locked);
      const writing = ended(write(s));
      await pause.reached;
      const starting = ended(start(s));
      const blocked = await someoneBlocked(s.app);
      pause.release();
      expect([await writing, await starting]).toEqual(['ok', '409 posting_changed']);
      expect(blocked).toBe(true);
      await expectNoneUnmarked(s);
    });
  });

  describe.runIf(testDialect === 'postgres')('it starts over', () => {
    /** Another request starts a draft at each of its first `n` tries, the last one given up. */
    it.each([
      [1, 'ok', 2],
      [2, 'ok', 3],
      [3, '409 conflict', 3],
    ])('%i made meanwhile: %s', async (n, expected, tries) => {
      const s = await scene();
      const before = await s.app.db.select().from(opportunities).all();
      let seen = 0;
      let last: string | undefined;
      const make = AsyncResource.bind(async () => {
        if (last !== undefined) await end(s, last);
        last = await start(s);
      });
      setRaceHook(async (point) => {
        if (point !== looked) return;
        seen += 1;
        if (seen <= n) await make();
      });
      const outcome = await ended(write(s));
      setRaceHook(undefined);
      expect([outcome, seen]).toEqual([expected, tries]);
      if (expected === 'ok') {
        expect(await identityOf(s)).toBe(NEW.externalId);
        await expectMarked(s, last!);
      } else {
        expect(await s.app.db.select().from(opportunities).all()).toEqual(before);
        expect((await rowOf(s, last!)).postingChangedAt).toBeNull();
        expect(await marks(s)).toBe(0);
      }
    });

    it('not for the one it had locked, given up meanwhile with none after it', async () => {
      const s = await scene();
      const first = await start(s);
      const pause = pauseAt(looked);
      const writing = ended(write(s));
      await pause.reached;
      await end(s, first);
      pause.release();
      expect(await writing).toBe('ok');
      expect(pause.arrived()).toBe(1);
      expect(await identityOf(s)).toBe(NEW.externalId);
      expect(await rowOf(s, first)).toMatchObject({ status: 'abandoned', postingChangedAt: null });
    });

    it('not for one opened on the ATS meanwhile, which is left alone', async () => {
      const s = await scene();
      const pause = pauseAt(looked);
      const writing = ended(write(s));
      await pause.reached;
      const id = await start(s);
      await s.app.db
        .update(applicationSubmissions)
        .set({ status: 'handed_off', handedOffAt: 1 })
        .where(eq(applicationSubmissions.id, id))
        .run();
      pause.release();
      expect(await writing).toBe('ok');
      expect(await identityOf(s)).toBe(NEW.externalId);
      expect(await rowOf(s, id)).toMatchObject({ status: 'handed_off', postingChangedAt: null });
      expect(pause.arrived()).toBe(1);
    });
  });

  // The attempt's lock comes before the row (submissionScope): with the row first, each would wait here.
  it.runIf(testDialect === 'postgres')(
    'beside a request that has the attempt’s lock and goes on to the opportunity',
    async () => {
      const s = await scene();
      const id = await start(s);
      let go!: () => void;
      const gate = new Promise<void>((r) => (go = r));
      let reached!: () => void;
      const has = new Promise<void>((r) => (reached = r));
      const other = ended(
        withTransaction(s.app.db, async (tx) => {
          await lockScope(tx, `submission:${id}`);
          reached();
          await gate;
          await tx
            .update(opportunities)
            .set({ compNote: 'its own' })
            .where(eq(opportunities.id, s.oppId))
            .run();
        }),
      );
      await has;
      const writing = ended(write(s));
      const blocked = await someoneBlocked(s.app);
      go();
      expect([await other, await writing]).toEqual(['ok', 'ok']);
      expect(blocked).toBe(true);
      const [row] = await s.app.db.select().from(opportunities).all();
      expect(row).toMatchObject({ compNote: 'its own', atsJobRef: { externalId: NEW.externalId } });
      await expectMarked(s, id);
    },
  );

  it.runIf(testDialect === 'postgres')('the opportunity deleted while it waits', async () => {
    const s = await scene();
    const pause = pauseAt(looked);
    const writing = ended(write(s));
    await pause.reached;
    await deleteOpportunity(s.app.db, s.ctx, s.oppId);
    pause.release();
    expect(await writing).toBe(gone);
    expect(await s.app.db.select().from(opportunities).all()).toEqual([]);
  });

  it('another user’s is as it was', async () => {
    const s = await scene();
    const id = await start(s);
    const other: UserCtx = { userId: s.otherUserId, isAdmin: false };
    expect(await ended(write({ ...s, ctx: other }))).toBe(gone);
    expect(await identityOf(s)).toBe(OLD.externalId);
    expect((await rowOf(s, id)).postingChangedAt).toBeNull();
  });

  // What holds the row by a foreign key and goes on to write it: it waits for that, and that for it.
  describe.runIf(testDialect === 'postgres')('beside "I submitted it" with its stage move', () => {
    const opened = async (s: Scene) => {
      const id = await start(s);
      await s.app.db
        .update(applicationSubmissions)
        .set({ status: 'handed_off', handedOffAt: 1 })
        .where(eq(applicationSubmissions.id, id))
        .run();
      return id;
    };
    const both = async (
      s: Scene,
      point: string,
      first: () => Promise<unknown>,
      then: () => Promise<unknown>,
    ) => {
      const pause = pauseAt(point);
      const one = ended(first());
      await pause.reached;
      const two = ended(then());
      const blocked = await someoneBlocked(s.app);
      pause.release();
      expect([await one, await two]).toEqual(['ok', 'ok']);
      expect(blocked).toBe(true);
      const [row] = await s.app.db.select().from(opportunities).all();
      expect(row).toMatchObject({ stage: 'applied' });
    };

    it.each(['submissions.attest.updated', 'submissions.attest.sendRecorded'])(
      'that first (%s)',
      async (point) => {
        const s = await scene();
        const id = await opened(s);
        await both(
          s,
          point,
          () => attestSubmission(s.app.db, s.ctx, id, { moveToApplied: true }),
          () => write(s),
        );
      },
    );

    it('it first', async () => {
      const s = await scene();
      const id = await opened(s);
      await both(
        s,
        locked,
        () => write(s),
        () => attestSubmission(s.app.db, s.ctx, id, { moveToApplied: true }),
      );
      expect(await identityOf(s)).toBe(NEW.externalId);
    });
  });

  describe('a draft moved to it by a merge', () => {
    const merge = (s: Scene, other: string) =>
      mergeOpportunities(s.app.db, s.ctx, s.oppId, other) as Promise<unknown>;
    const moved = async () => {
      const s = await scene();
      const other = await opportunity(s.app, s.ctx, 'Another Example Engineer');
      return { s, other, id: await start(s, other) };
    };

    it.runIf(testDialect === 'postgres')('between its look and its write', async () => {
      const { s, other, id } = await moved();
      const pause = pauseAt(looked);
      const writing = ended(write(s));
      await pause.reached;
      expect(await ended(merge(s, other))).toBe('ok');
      pause.release();
      expect(await writing).toBe('ok');
      expect((await rowOf(s, id)).opportunityId).toBe(s.oppId);
      await expectNoneUnmarked(s);
    });

    it('the merge has the row first', async () => {
      const { s, other, id } = await moved();
      const pause = pauseAt('opportunities.merge.locked');
      const merging = ended(merge(s, other));
      await pause.reached;
      const writing = ended(write(s));
      await someoneBlocked(s.app);
      pause.release();
      expect([await merging, await writing]).toEqual(['ok', 'ok']);
      expect((await rowOf(s, id)).opportunityId).toBe(s.oppId);
      await expectNoneUnmarked(s);
    });

    it.runIf(testDialect === 'postgres')('it has the row first', async () => {
      const { s, other, id } = await moved();
      const pause = pauseAt(locked);
      const writing = ended(write(s));
      await pause.reached;
      const merging = ended(merge(s, other));
      const blocked = await someoneBlocked(s.app);
      pause.release();
      expect([await writing, await merging]).toEqual(['ok', 'ok']);
      expect(blocked).toBe(true);
      expect((await rowOf(s, id)).opportunityId).toBe(s.oppId);
      expect(await identityOf(s)).toBe(NEW.externalId);
      await expectNoneUnmarked(s);
    });

    it('control: one after the other', async () => {
      for (const first of ['merge', 'write']) {
        const { s, other, id } = await moved();
        if (first === 'merge') await merge(s, other);
        await write(s);
        if (first === 'write') await merge(s, other);
        expect((await rowOf(s, id)).opportunityId).toBe(s.oppId);
        await expectNoneUnmarked(s);
      }
    });
  });
});

// What it changes is known from the row as it then is, not as it was read.
it.runIf(testDialect === 'postgres')(
  'the posting state: the identity is another by then, and a draft was started on it',
  async () => {
    const s = await scene();
    const set = (atsJobRef: AtsJobRef) =>
      s.app.db.update(opportunities).set({ atsJobRef }).where(eq(opportunities.id, s.oppId)).run();
    await set(NEW);
    const pause = pauseAt('opportunities.postingState.attemptLocked');
    const writing = ended(WRITERS['the posting state'].write(s));
    await pause.reached;
    await set(OLD);
    const id = await start(s);
    pause.release();
    expect(await writing).toBe('ok');
    expect(await identityOf(s)).toBe(NEW.externalId);
    await expectMarked(s, id);
  },
);

describe('the posting state, of the identity as it is', () => {
  const { looked } = WRITERS['the posting state'];
  const setTo = (s: Scene, ref: AtsJobRef) =>
    setPostingState(s.app.db, s.ctx, s.oppId, {
      postingState: 'confirmed',
      postingStateDetail: null,
      atsJobRef: ref,
    });
  const identity = (s: Scene, atsJobRef: AtsJobRef) =>
    s.app.db.update(opportunities).set({ atsJobRef }).where(eq(opportunities.id, s.oppId)).run();

  it.runIf(testDialect === 'postgres')('the same, a draft started meanwhile: no mark', async () => {
    const s = await scene();
    const pause = pauseAt(looked);
    const writing = ended(setTo(s, OLD));
    await pause.reached;
    const id = await start(s);
    pause.release();
    expect(await writing).toBe('ok');
    expect(pause.arrived()).toBe(1);
    expect((await rowOf(s, id)).postingChangedAt).toBeNull();
    expect(await marks(s)).toBe(0);
  });

  it.runIf(testDialect === 'postgres')(
    'the same, a draft in the making: both are done',
    async () => {
      const s = await scene();
      let id: string | undefined;
      const held = heldOpen(s.app, async (tx) => {
        id = await start(s, s.oppId, tx as never);
      });
      await held.reached;
      const writing = ended(setTo(s, OLD));
      const blocked = await someoneBlocked(s.app);
      held.go();
      await held.done;
      expect(await writing).toBe('ok');
      expect(blocked).toBe(true);
      expect((await rowOf(s, id!)).postingChangedAt).toBeNull();
    },
  );

  it.runIf(testDialect === 'postgres')(
    'changed meanwhile to the one it writes: no mark',
    async () => {
      const s = await scene();
      const pause = pauseAt(looked);
      const writing = ended(setTo(s, NEW));
      await pause.reached;
      await identity(s, NEW);
      const id = await start(s);
      pause.release();
      expect(await writing).toBe('ok');
      expect(await rowOf(s, id)).toMatchObject({ destinationUrl: NEW.url, postingChangedAt: null });
      expect(await marks(s)).toBe(0);
    },
  );

  it('with no identity in it, it takes no lock and changes none', async () => {
    const s = await scene();
    const id = await start(s);
    const pause = pauseAt(looked);
    const written = setPostingState(s.app.db, s.ctx, s.oppId, {
      postingState: 'needs_review',
      postingStateDetail: 'none_found',
    });
    expect(await ended(written)).toBe('ok');
    expect(pause.arrived()).toBe(0);
    pause.reached.catch(() => undefined);
    expect(await identityOf(s)).toBe(OLD.externalId);
    expect((await rowOf(s, id)).postingChangedAt).toBeNull();
  });
});

describe.runIf(testDialect === 'postgres')('the backfill, of the row as it was read', () => {
  const { write, looked } = WRITERS['the backfill'];
  it.each([
    ['the link', { postingUrl: 'https://example.com/mine' }],
    ['anything else', { updatedAt: 2 }],
  ])('%s written meanwhile: nothing is', async (_what, patch) => {
    const s = await scene();
    const id = await start(s);
    const pause = pauseAt(looked);
    const writing = write(s);
    await pause.reached;
    await s.app.db.update(opportunities).set(patch).where(eq(opportunities.id, s.oppId)).run();
    pause.release();
    expect(await writing).toEqual({ read: 1, set: 0, changed: 0, cleared: 0 });
    expect(await identityOf(s)).toBe(OLD.externalId);
    expect((await rowOf(s, id)).postingChangedAt).toBeNull();
  });
});
