// Confirmation email matching, wired (assisted apply M2b,
// https://github.com/bgoleno/opportun/issues/119; tl's cut and the requirements in its comments).
// Every message goes through the real ingest (jobs/mailIngest.ts ingestInbound), with the AI
// gate and the classifier mocked as in mailIngest.test.ts. Companies, domains and jobs are
// synthetic.
import { runStructured } from '@opportun/ai';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../src/adapters/mailProvider';
import {
  applicationSubmissions,
  auditLog,
  communications,
  jobs,
  nextSteps,
  opportunities,
} from '../src/db/schema';
import { CLASSIFY_JOB_KIND, ingestInbound } from '../src/jobs/mailIngest';
import { ATS_SENDER_DOMAINS } from '../src/lib/submissionMatch';
import { followUpSubmissions } from '../src/repos/submissionOutcome';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { heldApart } from './race';
import { api, requisition, submittedAttempt, type Submitted } from './submissionFixtures';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockImplementation(async (_deps, task) => {
    if (task === 'comms.classify') {
      return {
        classification: 'other',
        outreachKind: null,
        mismatchReason: null,
        opportunityMatch: null,
        proposedTransition: null,
        confidence: 0.9,
        hardConstraintViolation: null,
      };
    }
    return { jobRelated: true, reason: 'job mail', confidence: 0.9 };
  });
});

const boot = useApi();
const ON = { submissions: true };
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** Words the body carries that must never be stored anywhere (NFR-PRV5). */
const BODY_SECRET = 'body-only-marker-7f3a';

let seq = 0;
/** A confirmation from the company's own domain, naming the job id; override what a test needs. */
function confirmation(s: Submitted, over: Partial<InboundMessage> = {}): InboundMessage {
  seq += 1;
  const bodyText =
    over.bodyText ??
    `Thank you for applying for Senior Platform Engineer at Example Corp. ${BODY_SECRET} ` +
      `See ${s.ats.url}`;
  return {
    externalId: `confirm-${seq}`,
    threadKey: `confirm-thread-${seq}`,
    from: 'Example Corp Careers <careers@examplecorp.example>',
    to: ['me@user.example'],
    subject: 'Application received',
    snippet: 'Thank you for applying',
    bodyText,
    sentAt: s.submittedAt + 10 * MIN,
    ...over,
  };
}

async function ingest(
  app: FastifyInstance,
  c: TestClient,
  message: InboundMessage,
  submissions = true,
) {
  return await ingestInbound(app.db, ctxOf(c), app.storage, 'gmail', message, undefined, {
    submissions,
  });
}

const attempt = async (app: FastifyInstance, id: string) =>
  (await app.db
    .select()
    .from(applicationSubmissions)
    .where(eq(applicationSubmissions.id, id))
    .get())!;
const message = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(communications).where(eq(communications.id, id)).get())!;
const stageOf = async (app: FastifyInstance, oppId: string) =>
  (await app.db.select().from(opportunities).where(eq(opportunities.id, oppId)).get())!.stage;

describe('criterion 1: a matching confirmation confirms, and the stage does not change', () => {
  it('links the email to the attempt and its timeline, with the signal names as the basis', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const stage = await stageOf(app, s.oppId);
    const { id } = await ingest(app, a, confirmation(s));

    expect(await attempt(app, s.id)).toMatchObject({
      status: 'confirmed',
      confirmationKind: 'email',
      confirmationCommId: id,
      confirmationActivityId: null,
    });
    expect((await attempt(app, s.id)).confirmedAt).toEqual(expect.any(Number));
    expect((await message(app, id)).opportunityId).toBe(s.oppId);
    expect(await stageOf(app, s.oppId)).toBe(stage);
    // The basis is signal names (and whether this linked the message), nothing from the message
    // (tl on #119): no subject, sender or body text.
    const basis = (await attempt(app, s.id)).confirmationBasis;
    expect(basis).toEqual({
      signals: ['ats_job_ref', 'ats_board', 'sender_domain', 'role_and_company', 'time_window'],
      linkedMessage: true,
    });
    const stored = JSON.stringify(basis);
    for (const text of ['Application received', 'careers@', BODY_SECRET, 'Thank you']) {
      expect(stored).not.toContain(text);
    }
    const audited = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'submission.confirmed'))
      .all();
    expect(audited).toHaveLength(1);
    expect(JSON.stringify(audited[0]!.detail)).not.toContain(BODY_SECRET);
  });

  it('shows the evidence on the detail view: subject, the address without its display name, when, signals', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const sent = confirmation(s, { from: 'Example Corp (trust me) <careers@examplecorp.example>' });
    const { id } = await ingest(app, a, sent);
    const detail = (await api(a, 'GET', `/submissions/${s.id}`)).json();
    expect(detail.confirmationEmail).toEqual({
      communicationId: id,
      subject: 'Application received',
      fromAddress: 'careers@examplecorp.example',
      sentAt: sent.sentAt,
      signals: ['ats_job_ref', 'ats_board', 'sender_domain', 'role_and_company', 'time_window'],
    });
    expect(JSON.stringify(detail)).not.toContain(BODY_SECRET);
  });

  it('a re-delivered message does not confirm again, and a later outcome is not undone', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const sent = confirmation(s);
    await ingest(app, a, sent);
    const unlink = await api(a, 'POST', `/submissions/${s.id}/unlink-confirmation`, {});
    expect(unlink.statusCode, unlink.body).toBe(200);
    await ingest(app, a, sent); // the same externalId: an update, not a new message
    expect((await attempt(app, s.id)).status).toBe('submitted');
  });
});

describe('criterion 2: two candidates for one company give no automatic link', () => {
  it('nothing is recorded on either attempt, and the message is stored unlinked', async () => {
    const { app, a } = await boot(ON);
    const first = await submittedAttempt(app, a, { title: 'Senior Platform Engineer' });
    const second = await submittedAttempt(app, a, { title: 'Data Engineer' });
    // No job id, and both titles named: B and C hold for both, so both match.
    const { id } = await ingest(
      app,
      a,
      confirmation(first, {
        bodyText:
          'Thank you for applying for Senior Platform Engineer and Data Engineer at Example Corp.',
      }),
    );
    for (const s of [first, second]) {
      expect(await attempt(app, s.id)).toMatchObject({
        status: 'submitted',
        confirmationKind: null,
        confirmationCommId: null,
        confirmationBasis: null,
      });
    }
    expect((await message(app, id)).opportunityId).toBeNull();
  });
});

describe('criterion 2, control', () => {
  it('the same message with only one of those attempts confirms it, so the test above is ambiguity', async () => {
    const { app, a } = await boot(ON);
    const only = await submittedAttempt(app, a, { title: 'Senior Platform Engineer' });
    await ingest(
      app,
      a,
      confirmation(only, {
        bodyText:
          'Thank you for applying for Senior Platform Engineer and Data Engineer at Example Corp.',
      }),
    );
    expect((await attempt(app, only.id)).status).toBe('confirmed');
  });
});

describe('criterion 3 and acceptance 6: the sender', () => {
  it('a spoofed display name is not evidence', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    await ingest(
      app,
      a,
      confirmation(s, {
        from: '"careers@examplecorp.example" <noreply@evil.example>',
        bodyText: 'Thank you for applying for Senior Platform Engineer at Example Corp.',
      }),
    );
    expect((await attempt(app, s.id)).status).toBe('submitted');
  });

  it('with the default empty ATS list, an ATS mail domain gives no B: no id, no confirmation', async () => {
    expect(ATS_SENDER_DOMAINS).toEqual({});
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    await ingest(
      app,
      a,
      confirmation(s, {
        from: 'no-reply@ats-mail-one.example',
        bodyText: 'Thank you for applying for Senior Platform Engineer at Example Corp.',
      }),
    );
    expect((await attempt(app, s.id)).status).toBe('submitted');
  });

  it('from an ATS mail domain, the job id alone (A) still confirms', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    await ingest(app, a, confirmation(s, { from: 'no-reply@ats-mail-one.example' }));
    expect(await attempt(app, s.id)).toMatchObject({
      status: 'confirmed',
      confirmationKind: 'email',
    });
  });
});

describe('acceptance 7: a board-only ATS ref', () => {
  it('without B it does not confirm; with B it does', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    // Another job's link at the same board: the board matches, the job id does not.
    const boardOnly =
      'Your application was received. https://boards.greenhouse.io/examplecorp/jobs/9999999';
    await ingest(app, a, confirmation(s, { from: 'x@unrelated.example', bodyText: boardOnly }));
    expect((await attempt(app, s.id)).status).toBe('submitted');
    await ingest(app, a, confirmation(s, { bodyText: boardOnly }));
    const row = await attempt(app, s.id);
    expect(row.status).toBe('confirmed');
    expect((row.confirmationBasis as { signals: string[] }).signals).toEqual([
      'ats_board',
      'sender_domain',
      'time_window',
    ]);
  });
});

describe('triage: submission_window keeps an expected confirmation with no job wording', () => {
  it('a bare "received" note from the company domain is stored and matched, not dropped', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const bare = confirmation(s, { subject: 'Received', bodyText: `Ref ${s.ats.url}` });
    const { id } = await ingest(app, a, bare);
    expect(await message(app, id)).toMatchObject({
      triageDecision: 'passed',
      triageRule: 'submission_window',
    });
    expect((await attempt(app, s.id)).status).toBe('confirmed');
    // Not gated: the AI gate was never asked about it.
    expect(vi.mocked(runStructured).mock.calls.some(([, task]) => task !== 'comms.classify')).toBe(
      false,
    );
  });

  it('with the feature off, the same note is dropped and nothing is read or confirmed', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const bare = confirmation(s, { subject: 'Received', bodyText: `Ref ${s.ats.url}` });
    const { id } = await ingest(app, a, bare, false);
    expect((await message(app, id)).triageDecision).toBe('filtered');
    expect((await attempt(app, s.id)).status).toBe('submitted');
  });
});

describe('criterion 4: the body is never persisted', () => {
  it('not on the message, the attempt or the audit; the classify payload drops it when the job ends', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const { id } = await ingest(app, a, confirmation(s));
    const classify = await app.db.select().from(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).all();
    expect(classify).toHaveLength(1);
    // In flight, the classifier's payload carries it (its only copy)...
    expect(JSON.stringify(classify[0]!.payload)).toContain(BODY_SECRET);
    await app.jobs.drain();
    // ...and once the job has run, nothing anywhere holds it.
    const after = await app.db.select().from(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).all();
    expect(JSON.stringify(after)).not.toContain(BODY_SECRET);
    expect(JSON.stringify(await message(app, id))).not.toContain(BODY_SECRET);
    expect(JSON.stringify(await attempt(app, s.id))).not.toContain(BODY_SECRET);
    expect(JSON.stringify(await app.db.select().from(auditLog).all())).not.toContain(BODY_SECRET);
  });
});

describe('criterion 5: unlink', () => {
  it('returns the attempt to submitted, clears the confirmation, and takes the email off the timeline', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const { id } = await ingest(app, a, confirmation(s));
    const res = await api(a, 'POST', `/submissions/${s.id}/unlink-confirmation`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'submitted', confirmationKind: null });
    expect(await attempt(app, s.id)).toMatchObject({
      status: 'submitted',
      confirmedAt: null,
      confirmationKind: null,
      confirmationCommId: null,
      confirmationBasis: null,
    });
    expect((await message(app, id)).opportunityId).toBeNull();
    const audited = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'submission.confirmation_unlinked'))
      .all();
    expect(audited).toHaveLength(1);
  });

  it('keeps a link the user made after the match moved the message elsewhere', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const other = await submittedAttempt(app, a, { company: 'Other Co', domain: 'other.example' });
    const { id } = await ingest(app, a, confirmation(s));
    await app.db
      .update(communications)
      .set({ opportunityId: other.oppId })
      .where(eq(communications.id, id))
      .run();
    await api(a, 'POST', `/submissions/${s.id}/unlink-confirmation`, {});
    expect((await message(app, id)).opportunityId).toBe(other.oppId);
  });

  it('refuses an attempt not confirmed by an email, and another user gets a 404', async () => {
    const { app, a, b } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const notEmail = await api(a, 'POST', `/submissions/${s.id}/unlink-confirmation`, {});
    expect(notEmail.statusCode).toBe(409);
    expect(notEmail.json().error.code).toBe('not_email_confirmed');
    await ingest(app, a, confirmation(s));
    expect((await api(b, 'POST', `/submissions/${s.id}/unlink-confirmation`, {})).statusCode).toBe(
      404,
    );
    expect((await attempt(app, s.id)).status).toBe('confirmed');
  });

  it('the route 404s with the feature off', async () => {
    const { a } = await boot({ submissions: false });
    expect((await api(a, 'POST', '/submissions/x/unlink-confirmation', {})).statusCode).toBe(404);
  });
});

describe('acceptance 8: the follow-up step', () => {
  it('an email confirmation closes the open "check" step of an unknown attempt', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    expect(await followUpSubmissions(app.db, s.submittedAt + 4 * DAY)).toBe(1);
    const unknown = await attempt(app, s.id);
    expect(unknown.status).toBe('unknown');
    await ingest(app, a, confirmation(s, { sentAt: s.submittedAt + 5 * DAY }));
    expect((await attempt(app, s.id)).status).toBe('confirmed');
    const step = await app.db
      .select()
      .from(nextSteps)
      .where(eq(nextSteps.id, unknown.followupNextStepId!))
      .get();
    expect(step?.doneAt).toEqual(expect.any(Number));
  });

  it('a step the user already completed keeps its own time', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    await followUpSubmissions(app.db, s.submittedAt + 4 * DAY);
    const stepId = (await attempt(app, s.id)).followupNextStepId!;
    await app.db.update(nextSteps).set({ doneAt: 12345 }).where(eq(nextSteps.id, stepId)).run();
    await ingest(app, a, confirmation(s, { sentAt: s.submittedAt + 5 * DAY }));
    expect(
      (
        await app.db
          .select()
          .from(nextSteps)
          .where(and(eq(nextSteps.id, stepId)))
          .get()
      )?.doneAt,
    ).toBe(12345);
  });
});

describe('acceptance 9: an email confirmation and a user outcome on one attempt (Postgres-relevant)', () => {
  it('the email first: the outcome waits, then finds it confirmed (409), one end state', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const [ingested, outcome] = await heldApart(
      app,
      'mail.ingest.attemptLocked',
      () => ingest(app, a, confirmation(s)),
      () => api(a, 'POST', `/submissions/${s.id}/outcome`, { outcome: 'confirmed_by_user' }),
    );
    expect(outcome.statusCode, outcome.body).toBe(409);
    expect(await attempt(app, s.id)).toMatchObject({
      status: 'confirmed',
      confirmationKind: 'email',
      confirmationCommId: ingested.id,
    });
  });

  it('the outcome first: the email waits, then confirms nothing and links nothing', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const [outcome, ingested] = await heldApart(
      app,
      'submissions.outcome.locked',
      () => api(a, 'POST', `/submissions/${s.id}/outcome`, { outcome: 'confirmed_by_user' }),
      () => ingest(app, a, confirmation(s)),
    );
    expect(outcome.statusCode, outcome.body).toBe(200);
    expect(await attempt(app, s.id)).toMatchObject({
      status: 'confirmed',
      confirmationKind: 'user',
      confirmationCommId: null,
    });
    expect((await message(app, ingested.id)).opportunityId).toBeNull();
  });
});
