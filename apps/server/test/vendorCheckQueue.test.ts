// One user's company adds, follows, re-checks or probes never hold up another user's ATS detection
// beyond a small bound, and nothing is refused (https://github.com/bgoleno/opportun/issues/321; tl's
// design on https://github.com/bgoleno/opportun/issues/321#issuecomment-6767502359). Each user has
// at most VENDOR_CHECK_CAP vendor checks due at once; the rest are queued VENDOR_CHECK_SPACING_MS
// apart. The runner claims by run_at, so another user's new check, due now, goes ahead of the first
// user's spread-out backlog. No job runs here: claimNextJob is the runner's own claim, and the
// jobs are only claimed to see their order.
import { newId } from '@opportun/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { claimNextJob } from '../src/db/dialect';
import { jobs } from '../src/db/schema';
import { ATS_DETECT_KIND, atsDetectDedupeKey, enqueueAtsDetect } from '../src/jobs/atsDetect';
import {
  BOARD_PROBE_KIND,
  boardProbeDedupeKey,
  enqueueBoardProbe,
} from '../src/jobs/companyBoardProbe';
import { enqueue } from '../src/jobs/runner';
import {
  VENDOR_CHECK_CAP,
  VENDOR_CHECK_KINDS,
  VENDOR_CHECK_SPACING_MS,
} from '../src/jobs/vendorCheckQueue';
import type { UserCtx } from '../src/repos/base';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

/** The vendor-check jobs claimed, in the runner's order, as of `now`. */
async function claimedInOrder(app: FastifyInstance, now: number) {
  const claimed: { id: string; userId: string | null }[] = [];
  for (;;) {
    const job = await claimNextJob(app.db, 'test-worker', now);
    if (job === undefined) return claimed;
    if ((VENDOR_CHECK_KINDS as readonly string[]).includes(job.kind)) {
      claimed.push({ id: job.id, userId: job.userId });
    }
  }
}

/** The user's vendor-check jobs, oldest first, with when each is due. */
const dueTimes = async (app: FastifyInstance, c: TestClient) =>
  (
    await app.db
      .select({ runAt: jobs.runAt, createdAt: jobs.createdAt })
      .from(jobs)
      .where(and(eq(jobs.userId, c.userId), inArray(jobs.kind, [...VENDOR_CHECK_KINDS])))
      .all()
  )
    .sort((x, y) => x.createdAt - y.createdAt)
    .map((r) => r.runAt);

/** Clears the jobs boot() queued for itself, so the claims below see only these. */
const onlyTheseJobs = (app: FastifyInstance) => app.db.delete(jobs).run();

describe('#321: per user, a few vendor checks due at once and the rest queued', () => {
  it('the cap is 3 and the spacing 20 s, and the kinds are detection and the board probe', () => {
    expect(VENDOR_CHECK_CAP).toBe(3);
    expect(VENDOR_CHECK_SPACING_MS).toBe(20_000);
    expect([...VENDOR_CHECK_KINDS].sort()).toEqual([ATS_DETECT_KIND, BOARD_PROBE_KIND].sort());
  });

  it("one user following 50 companies: another user's one detection goes before the first's fourth", async () => {
    const { app, a, b } = await boot();
    await onlyTheseJobs(app);
    for (let i = 0; i < 50; i++) await enqueueAtsDetect(app.db, ctxOf(a), newId());
    const theirs = await enqueueAtsDetect(app.db, ctxOf(b), newId());

    const order = await claimedInOrder(app, Date.now() + 1000);
    const at = order.findIndex((j) => j.id === theirs);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThanOrEqual(VENDOR_CHECK_CAP);
    expect(order.slice(0, at).every((j) => j.userId === a.userId)).toBe(true);
  });

  it('a handful of companies: every check is due at once, as before', async () => {
    const { app, a } = await boot();
    await onlyTheseJobs(app);
    const before = Date.now();
    for (let i = 0; i < VENDOR_CHECK_CAP; i++) await enqueueAtsDetect(app.db, ctxOf(a), newId());
    const due = await dueTimes(app, a);
    expect(due).toHaveLength(VENDOR_CHECK_CAP);
    expect(due.every((t) => t <= Date.now() && t >= before)).toBe(true);
  });

  it('past the cap, each later check is due one spacing after the one before', async () => {
    const { app, a } = await boot();
    await onlyTheseJobs(app);
    for (let i = 0; i < VENDOR_CHECK_CAP + 3; i++) {
      await enqueueAtsDetect(app.db, ctxOf(a), newId());
    }
    const due = await dueTimes(app, a);
    const later = due.slice(VENDOR_CHECK_CAP);
    const lastAtOnce = Math.max(...due.slice(0, VENDOR_CHECK_CAP));
    expect(later[0]! - lastAtOnce).toBeGreaterThanOrEqual(VENDOR_CHECK_SPACING_MS);
    expect(later[1]! - later[0]!).toBe(VENDOR_CHECK_SPACING_MS);
    expect(later[2]! - later[1]!).toBe(VENDOR_CHECK_SPACING_MS);
    // Nothing is refused or lost: every one is queued, and runs in its turn.
    expect(due).toHaveLength(VENDOR_CHECK_CAP + 3);
  });

  it("board probes count toward the same cap as detections: one user's checks share one count", async () => {
    const { app, a } = await boot();
    await onlyTheseJobs(app);
    for (let i = 0; i < VENDOR_CHECK_CAP; i++) {
      const companyId = newId();
      await enqueue(
        app.db,
        BOARD_PROBE_KIND,
        { companyId },
        { dedupeKey: boardProbeDedupeKey(companyId), userId: a.userId },
      );
    }
    await enqueueAtsDetect(app.db, ctxOf(a), newId());
    const due = await dueTimes(app, a);
    expect(due[VENDOR_CHECK_CAP]! - Date.now()).toBeGreaterThan(VENDOR_CHECK_SPACING_MS - 1000);
  });

  it('board probes past the cap are spaced the same way', async () => {
    const { app, a } = await boot();
    await onlyTheseJobs(app);
    for (let i = 0; i < VENDOR_CHECK_CAP + 2; i++) {
      await enqueueBoardProbe(app.db, ctxOf(a), newId());
    }
    const due = await dueTimes(app, a);
    expect(due[VENDOR_CHECK_CAP + 1]! - due[VENDOR_CHECK_CAP]!).toBe(VENDOR_CHECK_SPACING_MS);
    expect(due[VENDOR_CHECK_CAP]! - Date.now()).toBeGreaterThan(VENDOR_CHECK_SPACING_MS - 1000);
  });

  // sec on https://github.com/bgoleno/opportun/issues/321#issuecomment-6767893892: Detect now has
  // no limit of its own, and is deduped only while a job is unfinished.
  it("Detect now pressed on many companies by one user: another user's goes before the first's fourth", async () => {
    const { app, a, b } = await boot();
    const company = async (c: TestClient, name: string) => {
      const res = await c.request({ method: 'POST', url: '/api/v1/companies', payload: { name } });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    };
    const detectNow = async (c: TestClient, id: string) => {
      const res = await c.request({ method: 'POST', url: `/api/v1/companies/${id}/detect-ats` });
      expect(res.statusCode, res.body).toBe(202);
      return res.json<{ jobId: string }>().jobId;
    };
    const mine: string[] = [];
    for (let i = 0; i < 12; i++) mine.push(await company(a, `Initech ${i}`));
    const theirsCompany = await company(b, 'Globex');
    await onlyTheseJobs(app);
    for (const id of mine) await detectNow(a, id);
    const theirs = await detectNow(b, theirsCompany);

    const order = await claimedInOrder(app, Date.now() + 1000);
    const at = order.findIndex((j) => j.id === theirs);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThanOrEqual(VENDOR_CHECK_CAP);
  });

  it('a company already queued is not queued twice, wherever its turn is', async () => {
    const { app, a } = await boot();
    await onlyTheseJobs(app);
    for (let i = 0; i < VENDOR_CHECK_CAP + 1; i++) {
      await enqueueAtsDetect(app.db, ctxOf(a), newId());
    }
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

  it("another user's checks do not count toward this user's cap", async () => {
    const { app, a, b } = await boot();
    await onlyTheseJobs(app);
    for (let i = 0; i < 10; i++) await enqueueAtsDetect(app.db, ctxOf(a), newId());
    const before = Date.now();
    await enqueueAtsDetect(app.db, ctxOf(b), newId());
    const [due] = await dueTimes(app, b);
    expect(due).toBeGreaterThanOrEqual(before);
    expect(due).toBeLessThanOrEqual(Date.now());
  });
});
