// The note of a stage change a message suggested, once the message is rejected.
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { communications, stageHistory } from '../src/db/schema';
import { upsertInbound } from '../src/repos/communications';
import { createOpportunity } from '../src/repos/opportunities';
import { rejectCommunication } from '../src/repos/reject';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const SUBJECT = 'Offer letter';
const NOTE = `Proposed by message: ${SUBJECT}`;

let seq = 0;
async function message(app: FastifyInstance, c: TestClient, subject: string | null = SUBJECT) {
  seq += 1;
  const { id } = await upsertInbound(app.db, ctxOf(c), 'gmail', {
    externalId: `msg-${seq}`,
    threadKey: `thread-${seq}`,
    from: 'Priya Shah <priya@initech.example>',
    to: ['me@example.com'],
    subject: subject ?? '',
    snippet: 's',
    bodyText: 'b',
    sentAt: 1_790_000_000_000 + seq,
  });
  if (subject === null) {
    await app.db.update(communications).set({ subject }).where(eq(communications.id, id));
  }
  return id;
}
const reject = (app: FastifyInstance, c: TestClient, id: string) =>
  rejectCommunication(app.db, ctxOf(c), id, { reason: 'spam', expectedOpportunityId: null });

async function noted(app: FastifyInstance, c: TestClient, notes: (string | null)[]) {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Globex',
    title: `Engineer ${(seq += 1)}`,
    sourceKind: 'manual',
  });
  for (const [i, note] of notes.entries()) {
    await app.db
      .insert(stageHistory)
      .values({
        id: `${opp.id}-${i}`,
        userId: c.userId,
        opportunityId: opp.id,
        fromStage: 'discovered',
        toStage: 'interested',
        note,
        at: i + 1,
      })
      .run();
  }
  return async () =>
    (
      await app.db
        .select()
        .from(stageHistory)
        .where(eq(stageHistory.opportunityId, opp.id))
        .orderBy(asc(stageHistory.at))
        .all()
    )
      .filter((h) => h.fromStage !== null)
      .map((h) => h.note);
}

describe('the note of a stage change a rejected message suggested', () => {
  it('no longer says what the message said, on any opportunity of theirs', async () => {
    const { app, a } = await boot();
    const one = await noted(app, a, [NOTE, 'my own words', null]);
    const two = await noted(app, a, [NOTE]);
    await reject(app, a, await message(app, a));
    expect(await one()).toEqual(['Proposed by a message', 'my own words', null]);
    expect(await two()).toEqual(['Proposed by a message']);
  });

  it('is known by the whole of the subject it was made from: trimmed, and cut', async () => {
    const { app, a } = await boot();
    const subject = `  ${'x'.repeat(200)}`;
    const notes = await noted(app, a, [
      `Proposed by message: ${'x'.repeat(120)}`,
      `Proposed by message: ${'x'.repeat(121)}`,
      `Proposed by message: ${'x'.repeat(119)}`,
      `${NOTE} and more`,
      `Re: Proposed by message: ${'x'.repeat(120)}`,
    ]);
    await reject(app, a, await message(app, a, subject));
    expect(await notes()).toEqual([
      'Proposed by a message',
      `Proposed by message: ${'x'.repeat(121)}`,
      `Proposed by message: ${'x'.repeat(119)}`,
      `${NOTE} and more`,
      `Re: Proposed by message: ${'x'.repeat(120)}`,
    ]);
  });

  it('stays while another message of theirs, not rejected, has that subject', async () => {
    const { app, a, b } = await boot();
    const notes = await noted(app, a, [NOTE]);
    const first = await message(app, a);
    const other = await message(app, a, ` ${SUBJECT} `);
    await message(app, b);
    await reject(app, a, first);
    expect(await notes()).toEqual([NOTE]);
    await reject(app, a, other);
    expect(await notes()).toEqual(['Proposed by a message']);
  });

  it('does not stay for a message rejected by an earlier release, its subject not cleared', async () => {
    const { app, a } = await boot();
    const notes = await noted(app, a, [NOTE]);
    const id = await message(app, a);
    const other = await message(app, a);
    await app.db.update(communications).set({ rejectedAt: 1 }).where(eq(communications.id, other));
    await reject(app, a, id);
    expect(await notes()).toEqual(['Proposed by a message']);
  });

  it("another user's stays, whoever's message it was", async () => {
    const { app, a, b } = await boot();
    const theirs = await noted(app, b, [NOTE]);
    await message(app, b);
    await reject(app, a, await message(app, a));
    expect(await theirs()).toEqual([NOTE]);
  });

  it('a message with no subject changes none', async () => {
    const { app, a } = await boot();
    const notes = await noted(app, a, ['Proposed by message: ', 'Proposed by a message', NOTE]);
    for (const subject of ['', '   ', null]) await reject(app, a, await message(app, a, subject));
    expect(await notes()).toEqual(['Proposed by message: ', 'Proposed by a message', NOTE]);
  });

  it('a reject that is refused changes none', async () => {
    const { app, a } = await boot();
    const notes = await noted(app, a, [NOTE]);
    const id = await message(app, a);
    const opp = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Hooli',
      title: 'Designer',
      sourceKind: 'manual',
    });
    await app.db
      .update(communications)
      .set({ opportunityId: opp.id })
      .where(eq(communications.id, id));
    await expect(reject(app, a, id)).rejects.toMatchObject({ code: 'message_changed' });
    expect(await notes()).toEqual([NOTE]);
  });
});
