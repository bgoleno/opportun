// Inbox triage controls (sort by date, filter by sender/source/keyword, bulk actions).
//
// The inbox already pages one view at a time, newest first, so these controls have to work on
// the server across the whole view, not on the page the client happens to hold. The fixtures
// are inserted straight into the table so each row's channel, sender, subject and sent_at are
// exactly what a filter has to match, which the ingest path would not let a test pin down.
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { communications } from '../src/db/schema';
import type { Db } from '../src/repos/base';
import { bulkTriage, listCommunications } from '../src/repos/communications';
import { useApi } from './api';

const boot = useApi();
const ctxOf = (userId: string) => ({ userId, isAdmin: false });

let seq = 0;
beforeEach(() => {
  seq = 0;
});

interface SeedRow {
  userId: string;
  channel: 'gmail' | 'apple_mail' | 'linkedin';
  from: string;
  subject?: string;
  snippet?: string;
  sentAt: number;
  needsReview?: boolean;
  opportunityId?: string | null;
}

async function insert(db: Db, row: SeedRow): Promise<string> {
  const id = `c${(seq += 1).toString().padStart(6, '0')}`;
  const now = 1_700_000_000_000 + seq;
  await db
    .insert(communications)
    .values({
      id,
      userId: row.userId,
      channel: row.channel,
      externalId: `ext-${id}`,
      from: row.from,
      to: [],
      subject: row.subject ?? null,
      snippet: row.snippet ?? null,
      sentAt: row.sentAt,
      needsReview: row.needsReview ?? true,
      opportunityId: row.opportunityId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

const DAY = 86_400_000;
const T = 1_780_000_000_000; // a fixed base instant for the fixtures

describe('inbox controls: filtering', () => {
  it('filters by source (channel)', async () => {
    const { app, a } = await boot();
    await insert(app.db, { userId: a.userId, channel: 'gmail', from: 'a@x.test', sentAt: T });
    await insert(app.db, { userId: a.userId, channel: 'linkedin', from: 'b@x.test', sentAt: T });
    await insert(app.db, { userId: a.userId, channel: 'apple_mail', from: 'c@x.test', sentAt: T });

    const page = await listCommunications(app.db, ctxOf(a.userId), {
      view: 'all',
      channel: 'linkedin',
      limit: 50,
      offset: 0,
    });
    expect(page.total).toBe(1);
    expect(page.items.map((i) => i.channel)).toEqual(['linkedin']);
  });

  it('filters by sender, case-insensitively and as a substring', async () => {
    const { app, a } = await boot();
    await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'Mihir Parekh <mihir@linkedin.com>',
      sentAt: T,
    });
    await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'noreply@candidate.fyi',
      sentAt: T,
    });

    const page = await listCommunications(app.db, ctxOf(a.userId), {
      view: 'all',
      sender: 'MIHIR',
      limit: 50,
      offset: 0,
    });
    expect(page.total).toBe(1);
    expect(page.items[0]?.from).toContain('mihir@linkedin.com');
  });

  it('filters by keyword across subject, snippet and sender', async () => {
    const { app, a } = await boot();
    await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'a@x.test',
      subject: 'Product Manager role',
      sentAt: T,
    });
    await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'b@x.test',
      snippet: 'we are hiring a product manager',
      sentAt: T,
    });
    await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'c@x.test',
      subject: 'unrelated',
      sentAt: T,
    });

    const page = await listCommunications(app.db, ctxOf(a.userId), {
      view: 'all',
      q: 'product manager',
      limit: 50,
      offset: 0,
    });
    expect(page.total).toBe(2);
  });

  it('composes filters with the view and stays scoped to the caller', async () => {
    const { app, a, b } = await boot();
    await insert(app.db, {
      userId: a.userId,
      channel: 'linkedin',
      from: 'r@x.test',
      subject: 'hi',
      sentAt: T,
    });
    // Same sender and channel, different user: must never appear.
    await insert(app.db, {
      userId: b.userId,
      channel: 'linkedin',
      from: 'r@x.test',
      subject: 'hi',
      sentAt: T,
    });

    const page = await listCommunications(app.db, ctxOf(a.userId), {
      view: 'needs_review',
      channel: 'linkedin',
      sender: 'r@x.test',
      limit: 50,
      offset: 0,
    });
    expect(page.total).toBe(1);
  });

  it('matches the keyword against the sender alone (the from leg of the OR)', async () => {
    const { app, a } = await boot();
    await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'recruiter@northwind.example',
      subject: 'hello',
      snippet: 'nothing relevant here',
      sentAt: T,
    });
    const page = await listCommunications(app.db, ctxOf(a.userId), {
      view: 'all',
      q: 'northwind',
      limit: 50,
      offset: 0,
    });
    expect(page.total).toBe(1);
  });

  it('paginates the filtered set: total is the whole match, items is one page', async () => {
    const { app, a } = await boot();
    // Three gmail matches and one linkedin non-match; the filter must bound both count and page.
    const first = await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'a@x.test',
      sentAt: T + 3,
    });
    const second = await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'b@x.test',
      sentAt: T + 2,
    });
    const third = await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'c@x.test',
      sentAt: T + 1,
    });
    await insert(app.db, {
      userId: a.userId,
      channel: 'linkedin',
      from: 'd@x.test',
      sentAt: T + 4,
    });

    const p1 = await listCommunications(app.db, ctxOf(a.userId), {
      view: 'all',
      channel: 'gmail',
      limit: 2,
      offset: 0,
    });
    expect(p1.total).toBe(3);
    expect(p1.items.map((i) => i.id)).toEqual([first, second]); // newest first

    const p2 = await listCommunications(app.db, ctxOf(a.userId), {
      view: 'all',
      channel: 'gmail',
      limit: 2,
      offset: 2,
    });
    expect(p2.total).toBe(3);
    expect(p2.items.map((i) => i.id)).toEqual([third]);
  });
});

describe('inbox controls: sort by date received', () => {
  it('defaults to newest first', async () => {
    const { app, a } = await boot();
    const old = await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'a@x.test',
      sentAt: T - DAY,
    });
    const mid = await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'b@x.test',
      sentAt: T,
    });
    const recent = await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'c@x.test',
      sentAt: T + DAY,
    });

    const page = await listCommunications(app.db, ctxOf(a.userId), {
      view: 'all',
      limit: 50,
      offset: 0,
    });
    expect(page.items.map((i) => i.id)).toEqual([recent, mid, old]);
  });

  it('lists oldest first when asked', async () => {
    const { app, a } = await boot();
    const old = await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'a@x.test',
      sentAt: T - DAY,
    });
    const mid = await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'b@x.test',
      sentAt: T,
    });
    const recent = await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'c@x.test',
      sentAt: T + DAY,
    });

    const page = await listCommunications(app.db, ctxOf(a.userId), {
      view: 'all',
      order: 'oldest',
      limit: 50,
      offset: 0,
    });
    expect(page.items.map((i) => i.id)).toEqual([old, mid, recent]);
  });
});

describe('inbox controls: bulk reject', () => {
  it('rejects every selected message of the caller, and reports the count', async () => {
    const { app, a } = await boot();
    const m1 = await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'a@x.test',
      sentAt: T,
    });
    const m2 = await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'b@x.test',
      sentAt: T,
    });

    const res = await bulkTriage(app.db, ctxOf(a.userId), {
      ids: [m1, m2],
      action: { kind: 'reject', reason: 'not_job_related' },
    });
    expect(res.succeeded).toBe(2);
    expect(res.skipped).toBe(0);

    const page = await listCommunications(app.db, ctxOf(a.userId), {
      view: 'all',
      limit: 50,
      offset: 0,
    });
    expect(page.items.map((i) => i.id)).not.toContain(m1);
    expect(page.items.map((i) => i.id)).not.toContain(m2);
  });

  it("cannot touch another user's messages, and leaves them byte-identical", async () => {
    const { app, a, b } = await boot();
    const ours = await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'a@x.test',
      sentAt: T,
    });
    const theirs = await insert(app.db, {
      userId: b.userId,
      channel: 'gmail',
      from: 'b@x.test',
      sentAt: T,
    });

    const before = await app.db
      .select()
      .from(communications)
      .where(and(eq(communications.userId, b.userId), eq(communications.id, theirs)))
      .get();

    const res = await bulkTriage(app.db, ctxOf(a.userId), {
      ids: [ours, theirs],
      action: { kind: 'reject', reason: 'not_job_related' },
    });
    expect(res.succeeded).toBe(1);
    expect(res.skipped).toBe(1);

    const after = await app.db
      .select()
      .from(communications)
      .where(and(eq(communications.userId, b.userId), eq(communications.id, theirs)))
      .get();
    expect(after).toEqual(before);
    expect(after?.rejectedAt ?? null).toBeNull();
  });

  it('counts distinct messages, not repeated ids in the request', async () => {
    const { app, a } = await boot();
    const m = await insert(app.db, {
      userId: a.userId,
      channel: 'gmail',
      from: 'a@x.test',
      sentAt: T,
    });

    const res = await bulkTriage(app.db, ctxOf(a.userId), {
      ids: [m, m, m],
      action: { kind: 'reject', reason: 'not_job_related' },
    });
    expect(res.succeeded).toBe(1);
    expect(res.skipped).toBe(0);
  });
});
