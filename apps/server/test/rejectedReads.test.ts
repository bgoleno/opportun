// A rejected message is read by nothing that lists, counts, links or searches messages. Each case
// has a rejected message as an earlier release left it, beside one that is not rejected.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { communications } from '../src/db/schema';
import { ingestInbound } from '../src/jobs/mailIngest';
import { dashboard, lastActivityAt } from '../src/repos/activities';
import { applyClassification, upsertInbound } from '../src/repos/communications';
import { createOpportunity } from '../src/repos/opportunities';
import { indexCommunication, search } from '../src/repos/search';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const T = Date.now() - 3_600_000;

let seq = 0;
async function message(
  app: FastifyInstance,
  c: TestClient,
  over: Partial<typeof communications.$inferInsert> = {},
) {
  seq += 1;
  const { id } = await upsertInbound(app.db, ctxOf(c), 'gmail', {
    externalId: `msg-${seq}`,
    threadKey: `thread-${seq}`,
    from: 'Priya Shah <priya@initech.example>',
    to: ['me@example.com'],
    subject: 'Staff engineer',
    snippet: 'Hiring',
    bodyText: 'Hiring',
    sentAt: T + seq,
  });
  if (Object.keys(over).length > 0) {
    await app.db.update(communications).set(over).where(eq(communications.id, id));
  }
  return id;
}
const REJECTED = { rejectedAt: T, rejectionReason: 'spam' as const, subject: null, snippet: null };
const opportunity = (app: FastifyInstance, c: TestClient) =>
  createOpportunity(app.db, ctxOf(c), {
    companyName: 'Globex',
    title: 'Engineer',
    sourceKind: 'manual',
  });

describe.each<[string, boolean]>([
  ['kept', false],
  ['rejected', true],
])('a %s message', (_what, rejected) => {
  const over = rejected ? REJECTED : {};
  const n = rejected ? 0 : 1;

  it('on the timeline of its opportunity, and in the recent activity', async () => {
    const { app, a } = await boot();
    const opp = await opportunity(app, a);
    await message(app, a, { ...over, opportunityId: opp.id });
    const res = await a.request({ method: 'GET', url: `/api/v1/opportunities/${opp.id}/timeline` });
    const { items, total } = res.json<{ items: { kind: string }[]; total: number }>();
    expect(items.filter((i) => i.kind === 'communication')).toHaveLength(n);
    expect(total).toBe(items.length);
    const { recentActivity } = await dashboard(app.db, ctxOf(a));
    expect(recentActivity.filter((i) => i.kind === 'communication')).toHaveLength(n);
  });

  it('as the last activity of its opportunity', async () => {
    const { app, a } = await boot();
    const opp = await opportunity(app, a);
    await message(app, a, { ...over, opportunityId: opp.id });
    expect((await lastActivityAt(app.db, ctxOf(a), [opp.id])).size).toBe(n);
  });

  it('in the count that needs review', async () => {
    const { app, a } = await boot();
    await message(app, a, { ...over, needsReview: true });
    expect((await dashboard(app.db, ctxOf(a))).needsTriage).toEqual({ communications: n });
  });

  it('as what links the rest of its thread', async () => {
    const { app, a } = await boot();
    const opp = await opportunity(app, a);
    await message(app, a, { ...over, opportunityId: opp.id, threadKey: 'one-thread' });
    const id = await message(app, a, { threadKey: 'one-thread' });
    const out = await applyClassification(
      app.db,
      ctxOf(a),
      id,
      {
        classification: 'other',
        outreachKind: null,
        mismatchReason: null,
        opportunityMatch: null,
        proposedTransition: null,
        confidence: 0.9,
        hardConstraintViolation: null,
      },
      'payload',
    );
    expect(out?.communication.opportunityId).toBe(rejected ? null : opp.id);
  });

  it('as what lets the rest of its thread through the filter', async () => {
    const { app, a } = await boot();
    const opp = await opportunity(app, a);
    await message(app, a, { ...over, opportunityId: opp.id, threadKey: 'one-thread' });
    const { id } = await ingestInbound(app.db, ctxOf(a), app.storage, 'gmail', {
      externalId: 'reply',
      threadKey: 'one-thread',
      from: 'Sam <sam@unknown.example>',
      to: ['me@example.com'],
      subject: 'Re: lunch',
      snippet: 'See you',
      bodyText: 'See you on Tuesday.',
      sentAt: T,
    });
    const row = await app.db.select().from(communications).where(eq(communications.id, id)).get();
    expect(row?.triageDecision).toBe(rejected ? 'filtered' : 'passed');
  });

  it('in the search, where an entry of it was left', async () => {
    const { app, a } = await boot();
    const id = await message(app, a, over);
    await indexCommunication(app.db, ctxOf(a), { id, subject: 'Zebra', snippet: 'stripes' });
    const res = await search(app.db, ctxOf(a), 'zebra', { limit: 10, offset: 0 });
    expect(res.items).toHaveLength(n);
    expect(res.total).toBe(n);
  });
});
