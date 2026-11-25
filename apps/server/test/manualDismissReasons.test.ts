// The reasons a person can dismiss with (https://github.com/bgoleno/opportun/issues/1048). Denied
// company is the system's: ingest writes it, with the denied company's name as its note, and a
// person's would read as that name and drop out of the learning.
import { DISMISS_REASONS, MANUAL_DISMISS_REASONS } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { discoveryResults, dismissalFeedback, opportunities, stageHistory } from '../src/db/schema';
import { packFromZip, runImport } from '../src/lib/importer';
import { createRun, ensureChannelSource, insertResult } from '../src/repos/discovery';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const SYSTEMS = 'denied_company';

async function card(app: FastifyInstance, a: TestClient): Promise<string> {
  const source = await ensureChannelSource(app.db, ctxOf(a), 'manual');
  const run = await createRun(app.db, ctxOf(a), { sourceId: source.id });
  const row = await insertResult(app.db, ctxOf(a), {
    runId: run.id,
    posting: {
      title: 'Dev',
      company: 'Initech',
      location: null,
      remote: null,
      descriptionMd: 'What the job is.',
      postingUrl: null,
    },
    dedupeKey: null,
    resolution: 'full',
  });
  return row.id;
}
async function opportunity(a: TestClient): Promise<string> {
  const res = await a.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName: 'Globex', title: 'Dev', sourceKind: 'manual' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

/** Each way a person dismisses: what it is sent, on what, and what it answers when it is taken. */
const ROUTES: [string, (app: FastifyInstance, a: TestClient, reason: string) => Promise<number>][] =
  [
    [
      'one result',
      async (app, a, reason) =>
        (
          await a.request({
            method: 'POST',
            url: `/api/v1/discovery/results/${await card(app, a)}/dismiss`,
            payload: { reason, note: 'a note' },
          })
        ).statusCode,
    ],
    [
      'several results',
      async (app, a, reason) =>
        (
          await a.request({
            method: 'POST',
            url: '/api/v1/discovery/results/bulk-dismiss',
            payload: { ids: [await card(app, a), await card(app, a)], reason, note: 'a note' },
          })
        ).statusCode,
    ],
    [
      'an opportunity',
      async (_app, a, reason) =>
        (
          await a.request({
            method: 'POST',
            url: `/api/v1/opportunities/${await opportunity(a)}/stage`,
            payload: { to: 'dismissed', dismissedReason: reason, note: 'a note' },
          })
        ).statusCode,
    ],
  ];

describe.each(ROUTES)('a person dismissing %s', (_what, send) => {
  it(`is refused ${SYSTEMS}, with nothing written`, async () => {
    const { app, a } = await boot();
    expect(await send(app, a, SYSTEMS)).toBe(400);
    expect(await app.db.select().from(dismissalFeedback).all()).toEqual([]);
    const results = await app.db.select().from(discoveryResults).all();
    expect(results.filter((r) => r.disposition !== 'pending')).toEqual([]);
    const opps = await app.db.select().from(opportunities).all();
    expect(opps.filter((o) => o.stage === 'dismissed' || o.dismissedReason !== null)).toEqual([]);
    const history = await app.db.select().from(stageHistory).all();
    expect(history.filter((h) => h.toStage === 'dismissed')).toEqual([]);
  });

  it.each(MANUAL_DISMISS_REASONS)('can say %s', async (reason) => {
    const { app, a } = await boot();
    expect(await send(app, a, reason)).toBe(200);
    const rows = await app.db.select().from(dismissalFeedback).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatchObject({ reason, note: 'a note' });
  });
});

it('the two lists: the system’s one is all that a person’s leaves out', () => {
  expect(DISMISS_REASONS).toEqual([...MANUAL_DISMISS_REASONS, SYSTEMS]);
  // Stored values: one may join them, none may go.
  expect(MANUAL_DISMISS_REASONS).toEqual([
    'seniority',
    'compensation',
    'location',
    'industry',
    'role_fit',
    'company',
    'stale',
    'not_interested',
    'duplicate',
    'other',
  ]);
});

it('one that is stored is read as it was', async () => {
  const { app, a } = await boot();
  const id = await card(app, a);
  await app.db
    .update(discoveryResults)
    .set({ disposition: 'dismissed' })
    .where(eq(discoveryResults.id, id))
    .run();
  await app.db
    .insert(dismissalFeedback)
    .values({
      id: 'f1',
      userId: a.userId,
      kind: 'dismissal',
      resultId: id,
      opportunityId: null,
      reason: SYSTEMS,
      note: 'Initech',
      at: 1,
    })
    .run();
  const res = await a.request({ method: 'GET', url: `/api/v1/discovery/results/${id}` });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json()).toMatchObject({ dismissReason: SYSTEMS, dismissNote: 'Initech' });
});

it('the import still takes it: a pack that has it keeps its row', async () => {
  const { app, a } = await boot();
  const { report } = await runImport(
    app.db,
    ctxOf(a),
    packFromZip(
      zipSync({
        'opportunities.csv': strToU8(
          'company,title,stage,posting_url,location,source,applied_at,dismissed_reason,notes_file,resume_doc_ref\n' +
            `Initech,Dev,dismissed,,,,,${SYSTEMS},,`,
        ),
      }),
    ),
  );
  expect(report).toMatchObject({ created: 1, errors: [] });
  const [row] = await app.db.select().from(opportunities).all();
  expect(row).toMatchObject({ stage: 'dismissed', dismissedReason: SYSTEMS });
});
