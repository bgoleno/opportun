// A message that arrives again stays as it was stored, and a rejected one stays rejected.
import { runStructured } from '@opportun/ai';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../src/adapters/mailProvider';
import { communications, jobs } from '../src/db/schema';
import { ingestInbound } from '../src/jobs/mailIngest';
import { CLASSIFY_JOB_KIND, classifyDedupeKey } from '../src/lib/mailClassifyQueue';
import { upsertInbound, type TriageFields } from '../src/repos/communications';
import { invalidateTriageContext } from '../src/lib/triageContext';
import { createRule } from '../src/repos/mailFilters';
import { rejectCommunication } from '../src/repos/reject';
import { CONFIG, makeIo, osascriptReturning, raw, withConfig } from '../../connector/test/fakes';
import { syncOnce } from '../../connector/src/sync';
import { useApi } from './api';
import { queryAll } from './db';
import { onSlowTransaction } from '../src/db/gate';
import { pauseAt, someoneBlocked } from './race';

// Mocked, so that a call is counted (none is made otherwise).
vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (userId: string) => ({ userId, isAdmin: false });
const T = 1_790_000_000_000;
const REF = 'https://boards.greenhouse.io/initech/jobs/1234567';
const OTHER_REF = 'https://boards.greenhouse.io/initech/jobs/7654321';

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockResolvedValue({ jobRelated: true, reason: 'r', confidence: 0.9 });
});

const first = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  externalId: 'msg-1',
  threadKey: 'thread-1',
  from: 'Priya Shah <priya@initech.example>',
  to: ['me@example.com'],
  subject: 'Staff engineer at Initech',
  snippet: 'We are hiring a staff engineer.',
  bodyText: `We are hiring a staff engineer and would like to interview you. ${REF}`,
  sentAt: T,
  ...over,
});

/** The same id, and everything else different at once. */
const again = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  externalId: 'msg-1',
  threadKey: 'thread-other',
  from: 'Someone Else <else@globex.example>',
  to: ['other@example.com'],
  subject: 'An interview at Globex',
  snippet: 'Another opening, for an interview.',
  bodyText: `Another opening, we are hiring and would like to interview you. ${OTHER_REF}`,
  sentAt: T + 86_400_000,
  ...over,
});

async function rowOf(app: FastifyInstance, id: string) {
  return (await app.db.select().from(communications).where(eq(communications.id, id)).get())!;
}
/** The row without the one column a second delivery may change. */
async function storedOf(app: FastifyInstance, id: string) {
  const { updatedAt, ...row } = await rowOf(app, id);
  void updatedAt;
  return row;
}
const indexed = async (app: FastifyInstance, id: string): Promise<string[]> =>
  (
    await queryAll<{ text: string }>(
      app,
      "SELECT text FROM search_index WHERE entity_kind = 'communication' AND entity_id = ?",
      id,
    )
  ).map((r) => r.text);
const classifyJobs = (app: FastifyInstance, id: string) =>
  app.db
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.kind, CLASSIFY_JOB_KIND), eq(jobs.dedupeKey, classifyDedupeKey(id))))
    .all();
async function rule(
  app: FastifyInstance,
  userId: string,
  pattern: string,
  effect: 'allow' | 'deny',
) {
  await createRule(app.db, ctxOf(userId), { pattern, effect });
  invalidateTriageContext(userId);
}
const dropJobs = (app: FastifyInstance) =>
  app.db.delete(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).run();
const reject = (app: FastifyInstance, userId: string, id: string) =>
  rejectCommunication(app.db, ctxOf(userId), id, {
    reason: 'not_job_related',
    expectedOpportunityId: null,
  });

const PASSED: TriageFields = { decision: 'passed', rule: 'r' };
const FILTERED: TriageFields = { decision: 'filtered', rule: 'r' };

describe('upsertInbound: a stored message stays as it was stored', () => {
  it.each<[string, TriageFields | undefined]>([
    ['with no verdict', undefined],
    ['with the same verdict', PASSED],
    ['with a filtered verdict', FILTERED],
  ])('every field different at once, %s', async (_what, triage) => {
    const { app, a } = await boot();
    const { id } = await upsertInbound(app.db, ctxOf(a.userId), 'gmail', first(), PASSED);
    // What a message stored by an earlier release still points at.
    await app.db.update(communications).set({ bodyRef: 'b' }).where(eq(communications.id, id));
    const before = await storedOf(app, id);
    const index = await indexed(app, id);
    const res = await upsertInbound(app.db, ctxOf(a.userId), 'gmail', again(), triage);
    expect(res).toMatchObject({ id, inserted: false });
    expect(await storedOf(app, id)).toEqual(before);
    expect(await indexed(app, id)).toEqual(index);
    expect(index).toHaveLength(1);
  });

  it('a filtered one stays filtered, whatever the next delivery is judged', async () => {
    const { app, a } = await boot();
    const { id } = await upsertInbound(app.db, ctxOf(a.userId), 'gmail', first(), FILTERED);
    const before = await storedOf(app, id);
    expect(before).toMatchObject({ subject: null, snippet: null, atsJobRefs: null });
    await upsertInbound(app.db, ctxOf(a.userId), 'gmail', first(), PASSED);
    await upsertInbound(app.db, ctxOf(a.userId), 'gmail', first());
    expect(await storedOf(app, id)).toEqual(before);
    expect(await indexed(app, id)).toEqual([]);
  });

  it('a rejected one stays rejected', async () => {
    const { app, a } = await boot();
    const { id } = await upsertInbound(app.db, ctxOf(a.userId), 'gmail', first(), PASSED);
    await reject(app, a.userId, id);
    const before = await storedOf(app, id);
    expect(before).toMatchObject({ subject: null, snippet: null });
    for (const msg of [first(), again()]) {
      for (const triage of [undefined, PASSED, FILTERED]) {
        await upsertInbound(app.db, ctxOf(a.userId), 'gmail', msg, triage);
        expect(await storedOf(app, id)).toEqual(before);
        expect(await indexed(app, id)).toEqual([]);
      }
    }
  });

  it('says when it was delivered last', async () => {
    const { app, a } = await boot();
    const { id } = await upsertInbound(app.db, ctxOf(a.userId), 'gmail', first(), PASSED);
    await app.db.update(communications).set({ updatedAt: 1 }).where(eq(communications.id, id));
    await upsertInbound(app.db, ctxOf(a.userId), 'gmail', again(), PASSED);
    expect((await rowOf(app, id)).updatedAt).toBeGreaterThan(1);
  });

  it("another user's copy of it is not the same message", async () => {
    const { app, a, b } = await boot();
    const mine = await upsertInbound(app.db, ctxOf(a.userId), 'gmail', first(), PASSED);
    const theirs = await upsertInbound(app.db, ctxOf(b.userId), 'gmail', again(), PASSED);
    expect(theirs).toMatchObject({ inserted: true });
    expect(theirs.id).not.toBe(mine.id);
    expect((await rowOf(app, theirs.id)).subject).toBe(again().subject);
  });
});

describe('upsertInbound: an empty text is filled in by the same message', () => {
  const empty = (over: Partial<InboundMessage> = {}) =>
    first({ snippet: '', bodyText: 'We are hiring.', ...over });

  it.each<[string, string | null]>([
    ['empty', ''],
    ['none', null],
  ])('a text that was %s, and its references', async (_what, snippet) => {
    const { app, a } = await boot();
    const { id } = await upsertInbound(app.db, ctxOf(a.userId), 'gmail', empty(), PASSED);
    await app.db.update(communications).set({ snippet }).where(eq(communications.id, id));
    const before = await storedOf(app, id);
    expect(before.atsJobRefs).toBeNull();
    await upsertInbound(app.db, ctxOf(a.userId), 'gmail', first(), PASSED);
    const after = await storedOf(app, id);
    expect(after.snippet).toBe(first().snippet);
    expect(after.atsJobRefs).toHaveLength(1);
    expect(after).toEqual({ ...before, snippet: after.snippet, atsJobRefs: after.atsJobRefs });
    expect(await indexed(app, id)).toEqual([`${first().subject}\n${first().snippet}`]);
  });

  it('the references it has stay', async () => {
    const { app, a } = await boot();
    const msg = first({ snippet: '' });
    const { id } = await upsertInbound(app.db, ctxOf(a.userId), 'gmail', msg, PASSED);
    const before = await rowOf(app, id);
    expect(before.atsJobRefs).toHaveLength(1);
    await upsertInbound(
      app.db,
      ctxOf(a.userId),
      'gmail',
      first({ bodyText: `We are hiring. ${OTHER_REF}` }),
      PASSED,
    );
    const after = await rowOf(app, id);
    expect(after.snippet).toBe(first().snippet);
    expect(after.atsJobRefs).toEqual(before.atsJobRefs);
  });

  it('compares what was stored: a long subject, cut, is the same one', async () => {
    const { app, a } = await boot();
    const subject = `Role ${'x'.repeat(2000)}\0`;
    const from = `"${'y'.repeat(2000)}" <priya@initech.example>`;
    const long = { subject, from };
    const { id } = await upsertInbound(app.db, ctxOf(a.userId), 'gmail', empty(long), PASSED);
    await upsertInbound(app.db, ctxOf(a.userId), 'gmail', first(long), PASSED);
    expect((await rowOf(app, id)).snippet).toBe(first().snippet);
  });

  it.each<[string, Partial<InboundMessage>]>([
    ['another sender', { from: 'Someone Else <else@globex.example>' }],
    ['another subject', { subject: 'An interview at Globex' }],
    ['another date', { sentAt: T + 1 }],
  ])('not by %s', async (_what, over) => {
    const { app, a } = await boot();
    const { id } = await upsertInbound(app.db, ctxOf(a.userId), 'gmail', empty(), PASSED);
    const before = await storedOf(app, id);
    await upsertInbound(app.db, ctxOf(a.userId), 'gmail', first(over), PASSED);
    expect(await storedOf(app, id)).toEqual(before);
  });

  it('not by a delivery that is filtered', async () => {
    const { app, a } = await boot();
    const { id } = await upsertInbound(app.db, ctxOf(a.userId), 'gmail', empty(), PASSED);
    for (const subject of [empty().subject, null]) {
      await app.db.update(communications).set({ subject }).where(eq(communications.id, id));
      const before = await storedOf(app, id);
      await upsertInbound(app.db, ctxOf(a.userId), 'gmail', first(), FILTERED);
      expect(await storedOf(app, id)).toEqual(before);
    }
  });

  it('not into a text that is there', async () => {
    const { app, a } = await boot();
    const { id } = await upsertInbound(app.db, ctxOf(a.userId), 'gmail', first(), PASSED);
    const before = await storedOf(app, id);
    await upsertInbound(app.db, ctxOf(a.userId), 'gmail', first({ snippet: 'Other' }), PASSED);
    expect(await storedOf(app, id)).toEqual(before);
  });

  it('not into a rejected or a filtered message, even with a subject that is equal', async () => {
    const { app, a } = await boot();
    for (const [i, gone] of [
      { rejectedAt: T, triageDecision: 'passed' as const },
      { rejectedAt: null, triageDecision: 'filtered' as const },
    ].entries()) {
      const msg = empty({ externalId: `msg-gone-${i}` });
      const { id } = await upsertInbound(app.db, ctxOf(a.userId), 'gmail', msg, PASSED);
      await app.db.update(communications).set(gone).where(eq(communications.id, id));
      const before = await storedOf(app, id);
      await upsertInbound(
        app.db,
        ctxOf(a.userId),
        'gmail',
        first({ externalId: msg.externalId }),
        PASSED,
      );
      expect(await storedOf(app, id)).toEqual(before);
      expect(await indexed(app, id)).toEqual([]);
    }
  });
});

describe('ingestInbound: a stored message', () => {
  const deliver = (
    app: FastifyInstance,
    userId: string,
    msg: InboundMessage,
    alongside?: () => Promise<void>,
  ) => ingestInbound(app.db, ctxOf(userId), app.storage, 'gmail', msg, alongside);

  it('is not routed again, and what goes with the delivery is still written', async () => {
    const { app, a } = await boot();
    const { id } = await deliver(app, a.userId, first());
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(1);
    const before = await storedOf(app, id);
    const alongside = vi.fn(() => Promise.resolve());
    const res = await deliver(app, a.userId, again(), alongside);
    expect(res).toEqual({ id, inserted: false });
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(1);
    expect(alongside).toHaveBeenCalledTimes(1);
    expect(await storedOf(app, id)).toEqual(before);
  });

  it("another user's copy of it does not count as stored", async () => {
    const { app, a, b } = await boot();
    await deliver(app, a.userId, first());
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(1);
    const { id, inserted } = await deliver(app, b.userId, first());
    expect(inserted).toBe(true);
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(2);
    expect(await classifyJobs(app, id)).toHaveLength(1);
  });

  it('never routed (its queueing failed) and not rejected, is routed', async () => {
    const { app, a } = await boot();
    const { id } = await deliver(app, a.userId, first());
    await dropJobs(app);
    await deliver(app, a.userId, again());
    expect(await classifyJobs(app, id)).toHaveLength(1);
  });

  it('that was rejected is not routed', async () => {
    const { app, a } = await boot();
    const { id } = await deliver(app, a.userId, first());
    await reject(app, a.userId, id);
    await dropJobs(app);
    for (const msg of [first(), again()]) await deliver(app, a.userId, msg);
    expect(await classifyJobs(app, id)).toEqual([]);
    expect(await rowOf(app, id)).toMatchObject({ subject: null, snippet: null });
    expect(await indexed(app, id)).toEqual([]);
  });

  it.each<[string, (app: FastifyInstance, userId: string, id: string) => Promise<unknown>]>([
    ['rejected', reject],
    [
      'filtered',
      (app, _userId, id) =>
        app.db
          .update(communications)
          .set({ triageDecision: 'filtered' })
          .where(eq(communications.id, id))
          .run(),
    ],
  ])('that is %s between its delivery and its routing is not routed', async (_what, close) => {
    const { app, a } = await boot();
    const { id } = await deliver(app, a.userId, first());
    await dropJobs(app);
    const paused = pauseAt('mail.ingest.stored');
    const delivery = deliver(app, a.userId, first());
    await paused.reached;
    await close(app, a.userId, id);
    paused.release();
    await delivery;
    expect(await classifyJobs(app, id)).toEqual([]);
  });

  it('that was filtered is not routed, even when its sender is allowed by then', async () => {
    const { app, a } = await boot();
    const msg = first({ from: 'News <news@shop.example>', bodyText: 'A sale on shoes.' });
    const { id } = await deliver(app, a.userId, msg);
    expect((await rowOf(app, id)).triageDecision).toBe('filtered');
    await rule(app, a.userId, 'news@shop.example', 'allow');
    const before = await storedOf(app, id);
    await deliver(app, a.userId, msg);
    expect(await classifyJobs(app, id)).toEqual([]);
    expect(await storedOf(app, id)).toEqual(before);
    expect(await indexed(app, id)).toEqual([]);
  });

  it('that passed is left as it was when its sender is denied by then', async () => {
    const { app, a } = await boot();
    const { id } = await deliver(app, a.userId, first());
    await rule(app, a.userId, 'priya@initech.example', 'deny');
    const before = await storedOf(app, id);
    const index = await indexed(app, id);
    await deliver(app, a.userId, first());
    expect(await storedOf(app, id)).toEqual(before);
    expect(await indexed(app, id)).toEqual(index);
    // Never routed (its queueing failed), it is not routed now.
    await dropJobs(app);
    await deliver(app, a.userId, first());
    expect(await classifyJobs(app, id)).toEqual([]);
    expect(await storedOf(app, id)).toEqual(before);
    // Control: a new message of that sender is filtered.
    const other = await deliver(app, a.userId, first({ externalId: 'msg-2' }));
    expect((await rowOf(app, other.id)).triageDecision).toBe('filtered');
  });
});

describe('a reject beside a delivery of the same message', () => {
  // With no text stored, so that a delivery has one to fill in.
  async function stored(app: FastifyInstance, userId: string) {
    const { id } = await upsertInbound(
      app.db,
      ctxOf(userId),
      'gmail',
      first({ snippet: '', bodyText: 'We are hiring.' }),
      PASSED,
    );
    return id;
  }
  const deliver = (app: FastifyInstance, userId: string, alongside?: () => Promise<void>) =>
    ingestInbound(app.db, ctxOf(userId), app.storage, 'gmail', first(), alongside);
  async function gone(app: FastifyInstance, id: string) {
    expect(await rowOf(app, id)).toMatchObject({
      subject: null,
      snippet: null,
      atsJobRefs: null,
      rejectedAt: expect.any(Number),
    });
    expect(await indexed(app, id)).toEqual([]);
    expect(await classifyJobs(app, id)).toEqual([]);
  }

  it('the reject once the delivery has read what it needs: it stays rejected', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a.userId);
    const pause = pauseAt('mail.ingest');
    const delivery = deliver(app, a.userId);
    await pause.reached;
    await reject(app, a.userId, id);
    pause.release();
    expect(await delivery).toEqual({ id, inserted: false });
    await gone(app, id);
  });

  it('the delivery once the reject has read the message: what it filled in goes too', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a.userId);
    const pause = pauseAt('reject.read');
    const rejecting = reject(app, a.userId, id);
    await pause.reached;
    await deliver(app, a.userId);
    expect((await rowOf(app, id)).snippet).toBe(first().snippet);
    await dropJobs(app);
    pause.release();
    await rejecting;
    await gone(app, id);
  });

  it('the reject under way: the delivery waits for it, and it stays rejected', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a.userId);
    onSlowTransaction(() => undefined);
    const pause = pauseAt('reject.erased');
    const rejecting = reject(app, a.userId, id);
    await pause.reached;
    const delivery = deliver(app, a.userId);
    const waited = await someoneBlocked(app);
    pause.release();
    await rejecting;
    await delivery;
    expect(waited).toBe(true);
    await gone(app, id);
  });

  it('the delivery under way: the reject waits for it, and what it filled in goes too', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a.userId);
    onSlowTransaction(() => undefined);
    let go!: () => void;
    let arrived!: () => void;
    const held = new Promise<void>((r) => (go = r));
    const reached = new Promise<void>((r) => (arrived = r));
    const delivery = deliver(app, a.userId, async () => {
      arrived();
      await held;
    });
    await reached;
    const rejecting = reject(app, a.userId, id);
    const waited = await someoneBlocked(app);
    go();
    await delivery;
    await rejecting;
    expect(waited).toBe(true);
    await dropJobs(app);
    await gone(app, id);
  });
});

describe('the connector: two syncs, and a new setup', () => {
  const HIRING = 'We are hiring a staff engineer and would like to interview you.';
  const mail = (over: Parameters<typeof raw>[1] = {}) => raw(1, { body: HIRING, ...over });
  /** The same message id, and everything else different at once. */
  const other = () =>
    mail({
      subject: 'An interview at Globex',
      sender: 'Someone Else <else@globex.example>',
      recipients: [{ name: 'Other', address: 'other@home.example' }],
      dateSent: '2026-10-02T00:00:00.000Z',
      body: `${HIRING} ${OTHER_REF}`,
    });

  it.each<[string, boolean]>([
    ['kept', false],
    ['rejected', true],
  ])('a %s message stays so', async (_what, rejected) => {
    const { app, a } = await boot();
    const minted = await a.request({
      method: 'POST',
      url: '/api/v1/device-tokens',
      payload: { name: 'Mac', scopes: ['mail:push'], password: 'correct horse battery' },
    });
    const config = { ...CONFIG, token: minted.json<{ token: string }>().token };
    /** One sync of a connector whose Mail holds `message`; `set` up anew, it has no cursor. */
    const sync = async (message: ReturnType<typeof raw>, cursor: number | null) => {
      const { io, fs } = makeIo({
        osascript: osascriptReturning([[message]]).run,
        fetch: async (_url, init) => {
          const res = await app.inject({
            method: 'POST',
            url: '/api/v1/connector/mail/batch',
            headers: init.headers,
            payload: init.body,
          });
          return {
            status: res.statusCode,
            headers: { get: () => null },
            text: () => Promise.resolve(res.body),
          };
        },
      });
      await withConfig(fs, config, cursor === null ? undefined : { cursor });
      return await syncOnce(io, config);
    };
    expect(await sync(mail(), null)).toMatchObject({ pushed: 1, inserted: 1 });
    const { id } = (await app.db
      .select()
      .from(communications)
      .where(eq(communications.userId, a.userId))
      .get())!;
    if (rejected) await reject(app, a.userId, id);
    await dropJobs(app);
    const before = await storedOf(app, id);
    const index = await indexed(app, id);
    expect(index).toHaveLength(rejected ? 0 : 1);
    expect(before.triageDecision).toBe('passed');

    const received = Date.parse(mail().dateReceived);
    for (const cursor of [received, null]) {
      for (const message of [mail(), other()]) {
        expect(await sync(message, cursor)).toMatchObject({ pushed: 1, inserted: 0 });
        expect(await storedOf(app, id)).toEqual(before);
        expect(await indexed(app, id)).toEqual(index);
      }
    }
    expect(await classifyJobs(app, id)).toHaveLength(rejected ? 0 : 1);
  });
});
