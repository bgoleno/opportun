// Three one-time repairs are gone, as no public version wrote what they repaired. That of dedupe keys
// (https://github.com/bgoleno/opportun/issues/912) also undid, at a new install's second start, its
// first with users, keys that are kept on purpose. Those of shifted alert leads and of companies' match
// keys (https://github.com/bgoleno/opportun/issues/1034) found nothing there.
import { dedupeKey } from '@opportun/core';
import { eq, inArray } from 'drizzle-orm';
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

/** Each repair's job kind, and the marker it wrote once queued. */
const REMOVED: [string, string][] = [
  ['discovery.repair_dedupe_keys', 'repair_dedupe_keys:done'],
  ['discovery.repair_alert_leads', 'repair_alert_leads:done'],
  ['companies.repair_match_keys', 'repair_company_match_keys:done'],
];
const KINDS = REMOVED.map(([kind]) => kind);
const MARKERS = REMOVED.map(([, marker]) => marker);

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

const queued = async (app: FastifyInstance) =>
  await app.db.select().from(jobs).where(inArray(jobs.kind, KINDS)).all();
const markers = async (app: FastifyInstance) =>
  (await app.db.select().from(settings).where(inArray(settings.key, MARKERS)).all())
    .map((s) => s.key)
    .sort();

it("a new install's second start leaves the keys kept on purpose, and queues none of them", async () => {
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
  for (const job of await queued(app)) await runQueuedJob(app, job.id);
  expect(await stored(app)).toEqual(before);
  expect(await queued(app)).toEqual([]);
  expect(await markers(app)).toEqual([]);
});

it.each(KINDS)(
  'a %s an older version left pending ends with no handler, and says so',
  async (kind) => {
    const t = await install();
    const { a } = await registerTwoUsers(t.app());
    const id = await enqueue(t.app().db, kind, {}, { dedupeKey: `${kind}:x`, userId: a.userId });
    const app = await t.restart({});
    await runQueuedJob(app, id);
    expect((await queued(app)).find((j) => j.id === id)).toMatchObject({
      status: 'dead',
      attempts: 1,
      lastError: `no handler registered for kind ${kind}`,
    });
  },
);

it('the markers an older version wrote stay, and nothing reads them', async () => {
  const t = await install();
  await registerTwoUsers(t.app());
  await t
    .app()
    .db.insert(settings)
    .values(MARKERS.map((key) => ({ key, userId: null, value: 1, updatedAt: 1 })))
    .onConflictDoNothing()
    .run();
  const app = await t.restart({});
  expect(await markers(app)).toEqual([...MARKERS].sort());
  expect(await queued(app)).toEqual([]);
});
