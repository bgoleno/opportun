// Stage 1 and Stage 2 enforcement at ingest (spec D1 rules 0-7, D6 filtered rows).
//
// A dropped message is stored as a header-only row and never queued for classification, so its
// content never reaches any model. The row keeps sender, date and the identifiers a deep link
// needs, and deliberately keeps no subject, snippet or body: the incident that motivated this
// had its private content in the subject ("Appointment Reminder", "Superbill").
//
// Rules 0 to 2 judge the sender alone; rules 3 to 7 read the text as well. Stage 2, the gate
// model, is consulted last and only about a message Stage 1 passed on a positive signal, and
// a drop there writes the same contentless row under the rule name `ai_gate`.
import { runStructured } from '@opportun/ai';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { communications, discoveryResults, jobs } from '../src/db/schema';
import type { InboundMessage } from '../src/adapters/mailProvider';
import { backfillClassify } from '../src/jobs/classifyBackfill';
import { CLASSIFY_JOB_KIND, ingestInbound } from '../src/jobs/mailIngest';
import type { TriageOutput } from '../src/lib/triageGate';
import { createRule, writeConsumerVeto } from '../src/repos/mailFilters';
import { listCommunications, upsertInbound } from '../src/repos/communications';
import { createOpportunity } from '../src/repos/opportunities';
import { search } from '../src/repos/search';
import { useApi } from './api';

// The gate's model router is mocked: ingest consults the gate on every positive pass now, so a
// test about anything else would otherwise depend on whatever a real provider did.
vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (userId: string) => ({ userId, isAdmin: false });

/** The archetype this feature exists for: private content, no job content anywhere in it. */
const APPOINTMENT = 'Your next appointment is 10/19/2026 at 2:30 PM with Dr. A.';
/** Ordinary job mail, which rule 5 recognizes by its vocabulary. */
const HIRING = 'We are hiring a staff engineer and would like to interview you.';

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  // The gate agrees with Stage 1 unless a test says otherwise, so a test about the rules is not
  // secretly a test of the gate.
  vi.mocked(runStructured).mockImplementation(async (_deps, task) => {
    if (task === 'comms.classify') {
      return {
        classification: 'solicitation',
        outreachKind: 'targeted',
        mismatchReason: null,
        opportunityMatch: null,
        proposedTransition: null,
        confidence: 0.9,
        hardConstraintViolation: null,
      };
    }
    return { jobRelated: true, reason: 'recruiter outreach', confidence: 0.9 };
  });
});

function gateReturns(output: Partial<TriageOutput>): void {
  vi.mocked(runStructured).mockResolvedValueOnce({
    jobRelated: true,
    reason: 'recruiter outreach',
    confidence: 0.9,
    ...output,
  } satisfies TriageOutput);
}

let seq = 0;
/**
 * Ingests one message. The default is the private archetype, so a test that wants a message
 * kept says what makes it job mail: `{ bodyText: HIRING }`, a known sender, or a linked thread.
 * Pass the same `externalId` twice to exercise the re-delivery path.
 */
async function ingest(
  app: FastifyInstance,
  userId: string,
  from: string,
  over: Partial<InboundMessage> = {},
) {
  seq += 1;
  const bodyText = over.bodyText ?? APPOINTMENT;
  const { id } = await ingestInbound(app.db, ctxOf(userId), app.storage, 'gmail', {
    externalId: `ext-${seq}`,
    threadKey: `thread-${seq}`,
    from,
    to: ['me@user.example'],
    subject: 'Appointment Reminder',
    snippet: bodyText.slice(0, 120),
    bodyText,
    sentAt: Date.now() - 1000 * seq,
    ...over,
  });
  return id;
}

const rowById = async (app: FastifyInstance, userId: string, id: string) =>
  (await app.db
    .select()
    .from(communications)
    .where(and(eq(communications.userId, userId), eq(communications.id, id)))
    .get())!;

const classifyJobs = async (app: FastifyInstance) =>
  app.db.select().from(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).all();

/** A thread with an opportunity already linked to it, which is rule 6's precondition. */
async function linkedThread(app: FastifyInstance, userId: string): Promise<string> {
  const ctx = ctxOf(userId);
  const opportunity = await createOpportunity(app.db, ctx, {
    companyName: 'Northwind Systems',
    title: 'Staff Engineer',
    location: 'United States',
    sourceKind: 'manual',
  });
  const threadKey = `linked-thread-${opportunity.id}`;
  const id = await ingest(app, userId, 'recruiter@northwind-systems.example', {
    threadKey,
    subject: 'Intro call',
    bodyText: HIRING,
  });
  await app.db
    .update(communications)
    .set({ opportunityId: opportunity.id })
    .where(and(eq(communications.userId, userId), eq(communications.id, id)))
    .run();
  return threadKey;
}

describe('Stage 1 at ingest', () => {
  it('stores a denied sender as a header-only row and never queues classification', async () => {
    const { app, a } = await boot();
    await createRule(app.db, ctxOf(a.userId), {
      pattern: '*@clinic-a.example',
      effect: 'deny',
    });

    const id = await ingest(app, a.userId, 'info@clinic-a.example');

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('filtered');
    expect(row.triageRule).toBe('deny_list');
    expect(row.subject).toBeNull();
    expect(row.snippet).toBeNull();
    expect(row.bodyRef).toBeNull();
    expect(row.from).toBe('info@clinic-a.example');
    expect(await classifyJobs(app)).toHaveLength(0);
  });

  it('matches the envelope address, never the display name', async () => {
    // Review Focus 2: the display name is attacker-controlled.
    const { app, a } = await boot();
    await createRule(app.db, ctxOf(a.userId), { pattern: '*@evil.test', effect: 'deny' });

    const id = await ingest(app, a.userId, '"recruiter@corp.com" <attacker@evil.test>');

    expect((await rowById(app, a.userId, id)).triageDecision).toBe('filtered');
  });

  it('does not let a display name smuggle an allowed address past a deny rule', async () => {
    const { app, a } = await boot();
    await createRule(app.db, ctxOf(a.userId), { pattern: '*@evil.test', effect: 'deny' });
    await createRule(app.db, ctxOf(a.userId), { pattern: '*@corp.com', effect: 'allow' });

    const id = await ingest(app, a.userId, 'Recruiter <attacker@evil.test>');

    expect((await rowById(app, a.userId, id)).triageDecision).toBe('filtered');
  });

  it('passes an allowed sender through to the classifier with its content intact', async () => {
    const { app, a } = await boot();

    const id = await ingest(app, a.userId, 'recruiter@brightforge.example', {
      subject: 'Next steps',
      bodyText: HIRING,
    });

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('passed');
    expect(row.subject).toBe('Next steps');
    expect(row.snippet).not.toBeNull();
    expect(await classifyJobs(app)).toHaveLength(1);
  });

  it('drops a consumer-domain sender while the veto is on, and passes it once it is off', async () => {
    const { app, a, b } = await boot();

    const denied = await ingest(app, a.userId, 'someone@gmail.com');
    expect((await rowById(app, a.userId, denied)).triageRule).toBe('consumer_domain');

    await writeConsumerVeto(app.db, ctxOf(b.userId), false);
    const allowed = await ingest(app, b.userId, 'someone@gmail.com', {
      subject: 'Hello',
      bodyText: HIRING,
    });
    expect((await rowById(app, b.userId, allowed)).triageDecision).toBe('passed');
  });

  it('lets an allow rule rescue a recruiter writing from a consumer domain', async () => {
    const { app, a } = await boot();
    await createRule(app.db, ctxOf(a.userId), {
      pattern: 'recruiter@gmail.com',
      effect: 'allow',
    });

    const id = await ingest(app, a.userId, 'recruiter@gmail.com', { subject: 'Staff PM role' });

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('passed');
    expect(row.subject).toBe('Staff PM role');
  });

  it('leaves messages stored before a deny rule existed untouched', async () => {
    // Review Focus 5: editing rules affects future syncs, never stored history.
    const { app, a } = await boot();
    const id = await ingest(app, a.userId, 'recruiter@brightforge.example', {
      subject: 'Next steps',
      bodyText: HIRING,
    });
    expect((await rowById(app, a.userId, id)).subject).toBe('Next steps');

    await createRule(app.db, ctxOf(a.userId), {
      pattern: '*@brightforge.example',
      effect: 'deny',
    });

    expect((await rowById(app, a.userId, id)).subject).toBe('Next steps');
  });

  it('keeps a filtered message out of the full-text index', async () => {
    const { app, a } = await boot();
    await createRule(app.db, ctxOf(a.userId), {
      pattern: '*@clinic-a.example',
      effect: 'deny',
    });

    await ingest(app, a.userId, 'info@clinic-a.example', { subject: 'Superbill' });

    const hits = await search(app.db, ctxOf(a.userId), 'Superbill', { limit: 10, offset: 0 });
    expect(hits.items).toHaveLength(0);
  });

  it('shows a blocked message only in the blocked view', async () => {
    const { app, a } = await boot();
    await createRule(app.db, ctxOf(a.userId), {
      pattern: '*@clinic-a.example',
      effect: 'deny',
    });
    const blocked = await ingest(app, a.userId, 'info@clinic-a.example');
    const kept = await ingest(app, a.userId, 'recruiter@brightforge.example', {
      subject: 'Next steps',
      bodyText: HIRING,
    });

    const page = { limit: 50, offset: 0 };
    const inBlocked = await listCommunications(app.db, ctxOf(a.userId), {
      view: 'blocked',
      ...page,
    });
    const inAll = await listCommunications(app.db, ctxOf(a.userId), { view: 'all', ...page });

    expect(inBlocked.items.map((c) => c.id)).toEqual([blocked]);
    expect(inAll.items.map((c) => c.id)).toContain(kept);
    expect(inAll.items.map((c) => c.id)).not.toContain(blocked);
  });

  it('is never picked up by the classify backfill', async () => {
    // C1: a blocked row's classification stays NULL forever, so without a triage predicate the
    // backfill re-queues it the moment an AI key is added, and the prompt carries its From
    // header. Subject and body are null, but "this user hears from a clinic" is the fact the
    // originating incident was about.
    const { app, a } = await boot();
    await createRule(app.db, ctxOf(a.userId), { pattern: '*@clinic-a.example', effect: 'deny' });
    await ingest(app, a.userId, 'info@clinic-a.example');

    const queued = await backfillClassify(app.db, ctxOf(a.userId));

    expect(queued).toBe(0);
    expect(await classifyJobs(app)).toHaveLength(0);
  });

  it('still backfills a passed message that was never classified', async () => {
    const { app, a } = await boot();
    await ingest(app, a.userId, 'recruiter@brightforge.example', {
      subject: 'Next steps',
      bodyText: HIRING,
    });

    expect(await backfillClassify(app.db, ctxOf(a.userId))).toBe(1);
  });

  it('does not blank a stored message when a deny rule is added and it is re-delivered', async () => {
    // C4: a Gmail history-id expiry re-runs the initial listing, so every stored message comes
    // back through upsertInbound. Spec D7: editing rules affects future syncs, never stored
    // history. Blanking here would also orphan the body file on disk and leave the subject in
    // the search index, since nothing deletes it on an update.
    const { app, a } = await boot();
    const kept = { externalId: 'redelivered-1', subject: 'Next steps', bodyText: HIRING };
    await ingest(app, a.userId, 'recruiter@brightforge.example', kept);
    await createRule(app.db, ctxOf(a.userId), {
      pattern: '*@brightforge.example',
      effect: 'deny',
    });

    await ingest(app, a.userId, 'recruiter@brightforge.example', kept);

    const rows = await app.db
      .select()
      .from(communications)
      .where(eq(communications.userId, a.userId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe('Next steps');
    expect(rows[0]!.triageDecision).toBe('passed');
  });

  it('stays unsearchable when the same blocked message is delivered again', async () => {
    const { app, a } = await boot();
    await createRule(app.db, ctxOf(a.userId), { pattern: '*@clinic-a.example', effect: 'deny' });
    const blocked = { externalId: 'filtered-1', subject: 'Superbill' };
    await ingest(app, a.userId, 'info@clinic-a.example', blocked);
    await ingest(app, a.userId, 'info@clinic-a.example', blocked);

    const hits = await search(app.db, ctxOf(a.userId), 'Superbill', { limit: 10, offset: 0 });
    expect(hits.items).toHaveLength(0);
  });

  it('clears an existing index entry if a filtered upsert ever lands on one', async () => {
    // Defense in depth, exercised directly because ingest cannot reach it: triage is
    // insert-only, so a stored row is never re-triaged and this branch has no caller today.
    // An index row outliving its text is invisible until someone searches, so the guard stays
    // and is tested at the seam rather than left to a reader's trust.
    const { app, a } = await boot();
    const ctx = ctxOf(a.userId);
    const msg = {
      externalId: 'seam-1',
      threadKey: 'seam-1',
      from: 'info@clinic-a.example',
      to: ['me@user.example'],
      subject: 'Superbill',
      snippet: 'balance due',
      bodyText: 'balance due',
      sentAt: Date.now(),
    };
    await upsertInbound(app.db, ctx, 'gmail', msg, { decision: 'passed', rule: 'none' });
    expect((await search(app.db, ctx, 'Superbill', { limit: 10, offset: 0 })).items).toHaveLength(
      1,
    );

    await upsertInbound(app.db, ctx, 'gmail', msg, {
      decision: 'filtered',
      rule: 'deny_list',
    });

    const hits = await search(app.db, ctx, 'Superbill', { limit: 10, offset: 0 });
    expect(hits.items).toHaveLength(0);
  });

  it('serves the fields the blocked view needs to explain itself and link out', async () => {
    // The API response is serialized against CommunicationViewSchema, which strips any key it
    // does not declare. Omitting these made BlockedRow render "blocked by no rule" and build
    // a link ending in /undefined, so the escape hatch the consumer veto ships enabled on top
    // of did not work in the running app at all.
    const { app, a } = await boot();
    await createRule(app.db, ctxOf(a.userId), { pattern: '*@clinic-a.example', effect: 'deny' });
    await ingest(app, a.userId, 'info@clinic-a.example', {
      subject: 'Superbill',
      externalId: 'api-blocked-1',
    });

    const res = await a.request({ method: 'GET', url: '/api/v1/communications?view=blocked' });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = (res.json() as { items: Record<string, unknown>[] }).items;

    expect(row?.externalId).toBe('api-blocked-1');
    expect(row?.triageDecision).toBe('filtered');
    expect(row?.triageRule).toBe('deny_list');
    expect(row?.subject).toBeNull();
  });
});

describe('Stage 1 rules 3 to 7 at ingest', () => {
  it('drops the appointment reminder this feature was built for, keeping nothing it said', async () => {
    const { app, a } = await boot();

    const id = await ingest(app, a.userId, 'noreply@smiledentalcare.example');

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('filtered');
    expect(row.triageRule).toBe('private_content');
    expect(row.subject).toBeNull();
    expect(row.snippet).toBeNull();
    expect(row.bodyRef).toBeNull();
    expect(await classifyJobs(app)).toHaveLength(0);
  });

  it('drops a private sender even when the message is full of job words (3a beats rule 5)', async () => {
    const { app, a } = await boot();

    const id = await ingest(app, a.userId, 'noreply@valleymedicalgroup.example', {
      subject: 'Open role',
      bodyText: HIRING,
    });

    const row = await rowById(app, a.userId, id);
    expect(row.triageRule).toBe('private_content');
    expect(row.bodyRef).toBeNull();
    expect(await classifyJobs(app)).toHaveLength(0);
  });

  it('drops private content from a known job sender (3b beats rule 4)', async () => {
    // The case a pass list would otherwise wave straight through.
    const { app, a } = await boot();

    const id = await ingest(app, a.userId, 'no-reply@us.greenhouse-mail.io', {
      subject: 'Your benefits',
      bodyText: 'Your explanation of benefits for claim number 4471 is ready.',
    });

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('filtered');
    expect(row.triageRule).toBe('private_content');
    expect(await classifyJobs(app)).toHaveLength(0);
  });

  it('passes a known job sender whose message carries no job vocabulary at all', async () => {
    const { app, a } = await boot();

    const id = await ingest(app, a.userId, 'inmail-hit-reply@linkedin.com', {
      subject: 'Quick question',
      bodyText: 'Hi there, I came across your profile and wanted to reach out.',
    });

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('passed');
    expect(row.triageRule).toBe('job_sender');
    expect(row.subject).toBe('Quick question');
    expect(await classifyJobs(app)).toHaveLength(1);
  });

  it('passes an unknown sender on job vocabulary alone', async () => {
    const { app, a } = await boot();

    const id = await ingest(app, a.userId, 'talent@northwind-systems.example', {
      subject: 'Hello',
      bodyText: HIRING,
    });

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('passed');
    expect(row.triageRule).toBe('vocabulary');
    // What a kept message keeps: the snippet, not the body (Plan 3 Task 1).
    expect(row.snippet).not.toBeNull();
  });

  it('passes a reply on a thread already linked to an opportunity, with no job words in it', async () => {
    const { app, a } = await boot();
    const threadKey = await linkedThread(app, a.userId);

    const id = await ingest(app, a.userId, 'assistant@northwind-systems.example', {
      threadKey,
      subject: 'Re: Intro call',
      bodyText: 'Tuesday at 2 works on our side. Looking forward to it.',
    });

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('passed');
    expect(row.triageRule).toBe('thread');
  });

  it('lets a linked thread outrank the consumer-domain veto', async () => {
    // Brian's decision, 2026-10-19: linking the thread is the user's own act, so a referral
    // conversation from a personal account is kept. A stranger cannot trigger it.
    const { app, a } = await boot();
    const threadKey = await linkedThread(app, a.userId);

    const id = await ingest(app, a.userId, 'friend@gmail.com', {
      threadKey,
      subject: 'Re: Intro call',
      bodyText: 'Happy to pass on a referral to the hiring manager.',
    });

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('passed');
    expect(row.triageRule).toBe('vocabulary');
  });

  it('keeps the private-content vetoes above a linked thread', async () => {
    const { app, a } = await boot();
    const threadKey = await linkedThread(app, a.userId);

    const id = await ingest(app, a.userId, 'friend@gmail.com', {
      threadKey,
      subject: 'Re: Intro call',
      bodyText: 'Also, my superbill from last week is attached.',
    });

    expect((await rowById(app, a.userId, id)).triageRule).toBe('private_content');
  });

  it('drops a message with no job signal anywhere in it', async () => {
    const { app, a } = await boot();

    const id = await ingest(app, a.userId, 'news@northwind-systems.example', {
      subject: 'Weekly update',
      bodyText: 'Here is what happened this week at the community garden.',
    });

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('filtered');
    expect(row.triageRule).toBe('no_signal');
    expect(row.subject).toBeNull();
    expect(row.bodyRef).toBeNull();
    expect(await classifyJobs(app)).toHaveLength(0);
  });

  it('passes an alert digest sender whose body has no job vocabulary (rule 4)', async () => {
    // Rule 4 covers alert_senders as well as job_senders. Without that, rule 7 would drop a
    // digest whose body happens to carry none of rule 5's words, and Discovery would empty out
    // for a reason nobody could see.
    const { app, a } = await boot();

    const id = await ingest(app, a.userId, 'jobalerts-noreply@linkedin.com', {
      subject: 'Your job alert for product manager',
      bodyText: '3 new postings in Portland, OR.',
    });

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('passed');
    expect(row.triageRule).toBe('job_sender');
  });
});

// Design D-5. The row keeps the handful of references extracted from the body, because Plan 3
// stops keeping the body itself and find-posting needs the link a recruiter sent.
describe('ATS references at ingest', () => {
  const POSTING = 'https://boards.greenhouse.io/brightforge/jobs/5550002002';

  it('keeps the posting link a kept message carried, without keeping the message', async () => {
    const { app, a } = await boot();

    const id = await ingest(app, a.userId, 'recruiter@brightforge.example', {
      subject: 'Next steps',
      bodyText: `We are hiring. The posting is here: ${POSTING}`,
    });

    const row = await rowById(app, a.userId, id);
    expect(row.atsJobRefs).toEqual([
      expect.objectContaining({
        kind: 'ats_greenhouse',
        org: 'brightforge',
        externalId: '5550002002',
      }),
    ]);
  });

  it('keeps none for a message Stage 1 dropped, because a link says what it was about', async () => {
    const { app, a } = await boot();

    const id = await ingest(app, a.userId, 'noreply@smiledentalcare.example', {
      subject: 'Appointment Reminder',
      bodyText: `Your visit is Tuesday. Careers: ${POSTING}`,
    });

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('filtered');
    expect(row.atsJobRefs).toBeNull();
  });

  it('stores nothing when there is no link to store', async () => {
    const { app, a } = await boot();

    const id = await ingest(app, a.userId, 'recruiter@brightforge.example', {
      subject: 'Next steps',
      bodyText: HIRING,
    });

    expect((await rowById(app, a.userId, id)).atsJobRefs).toBeNull();
  });
});

describe('Stage 2 at ingest', () => {
  it('writes a contentless row naming the gate, and never the body or the model text', async () => {
    const { app, a } = await boot();
    const writeAttachment = vi.spyOn(app.storage, 'writeAttachment');
    gateReturns({ jobRelated: false, confidence: 0.92, reason: 'dental appointment reminder' });

    const id = await ingest(app, a.userId, 'talent@northwind-systems.example', {
      subject: 'Hello',
      bodyText: HIRING,
    });

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('filtered');
    expect(row.triageRule).toBe('ai_gate');
    expect(row.subject).toBeNull();
    expect(row.snippet).toBeNull();
    expect(row.bodyRef).toBeNull();
    // No column carries the model's words, and the body never reached the disk at all.
    expect(JSON.stringify(row)).not.toContain('dental');
    expect(writeAttachment).not.toHaveBeenCalled();
    expect(await classifyJobs(app)).toHaveLength(0);
  });

  it('keeps the message when the gate is unavailable', async () => {
    // Fail open, toward the human: a gate that drops mail while it is broken swallows
    // recruiter email silently, which is worse than having no gate.
    const { app, a } = await boot();
    vi.mocked(runStructured).mockRejectedValueOnce(new Error('502 Bad Gateway'));

    const id = await ingest(app, a.userId, 'talent@northwind-systems.example', {
      subject: 'Hello',
      bodyText: HIRING,
    });

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('passed');
    expect(row.triageRule).toBe('vocabulary');
    expect(row.subject).toBe('Hello');
  });

  it('does not fail the delivery when the gate answers something unreadable', async () => {
    // The gate runs inside ingest, so an exception there is not a failed gate but a failed
    // delivery: a connector batch would answer 500 and store none of its messages.
    const { app, a } = await boot();
    vi.mocked(runStructured).mockResolvedValueOnce(undefined as never);

    const id = await ingest(app, a.userId, 'talent@northwind-systems.example', {
      subject: 'Hello',
      bodyText: HIRING,
    });

    const row = await rowById(app, a.userId, id);
    expect(row.triageDecision).toBe('passed');
    expect(row.snippet).not.toBeNull();
  });

  it('is never asked about a message the rules already dropped', async () => {
    const { app, a } = await boot();

    await ingest(app, a.userId, 'noreply@smiledentalcare.example');

    expect(runStructured).not.toHaveBeenCalled();
  });

  it('is never asked about a sender the user allow-listed', async () => {
    const { app, a } = await boot();
    await createRule(app.db, ctxOf(a.userId), {
      pattern: '*@brightforge.example',
      effect: 'allow',
    });

    const id = await ingest(app, a.userId, 'recruiter@brightforge.example', {
      subject: 'Next steps',
      bodyText: HIRING,
    });

    expect((await rowById(app, a.userId, id)).triageRule).toBe('allow_list');
    expect(runStructured).not.toHaveBeenCalled();
  });

  it('is never asked about an alert digest sender', async () => {
    // Those are parsed locally into discovery leads and never classified, so asking a model
    // about them spends money to risk emptying Discovery.
    const { app, a } = await boot();

    await ingest(app, a.userId, 'jobalerts-noreply@linkedin.com', {
      subject: 'Your job alert for product manager',
      bodyText: '3 new postings in Portland, OR.',
    });

    expect(runStructured).not.toHaveBeenCalled();
  });
});

// Plan 3 Task 1: the body is not kept. It travels to the classifier in the job payload, which is
// cleared when the job finishes, so the only lasting copy of a message is the one in the user's
// own mail system.
describe('message bodies are not persisted', () => {
  const classifyJobFor = async (app: FastifyInstance, id: string) =>
    (await classifyJobs(app)).find(
      (j) => (j.payload as { communicationId: string } | null)?.communicationId === id,
    );

  const filesUnder = async (dir: string): Promise<string[]> => {
    const { readdir } = await import('node:fs/promises');
    try {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  };

  it('writes no attachment, and hands the body to the classifier in the payload', async () => {
    const { app, a, dataDir } = await boot();

    const id = await ingest(app, a.userId, 'recruiter@brightforge.example', {
      subject: 'Next steps',
      bodyText: `${HIRING} The full description runs on for a while.`,
    });

    const row = await rowById(app, a.userId, id);
    expect(row.bodyRef).toBeNull();
    // The snippet is kept: Brian's retention target is the snippet plus a link, not subject only.
    expect(row.snippet).not.toBeNull();
    expect(await filesUnder(`${dataDir}/attachments`)).toEqual([]);
    const job = await classifyJobFor(app, id);
    expect((job?.payload as { body?: string }).body).toContain('staff engineer');
  });

  it('clears the body from the payload when the job finishes', async () => {
    const { app, a } = await boot();
    const id = await ingest(app, a.userId, 'recruiter@brightforge.example', {
      subject: 'Next steps',
      bodyText: HIRING,
    });

    await app.jobs.drain();

    const job = await classifyJobFor(app, id);
    expect(job?.status, job?.lastError ?? '').toBe('done');
    // The row that identifies the message stays; the message itself does not.
    expect(job?.payload).toEqual({ communicationId: id });
  });

  it('parses an alert digest from the body it was handed, with nothing on disk', async () => {
    const { app, a, dataDir } = await boot();

    await ingest(app, a.userId, 'jobalerts-noreply@linkedin.com', {
      subject: 'Your job alert for platform engineer',
      bodyText: [
        'Staff Platform Engineer',
        'Initech',
        'Austin, TX',
        'View job: https://www.linkedin.com/comm/jobs/view/3912345678/?trackingId=AbC',
      ].join('\n'),
    });

    const leads = await app.db
      .select()
      .from(discoveryResults)
      .where(eq(discoveryResults.userId, a.userId))
      .all();
    expect(leads).toHaveLength(1);
    expect(await filesUnder(`${dataDir}/attachments`)).toEqual([]);
  });
});
