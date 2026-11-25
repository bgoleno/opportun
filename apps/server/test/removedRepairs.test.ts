// The one-time repair of dedupe keys is gone (https://github.com/bgoleno/opportun/issues/912): no
// public version wrote the keys it corrected, and at a new install's second start, its first with
// users, it undid keys that are kept on purpose.
import { dedupeKey } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { discoveryResults, jobs, opportunities, settings } from '../src/db/schema';
import { enqueue } from '../src/lib/jobQueue';
import {
  createRun,
  ensureChannelSource,
  insertResult,
  setResolution,
} from '../src/repos/discovery';
import { restartableTestApp } from './helpers';
import { registerTwoUsers } from './isolation';
import { runQueuedJob } from './runQueuedJob';

const KIND = 'discovery.repair_dedupe_keys';
const MARKER = 'repair_dedupe_keys:done';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
async function install() {
  const t = await restartableTestApp();
  close = t.close;
  return t;
}

const ofKind = async (app: FastifyInstance) =>
  await app.db.select().from(jobs).where(eq(jobs.kind, KIND)).all();
const marker = async (app: FastifyInstance) =>
  await app.db.select().from(settings).where(eq(settings.key, MARKER)).all();

it("a new install's second start leaves the keys kept on purpose, and queues nothing", async () => {
  const t = await install();
  const { a } = await registerTwoUsers(t.app());
  const { db } = t.app();
  const ctx = { userId: a.userId, isAdmin: false };

  // A lead that a capture gave a location: it keeps the key it was stored with.
  const source = await ensureChannelSource(db, ctx, 'alert_email');
  const run = await createRun(db, ctx, { sourceId: source.id });
  const posting = {
    title: 'PM',
    company: 'Acme',
    location: null,
    remote: null,
    descriptionMd: null,
    postingUrl: null,
  };
  const leadKey = dedupeKey('Acme', 'PM', null);
  const lead = await insertResult(db, ctx, {
    runId: run.id,
    posting,
    dedupeKey: leadKey,
    resolution: 'needs_capture',
  });
  await setResolution(db, ctx, lead.id, {
    resolution: 'full',
    resolvedSourceRef: null,
    posting: { ...posting, location: 'Austin, TX', descriptionMd: 'What the job is.' },
  });
  // An opportunity whose company was renamed on its own page: its key is kept until it is saved (#910).
  const send = async (method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) => {
    const res = await a.request({ method, url: `/api/v1${url}`, payload });
    expect([200, 201], res.body).toContain(res.statusCode);
    return res.json() as { id: string; companyId: string };
  };
  const opp = await send('POST', '/opportunities', {
    companyName: 'Initech',
    title: 'Dev',
    location: 'Remote',
    sourceKind: 'manual',
  });
  await send('PATCH', `/companies/${opp.companyId}`, { name: 'Initech Labs' });

  const stored = async (app: FastifyInstance) => [
    await app.db.select().from(discoveryResults).where(eq(discoveryResults.id, lead.id)).get(),
    await app.db.select().from(opportunities).where(eq(opportunities.id, opp.id)).get(),
  ];
  const before = await stored(t.app());
  expect(before.map((r) => r!.dedupeKey)).toEqual([leadKey, 'initech|dev|remote']);

  const app = await t.restart({});
  for (const job of await ofKind(app)) await runQueuedJob(app, job.id);
  expect(await stored(app)).toEqual(before);
  expect(await ofKind(app)).toEqual([]);
  expect(await marker(app)).toEqual([]);
});

it('a job of it that an older version left pending ends as one with no handler, and its row says so', async () => {
  const t = await install();
  const { a } = await registerTwoUsers(t.app());
  const id = await enqueue(t.app().db, KIND, {}, { dedupeKey: `${KIND}:x`, userId: a.userId });
  const app = await t.restart({});
  await runQueuedJob(app, id);
  expect((await ofKind(app)).find((j) => j.id === id)).toMatchObject({
    status: 'dead',
    attempts: 1,
    lastError: `no handler registered for kind ${KIND}`,
  });
});

it('a marker an older version wrote stays, and nothing reads it', async () => {
  const t = await install();
  await registerTwoUsers(t.app());
  await t
    .app()
    .db.insert(settings)
    .values({ key: MARKER, userId: null, value: 1, updatedAt: 1 })
    .onConflictDoNothing()
    .run();
  const app = await t.restart({});
  expect(await marker(app)).toHaveLength(1);
  expect(await ofKind(app)).toEqual([]);
});
