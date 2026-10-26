// Reject as out of scope (spec D4). Brian: "I don't want to track it in 'dismissed', I want
// to kick it out altogether." `dismissed` means considered and declined; rejection means
// should never have been here, so the content goes and only enough identity stays to stop
// the next sync bringing it back.
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { communications, dismissalFeedback } from '../src/db/schema';
import { ingestInbound } from '../src/jobs/mailIngest';
import { createRule, listRules } from '../src/repos/mailFilters';
import { rejectCommunication } from '../src/repos/reject';
import { search } from '../src/repos/search';
import { useApi } from './api';

const boot = useApi();
const ctxOf = (userId: string) => ({ userId, isAdmin: false });

let seq = 0;
async function ingest(app: FastifyInstance, userId: string, from: string, subject: string) {
  seq += 1;
  const { id } = await ingestInbound(app.db, ctxOf(userId), app.storage, 'gmail', {
    externalId: `rej-${seq}`,
    threadKey: `rej-${seq}`,
    from,
    to: ['me@user.example'],
    subject,
    snippet: 'Your balance due is 42.00 and your next appointment is Tuesday.',
    bodyText: 'Your balance due is 42.00 and your next appointment is Tuesday.',
    sentAt: Date.now() - seq * 1000,
  });
  return id;
}

/**
 * The user's own allow rule, which is how a message like this reaches the inbox at all now that
 * Stage 1 drops private senders and private content on sight. Rule 0 beats both vetoes by
 * design: the user said yes to this sender, and no heuristic overrules them. A message that got
 * in that way is exactly what rejection is for, so the tests that need stored content to destroy
 * say so here rather than relying on the filter having missed it.
 */
const allowSender = (app: FastifyInstance, userId: string, pattern: string) =>
  createRule(app.db, ctxOf(userId), { pattern, effect: 'allow' });

const rowById = async (app: FastifyInstance, userId: string, id: string) =>
  (await app.db
    .select()
    .from(communications)
    .where(and(eq(communications.userId, userId), eq(communications.id, id)))
    .get())!;

describe('rejectCommunication', () => {
  it('destroys the content but keeps enough identity to prevent re-ingest', async () => {
    const { app, a } = await boot();
    await allowSender(app, a.userId, 'billing@clinic-a.example');
    const id = await ingest(app, a.userId, 'billing@clinic-a.example', 'Superbill');
    // There is content to destroy: without this the test would pass on an empty row.
    expect((await rowById(app, a.userId, id)).subject).toBe('Superbill');

    await rejectCommunication(app.db, ctxOf(a.userId), id, {
      reason: 'medical_or_personal',
    });

    const row = await rowById(app, a.userId, id);
    expect(row.subject).toBeNull();
    expect(row.snippet).toBeNull();
    expect(row.bodyRef).toBeNull();
    expect(row.rejectionReason).toBe('medical_or_personal');
    expect(row.rejectedAt).toBeGreaterThan(0);
    // Identity survives so the next sync recognizes it.
    expect(row.from).toBe('billing@clinic-a.example');
    expect(row.externalId).toBe(`rej-${seq}`);
  });

  it('leaves nothing searchable behind', async () => {
    const { app, a } = await boot();
    await allowSender(app, a.userId, 'billing@clinic-a.example');
    const id = await ingest(app, a.userId, 'billing@clinic-a.example', 'Superbill');
    expect(
      (await search(app.db, ctxOf(a.userId), 'Superbill', { limit: 10, offset: 0 })).items,
    ).toHaveLength(1);

    await rejectCommunication(app.db, ctxOf(a.userId), id, { reason: 'financial' });

    const hits = await search(app.db, ctxOf(a.userId), 'Superbill', { limit: 10, offset: 0 });
    expect(hits.items).toHaveLength(0);
  });

  it('records the reason code as feedback, and keeps the note local by default', async () => {
    const { app, a } = await boot();
    const id = await ingest(app, a.userId, 'billing@clinic-a.example', 'Superbill');

    await rejectCommunication(app.db, ctxOf(a.userId), id, {
      reason: 'medical_or_personal',
      note: 'this is my chiropractor',
    });

    const fb = (await app.db
      .select()
      .from(dismissalFeedback)
      .where(eq(dismissalFeedback.userId, a.userId))
      .get())!;
    expect(fb.kind).toBe('rejection');
    expect(fb.reason).toBe('medical_or_personal');
    expect(fb.note).toBe('this is my chiropractor');
    // The note is stored for the user to read; only the CODE may reach a model.
    expect(fb.shareNote).toBe(false);
  });

  it('shares a note only when the user opts that note in', async () => {
    const { app, a } = await boot();
    const id = await ingest(app, a.userId, 'x@agency-c.example', 'Role');

    await rejectCommunication(app.db, ctxOf(a.userId), id, {
      reason: 'wrong_role',
      note: 'wrong seniority',
      shareNote: true,
    });

    const fb = (await app.db
      .select()
      .from(dismissalFeedback)
      .where(eq(dismissalFeedback.userId, a.userId))
      .get())!;
    expect(fb.shareNote).toBe(true);
  });

  it('adds a deny rule for the sender when asked, and reports it blocked', async () => {
    const { app, a } = await boot();
    const id = await ingest(app, a.userId, 'billing@clinic-a.example', 'Superbill');

    const result = await rejectCommunication(app.db, ctxOf(a.userId), id, {
      reason: 'medical_or_personal',
      neverIngest: 'domain',
    });

    expect(result).toEqual({ blocked: true });
    const rules = await listRules(app.db, ctxOf(a.userId));
    expect(rules.map((r) => r.pattern)).toContain('*@clinic-a.example');
    expect(rules[0]!.effect).toBe('deny');
    expect(rules[0]!.source).toBe('rejection');
  });

  it('can deny just the one address instead of the whole domain', async () => {
    const { app, a } = await boot();
    const id = await ingest(app, a.userId, 'billing@clinic-a.example', 'Superbill');

    await rejectCommunication(app.db, ctxOf(a.userId), id, {
      reason: 'medical_or_personal',
      neverIngest: 'address',
    });

    expect((await listRules(app.db, ctxOf(a.userId))).map((r) => r.pattern)).toEqual([
      'billing@clinic-a.example',
    ]);
  });

  it('reports blocked: null when no block was asked for', async () => {
    const { app, a } = await boot();
    const id = await ingest(app, a.userId, 'x@agency-c.example', 'Role');

    const result = await rejectCommunication(app.db, ctxOf(a.userId), id, { reason: 'spam' });

    expect(result).toEqual({ blocked: null });
  });

  it('reports blocked: false, not a false success, when the sender cannot be parsed (issue #145)', async () => {
    const { app, a } = await boot();
    // A header listing several mailboxes has no single sender (senderAddress returns ''):
    // the trusted mailbox could sit last behind an attacker's own, so none is ever assumed.
    const id = await ingest(
      app,
      a.userId,
      'first@agency-c.example, second@agency-c.example',
      'Role',
    );

    const result = await rejectCommunication(app.db, ctxOf(a.userId), id, {
      reason: 'wrong_company',
      neverIngest: 'domain',
    });

    expect(result).toEqual({ blocked: false, blockFailureReason: 'unparseable_sender' });
    expect(await listRules(app.db, ctxOf(a.userId))).toHaveLength(0);
    // The message itself is still rejected: a block that could not be established doesn't
    // undo the part of the request that did succeed.
    expect((await rowById(app, a.userId, id)).rejectedAt).toBeGreaterThan(0);
  });

  it('re-enables a matching deny rule that exists but is disabled, rather than treating it as already satisfied (issue #145)', async () => {
    const { app, a } = await boot();
    const id = await ingest(app, a.userId, 'billing@clinic-a.example', 'Superbill');
    // A rule for this exact pattern already exists, but disabled -- e.g. a job_sender default
    // the user turned off, or one they disabled for an unrelated reason. Mail is still flowing.
    const disabled = await createRule(app.db, ctxOf(a.userId), {
      pattern: '*@clinic-a.example',
      effect: 'deny',
      enabled: false,
    });
    expect(disabled.enabled).toBe(false);

    const result = await rejectCommunication(app.db, ctxOf(a.userId), id, {
      reason: 'medical_or_personal',
      neverIngest: 'domain',
    });

    expect(result).toEqual({ blocked: true });
    const rules = await listRules(app.db, ctxOf(a.userId));
    expect(rules).toHaveLength(1);
    expect(rules[0]!.enabled).toBe(true);
  });

  it('retries the block on an already-rejected message instead of silently no-opping forever (issue #145)', async () => {
    const { app, a } = await boot();
    const id = await ingest(app, a.userId, 'billing@clinic-a.example', 'Superbill');
    // First call rejects the message without asking for a block at all -- standing in for a
    // first attempt whose block step failed for a real reason and was never retried, since
    // from the idempotency guard's point of view the two situations are indistinguishable.
    const first = await rejectCommunication(app.db, ctxOf(a.userId), id, { reason: 'spam' });
    expect(first).toEqual({ blocked: null });
    expect(await listRules(app.db, ctxOf(a.userId))).toHaveLength(0);

    const retried = await rejectCommunication(app.db, ctxOf(a.userId), id, {
      reason: 'spam',
      neverIngest: 'domain',
    });

    expect(retried).toEqual({ blocked: true });
    expect((await listRules(app.db, ctxOf(a.userId))).map((r) => r.pattern)).toContain(
      '*@clinic-a.example',
    );
    // Still idempotent on the part that already happened: no second feedback row.
    const fb = await app.db
      .select()
      .from(dismissalFeedback)
      .where(eq(dismissalFeedback.userId, a.userId))
      .all();
    expect(fb).toHaveLength(1);
  });

  it('adds no rule when the user does not ask for one', async () => {
    const { app, a } = await boot();
    const id = await ingest(app, a.userId, 'x@agency-c.example', 'Role');

    await rejectCommunication(app.db, ctxOf(a.userId), id, { reason: 'wrong_role' });

    expect(await listRules(app.db, ctxOf(a.userId))).toHaveLength(0);
  });

  it('is idempotent, so a double click does not write two feedback rows', async () => {
    const { app, a } = await boot();
    const id = await ingest(app, a.userId, 'x@agency-c.example', 'Role');

    await rejectCommunication(app.db, ctxOf(a.userId), id, { reason: 'spam' });
    await rejectCommunication(app.db, ctxOf(a.userId), id, { reason: 'spam' });

    const fb = await app.db
      .select()
      .from(dismissalFeedback)
      .where(eq(dismissalFeedback.userId, a.userId))
      .all();
    expect(fb).toHaveLength(1);
  });

  it("refuses another user's message", async () => {
    const { app, a, b } = await boot();
    const id = await ingest(app, a.userId, 'x@agency-c.example', 'Role');

    await expect(
      rejectCommunication(app.db, ctxOf(b.userId), id, { reason: 'spam' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('keeps a rejected message out of every inbox view', async () => {
    const { app, a } = await boot();
    const id = await ingest(app, a.userId, 'x@agency-c.example', 'Role');
    await rejectCommunication(app.db, ctxOf(a.userId), id, { reason: 'spam' });

    const { listCommunications } = await import('../src/repos/communications');
    const page = { limit: 50, offset: 0 };
    for (const view of ['needs_review', 'linked', 'spam', 'filtered', 'all'] as const) {
      const got = await listCommunications(app.db, ctxOf(a.userId), { view, ...page });
      expect(
        got.items.map((c) => c.id),
        view,
      ).not.toContain(id);
    }
  });

  it('feeds the reason code to prompt refinement but never an unshared note', async () => {
    const { rejectionLines } = await import('../src/jobs/refineClassifyPrompt');
    const lines = rejectionLines([
      {
        kind: 'rejection',
        reason: 'medical_or_personal',
        note: 'my chiropractor',
        shareNote: false,
      },
      { kind: 'rejection', reason: 'wrong_role', note: 'too junior', shareNote: true },
      { kind: 'classification', reason: 'outreach targeted -> spam', note: null, shareNote: false },
    ]);
    expect(lines).toEqual([
      'rejected as medical_or_personal',
      'rejected as wrong_role: too junior',
    ]);
    expect(lines.join(' ')).not.toContain('chiropractor');
  });
});
