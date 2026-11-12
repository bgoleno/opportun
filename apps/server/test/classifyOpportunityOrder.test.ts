// The open opportunities in the comms.classify prompt are in a stable order
// (https://github.com/bgoleno/opportun/issues/380, tl's ruling): the same set as before (the
// MAX_OPEN_OPPORTUNITIES most recently updated), ordered by when each was created, then by id.
// The list sits in the provider-cached prefix, and one cache entry covers the whole prefix: in
// updatedAt order, every message a batch linked to an opportunity reordered the list and made the
// next call write the whole prefix again.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { opportunities } from '../src/db/schema';
import { openOpportunitiesText } from '../src/jobs/classify';
import { createOpportunity, updateOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

describe('openOpportunitiesText: a stable order (#380)', () => {
  it('lists the open opportunities in the order they were created, and an update does not reorder them', async () => {
    const { app, a } = await boot();
    const ids: string[] = [];
    for (const [company, title] of [
      ['Initech', 'Staff Engineer'],
      ['Globex', 'Platform Lead'],
      ['Hooli', 'Principal Engineer'],
    ] as const) {
      const o = await createOpportunity(app.db, ctxOf(a), {
        companyName: company,
        title,
        sourceKind: 'manual',
      });
      ids.push(o.id);
    }
    const before = await openOpportunitiesText(app.db, ctxOf(a));
    expect(before.split('\n').map((l) => l.split(' | ')[0])).toEqual([
      '- Initech',
      '- Globex',
      '- Hooli',
    ]);
    // What linking a message does to an opportunity: its updatedAt moves.
    await updateOpportunity(app.db, ctxOf(a), ids[0]!, { title: 'Staff Engineer' });
    await app.db
      .update(opportunities)
      .set({ updatedAt: Date.now() + 60_000 })
      .where(eq(opportunities.id, ids[1]!))
      .run();
    expect(await openOpportunitiesText(app.db, ctxOf(a))).toBe(before);
  });

  it('orders opportunities created at the same time by id, whichever was updated last', async () => {
    const { app, a } = await boot();
    const ids: string[] = [];
    for (const company of ['Initech', 'Globex']) {
      const o = await createOpportunity(app.db, ctxOf(a), {
        companyName: company,
        title: 'Engineer',
        sourceKind: 'manual',
      });
      ids.push(o.id);
    }
    const [first, second] = [...ids].sort();
    const now = Date.now();
    const set = async (id: string, updatedAt: number) =>
      app.db
        .update(opportunities)
        .set({ createdAt: now, updatedAt })
        .where(eq(opportunities.id, id))
        .run();
    const companyOf = (id: string) => (id === ids[0] ? '- Initech' : '- Globex');
    const companies = async () =>
      (await openOpportunitiesText(app.db, ctxOf(a))).split('\n').map((l) => l.split(' | ')[0]);
    // The lower id updated last, then the higher: the query reads them in the opposite order
    // each time, and the text stays the same, the lower id first.
    await set(first!, now + 2);
    await set(second!, now + 1);
    const before = await openOpportunitiesText(app.db, ctxOf(a));
    expect(await companies()).toEqual([companyOf(first!), companyOf(second!)]);
    await set(second!, now + 3);
    expect(await openOpportunitiesText(app.db, ctxOf(a))).toBe(before);
  });

  it('keeps the same set: the most recently updated, up to the cap', async () => {
    const { app, a } = await boot();
    const ids: string[] = [];
    for (let i = 0; i < 201; i += 1) {
      const o = await createOpportunity(app.db, ctxOf(a), {
        companyName: `Company ${i}`,
        title: 'Engineer',
        sourceKind: 'manual',
      });
      ids.push(o.id);
    }
    // The oldest by creation is the most recently updated: it stays in, and the least recently
    // updated (the second created) is the one left out.
    const now = Date.now();
    for (const [i, id] of ids.entries()) {
      await app.db
        .update(opportunities)
        .set({ updatedAt: i === 0 ? now + 1_000_000 : now - 1_000_000 + i })
        .where(eq(opportunities.id, id))
        .run();
    }
    const lines = (await openOpportunitiesText(app.db, ctxOf(a))).split('\n');
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('- Company 0 | Engineer | discovered');
    expect(lines).not.toContain('- Company 1 | Engineer | discovered');
    expect(lines.at(-1)).toBe('- Company 200 | Engineer | discovered');
  });
});
