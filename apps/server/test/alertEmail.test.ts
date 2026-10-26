// Job alert emails as discovery leads (Task 12, FR-D1 alert source). Digests from the alert
// senders skip the AI classifier: a deterministic parser turns each job into a partial lead in
// the review queue (through the engine's insert path, so dedupe and lead resolution apply), the
// message is kept as 'other' with no activity, and the LinkedIn job links stay metadata only.
import { readFileSync } from 'node:fs';
import { runStructured } from '@opportun/ai';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_SENDERS_SETTING,
  DEFAULT_ALERT_SENDERS,
  MAX_FROM_HEADER_CHARS,
  senderAddress,
} from '../src/adapters/sources/alertEmail';
import { activities, communications, jobs } from '../src/db/schema';
import { CLASSIFY_JOB_KIND, enqueueClassify } from '../src/jobs/gmailSync';
import { LEAD_RESOLVE_KIND } from '../src/jobs/leadResolve';
import { parseIndeedAlert } from '../src/lib/alertParsers/indeed';
import { parseLinkedInAlert } from '../src/lib/alertParsers/linkedin';
import type { safeFetch } from '../src/lib/safeFetch';
import { listResults, listSources } from '../src/repos/discovery';
import { writeUserSetting } from '../src/repos/userSettings';
import { useApi } from './api';
import { connectGoogle, fakeGoogle, type FakeGoogle } from './fakeGoogle';
import type { TestClient } from './isolation';
import { expectLinear } from './scaling';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

let google: FakeGoogle;
const boot = useApi(() => {
  google = fakeGoogle();
  return { build: { google } };
});
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const PAGE = { limit: 50, offset: 0 };

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/alerts/${name}`, import.meta.url), 'utf8');
const LINKEDIN = fixture('linkedin-alert.txt');
const INDEED = fixture('indeed-alert.txt');
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockImplementation(async (_deps, task) => {
    if (task === 'comms.classify') {
      return {
        classification: 'solicitation',
        outreachKind: 'targeted',
        mismatchReason: null,
        opportunityMatch: null,
        proposedTransition: null,
        confidence: 0.9,
      };
    }
    // The Stage 1 gate, which ingest consults about every positively passed message. It has to
    // answer in its own shape: a reply of the wrong shape reads as "not job related" here,
    // where nothing validates it, and would drop mail these tests are not about.
    if (task === 'comms.triage') {
      return { jobRelated: true, reason: 'job mail', confidence: 0.9 };
    }
    return { score: 50, rationale: 'ok', disqualifiers: [] };
  });
});

describe('alert digest parsers', () => {
  it('ignores a spoofed display name: the address is the angle-addr that ends the header', () => {
    expect(senderAddress('"<jobalerts-noreply@linkedin.com>" <attacker@evil.example>')).toBe(
      'attacker@evil.example',
    );
    expect(senderAddress('jobalerts-noreply@linkedin.com <attacker@evil.example>')).toBe(
      'attacker@evil.example',
    );
    expect(senderAddress('Alerts <jobalerts-noreply@linkedin.com> trailing')).toBe('');
    expect(senderAddress('not an address')).toBe('');
  });

  it('drops job links outside the board domain (LinkedIn /comm/jobs/view, Indeed)', () => {
    const offsite = LINKEDIN.replaceAll(
      'https://www.linkedin.com/comm/',
      'https://evil.example/comm/',
    );
    expect(parseLinkedInAlert(offsite)).toEqual([]);
    const lookalike = LINKEDIN.replaceAll(
      'www.linkedin.com/comm/',
      'www.linkedin.com.evil.example/comm/',
    );
    expect(parseLinkedInAlert(lookalike)).toEqual([]);
    const notComm = LINKEDIN.replaceAll('/comm/jobs/view/', '/jobs/view/');
    expect(parseLinkedInAlert(notComm)).toEqual([]);
    const indeedOffsite = INDEED.replaceAll(
      'https://www.indeed.com/rc/',
      'https://evil.example/rc/',
    );
    expect(parseIndeedAlert(indeedOffsite)).toEqual([]);
  });

  it('parses a blank-free body in time that grows with its length, not faster', () => {
    const view = 'View job: https://www.linkedin.com/comm/jobs/view/1/';
    const body = (lines: number) =>
      Array.from({ length: lines }, (_, i) => (i % 2 === 0 ? `Line ${i}` : view)).join('\n');
    const small = body(12_500);
    const large = body(50_000);
    let leads: unknown[] = [];
    expectLinear({
      label: 'parseLinkedInAlert over a blank-free body',
      factor: 4,
      ceilingMs: 5_000,
      small: () => void parseLinkedInAlert(small),
      large: () => (leads = parseLinkedInAlert(large)),
    });
    expect(leads.length).toBeLessThanOrEqual(100);
  });

  // Both parsers against the inputs that would expose catastrophic backtracking: a body far
  // past the cap, and a line count far past any real digest.
  it('keeps both parsers linear on inputs built to trigger backtracking', () => {
    const view = 'View job: https://www.linkedin.com/comm/jobs/view/1/';
    expectLinear({
      label: 'parseIndeedAlert over a huge body',
      factor: 4,
      ceilingMs: 5_000,
      small: () => void parseIndeedAlert('x'.repeat(1_250_000)),
      large: () => void parseIndeedAlert('x'.repeat(5_000_000)),
    });
    expectLinear({
      label: 'parseLinkedInAlert over many lines',
      factor: 4,
      ceilingMs: 5_000,
      small: () => void parseLinkedInAlert(`${'A line\n'.repeat(100_000)}${view}`),
      large: () => void parseLinkedInAlert(`${'A line\n'.repeat(400_000)}${view}`),
    });
  });

  it('does not absorb the digest header into the first job', () => {
    const body = [
      'Your job alert for product manager in United States',
      'Principal Product Manager, Data Platform Governance',
      'The Walt Disney Company',
      'Burbank, CA',
      'View job: https://www.linkedin.com/comm/jobs/view/4479334176/',
    ].join('\n');
    const [lead] = parseLinkedInAlert(body);
    expect(lead).toMatchObject({
      title: 'Principal Product Manager, Data Platform Governance',
      company: 'The Walt Disney Company',
      location: 'Burbank, CA',
    });
  });

  it('drops a job whose block is only the digest header', () => {
    const body = [
      'Your job alert for product manager in United States',
      'View job: https://www.linkedin.com/comm/jobs/view/4479334176/',
    ].join('\n');
    expect(parseLinkedInAlert(body)).toEqual([]);
  });

  it('keeps a posting whose title legitimately contains the alert phrase', () => {
    const body = [
      '',
      'Manager, Your Job Alert Platform',
      'Acme Corp',
      'Remote',
      'View job: https://www.linkedin.com/comm/jobs/view/4479334177/',
    ].join('\n');
    const [lead] = parseLinkedInAlert(body);
    expect(lead?.title).toBe('Manager, Your Job Alert Platform');
  });

  it('LinkedIn: one lead per job with title, company, location and the canonical job link', () => {
    const leads = parseLinkedInAlert(LINKEDIN);
    expect(leads).toEqual([
      {
        company: 'Initech',
        title: 'Staff Platform Engineer',
        location: 'Austin, TX',
        remote: null,
        descriptionMd: null,
        postingUrl: 'https://www.linkedin.com/jobs/view/3912345678/',
        externalId: '3912345678',
      },
      {
        company: 'Globex Corporation',
        title: 'Senior Site Reliability Engineer',
        location: 'United States (Remote)',
        remote: true,
        descriptionMd: null,
        postingUrl: 'https://www.linkedin.com/jobs/view/3912345679/',
        externalId: '3912345679',
      },
      {
        company: 'Umbrella Health',
        // Raw from the parser; the engine sanitizes before storage.
        title: 'Platform Engineer II <script>alert(1)</script>',
        location: 'Austin, Texas Metropolitan Area',
        remote: null,
        descriptionMd: null,
        postingUrl: 'https://www.linkedin.com/jobs/view/3912345680/',
        externalId: '3912345680',
      },
    ]);
  });

  it('Indeed: title, company and location, pay line, and the job key link', () => {
    const leads = parseIndeedAlert(INDEED);
    expect(leads).toHaveLength(3);
    expect(leads[0]).toEqual({
      company: 'Initech',
      title: 'Platform Engineer',
      location: 'Austin, TX',
      remote: null,
      compNote: '$140,000 - $170,000 a year',
      descriptionMd: null,
      postingUrl: 'https://www.indeed.com/viewjob?jk=1a2b3c4d5e6f7a8b',
      externalId: '1a2b3c4d5e6f7a8b',
    });
    expect(leads[1]).toMatchObject({ company: 'Globex', location: 'Remote', remote: true });
    expect(leads[2]).toMatchObject({
      company: 'Umbrella Health',
      location: 'Round Rock, TX 78664',
      compNote: '$65 - $80 an hour',
    });
    expect(parseLinkedInAlert(INDEED)).toEqual([]);
    expect(parseIndeedAlert(LINKEDIN)).toEqual([]);
  });

  it('extracts the sender address from a From header', () => {
    expect(senderAddress('LinkedIn Job Alerts <JobAlerts-NoReply@LinkedIn.com>')).toBe(
      DEFAULT_ALERT_SENDERS[0],
    );
    expect(senderAddress('alert@indeed.com')).toBe('alert@indeed.com');
  });

  it('refuses a From header that carries more than one mailbox', () => {
    const trusted = DEFAULT_ALERT_SENDERS[0] as string;
    const angle = `<${trusted}>`;
    for (const header of [
      `attacker@evil.example, ${angle}`,
      `${angle}, attacker@evil.example`,
      `Alerts ${angle}, Evil <attacker@evil.example>`,
      `${trusted},`,
      // The cap is a reject, not a cut: truncation must not leave the trusted mailbox last.
      `${'a'.repeat(MAX_FROM_HEADER_CHARS - angle.length)}${angle}, <attacker@evil.example>`,
      // An unterminated quoted display name: which mailboxes the header lists is unclear.
      `"Alerts, Jobs ${angle}`,
    ]) {
      expect(senderAddress(header), JSON.stringify(header.slice(-80))).toBe('');
    }
    // One mailbox still matches, with a comma inside the quoted display name or without one.
    expect(senderAddress(`"Alerts, Jobs" ${angle}`)).toBe(trusted);
    expect(senderAddress(`Alerts ${angle}`)).toBe(trusted);
    expect(senderAddress(trusted)).toBe(trusted);
  });
});

async function setup() {
  const { app, a, b } = await boot();
  await connectGoogle(a, 'gmail', google);
  const fetched: string[] = [];
  app.jobs.services.sourceFetch = (async (url: string) => {
    fetched.push(url);
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof safeFetch;
  return { app, a, b, fetched };
}

async function sync(app: FastifyInstance, c: TestClient): Promise<void> {
  const res = await c.request({ method: 'POST', url: '/api/v1/integrations/gmail/sync' });
  expect(res.statusCode, res.body).toBe(202);
  await app.jobs.drain();
}

async function commBySubject(app: FastifyInstance, userId: string, subject: string) {
  return (await app.db
    .select()
    .from(communications)
    .where(and(eq(communications.userId, userId), eq(communications.subject, subject)))
    .get())!;
}

const classifyCalls = () =>
  vi.mocked(runStructured).mock.calls.filter(([, task]) => task === 'comms.classify');

describe('alert digests through Gmail sync', () => {
  it('a LinkedIn digest yields leads, the links are never fetched, and the AI never sees it', async () => {
    const { app, a, fetched } = await setup();
    google.gmail.add({
      id: 'li-1',
      from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
      subject: '"platform engineer": 3 new jobs in Austin',
      text: LINKEDIN,
      sentAt: T0,
    });
    google.gmail.add({
      id: 'rec-1',
      from: 'Pat Recruiter <pat@staffing.example>',
      subject: 'Staff role at Northwind',
      text: 'Hi, are you open to interviewing for a Staff Platform role at Northwind?',
      sentAt: T0 + 1000,
    });
    await sync(app, a);

    const ctx = ctxOf(a);
    const [source] = (await listSources(app.db, ctx, { ...PAGE, kind: 'alert_email' })).items;
    expect(source).toMatchObject({ kind: 'alert_email', enabled: true, scheduleCron: null });
    const leads = await listResults(app.db, ctx, {
      ...PAGE,
      sourceId: source!.id,
      sort: 'createdAt',
    });
    expect(leads.total).toBe(3);
    expect(leads.items.map((r) => r.posting.title)).toEqual([
      'Staff Platform Engineer',
      'Senior Site Reliability Engineer',
      'Platform Engineer II',
    ]);
    expect(leads.items[0]!.posting).toMatchObject({
      company: 'Initech',
      location: 'Austin, TX',
      postingUrl: 'https://www.linkedin.com/jobs/view/3912345678/',
      descriptionMd: null,
    });
    for (const r of leads.items) {
      expect(r.disposition).toBe('pending');
      expect(r.resolution).toBe('needs_capture');
    }
    // Lead resolution ran for each lead (no known company boards, so nothing was fetched).
    const resolveJobs = await app.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, LEAD_RESOLVE_KIND))
      .all();
    expect(resolveJobs).toHaveLength(3);
    expect(resolveJobs.every((j) => j.status === 'done')).toBe(true);
    expect(fetched).toEqual([]);

    // The digest is stored as 'other', never queued for the classifier, with no activity.
    const digest = await commBySubject(app, a.userId, '"platform engineer": 3 new jobs in Austin');
    expect(digest).toMatchObject({
      classification: 'other',
      needsReview: false,
      opportunityId: null,
    });
    const classifyJobs = await app.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, CLASSIFY_JOB_KIND))
      .all();
    const payloads = classifyJobs.map(
      (j) => (j.payload as { communicationId: string }).communicationId,
    );
    expect(payloads).not.toContain(digest.id);
    expect(
      await app.db.select().from(activities).where(eq(activities.userId, a.userId)).all(),
    ).toEqual([]);

    // Ordinary recruiter mail still goes to the AI classifier (and only that message does).
    const recruiter = await commBySubject(app, a.userId, 'Staff role at Northwind');
    expect(payloads).toEqual([recruiter.id]);
    expect(classifyCalls()).toHaveLength(1);
    const system = classifyCalls()[0]![2].system;
    expect(system).toContain('Staff role at Northwind');
    expect(system).not.toContain('3912345678');
  });

  it('remembers which message each lead came out of (design D3b)', async () => {
    // So the queue can link back to the mail rather than sending the user to search for it.
    const { app, a } = await setup();
    google.gmail.add({
      id: 'li-source',
      from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
      subject: 'Your job alert for platform engineer',
      text: LINKEDIN,
      sentAt: T0,
    });
    await sync(app, a);

    const digest = await commBySubject(app, a.userId, 'Your job alert for platform engineer');
    const leads = await listResults(app.db, ctxOf(a), PAGE);
    expect(leads.total).toBe(3);
    for (const lead of leads.items) {
      expect(lead.sourceCommunicationId).toBe(digest.id);
      // The link is built from these two at render time; no URL is stored.
      expect(lead.sourceMailChannel).toBe('gmail');
      expect(lead.sourceMailExternalId).toBe('li-source');
    }
  });

  it('a spoofed display name is ordinary mail: classified by AI, no leads', async () => {
    const { app, a } = await setup();
    google.gmail.add({
      id: 'spoof-1',
      from: '"<jobalerts-noreply@linkedin.com>" <attacker@evil.example>',
      subject: 'Totally a job alert',
      text: LINKEDIN,
      sentAt: T0,
    });
    await sync(app, a);
    expect((await listResults(app.db, ctxOf(a), PAGE)).total).toBe(0);
    expect(classifyCalls()).toHaveLength(1);
    const comm = await commBySubject(app, a.userId, 'Totally a job alert');
    expect(comm.classification).toBe('solicitation');
  });

  it('a second mailbox in the From header is ordinary mail: classified by AI, no leads', async () => {
    const { app, a } = await setup();
    google.gmail.add({
      id: 'multi-1',
      from: 'attacker@evil.example, LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
      subject: 'Two senders, one alert',
      text: LINKEDIN,
      sentAt: T0,
    });
    await sync(app, a);
    expect((await listResults(app.db, ctxOf(a), PAGE)).total).toBe(0);
    expect(classifyCalls()).toHaveLength(1);
    const comm = await commBySubject(app, a.userId, 'Two senders, one alert');
    expect(comm.classification).toBe('solicitation');
  });

  it('an Indeed digest parses into leads', async () => {
    const { app, a } = await setup();
    google.gmail.add({
      id: 'in-1',
      from: 'Indeed <alert@indeed.com>',
      subject: '12 new platform engineer jobs',
      text: INDEED,
      sentAt: T0,
    });
    await sync(app, a);
    const results = (await listResults(app.db, ctxOf(a), { ...PAGE, sort: 'createdAt' })).items;
    expect(results.map((r) => [r.posting.company, r.posting.externalId])).toEqual([
      ['Initech', '1a2b3c4d5e6f7a8b'],
      ['Globex', '9f8e7d6c5b4a3921'],
      ['Umbrella Health', '0011223344556677'],
    ]);
    expect(results[0]!.posting.compNote).toBe('$140,000 - $170,000 a year');
    expect(classifyCalls()).toHaveLength(0);
  });

  it('a re-synced or re-processed digest adds no duplicate leads', async () => {
    const { app, a } = await setup();
    google.gmail.add({
      id: 'li-1',
      from: 'jobalerts-noreply@linkedin.com',
      subject: 'Your job alert',
      text: LINKEDIN,
      sentAt: T0,
    });
    await sync(app, a);
    // The next digest repeats one of the same jobs under a new message id.
    const repeat = LINKEDIN.split('---------------------------------------------------------')[0]!;
    google.gmail.add({
      id: 'li-2',
      from: 'jobalerts-noreply@linkedin.com',
      subject: 'Your job alert (again)',
      text: repeat,
      sentAt: T0 + 60_000,
    });
    await sync(app, a);
    await sync(app, a);
    const ctx = ctxOf(a);
    expect((await listResults(app.db, ctx, PAGE)).total).toBe(3);

    // Classifying the stored digest again (e.g. a backfill) takes the dedupe-checked path too.
    const digest = await commBySubject(app, a.userId, 'Your job alert');
    await enqueueClassify(app.db, ctx, digest.id);
    await app.jobs.drain();
    const job = (
      await app.db.select().from(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).all()
    ).find((j) => (j.payload as { communicationId: string }).communicationId === digest.id)!;
    expect(job.status).toBe('done');
    expect(job.result).toEqual({ status: 'alert_digest', leads: 0 });
    expect((await listResults(app.db, ctx, PAGE)).total).toBe(3);
    expect(classifyCalls()).toHaveLength(0);
  });

  it('stores lead text sanitized (markup in a digest title is stripped)', async () => {
    const { app, a } = await setup();
    google.gmail.add({
      id: 'li-1',
      from: 'jobalerts-noreply@linkedin.com',
      subject: 'Your job alert',
      text: LINKEDIN,
      sentAt: T0,
    });
    await sync(app, a);
    const titles = (await listResults(app.db, ctxOf(a), PAGE)).items.map((r) => r.posting.title);
    expect(titles).toContain('Platform Engineer II');
    expect(titles.join(' ')).not.toMatch(/<script/i);
  });

  it('the sender list is per user and configurable (alert_senders:<userId>)', async () => {
    const { app, a } = await setup();
    await writeUserSetting(app.db, ctxOf(a), ALERT_SENDERS_SETTING, ['jobs@digest.example']);
    google.gmail.add({
      id: 'custom-1',
      from: 'Digest <jobs@digest.example>',
      subject: 'Custom digest',
      text: INDEED,
      sentAt: T0,
    });
    google.gmail.add({
      id: 'li-1',
      from: 'jobalerts-noreply@linkedin.com',
      subject: 'Not on my list any more',
      text: LINKEDIN,
      sentAt: T0 + 1000,
    });
    await sync(app, a);
    expect((await listResults(app.db, ctxOf(a), PAGE)).total).toBe(3);
    // The LinkedIn digest is now ordinary mail for this user: the classifier sees it.
    expect(classifyCalls()).toHaveLength(1);
    expect(classifyCalls()[0]![2].system).toContain('Not on my list any more');
  });
});
