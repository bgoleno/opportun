// The flag reaches confirmation matching through both mail callers (#119; tl on
// https://github.com/bgoleno/opportun/pull/173): Gmail sync (the job's services) and the Apple
// Mail connector route (the app's config). submissionConfirm.test.ts drives ingestInbound
// directly; these drive the callers, on and off.
import { runStructured } from '@opportun/ai';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applicationSubmissions } from '../src/db/schema';
import { useApi } from './api';
import { connectGoogle, fakeGoogle, type FakeGoogle } from './fakeGoogle';
import type { TestClient } from './isolation';
import { submittedAttempt, type Submitted } from './submissionFixtures';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockImplementation(async (_deps, task) =>
    task === 'comms.classify'
      ? {
          classification: 'other',
          outreachKind: null,
          mismatchReason: null,
          opportunityMatch: null,
          proposedTransition: null,
          confidence: 0.9,
          hardConstraintViolation: null,
        }
      : { jobRelated: true, reason: 'job mail', confidence: 0.9 },
  );
});

let google: FakeGoogle;
const boot = useApi(() => {
  google = fakeGoogle();
  return { build: { google } };
});
const PASSWORD = 'correct horse battery';

const statusOf = async (app: FastifyInstance, id: string) =>
  (
    await app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, id))
      .get()
  )?.status;

/** A confirmation naming the job, from the company's own domain. */
const confirmationText = (s: Submitted) =>
  `Thank you for applying for Senior Platform Engineer at Example Corp. See ${s.ats.url}`;

async function gmailSync(app: FastifyInstance, c: TestClient) {
  const res = await c.request({ method: 'POST', url: '/api/v1/integrations/gmail/sync' });
  expect(res.statusCode, res.body).toBe(202);
  await app.jobs.drain();
}

/**
 * The attempt is made with the feature on (its routes 404 otherwise); `off` then turns the flag
 * off where the caller reads it, so the same confirmation is delivered with it off.
 */
describe('Gmail sync passes the flag to ingest (the job services)', () => {
  it.each([
    [true, 'confirmed'],
    [false, 'submitted'],
  ])('with the flag %s, a matching confirmation leaves the attempt %s', async (on, status) => {
    const { app, a } = await boot({ submissions: true });
    await connectGoogle(a, 'gmail', google);
    const s = await submittedAttempt(app, a);
    (app.jobs.services as { submissions: boolean }).submissions = on;
    google.gmail.add({
      id: 'confirm-1',
      from: 'Example Corp <careers@examplecorp.example>',
      subject: 'Application received',
      text: confirmationText(s),
      sentAt: s.submittedAt + 60_000,
    });
    await gmailSync(app, a);
    expect(await statusOf(app, s.id)).toBe(status);
  });
});

describe('the Apple Mail connector passes the flag to ingest (the app config)', () => {
  it.each([
    [true, 'confirmed'],
    [false, 'submitted'],
  ])('with the flag %s, a matching confirmation leaves the attempt %s', async (on, status) => {
    const { app, a } = await boot({ submissions: true });
    const s = await submittedAttempt(app, a);
    const minted = await a.request({
      method: 'POST',
      url: '/api/v1/device-tokens',
      payload: { name: 'MacBook connector', scopes: ['mail:push'], password: PASSWORD },
    });
    expect(minted.statusCode, minted.body).toBe(201);
    (app.config as { submissions?: boolean }).submissions = on;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connector/mail/batch',
      headers: { authorization: `Bearer ${minted.json().token as string}` },
      payload: {
        messages: [
          {
            externalId: 'apple-mail:confirm-1@mail.example',
            threadKey: 'confirm-thread-1',
            from: 'Example Corp <careers@examplecorp.example>',
            to: ['me@example.com'],
            subject: 'Application received',
            snippet: 'Thank you for applying',
            bodyText: confirmationText(s),
            sentAt: s.submittedAt + 60_000,
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(await statusOf(app, s.id)).toBe(status);
  });
});
