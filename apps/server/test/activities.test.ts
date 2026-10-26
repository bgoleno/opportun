import { newId } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';
import { exec } from './db';

const boot = useApi();
const DAY = 86_400_000;

async function createOpp(c: TestClient, title = 'Principal PM', companyName = 'Initech') {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName, title, sourceKind: 'manual' },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; title: string; companyId: string };
}

function addActivity(c: TestClient, oppId: string, body: Record<string, unknown> = {}) {
  return c.request({
    method: 'POST',
    url: `/api/v1/opportunities/${oppId}/activities`,
    payload: { kind: 'note', title: 'Recruiter call', ...body },
  });
}

function addStep(c: TestClient, oppId: string, body: Record<string, unknown> = {}) {
  return c.request({
    method: 'POST',
    url: `/api/v1/opportunities/${oppId}/next-steps`,
    payload: { action: 'Send thank-you note', ...body },
  });
}

function move(c: TestClient, id: string, body: Record<string, unknown>) {
  return c.request({ method: 'POST', url: `/api/v1/opportunities/${id}/stage`, payload: body });
}

async function insertCommunication(
  app: FastifyInstance,
  userId: string,
  needsReview: boolean,
): Promise<void> {
  const now = Date.now();
  await exec(
    app,
    `INSERT INTO communications (id, user_id, channel, external_id, "from", "to", sent_at,
         needs_review, created_at, updated_at)
       VALUES (?, ?, 'gmail', ?, 'r@example.com', '[]', ?, ?, ?, ?)`,
    newId(),
    userId,
    newId(),
    now,
    needsReview ? 1 : 0,
    now,
    now,
  );
}

describe('activities', () => {
  it('creates, lists, patches and deletes', async () => {
    const { a } = await boot();
    const opp = await createOpp(a);
    const at = Date.now() - DAY;
    const created = await addActivity(a, opp.id, {
      kind: 'interview',
      title: 'Hiring manager screen',
      bodyMd: 'Went well.',
      occurredAt: at,
      participants: ['Jane Doe'],
      externalUrl: 'https://meet.example.com/x',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      opportunityId: opp.id,
      userId: a.userId,
      kind: 'interview',
      title: 'Hiring manager screen',
      bodyMd: 'Went well.',
      occurredAt: at,
      participants: ['Jane Doe'],
    });
    const defaulted = (await addActivity(a, opp.id)).json();
    expect(defaulted.occurredAt).toBeGreaterThan(at);
    expect(defaulted.participants).toEqual([]);

    const list = await a.request({
      method: 'GET',
      url: `/api/v1/opportunities/${opp.id}/activities`,
    });
    expect(list.json().total).toBe(2);
    // Most recent first by default.
    expect(list.json().items.map((x: { id: string }) => x.id)).toEqual([
      defaulted.id,
      created.json().id,
    ]);

    const id = created.json().id;
    const patched = await a.request({
      method: 'PATCH',
      url: `/api/v1/activities/${id}`,
      payload: { title: 'HM screen', bodyMd: null },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      id,
      title: 'HM screen',
      bodyMd: null,
      kind: 'interview',
    });

    expect(
      (await a.request({ method: 'DELETE', url: `/api/v1/activities/${id}` })).statusCode,
    ).toBe(204);
    const after = await a.request({
      method: 'GET',
      url: `/api/v1/opportunities/${opp.id}/activities`,
    });
    expect(after.json().total).toBe(1);
  });

  it('rejects an unknown kind and a missing opportunity', async () => {
    const { a } = await boot();
    const opp = await createOpp(a);
    expect((await addActivity(a, opp.id, { kind: 'telepathy' })).statusCode).toBe(400);
    expect((await addActivity(a, newId())).statusCode).toBe(404);
  });

  it('cannot attach an activity to another user opportunity or list theirs', async () => {
    const { a, b } = await boot();
    const opp = await createOpp(a);
    await addActivity(a, opp.id);
    expect((await addActivity(b, opp.id)).statusCode).toBe(404);
    const list = await b.request({
      method: 'GET',
      url: `/api/v1/opportunities/${opp.id}/activities`,
    });
    expect(list.statusCode).toBe(404);
  });

  const createActivity = async (c: TestClient) => {
    const opp = await createOpp(c);
    return (await addActivity(c, opp.id)).json().id as string;
  };
  assertIsolated({
    name: 'activities (GET)',
    create: createActivity,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/activities/${id}` }),
  });
  assertIsolated({
    name: 'activities (PATCH)',
    create: createActivity,
    read: (c, id) =>
      c.request({ method: 'PATCH', url: `/api/v1/activities/${id}`, payload: { title: 'x' } }),
  });
  assertIsolated({
    name: 'activities (DELETE)',
    create: createActivity,
    read: (c, id) => c.request({ method: 'DELETE', url: `/api/v1/activities/${id}` }),
  });
  assertIsolated({
    name: 'opportunity activity list',
    create: async (c) => (await createOpp(c)).id,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/opportunities/${id}/activities` }),
  });
});

describe('next steps', () => {
  it('creates, lists, toggles done and deletes', async () => {
    const { a } = await boot();
    const opp = await createOpp(a);
    const due = Date.now() + DAY;
    const created = await addStep(a, opp.id, { dueAt: due, owner: 'me' });
    expect(created.statusCode).toBe(201);
    const step = created.json();
    expect(step).toMatchObject({
      opportunityId: opp.id,
      action: 'Send thank-you note',
      dueAt: due,
      doneAt: null,
      owner: 'me',
    });

    const done = await a.request({
      method: 'PATCH',
      url: `/api/v1/next-steps/${step.id}`,
      payload: { done: true },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().doneAt).toBeGreaterThan(0);

    const undone = await a.request({
      method: 'PATCH',
      url: `/api/v1/next-steps/${step.id}`,
      payload: { done: false },
    });
    expect(undone.json().doneAt).toBeNull();

    const explicit = await a.request({
      method: 'PATCH',
      url: `/api/v1/next-steps/${step.id}`,
      payload: { doneAt: 1_760_000_000_000, action: 'Send note' },
    });
    expect(explicit.json()).toMatchObject({ doneAt: 1_760_000_000_000, action: 'Send note' });
    const cleared = await a.request({
      method: 'PATCH',
      url: `/api/v1/next-steps/${step.id}`,
      payload: { doneAt: null },
    });
    expect(cleared.json().doneAt).toBeNull();
    const both = await a.request({
      method: 'PATCH',
      url: `/api/v1/next-steps/${step.id}`,
      payload: { done: true, doneAt: null },
    });
    expect(both.statusCode).toBe(400);

    await addStep(a, opp.id, { action: 'Undated' });
    await addStep(a, opp.id, { action: 'Sooner', dueAt: due - 1000 });
    const list = await a.request({
      method: 'GET',
      url: `/api/v1/opportunities/${opp.id}/next-steps`,
    });
    // Soonest due first, undated last.
    expect(list.json().items.map((s: { action: string }) => s.action)).toEqual([
      'Sooner',
      'Send note',
      'Undated',
    ]);

    expect(
      (await a.request({ method: 'DELETE', url: `/api/v1/next-steps/${step.id}` })).statusCode,
    ).toBe(204);
    const after = await a.request({
      method: 'GET',
      url: `/api/v1/opportunities/${opp.id}/next-steps`,
    });
    expect(after.json().total).toBe(2);
  });

  const createStep = async (c: TestClient) => {
    const opp = await createOpp(c);
    return (await addStep(c, opp.id)).json().id as string;
  };
  assertIsolated({
    name: 'next steps (PATCH)',
    create: createStep,
    read: (c, id) =>
      c.request({ method: 'PATCH', url: `/api/v1/next-steps/${id}`, payload: { done: true } }),
  });
  assertIsolated({
    name: 'next steps (DELETE)',
    create: createStep,
    read: (c, id) => c.request({ method: 'DELETE', url: `/api/v1/next-steps/${id}` }),
  });
  assertIsolated({
    name: 'opportunity next step list',
    create: async (c) => (await createOpp(c)).id,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/opportunities/${id}/next-steps` }),
  });
});

describe('timeline', () => {
  it('merges activities and stage history, newest first, with a kind discriminator', async () => {
    const { a } = await boot();
    const opp = await createOpp(a);
    const older = (
      await addActivity(a, opp.id, { title: 'Old note', occurredAt: Date.now() - DAY })
    ).json();
    expect((await move(a, opp.id, { to: 'applied', note: 'submitted' })).statusCode).toBe(200);
    const newer = (
      await addActivity(a, opp.id, {
        kind: 'meeting',
        title: 'Future meeting',
        occurredAt: Date.now() + DAY,
      })
    ).json();

    const res = await a.request({ method: 'GET', url: `/api/v1/opportunities/${opp.id}/timeline` });
    expect(res.statusCode).toBe(200);
    const { items, total } = res.json();
    expect(total).toBe(4);
    expect(items.map((i: { kind: string }) => i.kind)).toEqual([
      'activity',
      'stage',
      'stage',
      'activity',
    ]);
    expect(items[0]).toMatchObject({
      kind: 'activity',
      id: newer.id,
      activityKind: 'meeting',
      title: 'Future meeting',
      opportunityId: opp.id,
      opportunityTitle: 'Principal PM',
    });
    expect(items[1]).toMatchObject({
      kind: 'stage',
      fromStage: 'discovered',
      toStage: 'applied',
      note: 'submitted',
    });
    expect(items[2]).toMatchObject({ kind: 'stage', fromStage: null, toStage: 'discovered' });
    expect(items[3]).toMatchObject({ kind: 'activity', id: older.id });
    const times = items.map((i: { occurredAt: number }) => i.occurredAt);
    expect([...times].sort((x, y) => y - x)).toEqual(times);

    const page = await a.request({
      method: 'GET',
      url: `/api/v1/opportunities/${opp.id}/timeline?limit=2&offset=1`,
    });
    expect(page.json().total).toBe(4);
    expect(page.json().items.map((i: { id: string }) => i.id)).toEqual([items[1].id, items[2].id]);
  });

  assertIsolated({
    name: 'opportunity timeline',
    create: async (c) => (await createOpp(c)).id,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/opportunities/${id}/timeline` }),
  });
});

describe('dashboard', () => {
  it('counts stages, due next steps, recent activity and triage for the caller only', async () => {
    const { app, a, b } = await boot();
    const now = Date.now();
    const o1 = await createOpp(a, 'PM one');
    const o2 = await createOpp(a, 'PM two');
    const o3 = await createOpp(a, 'PM three');
    const o4 = await createOpp(a, 'PM four');
    await createOpp(a, 'PM five');
    await move(a, o1.id, { to: 'applied' });
    await move(a, o2.id, { to: 'applied' });
    await move(a, o3.id, { to: 'dismissed', dismissedReason: 'location' });
    await move(a, o4.id, { to: 'closed', closedReason: 'ghosted' });

    const dueSoon = (await addStep(a, o1.id, { action: 'Due soon', dueAt: now + 2 * DAY })).json();
    const overdue = (await addStep(a, o2.id, { action: 'Overdue', dueAt: now - DAY })).json();
    await addStep(a, o1.id, { action: 'Too far', dueAt: now + 10 * DAY });
    await addStep(a, o1.id, { action: 'Undated' });
    // Steps on terminal-stage opportunities never show as due.
    await addStep(a, o3.id, { action: 'On dismissed', dueAt: now + DAY });
    await addStep(a, o4.id, { action: 'On closed', dueAt: now - DAY });
    const doneStep = (await addStep(a, o1.id, { action: 'Done', dueAt: now + DAY })).json();
    await a.request({
      method: 'PATCH',
      url: `/api/v1/next-steps/${doneStep.id}`,
      payload: { done: true },
    });
    for (let i = 0; i < 12; i++)
      await addActivity(a, o1.id, { title: `note ${i}`, occurredAt: now + DAY + i });

    // User B's data must not leak into A's dashboard.
    const bOpp = await createOpp(b, 'B role');
    await addStep(b, bOpp.id, { action: 'B step', dueAt: now + DAY });
    await addActivity(b, bOpp.id, { title: 'B note', occurredAt: now + 2 * DAY });
    await insertCommunication(app, a.userId, true);
    await insertCommunication(app, a.userId, false);
    await insertCommunication(app, b.userId, true);

    const res = await a.request({ method: 'GET', url: '/api/v1/dashboard' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stageCounts).toEqual({
      discovered: 1,
      interested: 0,
      preparing: 0,
      applied: 2,
      in_process: 0,
      offer: 0,
      dismissed: 1,
      closed: 1,
    });
    expect(body.dueNextSteps.map((s: { id: string }) => s.id)).toEqual([overdue.id, dueSoon.id]);
    expect(body.dueNextSteps[0]).toMatchObject({
      action: 'Overdue',
      opportunityId: o2.id,
      opportunityTitle: 'PM two',
      companyName: 'Initech',
    });
    expect(body.recentActivity).toHaveLength(10);
    expect(body.recentActivity[0]).toMatchObject({ kind: 'activity', title: 'note 11' });
    expect(JSON.stringify(body.recentActivity)).not.toContain('B note');
    expect(body.needsTriage).toEqual({ communications: 1 });

    const asB = (await b.request({ method: 'GET', url: '/api/v1/dashboard' })).json();
    expect(asB.stageCounts.discovered).toBe(1);
    expect(asB.stageCounts.applied).toBe(0);
    expect(asB.dueNextSteps.map((s: { action: string }) => s.action)).toEqual(['B step']);
    expect(asB.needsTriage).toEqual({ communications: 1 });
  });

  it('requires a session', async () => {
    const { app } = await boot();
    expect((await app.inject({ method: 'GET', url: '/api/v1/dashboard' })).statusCode).toBe(401);
  });
});
