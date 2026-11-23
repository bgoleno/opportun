// Deleting an opportunity beside its saves (https://github.com/bgoleno/opportun/issues/917). The
// delete took its search rows, then the opportunity; a save the opportunity, then its search row; so
// the two could each wait for the other on Postgres (40P01, one answered 500, sometimes the delete).
// SQLite's write gate runs them one after the other, and the same outcomes hold.
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { newId } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { activities, opportunities } from '../src/db/schema';
import { withTransaction, writeGateOf } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import type { Exec, UserCtx } from '../src/repos/base';
import { createActivity, updateActivity } from '../src/repos/activities';
import { createOpportunity, deleteOpportunity } from '../src/repos/opportunities';
import { indexActivity, indexOpportunity } from '../src/repos/search';
import { useApi } from './api';
import { queryAll, queryOne, sqliteOnly } from './db';
import type { TestClient } from './isolation';
import { pauseAt } from './race';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
const DELETING = 'opportunities.delete.locked';

async function create(app: FastifyInstance, c: TestClient, title = 'Staff Engineer') {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Initech',
    title,
    descriptionMd: 'What the job is.',
    sourceKind: 'manual',
  });
  const note = await createActivity(app.db, ctxOf(c), opp.id, {
    kind: 'note',
    title: 'A note',
    bodyMd: 'noted',
    occurredAt: Date.now(),
    participants: [],
    externalUrl: null,
  });
  return { id: opp.id, noteId: note.id };
}

const patch = (c: TestClient, id: string, payload: Record<string, unknown>) =>
  c.request({ method: 'PATCH', url: `/api/v1/opportunities/${id}`, payload });
const remove = (c: TestClient, id: string) =>
  c.request({ method: 'DELETE', url: `/api/v1/opportunities/${id}` });

/**
 * Whether somebody came to be blocked: on any lock on Postgres, at the gate on SQLite. Looked at before
 * the parked one is let go and asserted after, so a failure leaves nothing parked.
 */
async function someoneBlocked(app: FastifyInstance): Promise<boolean> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    const gate = writeGateOf(app.db);
    const n =
      gate === undefined
        ? ((
            await queryOne<{ n: number }>(
              app,
              sql`SELECT count(*)::int AS n FROM pg_stat_activity
                  WHERE datname = current_database() AND wait_event_type = 'Lock'`,
            )
          )?.n ?? 0)
        : gate.waiting();
    if (n > 0) return true;
    if (performance.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Everything the user has of the opportunity: its row, its activities and the search rows. */
async function left(app: FastifyInstance, c: TestClient, id: string) {
  const search = await queryAll<{ kind: string; id: string }>(
    app,
    'SELECT entity_kind AS kind, entity_id AS id FROM search_index WHERE user_id = ?',
    c.userId,
  );
  return {
    rows: await app.db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.id, id))
      .all(),
    activities: await app.db
      .select({ id: activities.id })
      .from(activities)
      .where(eq(activities.opportunityId, id))
      .all(),
    search,
  };
}
const NOTHING = { rows: [], activities: [], search: [] };

/** A transaction that does `first`, holds until let go, then does `rest`. */
function held(
  app: FastifyInstance,
  first: (tx: Exec) => Promise<unknown>,
  rest: (tx: Exec) => Promise<unknown>,
) {
  let go!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((r) => (go = r));
  const reached = new Promise<void>((r) => (arrived = r));
  const done = withTransaction(app.db, async (tx) => {
    await first(tx);
    arrived();
    await gate;
    await rest(tx);
  });
  return { reached, go, done };
}

describe('a delete and a save of one opportunity', () => {
  it.each<[string, Record<string, unknown>]>([
    ['description', { descriptionMd: 'Something else.' }],
    ['title', { title: 'Data Analyst' }],
    ['company', { companyName: 'Hooli' }],
    ['link', { postingUrl: 'https://example.com/jobs/1' }],
    ['priority', { priority: 3 }],
  ])(
    'the delete first, then a %s save: it is deleted, and the save is not found',
    async (_w, p) => {
      const { app, a } = await boot();
      const { id } = await create(app, a);
      // One to be found similar, so a title or company save has another opportunity to point at.
      await create(app, a, 'Data Analyst II');
      onSlowTransaction(() => undefined);
      const pause = pauseAt(DELETING);
      const deleting = remove(a, id);
      await pause.reached;
      const saving = patch(a, id, p);
      const blocked = await someoneBlocked(app);
      pause.release();
      expect(blocked).toBe(true);
      const [deleted, saved] = await Promise.all([deleting, saving]);
      expect(deleted.statusCode, deleted.body).toBe(204);
      expect(saved.statusCode, saved.body).toBe(404);
      const after = await left(app, a, id);
      expect({ rows: after.rows, activities: after.activities }).toEqual({
        rows: [],
        activities: [],
      });
      expect(after.search.map((s) => s.id)).not.toContain(id);
    },
  );

  // A save's own order, held where no race point is: the row written, its search row not yet.
  it.runIf(!sqliteOnly)('the save first, then the delete: both are done', async () => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    onSlowTransaction(() => undefined);
    const save = held(
      app,
      (tx) => tx.update(opportunities).set({ priority: 3 }).where(eq(opportunities.id, id)).run(),
      (tx) => indexOpportunity(tx, ctxOf(a), { id, title: 'Saved', descriptionMd: 'Saved.' }),
    );
    await save.reached;
    const deleting = remove(a, id);
    const blocked = await someoneBlocked(app);
    save.go();
    expect(blocked).toBe(true);
    const [, deleted] = await Promise.all([save.done, deleting]);
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await left(app, a, id)).toEqual(NOTHING);
  });

  it('one not there, or another user’s, is not found, and nothing goes', async () => {
    const { app, a, b } = await boot();
    const { id } = await create(app, a);
    expect((await remove(b, id)).statusCode).toBe(404);
    expect((await remove(a, newId())).statusCode).toBe(404);
    const after = await left(app, a, id);
    expect(after.rows).toHaveLength(1);
    expect(after.activities).toHaveLength(1);
    expect(after.search).toHaveLength(2);
  });

  it('two deletes at once: one deletes, the other is not found', async () => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    onSlowTransaction(() => undefined);
    const pause = pauseAt(DELETING);
    const first = remove(a, id);
    await pause.reached;
    const second = remove(a, id);
    const blocked = await someoneBlocked(app);
    pause.release();
    expect(blocked).toBe(true);
    expect([(await first).statusCode, (await second).statusCode]).toEqual([204, 404]);
    expect(await left(app, a, id)).toEqual(NOTHING);
  });
});

describe('a delete and its activities: none is left in search', () => {
  it.runIf(!sqliteOnly)('one being edited', async () => {
    const { app, a } = await boot();
    const { id, noteId } = await create(app, a);
    onSlowTransaction(() => undefined);
    const edit = held(
      app,
      (tx) => tx.update(activities).set({ title: 'Edited' }).where(eq(activities.id, noteId)).run(),
      (tx) => indexActivity(tx, ctxOf(a), { id: noteId, title: 'Edited', bodyMd: 'edited' }),
    );
    await edit.reached;
    const deleting = remove(a, id);
    const blocked = await someoneBlocked(app);
    edit.go();
    expect(blocked).toBe(true);
    const [, deleted] = await Promise.all([edit.done, deleting]);
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await left(app, a, id)).toEqual(NOTHING);
  });

  it.runIf(!sqliteOnly)('one being added', async () => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    onSlowTransaction(() => undefined);
    const added = newId();
    const now = Date.now();
    const add = held(
      app,
      (tx) =>
        tx
          .insert(activities)
          .values({
            id: added,
            userId: a.userId,
            opportunityId: id,
            kind: 'note',
            title: 'Added',
            bodyMd: 'added',
            occurredAt: now,
            participants: [],
            createdAt: now,
            updatedAt: now,
          })
          .run(),
      (tx) => indexActivity(tx, ctxOf(a), { id: added, title: 'Added', bodyMd: 'added' }),
    );
    await add.reached;
    const deleting = remove(a, id);
    const blocked = await someoneBlocked(app);
    add.go();
    expect(blocked).toBe(true);
    const [, deleted] = await Promise.all([add.done, deleting]);
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await left(app, a, id)).toEqual(NOTHING);
  });

  it('an edit that comes after is not found', async () => {
    const { app, a } = await boot();
    const { id, noteId } = await create(app, a);
    onSlowTransaction(() => undefined);
    const pause = pauseAt(DELETING);
    const deleting = remove(a, id);
    await pause.reached;
    pause.release();
    expect((await deleting).statusCode).toBe(204);
    await expect(updateActivity(app.db, ctxOf(a), noteId, { title: 'Late' })).rejects.toMatchObject(
      {
        statusCode: 404,
      },
    );
    expect(await left(app, a, id)).toEqual(NOTHING);
  });

  it('more of them than one statement names', async () => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    const kept = await create(app, a, 'Data Analyst');
    const now = Date.now();
    await withTransaction(app.db, async (tx) => {
      for (let n = 0; n < 1200; n++) {
        const row = {
          id: newId(),
          userId: a.userId,
          opportunityId: id,
          kind: 'note' as const,
          title: `n${n}`,
          bodyMd: null,
          occurredAt: now,
          participants: [],
          createdAt: now,
          updatedAt: now,
        };
        await tx.insert(activities).values(row).run();
        await indexActivity(tx, ctxOf(a), row);
      }
    });
    await deleteOpportunity(app.db, ctxOf(a), id);
    const after = await left(app, a, id);
    expect(after.activities).toEqual([]);
    expect(after.search.map((s) => s.id).sort()).toEqual([kept.id, kept.noteId].sort());
  });
});
