// The AI dedupe pass beside what else writes the pair (#998): it names one opportunity on the other's
// row, so it takes the user's lock first, as whatever writes or names two of them does (#920). What it
// was told is decided on the pair as it is then, and nothing is held while the model is asked.
import { runStructured } from '@opportun/ai';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresConfig } from '../src/config';
import { rawRun } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import { runOpportunityDedupeAi } from '../src/jobs/opportunityDedupeAi';
import { queryOne, testDialect } from './db';
import { useApi } from './api';
import { captureLogs } from './helpers';
import type { TestClient } from './isolation';
import { heldApart, pauseAt } from './race';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

let logs = captureLogs();
const boot = useApi(() => ({ logStream: logs }));
const open: pg.Client[] = [];
beforeEach(() => {
  logs = captureLogs();
  vi.mocked(runStructured).mockReset();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.end().catch(() => undefined)));
});

const T = { companyName: 'Acme Robotics', title: 'Senior Product Manager' };
const C = { companyName: 'Acme Robotics, Inc.', title: 'Product Manager II' };

async function make(c: TestClient, over: Record<string, unknown>): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { sourceKind: 'manual', ...over },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

/** A pending pair, as the pass reads it: `tracked` is the first of the two by id. */
async function pair(app: FastifyInstance, c: TestClient) {
  await make(c, T);
  await make(c, C);
  const row = (await queryOne(
    app,
    'SELECT opportunity_id_a AS a, opportunity_id_b AS b FROM opportunity_dedupe_candidates WHERE user_id = ?',
    c.userId,
  )) as { a: string; b: string };
  return { tracked: row.a, candidate: row.b };
}
const decision = async (app: FastifyInstance, c: TestClient) =>
  (await queryOne(
    app,
    'SELECT decision, decided_by AS "decidedBy", ai_failures AS "failures" FROM opportunity_dedupe_candidates WHERE user_id = ?',
    c.userId,
  )) as { decision: string; decidedBy: string | null; failures: number } | undefined;
const markOf = async (app: FastifyInstance, id: string) =>
  (
    (await queryOne(
      app,
      'SELECT possible_duplicate_of AS v FROM opportunities WHERE id = ?',
      id,
    )) as { v: string | null } | undefined
  )?.v;

const warnings: unknown[] = [];
const log = { warn: (obj: unknown, msg: string) => warnings.push([msg, obj]) };
/** The model's answer, with `meanwhile` run while it is asked. */
const answers = (ref: string | null, meanwhile?: () => Promise<unknown>) =>
  vi.mocked(runStructured).mockImplementationOnce((async () => {
    await meanwhile?.();
    return { duplicateOfRef: ref, confidence: 0.9, reason: 'as told' };
  }) as never);
const pass = (app: FastifyInstance) => runOpportunityDedupeAi(app.db, { log });
beforeEach(() => {
  warnings.length = 0;
});

const save = (c: TestClient, id: string, payload: Record<string, unknown>) =>
  c.request({ method: 'PATCH', url: `/api/v1/opportunities/${id}`, payload });
const remove = (c: TestClient, id: string) =>
  c.request({ method: 'DELETE', url: `/api/v1/opportunities/${id}` });
const merge = (c: TestClient, id: string, otherId: string) =>
  c.request({ method: 'POST', url: `/api/v1/opportunities/${id}/merge`, payload: { otherId } });
const dismissDuplicate = (c: TestClient, id: string, otherId: string) =>
  c.request({
    method: 'POST',
    url: `/api/v1/opportunities/${id}/dismiss-duplicate`,
    payload: { otherId },
  });

/** A connection of its own that holds `id`'s row, as a save that hasn't committed does. */
async function holdRow(app: FastifyInstance, id: string) {
  const by = new pg.Client({ connectionString: (app.config.db as PostgresConfig).url });
  by.on('error', () => undefined);
  await by.connect();
  open.push(by);
  await by.query('BEGIN');
  await by.query('SELECT 1 FROM opportunities WHERE id = $1 FOR NO KEY UPDATE', [id]);
  /** Waits until `n` of the app's statements wait for a lock. */
  const blocked = async (n: number) => {
    for (let i = 0; i < 400; i += 1) {
      await by.query('SELECT pg_stat_clear_snapshot()'); // in a transaction it is read once
      const res = await by.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock'`,
      );
      if (res.rows[0]!.n >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`never ${n} blocked`);
  };
  return { blocked, letGo: () => by.query('COMMIT') };
}

describe.runIf(testDialect === 'postgres')(
  'the pass and a writer of both rows, on Postgres (#998)',
  () => {
    // The pass's write of the candidate first in line for its row, the other writer, which holds the
    // tracked row by then, behind it; and the pass's foreign key then needs the tracked row.
    it('a merge of the pair: no deadlock', async () => {
      const { app, a } = await boot();
      onSlowTransaction(() => undefined);
      const { tracked, candidate } = await pair(app, a);
      answers(tracked);
      const row = await holdRow(app, candidate);
      const passing = pass(app);
      await row.blocked(1);
      const merging = merge(a, candidate, tracked);
      await row.blocked(2);
      await row.letGo();
      const [outcome, merged] = await Promise.all([passing, merging]);
      expect(merged.statusCode, merged.body).toBe(200);
      expect(outcome).toMatchObject({ confirmed: 1, failed: 0 });
      expect(logs.text()).not.toContain('40P01');
      expect(warnings).toEqual([]);
      expect(await markOf(app, candidate)).toBeNull(); // the tracked one is gone, merged in
    });

    it('a save of the tracked one’s link and title, the candidate dismissed and holding the new key: no deadlock', async () => {
      const { app, a } = await boot();
      onSlowTransaction(() => undefined);
      const { tracked, candidate } = await pair(app, a);
      const dismissed = await a.request({
        method: 'POST',
        url: `/api/v1/opportunities/${candidate}/stage`,
        payload: { to: 'dismissed', dismissedReason: 'other' },
      });
      expect(dismissed.statusCode, dismissed.body).toBe(200);
      answers(tracked);
      const row = await holdRow(app, candidate);
      const passing = pass(app);
      await row.blocked(1);
      const theirs = (await queryOne(
        app,
        'SELECT title FROM opportunities WHERE id = ?',
        candidate,
      )) as { title: string };
      const companyOf = (await queryOne(
        app,
        'SELECT c.name FROM opportunities o JOIN companies c ON c.id = o.company_id WHERE o.id = ?',
        candidate,
      )) as { name: string };
      const saving = save(a, tracked, {
        companyName: companyOf.name,
        title: theirs.title,
        postingUrl: 'https://example.com/jobs/1',
      });
      await row.blocked(2);
      await row.letGo();
      const [outcome, saved] = await Promise.all([passing, saving]);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(outcome).toMatchObject({ failed: 0 });
      expect(warnings).toEqual([]);
    });

    it('a delete of the tracked one: no deadlock, and nothing marked', async () => {
      const { app, a } = await boot();
      onSlowTransaction(() => undefined);
      const { tracked, candidate } = await pair(app, a);
      answers(tracked);
      const row = await holdRow(app, candidate);
      const passing = pass(app);
      await row.blocked(1);
      const removing = remove(a, tracked);
      await new Promise((r) => setTimeout(r, 200));
      await row.letGo();
      const [, removed] = await Promise.all([passing, removing]);
      expect(removed.statusCode, removed.body).toBeLessThan(300);
      expect(await markOf(app, candidate)).toBeNull();
      expect(warnings).toEqual([]);
    });
  },
);

describe('what it was told is decided on the pair as it is then (#998)', () => {
  it.each(['tracked', 'candidate'] as const)(
    'the %s one deleted while the model is asked: nothing',
    async (which) => {
      const { app, a } = await boot();
      const ids = await pair(app, a);
      answers(ids.tracked, async () => {
        expect((await remove(a, ids[which])).statusCode).toBeLessThan(300);
      });
      expect(await pass(app)).toEqual({
        scanned: 1,
        confirmed: 0,
        rejected: 0,
        failed: 0,
        capped: 0,
      });
      expect(await decision(app, a)).toBeUndefined();
      const left = which === 'tracked' ? ids.candidate : ids.tracked;
      expect(await markOf(app, left)).toBeNull();
      expect(warnings).toEqual([]);
    },
  );

  it('the pair merged while the model is asked: nothing', async () => {
    const { app, a } = await boot();
    const { tracked, candidate } = await pair(app, a);
    answers(tracked, async () => {
      const res = await merge(a, candidate, tracked);
      expect(res.statusCode, res.body).toBe(200);
    });
    expect(await pass(app)).toMatchObject({ confirmed: 0, rejected: 0, failed: 0 });
    expect(await markOf(app, candidate)).toBeNull();
    expect(warnings).toEqual([]);
  });

  it.each([true, false])(
    'the user says they differ while the model is asked, its answer same %s: theirs stays',
    async (same) => {
      const { app, a } = await boot();
      const { tracked, candidate } = await pair(app, a);
      // Marked by Create anyway, say; the pair still waits for the pass.
      await rawRun(
        app.db,
        sql`UPDATE opportunities SET possible_duplicate_of = ${tracked} WHERE id = ${candidate}`,
      );
      answers(same ? tracked : null, async () => {
        const res = await dismissDuplicate(a, candidate, tracked);
        expect(res.statusCode, res.body).toBe(200);
      });
      expect(await pass(app)).toMatchObject({ confirmed: 0, rejected: 0, failed: 0 });
      expect(await decision(app, a)).toMatchObject({ decision: 'rejected', decidedBy: 'user' });
      expect(await markOf(app, candidate)).toBeNull();
      expect(warnings).toEqual([]);
    },
  );

  it('the candidate marked against another while the model is asked: that mark stays', async () => {
    const { app, a } = await boot();
    const { tracked, candidate } = await pair(app, a);
    const third = await make(a, { companyName: 'Globex', title: 'Data Analyst' });
    answers(tracked, () =>
      rawRun(
        app.db,
        sql`UPDATE opportunities SET possible_duplicate_of = ${third} WHERE id = ${candidate}`,
      ),
    );
    expect(await pass(app)).toMatchObject({ confirmed: 1 });
    expect(await markOf(app, candidate)).toBe(third);
  });

  it('its mark cleared while the model is asked: the new one is written', async () => {
    const { app, a } = await boot();
    const { tracked, candidate } = await pair(app, a);
    const third = await make(a, { companyName: 'Globex', title: 'Data Analyst' });
    await rawRun(
      app.db,
      sql`UPDATE opportunities SET possible_duplicate_of = ${third} WHERE id = ${candidate}`,
    );
    answers(tracked, async () => {
      expect((await remove(a, third)).statusCode).toBeLessThan(300);
    });
    expect(await pass(app)).toMatchObject({ confirmed: 1 });
    expect(await markOf(app, candidate)).toBe(tracked);
  });
});

describe('the user’s lock (#998)', () => {
  it('is not held while the model is asked: a save that takes it is done meanwhile', async () => {
    const { app, a } = await boot();
    const { tracked, candidate } = await pair(app, a);
    answers(tracked, async () => {
      const res = await save(a, candidate, { title: 'Product Manager III' });
      expect(res.statusCode, res.body).toBe(200);
    });
    expect(await pass(app)).toMatchObject({ scanned: 1 });
  });

  it('is held for the decision: a save that takes it waits, and both are done', async () => {
    const { app, a } = await boot();
    const { tracked, candidate } = await pair(app, a);
    answers(tracked);
    const [outcome, saved] = await heldApart(
      app,
      'opportunityDedupe.ai.locked',
      () => pass(app),
      () => save(a, tracked, { title: 'Product Lead' }),
    );
    expect(outcome).toMatchObject({ confirmed: 1, failed: 0 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await markOf(app, candidate)).toBe(tracked);
    expect(await decision(app, a)).toMatchObject({ decision: 'confirmed', decidedBy: 'ai' });
  });

  it('a delete that has it: the pass waits, and marks nothing', async () => {
    const { app, a } = await boot();
    const { tracked, candidate } = await pair(app, a);
    // Deleting once the model has answered: the pass then waits for the user's lock.
    let deleting: Promise<unknown> = Promise.resolve();
    onSlowTransaction(() => undefined);
    const pause = pauseAt('opportunities.delete.locked');
    answers(tracked, async () => {
      deleting = remove(a, tracked);
      await pause.reached;
      setTimeout(() => pause.release(), 300);
    });
    expect(await pass(app)).toMatchObject({ confirmed: 0, rejected: 0, failed: 0 });
    await deleting;
    expect(await markOf(app, candidate)).toBeNull();
    expect(await decision(app, a)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("another user's is not waited for", async () => {
    const { app, a, b } = await boot();
    const { tracked } = await pair(app, a);
    const theirs = await make(b, T);
    onSlowTransaction(() => undefined);
    if (testDialect === 'sqlite') return; // one write gate for all
    const pause = pauseAt('opportunities.delete.locked');
    const deleting = remove(b, theirs);
    await pause.reached;
    answers(tracked);
    expect(await pass(app)).toMatchObject({ confirmed: 1 });
    pause.release();
    await deleting;
  });
});
