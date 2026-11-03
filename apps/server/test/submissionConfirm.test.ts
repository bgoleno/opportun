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
import { createOpportunity } from '../src/repos/opportunities';
import { followUpSubmissions } from '../src/repos/submissionOutcome';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { heldApart } from './race';
import { api, submittedAttempt, type Submitted } from './submissionFixtures';

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
  it('refers to the email by id, writes nothing to the message, and keeps only signal names', async () => {
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
    // The message is not placed on the opportunity: the attempt points at it (tl and sec on #173).
    expect((await message(app, id)).opportunityId).toBeNull();
    expect(await stageOf(app, s.oppId)).toBe(stage);
    // The basis is signal names, nothing from the message (tl on #119): no subject, sender or
    // body text.
    const basis = (await attempt(app, s.id)).confirmationBasis;
    expect(basis).toEqual({
      signals: ['ats_job_ref', 'sender_domain', 'role_and_company', 'time_window'],
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
      signals: ['ats_job_ref', 'sender_domain', 'role_and_company', 'time_window'],
    });
    expect(JSON.stringify(detail)).not.toContain(BODY_SECRET);
  });

  // https://github.com/bgoleno/opportun/issues/176 item 1, the server half of "(unreadable)":
  // a From header that names no single mailbox gives the evidence card an empty address,
  // never the raw header (the web half shows "(unreadable)" for it, emailEvidence.test.tsx).
  it('gives the evidence an empty sender address when the From header names no single mailbox', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    // Matched on the job id (A); the header lists two mailboxes, so it has no one sender.
    await ingest(
      app,
      a,
      confirmation(s, { from: 'careers@examplecorp.example, other@examplecorp.example' }),
    );
    expect((await attempt(app, s.id)).status).toBe('confirmed');
    const detail = (await api(a, 'GET', `/submissions/${s.id}`)).json();
    expect(detail.confirmationEmail.fromAddress).toBe('');
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

describe('acceptance 7, as corrected on #173: a link to another job at the same board', () => {
  it('never confirms, even from the company domain with the role and company named', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    // Every extracted ref carries a job id: this one names another job at the same board, so
    // the message is about that job (a rejection for it, or "you may also like").
    const otherJob =
      'Thank you for applying for Senior Platform Engineer at Example Corp. ' +
      'You may also like https://boards.greenhouse.io/examplecorp/jobs/9999999';
    await ingest(app, a, confirmation(s, { bodyText: otherJob }));
    expect((await attempt(app, s.id)).status).toBe('submitted');
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

describe('triage stays narrow: submission_window passes only what the matcher matched (tl on #173)', () => {
  // https://github.com/bgoleno/opportun/issues/176 item 2: with no job wording, only
  // submission_window can keep this message, and it does so for an ambiguous match too.
  it('keeps an ambiguous confirmation with no job wording, under submission_window, confirming neither', async () => {
    const { app, a } = await boot(ON);
    // A real ambiguous pair: "QA Engineer" is whole words inside "QA Engineer Tools", so a
    // message naming the second names the first too (and the two titles dedupe apart).
    const qa = await submittedAttempt(app, a, { title: 'QA Engineer' });
    const tools = await submittedAttempt(app, a, { title: 'QA Engineer Tools' });
    const { id } = await ingest(
      app,
      a,
      confirmation(qa, {
        subject: 'Received',
        bodyText: 'We got it: QA Engineer Tools at Example Corp.',
      }),
    );
    expect(await message(app, id)).toMatchObject({
      triageDecision: 'passed',
      triageRule: 'submission_window',
    });
    for (const s of [qa, tools]) {
      expect(await attempt(app, s.id)).toMatchObject({
        status: 'submitted',
        confirmationCommId: null,
      });
    }
  });

  it('a non-confirmation from the company domain in the window is dropped, as before', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const { id } = await ingest(
      app,
      a,
      confirmation(s, { subject: 'Your order has shipped', bodyText: 'Track your parcel here.' }),
    );
    expect(await message(app, id)).toMatchObject({
      triageDecision: 'filtered',
      triageRule: 'no_signal',
    });
  });

  it('a matching confirmation with private content is kept out by that veto, and never matched', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const { id } = await ingest(
      app,
      a,
      confirmation(s, { bodyText: `${confirmation(s).bodyText} Your claim number is 12345.` }),
    );
    expect(await message(app, id)).toMatchObject({
      triageDecision: 'filtered',
      triageRule: 'private_content',
    });
    expect((await attempt(app, s.id)).status).toBe('submitted');
  });

  it('a match from a personal email provider is kept out by that veto', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a, { domain: 'gmail.com' });
    const { id } = await ingest(
      app,
      a,
      confirmation(s, {
        from: 'hr@gmail.com',
        bodyText: 'Thank you for applying for Senior Platform Engineer at Example Corp.',
      }),
    );
    expect(await message(app, id)).toMatchObject({
      triageDecision: 'filtered',
      triageRule: 'consumer_domain',
    });
    expect((await attempt(app, s.id)).status).toBe('submitted');
  });

  it('a confirmation found by email does not count as a thread the user linked', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const first = confirmation(s);
    await ingest(app, a, first);
    expect((await attempt(app, s.id)).status).toBe('confirmed');
    // Later in the same thread, from a personal address, with no job wording: still the
    // ordinary rules, so it is kept out and placed nowhere.
    const later = await ingest(
      app,
      a,
      confirmation(s, {
        threadKey: first.threadKey,
        from: 'someone@gmail.com',
        subject: 'Re: Application received',
        bodyText: 'Lunch on Friday?',
      }),
    );
    expect(await message(app, later.id)).toMatchObject({
      triageDecision: 'filtered',
      opportunityId: null,
    });
  });
});

describe('a merge or an opportunity delete waits for an email confirmation in flight (tl on #173, Postgres)', () => {
  it('a merge of its opportunity waits on the attempt, then moves it confirmed', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    // Unknown, with its follow-up step: the confirmation writes the attempt, then that step.
    await followUpSubmissions(app.db, s.submittedAt + 4 * DAY);
    const keep = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Example Corp',
      title: 'Kept opportunity',
      sourceKind: 'manual',
    });
    const [, merged] = await heldApart(
      app,
      'submissions.confirm.updated',
      () => ingest(app, a, confirmation(s, { sentAt: s.submittedAt + 5 * DAY })),
      () => api(a, 'POST', `/opportunities/${keep.id}/merge`, { otherId: s.oppId }),
    );
    expect(merged.statusCode, merged.body).toBe(200);
    expect(await attempt(app, s.id)).toMatchObject({
      status: 'confirmed',
      opportunityId: keep.id,
    });
  });

  it('a delete of its opportunity waits on the attempt, then removes it', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const [ingested, deleted] = await heldApart(
      app,
      'submissions.confirm.updated',
      () => ingest(app, a, confirmation(s)),
      () => api(a, 'DELETE', `/opportunities/${s.oppId}`),
    );
    expect(deleted.statusCode, deleted.body).toBeLessThan(300);
    expect(
      await app.db
        .select()
        .from(applicationSubmissions)
        .where(eq(applicationSubmissions.id, s.id))
        .get(),
    ).toBeUndefined();
    expect((await message(app, ingested.id)).id).toBe(ingested.id);
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
  it('returns the attempt to submitted and clears the confirmation; the message is untouched', async () => {
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

  it('leaves a link the user made to the message as it is', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const { id } = await ingest(app, a, confirmation(s));
    await app.db
      .update(communications)
      .set({ opportunityId: s.oppId })
      .where(eq(communications.id, id))
      .run();
    await api(a, 'POST', `/submissions/${s.id}/unlink-confirmation`, {});
    expect((await message(app, id)).opportunityId).toBe(s.oppId);
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
