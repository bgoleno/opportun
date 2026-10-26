// Referral tracking (Task 22, FR-C4): an ask is a 'referral' activity linked to the contact
// (participants [{contactId, name}]) with its status in the body; PATCH moves the status; the
// timeline shows it and the contact view lists its referrals. Everything is user-scoped.
import { describe, expect, it } from 'vitest';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';

const boot = useApi();

async function createOpp(c: TestClient, title = 'Staff Platform Engineer') {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName: 'Initech', title, sourceKind: 'manual' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}

async function createContact(c: TestClient, name = 'Jane Doe') {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/contacts',
    payload: { name, company: 'Initech' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; name: string };
}

function ask(c: TestClient, oppId: string, body: Record<string, unknown>) {
  return c.request({
    method: 'POST',
    url: `/api/v1/opportunities/${oppId}/referrals`,
    payload: body,
  });
}

function setStatus(c: TestClient, activityId: string, referralStatus: string) {
  return c.request({
    method: 'PATCH',
    url: `/api/v1/activities/${activityId}`,
    payload: { referralStatus },
  });
}

describe('referral asks', () => {
  it('records an ask as a referral activity linked to the contact', async () => {
    const { a } = await boot();
    const opp = await createOpp(a);
    const jane = await createContact(a);
    const res = await ask(a, opp.id, { contactId: jane.id, note: 'Sent my resume over chat.' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      opportunityId: opp.id,
      kind: 'referral',
      title: 'Referral ask: Jane Doe',
      participants: [{ contactId: jane.id, name: 'Jane Doe' }],
      bodyMd: 'Status: asked\n\nSent my resume over chat.',
    });

    // Asking the same contact again for the same opportunity is a duplicate.
    const again = await ask(a, opp.id, { contactId: jane.id });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.existingId).toBe(res.json().id);

    const listed = await a.request({
      method: 'GET',
      url: `/api/v1/opportunities/${opp.id}/referrals`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [
        {
          activityId: res.json().id,
          contactId: jane.id,
          name: 'Jane Doe',
          status: 'asked',
          note: 'Sent my resume over chat.',
          occurredAt: expect.any(Number),
        },
      ],
      total: 1,
    });
  });

  it('moves the status through asked, agreed, submitted (and declined) on the activity', async () => {
    const { a } = await boot();
    const opp = await createOpp(a);
    const jane = await createContact(a);
    const id = (await ask(a, opp.id, { contactId: jane.id, note: 'Coffee chat first.' })).json()
      .id as string;

    for (const status of ['agreed', 'submitted', 'declined', 'asked']) {
      const res = await setStatus(a, id, status);
      expect(res.statusCode, res.body).toBe(200);
      // The note survives every transition.
      expect(res.json().bodyMd).toBe(`Status: ${status}\n\nCoffee chat first.`);
    }
    expect((await setStatus(a, id, 'maybe')).statusCode).toBe(400);

    // Status cannot be set on an activity that is not a referral.
    const note = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${opp.id}/activities`,
      payload: { kind: 'note', title: 'Call' },
    });
    const bad = await setStatus(a, note.json().id, 'agreed');
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('not_a_referral');

    // A body edit together with a status keeps the status line first.
    const both = await a.request({
      method: 'PATCH',
      url: `/api/v1/activities/${id}`,
      payload: { referralStatus: 'submitted', bodyMd: 'Submitted through the portal.' },
    });
    expect(both.json().bodyMd).toBe('Status: submitted\n\nSubmitted through the portal.');
  });

  it('shows referral asks on the opportunity timeline', async () => {
    const { a } = await boot();
    const opp = await createOpp(a);
    const jane = await createContact(a);
    const id = (await ask(a, opp.id, { contactId: jane.id })).json().id as string;
    await setStatus(a, id, 'agreed');
    const res = await a.request({ method: 'GET', url: `/api/v1/opportunities/${opp.id}/timeline` });
    expect(res.statusCode, res.body).toBe(200);
    const item = (res.json() as { items: Record<string, unknown>[] }).items.find(
      (i) => i.id === id,
    );
    expect(item).toMatchObject({
      kind: 'activity',
      activityKind: 'referral',
      title: 'Referral ask: Jane Doe',
      bodyMd: 'Status: agreed',
      participants: [{ contactId: jane.id, name: 'Jane Doe' }],
    });
  });

  it('lists a contact referrals on the contact view, newest first', async () => {
    const { a } = await boot();
    const first = await createOpp(a, 'Staff Platform Engineer');
    const second = await createOpp(a, 'Principal Engineer');
    const jane = await createContact(a);
    const sam = await createContact(a, 'Sam Lee');
    const r1 = (await ask(a, first.id, { contactId: jane.id })).json().id as string;
    const r2 = (await ask(a, second.id, { contactId: jane.id })).json().id as string;
    await ask(a, first.id, { contactId: sam.id });
    await setStatus(a, r1, 'submitted');

    const view = await a.request({ method: 'GET', url: `/api/v1/contacts/${jane.id}` });
    expect(view.statusCode).toBe(200);
    const referrals = view.json().referrals as Record<string, unknown>[];
    expect(referrals.map((r) => r.activityId).sort()).toEqual([r1, r2].sort());
    expect(referrals.find((r) => r.activityId === r1)).toMatchObject({
      opportunityId: first.id,
      opportunityTitle: 'Staff Platform Engineer',
      companyName: 'Initech',
      status: 'submitted',
    });
    expect(referrals.find((r) => r.activityId === r2)).toMatchObject({ status: 'asked' });
    // A plain-text participant with the same name never links.
    await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${first.id}/activities`,
      payload: { kind: 'referral', title: 'Manual', participants: [jane.id, 'Jane Doe'] },
    });
    const again = await a.request({ method: 'GET', url: `/api/v1/contacts/${jane.id}` });
    expect(again.json().referrals).toHaveLength(2);
  });

  it("refuses another user's contact or opportunity, and never lists across users", async () => {
    const { a, b } = await boot();
    const oppA = await createOpp(a);
    const janeA = await createContact(a);
    const oppB = await createOpp(b);
    const janeB = await createContact(b);

    expect((await ask(b, oppA.id, { contactId: janeB.id })).statusCode).toBe(404);
    expect((await ask(b, oppB.id, { contactId: janeA.id })).statusCode).toBe(404);
    const mine = (await ask(a, oppA.id, { contactId: janeA.id })).json().id as string;
    expect((await setStatus(b, mine, 'declined')).statusCode).toBe(404);
    const listB = await b.request({
      method: 'GET',
      url: `/api/v1/opportunities/${oppA.id}/referrals`,
    });
    expect(listB.statusCode).toBe(404);
    const viewB = await b.request({ method: 'GET', url: `/api/v1/contacts/${janeB.id}` });
    expect(viewB.json().referrals).toEqual([]);
  });
});

assertIsolated({
  name: 'referral asks (status PATCH)',
  create: async (c) => {
    const opp = await createOpp(c);
    const contact = await createContact(c);
    const res = await ask(c, opp.id, { contactId: contact.id });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  },
  read: (c, id) => setStatus(c, id, 'agreed'),
});

assertIsolated({
  name: 'opportunity referral list',
  create: async (c) => (await createOpp(c)).id,
  read: (c, id) => c.request({ method: 'GET', url: `/api/v1/opportunities/${id}/referrals` }),
});
