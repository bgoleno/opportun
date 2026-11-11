// One user's company adds, follows, re-checks or probes never hold up another user's ATS detection
// beyond a small bound, and nothing is refused (https://github.com/bgoleno/opportun/issues/321; tl's
// design on https://github.com/bgoleno/opportun/issues/321#issuecomment-6767502359, as changed on
// https://github.com/bgoleno/opportun/pull/330#issuecomment-6768955332). A user's first
// VENDOR_CHECK_CAP checks go just ahead of every other user's waiting ones; the rest go to the back
// of the line. No job runs here: claimNextJob is the runner's own claim, and the jobs are only
// claimed to see their order.
import { newId } from '@opportun/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { claimNextJob } from '../src/db/dialect';
import { jobs } from '../src/db/schema';
import { ATS_DETECT_KIND, atsDetectDedupeKey, enqueueAtsDetect } from '../src/jobs/atsDetect';
import { BOARD_PROBE_KIND, enqueueBoardProbe } from '../src/jobs/companyBoardProbe';
import { NETWORK_PROBE_KIND } from '../src/jobs/networkBoardProbe';
import {
  VENDOR_CHECK_CAP,
  VENDOR_CHECK_KINDS,
  VENDOR_CHECK_WINDOW_MS,
} from '../src/jobs/vendorCheckQueue';
import type { UserCtx } from '../src/repos/base';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
const HOUR = 3_600_000;

/** The vendor-check jobs claimed, in the runner's order, as of `now`, by whom. */
async function claimedInOrder(app: FastifyInstance, now = Date.now() + 1000) {
  const claimed: { id: string; userId: string | null }[] = [];
  for (;;) {
    const job = await claimNextJob(app.db, 'test-worker', now);
    if (job === undefined) return claimed;
    if ((VENDOR_CHECK_KINDS as readonly string[]).includes(job.kind)) {
      claimed.push({ id: job.id, userId: job.userId });
    }
  }
}

/** Who was claimed, in order, as 'a' or 'b'. */
const whose = (order: { userId: string | null }[], a: TestClient) =>
  order.map((j) => (j.userId === a.userId ? 'a' : 'b'));

const times = (n: number, who: string) => Array.from({ length: n }, () => who);

/** The user's vendor-check jobs, with when each is due. */
const dueTimes = async (app: FastifyInstance, c: TestClient) =>
  (
    await app.db
      .select({ runAt: jobs.runAt })
      .from(jobs)
      .where(and(eq(jobs.userId, c.userId), inArray(jobs.kind, [...VENDOR_CHECK_KINDS])))
      .all()
  ).map((r) => r.runAt);

/** Clears the jobs boot() queued for itself, so the claims below see only these. */
const onlyTheseJobs = (app: FastifyInstance) => app.db.delete(jobs).run();

const follows = async (app: FastifyInstance, c: TestClient, n: number) => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await enqueueAtsDetect(app.db, ctxOf(c), newId()));
  return ids;
};

describe('#321: a user alone is not slowed', () => {
  it('the cap is 3, and the kinds are detection, the board probe and the network probe', () => {
    expect(VENDOR_CHECK_CAP).toBe(3);
    expect([...VENDOR_CHECK_KINDS].sort()).toEqual(
      [ATS_DETECT_KIND, BOARD_PROBE_KIND, NETWORK_PROBE_KIND].sort(),
    );
  });

  it("qa's 30 follows by one user, and no one else waiting: every one is due at once, as before", async () => {
    const { app, a } = await boot();
    await onlyTheseJobs(app);
    await follows(app, a, 30);
    const due = await dueTimes(app, a);
    expect(due).toHaveLength(30);
    expect(due.every((t) => t <= Date.now())).toBe(true);
  });
});

describe("#321: another user's first checks go ahead of a backlog", () => {
  it('A follows 30, then B follows 1: B is claimed within the first 3', async () => {
    const { app, a, b } = await boot();
    await onlyTheseJobs(app);
    await follows(app, a, 30);
    const [theirs] = await follows(app, b, 1);
    const order = await claimedInOrder(app);
    const at = order.findIndex((j) => j.id === theirs);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(VENDOR_CHECK_CAP);
  });

  it("B's fourth goes to the back of the line, behind A's backlog", async () => {
    const { app, a, b } = await boot();
    await onlyTheseJobs(app);
    await follows(app, a, 10);
    await follows(app, b, VENDOR_CHECK_CAP + 1);
    expect(whose(await claimedInOrder(app), a)).toEqual([
      ...times(VENDOR_CHECK_CAP, 'b'),
      ...times(10, 'a'),
      'b',
    ]);
  });

  it("a user's own first checks keep the order they came in", async () => {
    const { app, a, b } = await boot();
    await onlyTheseJobs(app);
    await follows(app, a, 5);
    const mine = await follows(app, b, VENDOR_CHECK_CAP);
    expect((await claimedInOrder(app)).slice(0, VENDOR_CHECK_CAP).map((j) => j.id)).toEqual(mine);
  });

  it('a check placed ahead of a backlog long past due is still claimed first', async () => {
    const { app, a, b } = await boot();
    await onlyTheseJobs(app);
    await follows(app, a, 5);
    // A's backlog has waited an hour already (the runner was busy, or down).
    await app.db
      .update(jobs)
      .set({ runAt: Date.now() - HOUR })
      .where(eq(jobs.userId, a.userId))
      .run();
    const [theirs] = await follows(app, b, 1);
    expect((await claimedInOrder(app)).at(0)?.id).toBe(theirs);
  });

  it("running checks count toward the user's cap", async () => {
    const { app, a, b } = await boot();
    await onlyTheseJobs(app);
    await follows(app, b, VENDOR_CHECK_CAP);
    // B's three are claimed: running, not pending.
    for (let i = 0; i < VENDOR_CHECK_CAP; i++) {
      const claimed = await claimNextJob(app.db, 'test-worker', Date.now() + 1000);
      expect(claimed?.userId).toBe(b.userId);
    }
    await follows(app, a, 5);
    await follows(app, b, 1);
    expect(whose(await claimedInOrder(app), a)).toEqual([...times(5, 'a'), 'b']);
  });

  it('board probes count toward the same cap as detections', async () => {
    const { app, a, b } = await boot();
    await onlyTheseJobs(app);
    await follows(app, a, 5);
    for (let i = 0; i < VENDOR_CHECK_CAP; i++) await enqueueBoardProbe(app.db, ctxOf(b), newId());
    await follows(app, b, 1);
    expect(whose(await claimedInOrder(app), a)).toEqual([
      ...times(VENDOR_CHECK_CAP, 'b'),
      ...times(5, 'a'),
      'b',
    ]);
  });

  it('a company already queued is not queued twice, and keeps its place', async () => {
    const { app, a } = await boot();
    await onlyTheseJobs(app);
    await follows(app, a, VENDOR_CHECK_CAP + 1);
    const companyId = newId();
    const first = await enqueueAtsDetect(app.db, ctxOf(a), companyId);
    const again = await enqueueAtsDetect(app.db, ctxOf(a), companyId);
    expect(again).toBe(first);
    const rows = await app.db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, atsDetectDedupeKey(companyId)))
      .all();
    expect(rows).toHaveLength(1);
  });
});

// sec on https://github.com/bgoleno/opportun/pull/330#issuecomment-6769528639 (B2): a user who queues
// one more check each time one of theirs finishes never reaches the cap of pending or running, and
// was placed ahead every time, so another user's backlog was never reached.
describe('#321: a user who keeps queueing one at a time', () => {
  it("cannot keep another user's backlog waiting: it gets a claim within a few", async () => {
    const { app, a, b } = await boot();
    await onlyTheseJobs(app);
    await follows(app, a, 10);
    // B keeps two checks in flight: each time one of B's finishes, B queues another.
    await follows(app, b, 2);
    let claimsBeforeA: number | null = null;
    for (let i = 0; i < 20; i++) {
      const job = await claimNextJob(app.db, 'test-worker', Date.now() + 1000);
      if (job === undefined) break;
      if (job.userId === a.userId) {
        claimsBeforeA = i;
        break;
      }
      await app.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job.id)).run();
      await follows(app, b, 1);
    }
    expect(claimsBeforeA).not.toBeNull();
    expect(claimsBeforeA!).toBeLessThanOrEqual(VENDOR_CHECK_CAP);
  });

  /** Claims every check due, and marks each finished. */
  async function runAll(app: FastifyInstance) {
    for (;;) {
      const job = await claimNextJob(app.db, 'test-worker', Date.now() + 1000);
      if (job === undefined) return;
      await app.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job.id)).run();
    }
  }

  it("B's 4th inside the window goes to the back, even with none of B's waiting", async () => {
    const { app, a, b } = await boot();
    await onlyTheseJobs(app);
    await follows(app, b, VENDOR_CHECK_CAP);
    await runAll(app);
    await follows(app, a, 5);
    await follows(app, b, 1);
    expect(whose(await claimedInOrder(app), a)).toEqual([...times(5, 'a'), 'b']);
  });

  it('a finished check inside the window counts toward the cap', async () => {
    const { app, a, b } = await boot();
    await onlyTheseJobs(app);
    await follows(app, b, 1);
    await runAll(app);
    await follows(app, a, 5);
    // One of B's finished a moment ago, and two wait: the next is B's fourth in the window.
    await follows(app, b, 2);
    await follows(app, b, 1);
    expect(whose(await claimedInOrder(app), a)).toEqual(['b', 'b', ...times(5, 'a'), 'b']);
  });

  it("past the window, B's checks go ahead again", async () => {
    const { app, a, b } = await boot();
    await onlyTheseJobs(app);
    await follows(app, b, VENDOR_CHECK_CAP);
    await runAll(app);
    // Those three were made longer ago than the window.
    await app.db
      .update(jobs)
      .set({ createdAt: Date.now() - VENDOR_CHECK_WINDOW_MS - 1000 })
      .where(eq(jobs.userId, b.userId))
      .run();
    await follows(app, a, 5);
    await follows(app, b, 1);
    expect(whose(await claimedInOrder(app), a)).toEqual(['b', ...times(5, 'a')]);
  });

  it('the window is 10 minutes', () => {
    expect(VENDOR_CHECK_WINDOW_MS).toBe(10 * 60_000);
  });
});

// sec on https://github.com/bgoleno/opportun/pull/330#issuecomment-6768866975 (and qa on Postgres):
// enqueues for one user at the same moment each counted before any of them inserted, so all of them
// went ahead.
describe('#321: enqueues for one user at the same moment', () => {
  it('ten at once: at most 3 of them go ahead of the other user', async () => {
    const { app, a, b } = await boot();
    await onlyTheseJobs(app);
    await follows(app, a, 10);
    await Promise.all(
      Array.from({ length: 10 }, () => enqueueAtsDetect(app.db, ctxOf(b), newId())),
    );
    const order = whose(await claimedInOrder(app), a);
    expect(order.indexOf('a')).toBe(VENDOR_CHECK_CAP);
    expect(order.filter((w) => w === 'b')).toHaveLength(10);
  });

  it('Detect now pressed on many companies at once, through the route: the same', async () => {
    const { app, a, b } = await boot();
    const company = async (c: TestClient, name: string) => {
      const res = await c.request({ method: 'POST', url: '/api/v1/companies', payload: { name } });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    };
    const detectNow = async (c: TestClient, id: string) => {
      const res = await c.request({ method: 'POST', url: `/api/v1/companies/${id}/detect-ats` });
      expect(res.statusCode, res.body).toBe(202);
    };
    const theirs: string[] = [];
    for (let i = 0; i < 8; i++) theirs.push(await company(b, `Globex ${i}`));
    const mine: string[] = [];
    for (let i = 0; i < 6; i++) mine.push(await company(a, `Initech ${i}`));
    await onlyTheseJobs(app);
    for (const id of mine) await detectNow(a, id);
    await Promise.all(theirs.map((id) => detectNow(b, id)));
    const order = whose(await claimedInOrder(app), a);
    expect(order.indexOf('a')).toBe(VENDOR_CHECK_CAP);
    expect(order.filter((w) => w === 'b')).toHaveLength(8);
  });

  it('a failed enqueue does not stop the next one for that user', async () => {
    const { app, a } = await boot();
    await onlyTheseJobs(app);
    // A payload the job's schema refuses: the enqueue throws, and the user's line goes on.
    await expect(enqueueAtsDetect(app.db, ctxOf(a), '')).rejects.toThrow();
    await follows(app, a, 1);
    expect(await dueTimes(app, a)).toHaveLength(1);
  });
});
