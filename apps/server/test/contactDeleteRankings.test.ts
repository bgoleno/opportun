// https://github.com/bgoleno/opportun/issues/710 (sec and tl): a deleted contact's AI rationale
// stayed inside the kept referral rankings (#640) until the opportunity was ranked again. Never
// shown, but kept, so the deletion was incomplete. Deleting a contact now deletes the user's kept
// rankings that name them; such a ranking would be made afresh on the next open anyway, since the
// candidate set it was made from is part of its key.
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { referralRankings } from '../src/db/schema';
import { createContact } from '../src/repos/contacts';
import { createOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

async function keptRanking(
  app: FastifyInstance,
  c: TestClient,
  title: string,
  contactIds: string[],
): Promise<string> {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Initech',
    title,
    sourceKind: 'manual',
  });
  const now = Date.now();
  await app.db
    .insert(referralRankings)
    .values({
      id: newId(),
      userId: c.userId,
      opportunityId: opp.id,
      inputHash: `hash-${opp.id}`,
      ranking: contactIds.map((contactId, i) => ({
        contactId,
        rank: i + 1,
        rationale: `Why ${contactId} could refer you.`,
      })),
      rankedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return opp.id;
}

const rankingsOf = async (app: FastifyInstance, c: TestClient) =>
  await app.db
    .select()
    .from(referralRankings)
    .where(eq(referralRankings.userId, c.userId))
    .orderBy(referralRankings.opportunityId)
    .all();

describe('deleting a contact leaves no kept ranking naming them (#710)', () => {
  it("removes the user's rankings that name the contact, keeps the rest, and touches no one else's", async () => {
    const { app, a, b } = await boot();
    const gone = await createContact(app.db, ctxOf(a), { name: 'Sam Lee' });
    const stays = await createContact(app.db, ctxOf(a), { name: 'Jane Doe' });
    const theirs = await createContact(app.db, ctxOf(b), { name: 'Lee Park' });
    const both = await keptRanking(app, a, 'Staff Engineer', [gone.id, stays.id]);
    const other = await keptRanking(app, a, 'Data Scientist', [stays.id]);
    await keptRanking(app, b, 'Staff Engineer', [theirs.id]);
    const bBefore = JSON.stringify(await rankingsOf(app, b));

    const res = await a.request({ method: 'DELETE', url: `/api/v1/network/${gone.id}` });
    expect(res.statusCode, res.body).toBe(204);

    const left = await rankingsOf(app, a);
    expect(left.map((r) => r.opportunityId)).toEqual([other]);
    expect(left.map((r) => r.opportunityId)).not.toContain(both);
    // No stored ranking of anyone's still names the deleted contact.
    const all = await app.db.select().from(referralRankings).all();
    expect(JSON.stringify(all)).not.toContain(gone.id);
    expect(JSON.stringify(await rankingsOf(app, b))).toBe(bBefore);
  });

  it("another user deleting their own contact leaves this user's rankings alone", async () => {
    const { app, a, b } = await boot();
    const mine = await createContact(app.db, ctxOf(a), { name: 'Sam Lee' });
    const theirs = await createContact(app.db, ctxOf(b), { name: 'Lee Park' });
    await keptRanking(app, a, 'Staff Engineer', [mine.id]);
    const aBefore = JSON.stringify(await rankingsOf(app, a));
    expect(
      (await b.request({ method: 'DELETE', url: `/api/v1/network/${theirs.id}` })).statusCode,
    ).toBe(204);
    expect(JSON.stringify(await rankingsOf(app, a))).toBe(aBefore);
  });
});
