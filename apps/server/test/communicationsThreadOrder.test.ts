// An opportunity's thread in the order the tab shows it (https://github.com/bgoleno/opportun/issues/394):
// the cap applies after ordering, so newest first on a long thread is the newest 200, not the
// oldest 200 turned round. Without `order`, a thread stays oldest first and the Inbox newest
// first, as before.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { communications } from '../src/db/schema';
import { upsertInbound } from '../src/repos/communications';
import { createOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const COUNT = 205;
const T0 = Date.UTC(2026, 0, 1);

async function longThread(app: Awaited<ReturnType<typeof boot>>['app'], c: TestClient) {
  const ctx = ctxOf(c);
  const opp = await createOpportunity(app.db, ctx, {
    companyName: 'Acme',
    title: 'Staff Engineer',
    sourceKind: 'manual',
  });
  for (let i = 0; i < COUNT; i++) {
    const { id } = await upsertInbound(app.db, ctx, 'gmail', {
      externalId: `m-${i}`,
      threadKey: 't-long',
      from: 'recruiter@acme.example',
      to: ['me@example.com'],
      subject: `Message ${i}`,
      snippet: '',
      bodyText: '',
      sentAt: T0 + i * 60_000,
    });
    await app.db
      .update(communications)
      .set({ opportunityId: opp.id })
      .where(eq(communications.id, id))
      .run();
  }
  return opp.id;
}

const subjects = (body: { items: { subject: string | null }[] }) =>
  body.items.map((m) => m.subject);

describe("an opportunity's thread over the cap (#394)", () => {
  it('newest first: the newest 200, newest at the top; oldest first: the oldest 200', async () => {
    const { app, a } = await boot();
    const id = await longThread(app, a);
    const list = async (order?: string) =>
      (
        await a.request({
          method: 'GET',
          url: `/api/v1/communications?view=all&opportunityId=${id}&limit=200${order === undefined ? '' : `&order=${order}`}`,
        })
      ).json();

    const newest = await list('newest');
    expect(newest.total).toBe(COUNT);
    expect(newest.items).toHaveLength(200);
    expect(subjects(newest)[0]).toBe(`Message ${COUNT - 1}`);
    expect(subjects(newest).at(-1)).toBe(`Message ${COUNT - 200}`);

    const oldest = await list('oldest');
    expect(oldest.items).toHaveLength(200);
    expect(subjects(oldest)[0]).toBe('Message 0');
    expect(subjects(oldest).at(-1)).toBe('Message 199');

    // No order asked: the thread stays oldest first, as before.
    expect(subjects(await list())).toEqual(subjects(oldest));
  });

  // https://github.com/bgoleno/opportun/issues/422: the tab shows the rest of a long thread with
  // the next page, so a page must carry on from the last one in the same order, with no message
  // twice and none missed.
  it('the next page in either order carries on from the first: the rest, none twice', async () => {
    const { app, a } = await boot();
    const id = await longThread(app, a);
    const page = async (order: string, offset: number) =>
      (
        await a.request({
          method: 'GET',
          url: `/api/v1/communications?view=all&opportunityId=${id}&order=${order}&limit=200&offset=${offset}`,
        })
      ).json();
    for (const order of ['newest', 'oldest']) {
      const first = subjects(await page(order, 0));
      const rest = await page(order, 200);
      expect(rest.total).toBe(COUNT);
      expect(subjects(rest)).toHaveLength(COUNT - 200);
      const all = [...first, ...subjects(rest)];
      expect(new Set(all).size).toBe(COUNT);
      const numbers = all.map((s) => Number(s?.replace('Message ', '')));
      const sorted = [...numbers].sort((x, y) => (order === 'oldest' ? x - y : y - x));
      expect(numbers).toEqual(sorted);
    }
  });

  it('the Inbox without an order is still newest first', async () => {
    const { app, a } = await boot();
    await longThread(app, a);
    const res = await a.request({ method: 'GET', url: '/api/v1/communications?view=all&limit=3' });
    expect(subjects(res.json())).toEqual([
      `Message ${COUNT - 1}`,
      `Message ${COUNT - 2}`,
      `Message ${COUNT - 3}`,
    ]);
  });
});
