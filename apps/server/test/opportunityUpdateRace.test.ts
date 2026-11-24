// Saving an opportunity never writes back a company or a dedupe key that changed meanwhile
// (https://github.com/bgoleno/opportun/issues/889, tl's design there). The overlaps are Postgres's:
// on SQLite the write gate runs each transaction alone, so the same saves run one after the other
// and the same outcomes hold.
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { dedupeKey, type AtsJobRef } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { companies, opportunities } from '../src/db/schema';
import { writeGateOf } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import type { UserCtx } from '../src/repos/base';
import {
  createOpportunity,
  transitionOpportunity,
  updateOpportunity,
} from '../src/repos/opportunities';
import { useApi } from './api';
import { queryOne, sqliteOnly, testDialect } from './db';
import type { TestClient } from './isolation';
import { heldApart, pauseAt, settledOrWaiting } from './race';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
const LOCKED = 'opportunities.update.locked';

const create = (
  app: FastifyInstance,
  c: TestClient,
  title = 'Staff Engineer',
  companyName = 'Initech',
) => createOpportunity(app.db, ctxOf(c), { companyName, title, sourceKind: 'manual' });

const patch = (c: TestClient, id: string, payload: Record<string, unknown>) =>
  c.request({ method: 'PATCH', url: `/api/v1/opportunities/${id}`, payload });

const post = (c: TestClient, companyName: string, title: string) =>
  c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName, title, sourceKind: 'manual' },
  });

/** The row as stored, with its company's name. */
async function stored(app: FastifyInstance, id: string) {
  const row = await app.db
    .select({
      companyName: companies.name,
      title: opportunities.title,
      location: opportunities.location,
      descriptionMd: opportunities.descriptionMd,
      key: opportunities.dedupeKey,
    })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(eq(opportunities.id, id))
    .get();
  if (row === undefined) throw new Error('no such opportunity');
  return row;
}

/** The key is the one its own company, title and location make. */
async function expectKeyMatches(app: FastifyInstance, id: string) {
  const row = await stored(app, id);
  expect(row.key).toBe(dedupeKey(row.companyName, row.title, row.location));
  return row;
}

/** Waits until a caller is blocked by another: on any lock on Postgres, at the gate on SQLite. */
async function someoneBlocked(app: FastifyInstance): Promise<void> {
  const deadline = performance.now() + 10_000;
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
    if (n > 0) return;
    if (performance.now() > deadline) throw new Error('nobody was ever blocked');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('a save that is not about the company, title or location writes none of them back', () => {
  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['company', { companyName: 'Hooli' }, { companyName: 'Hooli' }],
    ['title', { title: 'Data Analyst' }, { title: 'Data Analyst' }],
    ['location', { location: 'Oslo' }, { location: 'Oslo' }],
  ])(
    'a %s changed while a description is being saved survives, with its key',
    async (_w, change, now) => {
      const { app, a } = await boot();
      const { id } = await create(app, a);
      onSlowTransaction(() => undefined);
      const pause = pauseAt(LOCKED);
      const describing = patch(a, id, { descriptionMd: 'What the job is.' });
      await pause.reached;
      const changing = patch(a, id, change);
      // Nothing holds the change back on Postgres: it commits while the description's save is open.
      const seen = await settledOrWaiting(app, changing);
      pause.release();
      expect(seen).toBe(testDialect === 'postgres' ? 'settled' : 'waiting');
      const [described, changed] = await Promise.all([describing, changing]);
      expect(described.statusCode, described.body).toBe(200);
      expect(changed.statusCode, changed.body).toBe(200);
      const row = await expectKeyMatches(app, id);
      expect(row).toMatchObject({ ...now, descriptionMd: 'What the job is.' });
    },
  );

  it('a key given up meanwhile stays given up', async () => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    await transitionOpportunity(app.db, ctxOf(a), id, {
      to: 'dismissed',
      dismissedReason: 'not_interested',
    });
    onSlowTransaction(() => undefined);
    const pause = pauseAt(LOCKED);
    const describing = patch(a, id, { descriptionMd: 'What the job was.' });
    await pause.reached;
    // A new opportunity takes the dismissed one's key over (createOpportunity's claim).
    const taking = post(a, 'Initech', 'Staff Engineer');
    const seen = await settledOrWaiting(app, taking);
    pause.release();
    expect(seen).toBe(testDialect === 'postgres' ? 'settled' : 'waiting');
    const [described, taken] = await Promise.all([describing, taking]);
    expect(described.statusCode, described.body).toBe(200);
    expect(taken.statusCode, taken.body).toBe(201);
    expect((await stored(app, id)).key).toBeNull();
    await expectKeyMatches(app, taken.json<{ id: string }>().id);
  });
});

describe('two saves that each change part of the key', () => {
  const COMPANY = { companyName: 'Hooli' };
  const TITLE = { title: 'Data Analyst' };
  const LOCATION = { location: 'Oslo' };
  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['the title, then the company', TITLE, COMPANY],
    ['the company, then the title', COMPANY, TITLE],
    ['the location, then the title', LOCATION, TITLE],
    ['the title, then the location', TITLE, LOCATION],
  ])('%s: the second waits, and the key matches what is stored', async (_what, one, two) => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    const [first, second] = await heldApart(
      app,
      LOCKED,
      () => patch(a, id, one),
      () => patch(a, id, two),
    );
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(await expectKeyMatches(app, id)).toMatchObject({ ...one, ...two });
  });

  // Postgres only: on SQLite the delete would wait at the gate behind the save. The delete waits for
  // the user's lock as well (#920, below), so the row goes here by a plain DELETE.
  it.runIf(!sqliteOnly)('an opportunity gone while its save waits is not found', async () => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    const other = await create(app, a, 'Another Job');
    onSlowTransaction(() => undefined);
    const pause = pauseAt(LOCKED);
    const first = patch(a, other.id, { title: 'Yet Another Job' });
    await pause.reached;
    const second = patch(a, id, COMPANY);
    const seen = await settledOrWaiting(app, second, pause);
    await app.db.delete(opportunities).where(eq(opportunities.id, id)).run();
    pause.release();
    expect(seen).toBe('waiting');
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(404);
  });

  it('a delete waits for a save that is being made, and a save behind it is not found', async () => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    const other = await create(app, a, 'Another Job');
    onSlowTransaction(() => undefined);
    const pause = pauseAt(LOCKED);
    const first = patch(a, other.id, { title: 'Yet Another Job' });
    await pause.reached;
    const deleting = a.request({ method: 'DELETE', url: `/api/v1/opportunities/${id}` });
    const seen = await settledOrWaiting(app, deleting, pause);
    // Behind the delete whenever it comes: the lock goes to whoever asked first.
    const second = patch(a, id, COMPANY);
    pause.release();
    expect(seen).toBe('waiting');
    expect((await first).statusCode).toBe(200);
    expect((await deleting).statusCode).toBe(204);
    expect((await second).statusCode).toBe(404);
  });
});

describe("a create and an update that claim one dismissed holder's key: neither deadlocks", () => {
  async function dismissedHolder(app: FastifyInstance, c: TestClient): Promise<string> {
    const { id } = await create(app, c, 'Data Analyst', 'Hooli');
    await transitionOpportunity(app.db, ctxOf(c), id, {
      to: 'dismissed',
      dismissedReason: 'not_interested',
    });
    return id;
  }
  const CLAIM = { companyName: 'Hooli', title: 'Data Analyst' };

  it('the create holds the dismissed row', async () => {
    const { app, a } = await boot();
    const holder = await dismissedHolder(app, a);
    const { id } = await create(app, a);
    onSlowTransaction(() => undefined);
    const pause = pauseAt('opportunities.create.locked');
    const creating = post(a, CLAIM.companyName, CLAIM.title);
    await pause.reached;
    const updating = patch(a, id, CLAIM);
    await someoneBlocked(app);
    pause.release();
    const [created, updated] = await Promise.all([creating, updating]);
    expect(created.statusCode, created.body).toBe(201);
    expect(updated.statusCode, updated.body).toBe(409);
    expect(updated.json<{ error: { existingId: string } }>().error.existingId).toBe(
      created.json<{ id: string }>().id,
    );
    expect((await stored(app, holder)).key).toBeNull();
    await expectKeyMatches(app, created.json<{ id: string }>().id);
    expect(await expectKeyMatches(app, id)).toMatchObject({ companyName: 'Initech' });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['company and title', CLAIM, 'Initech'],
    ['title alone', { title: CLAIM.title }, CLAIM.companyName],
  ])('the update holds it, changing the %s', async (_what, change, from) => {
    const { app, a } = await boot();
    const holder = await dismissedHolder(app, a);
    const { id } = await create(app, a, 'Staff Engineer', from);
    onSlowTransaction(() => undefined);
    const pause = pauseAt(LOCKED);
    const updating = patch(a, id, change);
    await pause.reached;
    const creating = post(a, CLAIM.companyName, CLAIM.title);
    await someoneBlocked(app);
    pause.release();
    const [updated, created] = await Promise.all([updating, creating]);
    expect(updated.statusCode, updated.body).toBe(200);
    expect(created.statusCode, created.body).toBe(409);
    expect(created.json<{ error: { existingId: string } }>().error.existingId).toBe(id);
    expect((await stored(app, holder)).key).toBeNull();
    expect(await expectKeyMatches(app, id)).toMatchObject(CLAIM);
  });

  it("the lock is the user's: another user's save goes ahead", async () => {
    const { app, a, b } = await boot();
    const mine = await create(app, a);
    const theirs = await create(app, b);
    onSlowTransaction(() => undefined);
    const pause = pauseAt(LOCKED);
    const first = patch(a, mine.id, { title: 'Data Analyst' });
    await pause.reached;
    const other = patch(b, theirs.id, { title: 'Data Analyst' });
    const seen = await settledOrWaiting(app, other, pause);
    pause.release();
    await Promise.all([first, other]);
    expect(seen).toBe(testDialect === 'postgres' ? 'arrived' : 'waiting');
  });
});

// tl on #910: the identity of a `gh_jid` link was proven on the company's own boards (#785), so a
// company change drops it, and a link save that read it before must not put it back.
describe('a link save and a company save: an identity proven for the old company goes', () => {
  const PROVEN: AtsJobRef = {
    kind: 'ats_greenhouse',
    org: 'initech',
    externalId: '1000001',
    url: 'https://boards.greenhouse.io/initech/jobs/1000001',
    verifiedVia: 'gh_jid',
  };
  const LINK = { postingUrl: 'https://www.initech.example/careers/two?gh_jid=1000001' };
  const COMPANY = { companyName: 'Hooli' };

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['the link, then the company', LINK, COMPANY],
    ['the company, then the link', COMPANY, LINK],
  ])('%s', async (_what, one, two) => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    await app.db
      .update(opportunities)
      .set({
        postingUrl: 'https://www.initech.example/careers/one?gh_jid=1000001',
        atsJobRef: PROVEN,
        postingState: 'confirmed',
      })
      .where(eq(opportunities.id, id));
    onSlowTransaction(() => undefined);
    const pause = pauseAt(LOCKED);
    // The repository's own save: the route also asks Greenhouse about a new link.
    const first = updateOpportunity(app.db, ctxOf(a), id, one);
    await pause.reached;
    const second = updateOpportunity(app.db, ctxOf(a), id, two);
    const seen = await settledOrWaiting(app, second, pause);
    pause.release();
    await Promise.all([first, second]);
    const row = await app.db
      .select({ postingUrl: opportunities.postingUrl, atsJobRef: opportunities.atsJobRef })
      .from(opportunities)
      .where(eq(opportunities.id, id))
      .get();
    expect(await expectKeyMatches(app, id)).toMatchObject(COMPANY);
    expect(row).toEqual({ ...LINK, atsJobRef: null });
    expect(seen).toBe('waiting');
  });

  it('the same job on a new link, with the company as it was, keeps it', async () => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    await app.db.update(opportunities).set({ atsJobRef: PROVEN }).where(eq(opportunities.id, id));
    const saved = await updateOpportunity(app.db, ctxOf(a), id, LINK);
    expect(saved.atsJobRef).toEqual(PROVEN);
  });
});

describe('what a save leaves as it was', () => {
  it('a patch with none of the three leaves the key, whatever it is', async () => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    // As after a rename on the company's own page: the key is of the name the opportunity had.
    const key = 'a key of another name';
    await app.db.update(opportunities).set({ dedupeKey: key }).where(eq(opportunities.id, id));
    for (const p of [
      { descriptionMd: 'x' },
      { priority: 3 },
      { postingUrl: 'https://example.com/jobs/1' },
      { compNote: null },
    ]) {
      const res = await patch(a, id, p);
      expect(res.statusCode, res.body).toBe(200);
      expect((await stored(app, id)).key).toBe(key);
    }
  });

  it('an opportunity with no key has none after any save', async () => {
    const { app, a } = await boot();
    await create(app, a);
    const { id } = await createOpportunity(
      app.db,
      ctxOf(a),
      { companyName: 'Initech', title: 'Staff Engineer', sourceKind: 'manual' },
      { force: true },
    );
    expect((await stored(app, id)).key).toBeNull();
    for (const p of [
      { descriptionMd: 'x' },
      { title: 'Data Analyst' },
      { companyName: 'Hooli' },
      { location: 'Oslo' },
    ]) {
      const res = await patch(a, id, p);
      expect(res.statusCode, res.body).toBe(200);
      expect((await stored(app, id)).key).toBeNull();
    }
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['title', { title: 'Data Analyst' }, { companyName: 'Initech', title: 'Staff Engineer' }],
    ['company', { companyName: 'Hooli' }, { companyName: 'Initech', title: 'Data Analyst' }],
  ])(
    'a %s that a live opportunity already has is a duplicate, and nothing is written',
    async (w, p, from) => {
      const { app, a } = await boot();
      const taken = await create(app, a, 'Data Analyst', w === 'title' ? 'Initech' : 'Hooli');
      const { id } = await create(app, a, from.title as string, from.companyName as string);
      const before = await stored(app, id);
      const res = await patch(a, id, { ...p, descriptionMd: 'Not kept.' });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: 'duplicate', existingId: taken.id } });
      expect(await stored(app, id)).toEqual(before);
      const company = await app.db
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.userId, a.userId), eq(companies.name, 'Hooli')))
        .all();
      expect(company).toHaveLength(w === 'title' ? 0 : 1);
    },
  );
});
