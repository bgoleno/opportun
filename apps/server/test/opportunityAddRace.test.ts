// Adding to an opportunity, or moving it, beside its delete
// (https://github.com/bgoleno/opportun/issues/925): a delete that wins leaves the other with 404 and
// nothing written, where it failed on a foreign key (500). The overlaps are Postgres's; SQLite's write
// gate runs them one after the other, and the same outcomes hold.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  activities,
  attachments,
  dismissalFeedback,
  nextSteps,
  opportunities,
  stageHistory,
} from '../src/db/schema';
import { onSlowTransaction } from '../src/db/gate';
import type { Exec, UserCtx } from '../src/repos/base';
import { createActivity, createNextStep, createReferral } from '../src/repos/activities';
import { createAttachment } from '../src/repos/attachments';
import { createContact } from '../src/repos/contacts';
import { createOpportunity, transitionOpportunityIn } from '../src/repos/opportunities';
import { useApi } from './api';
import { queryAll } from './db';
import type { TestClient } from './isolation';
import { heldOpen, pauseAt, someoneBlocked } from './race';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

const create = (app: FastifyInstance, c: TestClient) =>
  createOpportunity(app.db, ctxOf(c), {
    companyName: 'Initech',
    title: 'Staff Engineer',
    sourceKind: 'manual',
  });
const post = (c: TestClient, url: string, payload: Record<string, unknown>) =>
  c.request({ method: 'POST', url: `/api/v1/opportunities/${url}`, payload });
const remove = (c: TestClient, id: string) =>
  c.request({ method: 'DELETE', url: `/api/v1/opportunities/${id}` });

const FILE = {
  filename: 'offer.pdf',
  mime: 'application/pdf',
  bytes: 3,
  sha256: 'a'.repeat(64),
  storedPath: 'attachments/a',
};
const NOTE = {
  kind: 'note' as const,
  title: 'A note',
  bodyMd: 'noted',
  occurredAt: 1,
  participants: [],
  externalUrl: null,
};

/** Every row that names the opportunity, and every search row the user has. */
async function rowsOf(app: FastifyInstance, c: TestClient, id: string) {
  const of = async (table: typeof activities | typeof nextSteps | typeof attachments) =>
    (await app.db.select({ id: table.id }).from(table).where(eq(table.opportunityId, id)).all())
      .length;
  return {
    opportunity: (
      await app.db
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(eq(opportunities.id, id))
        .all()
    ).length,
    activities: await of(activities),
    nextSteps: await of(nextSteps),
    attachments: await of(attachments),
    history: (
      await app.db
        .select({ id: stageHistory.id })
        .from(stageHistory)
        .where(eq(stageHistory.opportunityId, id))
        .all()
    ).length,
    feedback: (
      await app.db
        .select({ id: dismissalFeedback.id })
        .from(dismissalFeedback)
        .where(eq(dismissalFeedback.userId, c.userId))
        .all()
    ).length,
    search: (
      await queryAll(
        app,
        "SELECT entity_id FROM search_index WHERE user_id = ? AND entity_kind IN ('opportunity', 'activity')",
        c.userId,
      )
    ).length,
  };
}
const NOTHING = {
  opportunity: 0,
  activities: 0,
  nextSteps: 0,
  attachments: 0,
  history: 0,
  feedback: 0,
  search: 0,
};

type Add = (c: TestClient, app: FastifyInstance, id: string, contactId: string) => Promise<number>;
/** The status a repository call ends as: what the route answers. */
const statusOf = (p: Promise<unknown>): Promise<number> =>
  p.then(
    () => 201,
    (e: unknown) => (e as { statusCode?: number }).statusCode ?? 500,
  );
const ADDS: [string, Add][] = [
  ['an activity', async (c, _a, id) => (await post(c, `${id}/activities`, NOTE)).statusCode],
  [
    'a next step',
    async (c, _a, id) => (await post(c, `${id}/next-steps`, { action: 'Call' })).statusCode,
  ],
  ['a file', (c, app, id) => statusOf(createAttachment(app.db, ctxOf(c), id, FILE))],
  [
    'a referral ask',
    (c, app, id, contactId) => statusOf(createReferral(app.db, ctxOf(c), id, { contactId })),
  ],
  [
    'a stage move',
    async (c, _a, id) => (await post(c, `${id}/stage`, { to: 'interested' })).statusCode,
  ],
  [
    'a dismissal',
    async (c, _a, id) =>
      (await post(c, `${id}/stage`, { to: 'dismissed', dismissedReason: 'not_interested' }))
        .statusCode,
  ],
];

describe('the delete first: the other is not found, and nothing is written', () => {
  it.each(ADDS)('%s', async (_what, add) => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    const contact = await createContact(app.db, ctxOf(a), { name: 'Dana Testworth' });
    onSlowTransaction(() => undefined);
    const pause = pauseAt('opportunities.delete.locked');
    const deleting = remove(a, id);
    await pause.reached;
    const adding = add(a, app, id, contact.id);
    const blocked = await someoneBlocked(app);
    pause.release();
    const [deleted, added] = await Promise.all([deleting, adding]);
    expect(blocked).toBe(true);
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(added).toBe(404);
    expect(await rowsOf(app, a, id)).toEqual(NOTHING);
  });
});

describe('the other first: both are done, and all of it goes with the opportunity', () => {
  const HELD: [
    string,
    (tx: Exec, ctx: UserCtx, id: string, contactId: string) => Promise<unknown>,
  ][] = [
    ['an activity', (tx, ctx, id) => createActivity(tx, ctx, id, NOTE)],
    ['a next step', (tx, ctx, id) => createNextStep(tx, ctx, id, { action: 'Call' })],
    ['a file', (tx, ctx, id) => createAttachment(tx as never, ctx, id, FILE)],
    [
      'a referral ask',
      (tx, ctx, id, contactId) => createReferral(tx as never, ctx, id, { contactId }),
    ],
    ['a stage move', (tx, ctx, id) => transitionOpportunityIn(tx, ctx, id, { to: 'interested' })],
  ];
  it.each(HELD)('%s', async (_what, add) => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    const contact = await createContact(app.db, ctxOf(a), { name: 'Dana Testworth' });
    onSlowTransaction(() => undefined);
    const other = heldOpen(app, (tx) => add(tx, ctxOf(a), id, contact.id));
    await other.reached;
    const deleting = remove(a, id);
    const blocked = await someoneBlocked(app);
    other.go();
    const [, deleted] = await Promise.all([other.done, deleting]);
    expect(blocked).toBe(true);
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await rowsOf(app, a, id)).toEqual(NOTHING);
  });
});

describe('controls', () => {
  it.each(ADDS)('%s with nothing beside it', async (_what, add) => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    const contact = await createContact(app.db, ctxOf(a), { name: 'Dana Testworth' });
    expect([200, 201]).toContain(await add(a, app, id, contact.id));
  });

  it.each(ADDS)("%s of another user's, or of none, is not found", async (_what, add) => {
    const { app, a, b } = await boot();
    const { id } = await create(app, a);
    const contact = await createContact(app.db, ctxOf(b), { name: 'Dana Testworth' });
    const before = await rowsOf(app, a, id);
    expect(await add(b, app, id, contact.id)).toBe(404);
    expect(await add(b, app, '01a00000-0000-7000-8000-000000000000', contact.id)).toBe(404);
    expect(await rowsOf(app, a, id)).toEqual(before);
  });

  it('two adds at once do not wait for each other', async () => {
    const { app, a } = await boot();
    const { id } = await create(app, a);
    onSlowTransaction(() => undefined);
    const first = heldOpen(app, (tx) => createActivity(tx, ctxOf(a), id, NOTE));
    await first.reached;
    const second = post(a, `${id}/next-steps`, { action: 'Call' });
    const done = await Promise.race([
      second.then(() => 'done'),
      someoneBlocked(app).then((b) => (b ? 'blocked' : 'neither')),
    ]);
    first.go();
    await first.done;
    expect((await second).statusCode).toBe(201);
    expect(done).toBe(process.env.TEST_DB_DIALECT === 'postgres' ? 'done' : 'blocked');
  });
});
