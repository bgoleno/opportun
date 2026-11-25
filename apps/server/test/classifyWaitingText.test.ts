// What a later try of a message sends to the model, and what it must not
// (https://github.com/bgoleno/opportun/issues/1050, sec's conditions 1 and 2): a Gmail message is read
// again, and used only if it is this one; the two other channels have their snippet; and a message the
// user has blocked since is not sent at all. The same holds for the backfill of a new key, which has no
// text of its own either. Every message is made up.
import { readFileSync } from 'node:fs';
import { AiUnavailableError, runStructured } from '@opportun/ai';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  communications,
  discoveryResults,
  jobs,
  opportunities,
  taskRuns,
  users,
} from '../src/db/schema';
import { backfillClassify } from '../src/jobs/classifyBackfill';
import { enqueueClassify } from '../src/lib/mailClassifyQueue';
import { invalidateTriageContext } from '../src/lib/triageContext';
import { sweepWaitingMessages } from '../src/jobs/classifyWaiting';
import { reclassify } from '../src/repos/communications';
import { createRule } from '../src/repos/mailFilters';
import { createOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import {
  classifier,
  ctxOf,
  drain,
  FOLLOW_UP,
  NOW,
  onlySchedule,
  rowOf,
  shown,
  stored,
  waitOf,
  type Stored,
} from './classifyWaitingFixtures';
import { connectGoogle, fakeGoogle, type FakeMail } from './fakeGoogle';
import type { TestClient } from './isolation';
import { pauseAt, whileParked } from './race';
import { storeBodyFor } from './storedBody';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

let google: ReturnType<typeof fakeGoogle>;
const bootApp = useApi(() => ({ build: { google } }));
async function boot(connected = true) {
  const env = await bootApp();
  await onlySchedule(env.app, null);
  if (connected) await connectGoogle(env.a, 'gmail', google);
  google.gmail.calls.length = 0;
  return env;
}

beforeEach(() => {
  google = fakeGoogle();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'], shouldAdvanceTime: true });
  vi.mocked(runStructured).mockReset();
  classifier(() => FOLLOW_UP);
});
afterEach(() => {
  vi.useRealTimers();
});

const FROM = 'Riley Recruiter <riley@initech.example>';
const SUBJECT = 'Staff Engineer';
const SNIPPET = 'The snippet of it: the role.';
const WHOLE = 'The whole of it, which only the mailbox has: the role.';
const SENT_AT = NOW - 3_600_000;
const row: Stored = { from: FROM, subject: SUBJECT, snippet: SNIPPET, sentAt: SENT_AT };
const mail = (id: string, over: Partial<FakeMail> = {}) =>
  google.gmail.add({
    id,
    threadId: `thread-${id}`,
    from: FROM,
    to: ['me@example.com'],
    subject: SUBJECT,
    text: WHOLE,
    sentAt: SENT_AT,
    ...over,
  });

describe('a Gmail message is read again from the mailbox', () => {
  it('at its own turn, and nothing of it is kept', async () => {
    const { app, a } = await boot();
    mail('m1');
    const id = await stored(app, a, { ...row, channel: 'gmail', externalId: 'm1' });
    const before = await rowOf(app, id);
    await sweepWaitingMessages(app.db);
    expect(google.gmail.calls).toEqual([]);
    await app.jobs.drain();
    expect(google.gmail.calls).toEqual(['messages.get']);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain(WHOLE);
    expect(await rowOf(app, id)).toMatchObject({
      classification: 'follow_up',
      bodySource: 'refetched',
      snippet: before.snippet,
      subject: before.subject,
      bodyRef: null,
    });
    const kept = JSON.stringify([
      await app.db.select().from(communications).all(),
      await app.db.select().from(jobs).all(),
      await app.db.select().from(taskRuns).all(),
    ]);
    expect(kept).not.toContain(WHOLE);
  });

  // Another account's mailbox, or another message of that id: whichever of the three differs.
  it.each([
    ['sender', { from: 'Riley Recruiter <riley@globex.example>' }],
    ['sender’s name', { from: 'Riley R. <riley@initech.example>' }],
    ['subject', { subject: 'Staff Engineer, again' }],
    ['missing subject', { subject: '' }],
    ['date', { sentAt: SENT_AT + 1 }],
    ['missing date', { sentAt: 0 }],
  ] as [string, Partial<FakeMail>][])(
    'another %s: the snippet, and nothing of it',
    async (_n, over) => {
      const { app, a } = await boot();
      mail('m1', over);
      const id = await stored(app, a, { ...row, channel: 'gmail', externalId: 'm1' });
      await drain(app, a);
      expect(google.gmail.calls).toEqual(['messages.get']);
      expect(shown()).toHaveLength(1);
      expect(shown()[0]).toContain(SNIPPET);
      expect(JSON.stringify(vi.mocked(runStructured).mock.calls)).not.toContain(WHOLE);
      expect(await rowOf(app, id)).toMatchObject({
        classification: 'follow_up',
        bodySource: 'snippet',
        from: FROM,
        subject: SUBJECT,
        sentAt: SENT_AT,
      });
    },
  );

  it('a subject where the stored one is missing is another message’s too', async () => {
    const { app, a } = await boot();
    mail('m1');
    await stored(app, a, { ...row, channel: 'gmail', externalId: 'm1', subject: '' });
    await drain(app, a);
    expect(shown()[0]).not.toContain(WHOLE);
  });

  it('a missing subject is a missing one', async () => {
    const { app, a } = await boot();
    mail('m1', { subject: '' });
    await stored(app, a, { ...row, channel: 'gmail', externalId: 'm1', subject: '' });
    await drain(app, a);
    expect(shown()[0]).toContain(WHOLE);
  });

  it('one whose sender or date is missing on both sides is not known to be it', async () => {
    const { app, a } = await boot();
    mail('m1', { sentAt: 0 });
    await stored(app, a, { ...row, channel: 'gmail', externalId: 'm1', sentAt: 0 });
    await drain(app, a);
    expect(shown()[0]).not.toContain(WHOLE);
  });

  // As Gmail's sync stores one with no From header, and as nothing does.
  it.each(['(unknown sender)', ''])('nor one with no sender on either (%j)', async (from) => {
    const { app, a } = await boot();
    mail('m1', { from: '' });
    await stored(app, a, { ...row, channel: 'gmail', externalId: 'm1', from });
    await drain(app, a);
    expect(google.gmail.calls).toEqual(['messages.get']);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).not.toContain(WHOLE);
  });

  it('the date is Gmail’s own, not the header the sender wrote', async () => {
    const { app, a } = await boot();
    mail('m1');
    const get = google.gmailGetMessage.bind(google);
    google.gmailGetMessage = async (client, id) => {
      const msg = await get(client, id);
      const headers = msg.payload?.headers ?? [];
      const date = { name: 'Date', value: new Date(SENT_AT).toUTCString() };
      return {
        ...msg,
        internalDate: null,
        payload: { ...msg.payload, headers: [...headers.filter((h) => h.name !== 'Date'), date] },
      };
    };
    await stored(app, a, { ...row, channel: 'gmail', externalId: 'm1' });
    await drain(app, a);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).not.toContain(WHOLE);
  });

  it('a long subject is compared as it is stored, cut', async () => {
    const { app, a } = await boot();
    const subject = `Staff Engineer ${'x'.repeat(2000)}`;
    mail('m1', { subject });
    const id = await stored(app, a, { ...row, channel: 'gmail', externalId: 'm1', subject });
    expect((await rowOf(app, id)).subject!.length).toBeLessThan(subject.length);
    await drain(app, a);
    expect(shown()[0]).toContain(WHOLE);
  });

  it.each([
    ['gone from it', async () => undefined],
    [
      'refused by Gmail',
      async () => {
        google.gmailGetMessage = async () => Promise.reject(new Error('refused'));
      },
    ],
  ])('%s: the snippet', async (_name, make) => {
    const { app, a } = await boot();
    await make();
    const id = await stored(app, a, { ...row, channel: 'gmail', externalId: 'gone' });
    await drain(app, a);
    expect(shown()[0]).toContain(SNIPPET);
    expect((await rowOf(app, id)).bodySource).toBe('snippet');
  });

  it('Gmail disconnected since: the snippet', async () => {
    const { app, a } = await boot(false);
    mail('m1');
    const id = await stored(app, a, { ...row, channel: 'gmail', externalId: 'm1' });
    await drain(app, a);
    expect(shown()[0]).toContain(SNIPPET);
    expect((await rowOf(app, id)).bodySource).toBe('snippet');
  });

  it('not while the calls are stopped, nor for one that is classified or rejected by its turn', async () => {
    const { app, a } = await boot();
    mail('m1');
    const id = await stored(app, a, { ...row, channel: 'gmail', externalId: 'm1' });
    const stop = await stored(app, a, { wait: 'key_rejected' });
    expect((await drain(app, a)).stopped).toBe('key_rejected');
    await app.db.delete(communications).where(eq(communications.id, stop)).run();
    for (const over of [{ classification: 'other' as const }, { rejectedAt: NOW }]) {
      const gone = { classification: null, rejectedAt: null, ...over };
      await app.db.update(communications).set(gone).where(eq(communications.id, id)).run();
      await enqueueClassify(app.db, ctxOf(a), id);
      await app.jobs.drain();
    }
    expect(google.gmail.calls).toEqual([]);
    expect(shown()).toEqual([]);
  });

  it.each(['apple_mail', 'linkedin'] as const)(
    '%s has its snippet, and Gmail is not asked',
    async (channel) => {
      const { app, a } = await boot();
      mail('m1');
      const id = await stored(app, a, { ...row, channel, externalId: 'm1' });
      await drain(app, a);
      expect(google.gmail.calls).toEqual([]);
      expect(shown()[0]).toContain(SNIPPET);
      expect(await rowOf(app, id)).toMatchObject({
        classification: 'follow_up',
        bodySource: 'snippet',
      });
    },
  );
});

describe('a message the user has blocked since', () => {
  const CHANNELS = ['gmail', 'apple_mail', 'linkedin'] as const;
  type Channel = (typeof CHANNELS)[number];
  /** A private record (rule 3b of the filter), and one whose sender is (3a). */
  const PRIVATE = 'Your claim number is ready. The role of your plan.';
  const ME = 'me@mine.example';

  interface Block {
    name: string;
    row: Stored;
    /** What the mailbox has, where the block is in the text. */
    text?: string;
    /** The sender alone decides, so nothing is read again. */
    bySender: boolean;
    since?: (app: FastifyInstance, c: TestClient) => Promise<unknown>;
  }
  const BLOCKS: Block[] = [
    {
      name: 'a rule that denies the sender',
      row: {},
      bySender: true,
      since: (app, c) =>
        createRule(app.db, ctxOf(c), { pattern: 'riley@initech.example', effect: 'deny' }),
    },
    {
      name: 'a rule that denies the domain',
      row: {},
      bySender: true,
      since: (app, c) =>
        createRule(app.db, ctxOf(c), { pattern: '*@initech.example', effect: 'deny' }),
    },
    {
      name: 'a consumer sender',
      row: { from: 'Somebody <somebody@gmail.com>' },
      bySender: true,
    },
    { name: 'private content', row: { snippet: PRIVATE }, text: PRIVATE, bySender: false },
    {
      name: 'a private sender',
      row: { from: 'Desk <desk@example-dental.example>' },
      bySender: false,
    },
    {
      name: 'an automatic unsubscribe',
      row: { from: ME, snippet: 'This message was automatically generated by Gmail.' },
      text: 'This message was automatically generated by Gmail.',
      bySender: false,
      since: (app, c) =>
        app.db.update(users).set({ email: ME }).where(eq(users.id, c.userId)).run(),
    },
    {
      name: 'a request to an unsubscribe address alone',
      row: { from: ME, to: ['unsubscribe@lists.example'] },
      bySender: false,
      since: (app, c) =>
        app.db.update(users).set({ email: ME }).where(eq(users.id, c.userId)).run(),
    },
  ];
  const CASES = BLOCKS.flatMap((b) => CHANNELS.map((ch) => [b.name, ch, b] as const));

  async function blockedOne(app: FastifyInstance, c: TestClient, channel: Channel, b: Block) {
    const over = { ...row, ...b.row, channel, externalId: 'm1' };
    mail('m1', {
      from: over.from!,
      subject: over.subject!,
      text: b.text ?? WHOLE,
      ...(over.to === undefined ? {} : { to: over.to }),
    });
    const id = await stored(app, c, over);
    await b.since?.(app, c);
    invalidateTriageContext(c.userId);
    return id;
  }

  it.each(CASES)('%s, %s: not sent, and it waits no more', async (_name, channel, b) => {
    const { app, a } = await boot();
    const id = await blockedOne(app, a, channel, b);
    const before = await rowOf(app, id);
    expect(await drain(app, a)).toEqual({ classified: 0, left: 1, stopped: null });
    expect(shown()).toEqual([]);
    expect(google.gmail.calls).toEqual(b.bySender || channel !== 'gmail' ? [] : ['messages.get']);
    const after = await rowOf(app, id);
    expect(after.classifyWait).toBe('blocked');
    // Nothing else of it is changed: its decision, its content.
    expect(after).toEqual({
      ...before,
      classifyWait: 'blocked',
      classifyTriedAt: after.classifyTriedAt,
      updatedAt: after.updatedAt,
    });
    // No later try or backfill takes it, the rule gone or not.
    expect(await sweepWaitingMessages(app.db)).toEqual({ queued: 0 });
    expect(await backfillClassify(app.db, ctxOf(a))).toBe(0);
    const res = await a.request({ method: 'GET', url: '/api/v1/communications/unclassified' });
    expect(Object.values(res.json<Record<string, number>>())).toEqual(Array(8).fill(0));
  });

  it.each(CASES)(
    '%s, %s: the backfill of a new key does not send it either',
    async (_n, channel, b) => {
      const { app, a } = await boot();
      const id = await blockedOne(app, a, channel, { ...b, row: { ...b.row, wait: 'no_key' } });
      expect(await backfillClassify(app.db, ctxOf(a))).toBe(1);
      await app.jobs.drain();
      expect(shown()).toEqual([]);
      expect(await waitOf(app, id)).toBe('blocked');
    },
  );

  it.each(CHANNELS)('%s: an allow rule stands above a deny rule and the rest', async (channel) => {
    const { app, a } = await boot();
    const allow = { pattern: 'somebody@gmail.com', effect: 'allow' } as const;
    await createRule(app.db, ctxOf(a), allow);
    await createRule(app.db, ctxOf(a), { pattern: '*@gmail.com', effect: 'deny' });
    const id = await blockedOne(app, a, channel, {
      name: '',
      row: { from: 'Somebody <somebody@gmail.com>', snippet: PRIVATE },
      text: PRIVATE,
      bySender: true,
    });
    await drain(app, a);
    expect((await rowOf(app, id)).classification).toBe('follow_up');
  });

  it.each(CHANNELS)('%s: text with no word of a job is no block', async (channel) => {
    const { app, a } = await boot();
    const id = await blockedOne(app, a, channel, {
      name: '',
      row: { subject: 'Hello', snippet: 'See you on Tuesday.' },
      text: 'See you on Tuesday.',
      bySender: true,
    });
    await drain(app, a);
    expect((await rowOf(app, id)).classification).toBe('follow_up');
  });

  it('the consumer rule yields to a thread that is linked, and to the user’s setting', async () => {
    const { app, a } = await boot();
    const over = { ...row, from: 'Somebody <somebody@gmail.com>', threadKey: 'linked' };
    const id = await stored(app, a, over);
    const before = await stored(app, a, over);
    const opp = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Initech',
      title: 'Engineer',
      sourceKind: 'manual',
    });
    await app.db
      .update(communications)
      .set({ opportunityId: opp.id, classification: 'other', classifyWait: null })
      .where(eq(communications.id, before))
      .run();
    await drain(app, a);
    expect((await rowOf(app, id)).classification).toBe('follow_up');
    expect(await app.db.select().from(opportunities).all()).toHaveLength(1);
  });

  it('the block is in the text alone, which only the mailbox has: not sent', async () => {
    const { app, a } = await boot();
    mail('m1', { text: PRIVATE });
    const id = await stored(app, a, { ...row, channel: 'gmail', externalId: 'm1' });
    await drain(app, a);
    expect(shown()).toEqual([]);
    expect(await waitOf(app, id)).toBe('blocked');
  });

  it('another message’s text blocks nothing', async () => {
    const { app, a } = await boot();
    mail('m1', { text: PRIVATE, subject: 'Another' });
    const id = await stored(app, a, { ...row, channel: 'gmail', externalId: 'm1' });
    await drain(app, a);
    expect((await rowOf(app, id)).classification).toBe('follow_up');
  });

  it('a first job, whose text its ingest has checked, is not checked again', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a, { ...row, wait: null });
    await createRule(app.db, ctxOf(a), { pattern: '*@initech.example', effect: 'deny' });
    await enqueueClassify(app.db, ctxOf(a), id, 'The text of the job.');
    await app.jobs.drain();
    expect(await rowOf(app, id)).toMatchObject({
      classification: 'follow_up',
      bodySource: 'payload',
    });
  });

  it('an alert digest of a sender denied since makes no leads', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a, { from: 'jobalerts-noreply@linkedin.com' });
    await createRule(app.db, ctxOf(a), {
      pattern: 'jobalerts-noreply@linkedin.com',
      effect: 'deny',
    });
    await drain(app, a);
    expect(await rowOf(app, id)).toMatchObject({ classifyWait: 'blocked', classification: null });
  });
});

describe('an alert digest whose first job failed', () => {
  const DIGEST = readFileSync(
    new URL('./fixtures/alerts/linkedin-alert.txt', import.meta.url),
    'utf8',
  );
  const SENDER = 'jobalerts-noreply@linkedin.com';
  const digest: Stored = { ...row, from: SENDER, subject: 'Your job alert', wait: 'failed' };
  const leads = async (app: FastifyInstance) =>
    (await app.db.select().from(discoveryResults).all()).length;

  it('is read again from Gmail, makes its leads, and no call', async () => {
    const { app, a } = await boot();
    mail('m1', { from: SENDER, subject: 'Your job alert', text: DIGEST });
    const id = await stored(app, a, { ...digest, channel: 'gmail', externalId: 'm1' });
    expect(await drain(app, a)).toEqual({ classified: 0, left: 0, stopped: null });
    expect(google.gmail.calls).toEqual(['messages.get']);
    expect(await leads(app)).toBe(3);
    expect(shown()).toEqual([]);
    expect(await rowOf(app, id)).toMatchObject({
      classification: 'other',
      classifyWait: null,
      classifyTriedAt: null,
    });
  });

  it.each([
    ['Gmail has another message of that id', 'gmail', { subject: 'Another' }],
    ['it is gone from Gmail', 'gmail', null],
    ['its channel cannot be asked', 'apple_mail', null],
    ['its channel cannot be asked', 'linkedin', null],
  ] as [string, 'gmail' | 'apple_mail' | 'linkedin', Partial<FakeMail> | null][])(
    '%s (%s): nothing is made of its snippet, and it says it failed',
    async (_name, channel, other) => {
      const { app, a } = await boot();
      if (other !== null) mail('m1', { from: SENDER, text: DIGEST, ...other });
      const snippet = DIGEST.slice(0, 500);
      const id = await stored(app, a, { ...digest, snippet, channel, externalId: 'm1' });
      expect(await drain(app, a)).toEqual({ classified: 0, left: 1, stopped: null });
      expect(await leads(app)).toBe(0);
      expect(shown()).toEqual([]);
      expect(await rowOf(app, id)).toMatchObject({ classification: null, classifyWait: 'failed' });
    },
  );

  it('the same in the backfill of a new key', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a, { ...digest, wait: null, snippet: DIGEST.slice(0, 500) });
    await backfillClassify(app.db, ctxOf(a));
    await app.jobs.drain();
    expect(await leads(app)).toBe(0);
    expect(await waitOf(app, id)).toBe('failed');
  });

  it('a stored text, as an older version kept it, is read', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a, digest);
    await storeBodyFor(app, a.userId, id, DIGEST);
    await drain(app, a);
    expect(await leads(app)).toBe(3);
    expect((await rowOf(app, id)).classification).toBe('other');
  });

  it('its job’s own text is read, and no Gmail', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a, { ...digest, wait: null });
    await enqueueClassify(app.db, ctxOf(a), id, DIGEST);
    await app.jobs.drain();
    expect(google.gmail.calls).toEqual([]);
    expect(await leads(app)).toBe(3);
  });

  it('the user’s correction while it is read stands', async () => {
    const { app, a } = await boot();
    mail('m1', { from: SENDER, subject: 'Your job alert', text: DIGEST });
    const id = await stored(app, a, { ...digest, channel: 'gmail', externalId: 'm1' });
    const pause = pauseAt('alertDigest.mark');
    const tried = drain(app, a);
    await whileParked(pause, () =>
      reclassify(app.db, ctxOf(a), id, { classification: 'networking' }),
    );
    await tried;
    expect(await rowOf(app, id)).toMatchObject({
      classification: 'networking',
      classifyWait: null,
      classifyTriedAt: null,
    });
  });
});

describe('what is written of it', () => {
  it('an error that carries the text: a reason in the row, and nothing of the text in a job', async () => {
    const { app, a } = await boot();
    mail('m1');
    await stored(app, a, { ...row, channel: 'gmail', externalId: 'm1' });
    classifier((system) => {
      throw new AiUnavailableError('provider_error', system.slice(-400));
    });
    await sweepWaitingMessages(app.db);
    await app.jobs.drain();
    const kept = JSON.stringify([
      await app.db.select().from(communications).all(),
      await app.db.select().from(jobs).all(),
    ]);
    expect(kept).not.toContain(WHOLE);
  });
});
