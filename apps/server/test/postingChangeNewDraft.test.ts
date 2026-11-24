// A save of a new posting link beside an application being started
// (https://github.com/bgoleno/opportun/issues/913): the draft is marked as one that was there before
// the save is. The save takes the live attempt's lock and then waits for the user's, so one started
// in between had no lock it knew of, and no mark. The overlaps are Postgres's; SQLite's write gate
// runs the two one after the other.
import { newId, type AtsJobRef, type NormalizedPosting } from '@opportun/core';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AsyncResource } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { lockScope, withTransaction } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import {
  applicationSubmissions,
  auditLog,
  companies,
  opportunities,
  resumes,
} from '../src/db/schema';
import { setRaceHook } from '../src/lib/racePoints';
import type { UserCtx } from '../src/repos/base';
import { confirm } from '../src/lib/postingReconcile';
import { createOpportunity, getOpportunity, updateOpportunity } from '../src/repos/opportunities';
import { attestSubmission } from '../src/repos/submissionOutcome';
import { insertResume } from '../src/repos/resumes';
import { createSubmissionDraft } from '../src/repos/submissions';
import { useApi } from './api';
import { queryAll, testDialect } from './db';
import { heldOpen, pauseAt, someoneBlocked } from './race';

const boot = useApi();
const OLD_URL = 'https://boards.greenhouse.io/examplecorp/jobs/1000001';
const NEW_URL = 'https://boards.greenhouse.io/examplecorp/jobs/2000002';
const REF: AtsJobRef = {
  kind: 'ats_greenhouse',
  org: 'examplecorp',
  externalId: '1000001',
  url: OLD_URL,
};

interface Scene {
  app: FastifyInstance;
  ctx: UserCtx;
  oppId: string;
  resumeId: string;
}
async function scene(): Promise<Scene> {
  const { app, a } = await boot();
  const ctx = { userId: a.userId, isAdmin: false };
  const opp = await createOpportunity(app.db, ctx, {
    companyName: 'Example Corp',
    title: 'Senior Example Engineer',
    sourceKind: 'manual',
  });
  await app.db
    .update(opportunities)
    .set({ stage: 'interested', atsJobRef: REF, postingUrl: OLD_URL, postingState: 'confirmed' })
    .where(eq(opportunities.id, opp.id))
    .run();
  const resume = await insertResume(app.db, ctx, {
    kind: 'base',
    title: 'Example Resume',
    store: 'local_file',
    docRef: `resumes/${newId()}.txt`,
    opportunityId: null,
    parentResumeId: null,
  });
  await app.db.update(resumes).set({ status: 'final' }).where(eq(resumes.id, resume.id)).run();
  // Transactions are parked on purpose.
  onSlowTransaction(() => undefined);
  return { app, ctx, oppId: opp.id, resumeId: resume.id };
}
const start = (s: Scene) =>
  createSubmissionDraft(s.app.db, s.ctx, s.oppId, {
    idempotencyKey: newId(),
    resumeId: s.resumeId,
  }).then((r) => r.submission.id);
const save = (s: Scene, patch: Parameters<typeof updateOpportunity>[3] = { postingUrl: NEW_URL }) =>
  updateOpportunity(s.app.db, s.ctx, s.oppId, patch);
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

/** The attempt as a posting change leaves it: a draft, marked, its destination kept; said once. */
async function expectMarked({ app, ctx }: Scene, id: string, times = 1): Promise<void> {
  const row = await app.db
    .select()
    .from(applicationSubmissions)
    .where(eq(applicationSubmissions.id, id))
    .get();
  expect(row).toMatchObject({
    status: 'draft',
    destinationUrl: OLD_URL,
    postingChangedAt: times === 0 ? null : expect.any(Number),
  });
  const [said] = await app.db
    .select({ n: count() })
    .from(auditLog)
    .where(and(eq(auditLog.userId, ctx.userId), eq(auditLog.event, 'submission.posting_changed')))
    .all();
  expect(said?.n).toBe(times);
}
const linkOf = async ({ app, oppId }: Scene) =>
  (await app.db.select().from(opportunities).where(eq(opportunities.id, oppId)).get())?.postingUrl;

/** The save waits for the user's lock; `meanwhile` is done; the lock is let go. */
async function whileItWaits<T>(
  s: Scene,
  meanwhile: () => Promise<T>,
  patch?: Parameters<typeof updateOpportunity>[3],
): Promise<{ saved: string; made: T }> {
  const held = heldOpen(s.app, (tx) => lockScope(tx, `user:${s.ctx.userId}`));
  await held.reached;
  const saving = ended(save(s, patch));
  const blocked = await someoneBlocked(s.app);
  const made = await meanwhile();
  held.go();
  await held.done;
  const saved = await saving;
  expect(blocked).toBe(true);
  return { saved, made };
}

it('control: a draft that was there before the save is marked', async () => {
  const s = await scene();
  const id = await start(s);
  await save(s);
  await expectMarked(s, id);
});

// SQLite: nothing is started while the save waits at the gate.
describe.runIf(testDialect === 'postgres')('started while the save waits for the lock', () => {
  it('is marked, and the link is saved', async () => {
    const s = await scene();
    const { saved, made } = await whileItWaits(s, () => start(s));
    expect(saved).toBe('ok');
    expect(await linkOf(s)).toBe(NEW_URL);
    await expectMarked(s, made);
  });

  it('after the one the save had locked was given up: the new one is marked, the old one is not', async () => {
    const s = await scene();
    const first = await start(s);
    const { saved, made } = await whileItWaits(s, async () => {
      await end(s, first);
      return start(s);
    });
    expect(saved).toBe('ok');
    await expectMarked(s, made);
    const old = await s.app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, first))
      .get();
    expect(old).toMatchObject({ status: 'abandoned', postingChangedAt: null });
  });

  it('the rest of the save is written once, with the company and the title', async () => {
    const s = await scene();
    const { saved, made } = await whileItWaits(s, () => start(s), {
      postingUrl: NEW_URL,
      companyName: 'Initech',
      title: 'Another Job',
    });
    expect(saved).toBe('ok');
    const row = await s.app.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, s.oppId))
      .get();
    expect(row).toMatchObject({ postingUrl: NEW_URL, title: 'Another Job' });
    await expectMarked(s, made);
  });

  it('control: by a save of the same link is not marked', async () => {
    const s = await scene();
    const { saved, made } = await whileItWaits(s, () => start(s), { postingUrl: OLD_URL });
    expect(saved).toBe('ok');
    await expectMarked(s, made, 0);
  });

  it('control: by a save without a link is not marked', async () => {
    const s = await scene();
    const { saved, made } = await whileItWaits(s, () => start(s), { title: 'Another Job' });
    expect(saved).toBe('ok');
    await expectMarked(s, made, 0);
  });
});

/** Every live draft that is on a link the opportunity has left is marked. */
async function expectNoneUnmarked({ app, oppId }: Scene): Promise<void> {
  const link = (await app.db.select().from(opportunities).where(eq(opportunities.id, oppId)).get())!
    .postingUrl;
  const live = await app.db
    .select()
    .from(applicationSubmissions)
    .where(
      and(
        eq(applicationSubmissions.opportunityId, oppId),
        inArray(applicationSubmissions.status, ['draft', 'reviewed']),
      ),
    )
    .all();
  for (const a of live) {
    if (a.destinationUrl !== link) expect(a.postingChangedAt).not.toBeNull();
  }
}
const attempts = async ({ app, oppId }: Scene) =>
  (
    await app.db
      .select({ id: applicationSubmissions.id })
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.opportunityId, oppId))
      .all()
  ).length;

describe('started beside a save that has the lock', () => {
  it.runIf(testDialect === 'postgres')('it waits for the save, and is refused', async () => {
    const s = await scene();
    const pause = pauseAt('opportunities.update.locked');
    const saving = ended(save(s));
    await pause.reached;
    const starting = ended(start(s));
    const blocked = await someoneBlocked(s.app);
    pause.release();
    expect([await saving, await starting]).toEqual(['ok', '409 posting_changed']);
    expect(blocked).toBe(true);
    expect(await attempts(s)).toBe(0);
    await expectNoneUnmarked(s);
  });

  // Not committed when the save looks, so it must be waited for before the look.
  it.runIf(testDialect === 'postgres')(
    'in the making when the save comes to the row: the save waits for it, and marks it',
    async () => {
      const s = await scene();
      let id: string | undefined;
      const held = heldOpen(s.app, async (tx) => {
        id = (
          await createSubmissionDraft(tx as never, s.ctx, s.oppId, {
            idempotencyKey: newId(),
            resumeId: s.resumeId,
          })
        ).submission.id;
      });
      await held.reached;
      const saving = ended(save(s));
      const blocked = await someoneBlocked(s.app);
      held.go();
      await held.done;
      expect(await saving).toBe('ok');
      expect(blocked).toBe(true);
      await expectMarked(s, id!);
      await expectNoneUnmarked(s);
    },
  );

  it('control: beside a save that changes no link it goes on', async () => {
    const s = await scene();
    const pause = pauseAt('opportunities.update.locked');
    const saving = ended(save(s, { title: 'Another Job' }));
    await pause.reached;
    const starting = ended(start(s));
    const blocked = await someoneBlocked(s.app);
    pause.release();
    expect([await saving, await starting]).toEqual(['ok', 'ok']);
    // SQLite runs one writing transaction at a time.
    expect(blocked).toBe(testDialect !== 'postgres');
    expect(await attempts(s)).toBe(1);
  });

  it.runIf(testDialect === 'postgres')(
    'the same link saved again takes no lock on the row before it writes',
    async () => {
      const s = await scene();
      const pause = pauseAt('opportunities.update.locked');
      const saving = ended(save(s, { postingUrl: OLD_URL }));
      await pause.reached;
      expect(await ended(start(s))).toBe('ok');
      pause.release();
      expect(await saving).toBe('ok');
    },
  );
});

// On both engines: nothing is held while a start reads what it pins.
describe('started from what was read before a save', () => {
  type Change = [
    string,
    Parameters<typeof updateOpportunity>[3] | 'ref' | 'state' | 'link alone',
    string,
  ];
  const CHANGES: Change[] = [
    ['the link', { postingUrl: NEW_URL }, '409 posting_changed'],
    ['no link', { postingUrl: null }, '409 posting_changed'],
    ['the link, with the identity as it was,', 'link alone', '409 posting_changed'],
    ['the identity', 'ref', '409 posting_changed'],
    ['the posting state', 'state', '409 posting_changed'],
    ['the title', { title: 'Another Job' }, 'ok'],
    ['the same link', { postingUrl: OLD_URL }, 'ok'],
    ['nothing', {}, 'ok'],
  ];
  it.each(CHANGES)('%s saved meanwhile', async (_w, change, expected) => {
    const s = await scene();
    const pause = pauseAt('submissions.create');
    const starting = ended(start(s));
    await pause.reached;
    if (change === 'link alone') {
      await s.app.db
        .update(opportunities)
        .set({ postingUrl: `${OLD_URL}?gh_src=x` })
        .where(eq(opportunities.id, s.oppId))
        .run();
    } else if (change === 'ref') {
      await s.app.db
        .update(opportunities)
        .set({ atsJobRef: { ...REF, externalId: '2000002' } })
        .where(eq(opportunities.id, s.oppId))
        .run();
    } else if (change === 'state') {
      await s.app.db
        .update(opportunities)
        .set({ postingState: 'needs_review' })
        .where(eq(opportunities.id, s.oppId))
        .run();
    } else {
      await save(s, change);
    }
    pause.release();
    expect(await starting).toBe(expected);
    expect(await attempts(s)).toBe(expected === 'ok' ? 1 : 0);
    if (change !== 'link alone') await expectNoneUnmarked(s);
  });

  it('says what happened; and the same request again starts afresh, on the posting there is now', async () => {
    const s = await scene();
    const key = newId();
    const again = () =>
      createSubmissionDraft(s.app.db, s.ctx, s.oppId, {
        idempotencyKey: key,
        resumeId: s.resumeId,
      });
    const pause = pauseAt('submissions.create');
    const starting = again().then(
      () => undefined,
      (e: unknown) => e,
    );
    await pause.reached;
    await save(s);
    pause.release();
    expect(await starting).toMatchObject({
      statusCode: 409,
      code: 'posting_changed',
      userMessage:
        "This opportunity's posting changed while you were starting the application. Check the posting, then start again.",
    });
    setRaceHook(undefined);
    const { submission, replayed } = await again();
    expect(replayed).toBe(false);
    expect(submission).toMatchObject({ destinationUrl: NEW_URL, postingChangedAt: null });
    expect((await again()).replayed).toBe(true);
    expect(await attempts(s)).toBe(1);
  });
});

describe.runIf(testDialect === 'postgres')('the save starts over', () => {
  /** Another request starts a draft at each of the save's first `n` tries, the last one given up. */
  function madeAtEach(s: Scene, n: number) {
    let tries = 0;
    let last: string | undefined;
    const make = AsyncResource.bind(async () => {
      if (last !== undefined) await end(s, last);
      last = await start(s);
    });
    setRaceHook(async (point) => {
      if (point !== 'opportunities.update.attemptLocked') return;
      tries += 1;
      if (tries <= n) await make();
    });
    return () => {
      setRaceHook(undefined);
      return { tries, last };
    };
  }

  it.each([
    [1, 'ok', 2],
    [2, 'ok', 3],
    [3, '409 conflict', 3],
  ])('%i made meanwhile: %s', async (n, expected, tries) => {
    const s = await scene();
    const before = await s.app.db.select().from(opportunities).all();
    const done = madeAtEach(s, n);
    const saved = await ended(
      save(s, { postingUrl: NEW_URL, companyName: 'Initech', title: 'Another Job' }),
    );
    const { tries: seen, last } = done();
    expect([saved, seen]).toEqual([expected, tries]);
    if (expected === 'ok') {
      expect(await linkOf(s)).toBe(NEW_URL);
      await expectMarked(s, last!);
      await expectNoneUnmarked(s);
    } else {
      // Nothing was written: not the row, a company, nor a mark.
      expect(await s.app.db.select().from(opportunities).all()).toEqual(before);
      expect(await s.app.db.select().from(companies).all()).toHaveLength(1);
      await expectMarked(s, last!, 0);
    }
  });

  it('one opened on the ATS meanwhile is left alone, and the save goes on', async () => {
    const s = await scene();
    const first = await start(s);
    const { saved } = await whileItWaits(s, () =>
      s.app.db
        .update(applicationSubmissions)
        .set({ status: 'handed_off', handedOffAt: 1 })
        .where(eq(applicationSubmissions.id, first))
        .run(),
    );
    expect(saved).toBe('ok');
    expect(await linkOf(s)).toBe(NEW_URL);
    const row = await s.app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, first))
      .get();
    expect(row).toMatchObject({ status: 'handed_off', postingChangedAt: null });
  });

  it('one made meanwhile that is opened on the ATS already does not start it over', async () => {
    const s = await scene();
    let tries = 0;
    const make = AsyncResource.bind(async () => {
      const id = await start(s);
      await s.app.db
        .update(applicationSubmissions)
        .set({ status: 'handed_off', handedOffAt: 1 })
        .where(eq(applicationSubmissions.id, id))
        .run();
    });
    setRaceHook(async (point) => {
      if (point !== 'opportunities.update.attemptLocked') return;
      tries += 1;
      if (tries === 1) await make();
    });
    const saved = await ended(save(s));
    setRaceHook(undefined);
    expect([saved, tries]).toEqual(['ok', 1]);
    expect(await linkOf(s)).toBe(NEW_URL);
  });

  it('in its caller’s transaction it does so from its savepoint, which gives its locks back', async () => {
    const s = await scene();
    // The locks held when a try has taken the live attempt's: the user's, of the try before, is not.
    const held: number[] = [];
    const locks = AsyncResource.bind(async () => {
      const [row] = await queryAll<{ n: number }>(
        s.app,
        `SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND granted
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      held.push(row!.n);
    });
    let last: string | undefined;
    const make = AsyncResource.bind(async () => {
      last = await start(s);
    });
    setRaceHook(async (point) => {
      if (point !== 'opportunities.update.attemptLocked') return;
      await locks();
      if (held.length === 1) await make();
    });
    const saved = await ended(
      withTransaction(s.app.db, async (tx) => {
        await tx
          .update(opportunities)
          .set({ compNote: 'the caller’s own' })
          .where(eq(opportunities.id, s.oppId))
          .run();
        return updateOpportunity(tx as never, s.ctx, s.oppId, { postingUrl: NEW_URL });
      }),
    );
    setRaceHook(undefined);
    expect(saved).toBe('ok');
    // None at the first try (there was no attempt), and the new attempt's alone at the second.
    expect(held).toEqual([0, 1]);
    const row = await s.app.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, s.oppId))
      .get();
    expect(row).toMatchObject({ postingUrl: NEW_URL, compNote: 'the caller’s own' });
    await expectMarked(s, last!);
  });
});

describe.runIf(testDialect === 'postgres')('what a save that gives up answers its caller', () => {
  it('the board check fails as for any error, and writes nothing without the location', async () => {
    const s = await scene();
    let tries = 0;
    let last: string | undefined;
    const make = AsyncResource.bind(async () => {
      if (last !== undefined) await end(s, last);
      last = await start(s);
    });
    setRaceHook(async (point) => {
      if (point !== 'opportunities.update.attemptLocked') return;
      tries += 1;
      if (tries <= 3) await make();
    });
    const before = await s.app.db.select().from(opportunities).all();
    const outcome = await ended(
      confirm(s.app.db, s.ctx, await getOpportunity(s.app.db, s.ctx, s.oppId), {
        company: 'Example Corp',
        title: 'Senior Example Engineer',
        descriptionMd: 'The new posting.',
        postingUrl: NEW_URL,
        location: 'Remote',
      } as NormalizedPosting),
    );
    setRaceHook(undefined);
    expect([outcome, tries]).toEqual(['409 conflict', 3]);
    expect(await s.app.db.select().from(opportunities).all()).toEqual(before);
  });
});

// What holds the opportunity's row by a foreign key and goes on to write it: the save waits for it.
describe.runIf(testDialect === 'postgres')('beside "I submitted it" with its stage move', () => {
  async function opened(s: Scene): Promise<string> {
    const id = await start(s);
    await s.app.db
      .update(applicationSubmissions)
      .set({ status: 'handed_off', handedOffAt: 1 })
      .where(eq(applicationSubmissions.id, id))
      .run();
    return id;
  }
  const attest = (s: Scene, id: string) =>
    attestSubmission(s.app.db, s.ctx, id, { moveToApplied: true });

  it.each(['submissions.attest.updated', 'submissions.attest.sendRecorded'])(
    'that first (%s): the save waits, and both are done',
    async (point) => {
      const s = await scene();
      const id = await opened(s);
      const pause = pauseAt(point);
      const attesting = ended(attest(s, id));
      await pause.reached;
      const saving = ended(save(s));
      const blocked = await someoneBlocked(s.app);
      pause.release();
      expect([await attesting, await saving]).toEqual(['ok', 'ok']);
      expect(blocked).toBe(true);
      const row = await s.app.db
        .select()
        .from(opportunities)
        .where(eq(opportunities.id, s.oppId))
        .get();
      expect(row).toMatchObject({ postingUrl: NEW_URL, stage: 'applied' });
    },
  );

  it('the save first: that waits, and both are done', async () => {
    const s = await scene();
    const id = await opened(s);
    const pause = pauseAt('opportunities.update.locked');
    const saving = ended(save(s));
    await pause.reached;
    const attesting = ended(attest(s, id));
    const blocked = await someoneBlocked(s.app);
    pause.release();
    expect([await saving, await attesting]).toEqual(['ok', 'ok']);
    expect(blocked).toBe(true);
    const row = await s.app.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, s.oppId))
      .get();
    expect(row).toMatchObject({ postingUrl: NEW_URL, stage: 'applied' });
  });
});
