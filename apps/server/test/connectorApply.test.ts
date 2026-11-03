// The extension's assisted apply read routes and the apply:assist scope
// (https://github.com/bgoleno/opportun/issues/182; tl's and sec's rulings on the issue).
// Every attempt is made through the real session routes (submissionFixtures.ts); tokens are
// minted through POST /device-tokens.
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { loggedUrl } from '../src/app';
import { applicationSubmissions, attachments, auditLog } from '../src/db/schema';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { api, handedOffAttempt, requisition } from './submissionFixtures';

const boot = useApi();
const ON = { submissions: true };
const PASSWORD = 'correct horse battery';
const PDF = Buffer.from('%PDF-1.4\n% placeholder resume snapshot\n%%EOF\n');

async function mint(c: TestClient, scopes: string[]) {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/device-tokens',
    payload: { name: 'Chrome', scopes, password: PASSWORD },
  });
  return res;
}

async function token(c: TestClient, scopes: string[]): Promise<string> {
  const res = await mint(c, scopes);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const current = (app: FastifyInstance, t: string, url: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/connector/apply/current?url=${encodeURIComponent(url)}`,
    headers: bearer(t),
  });

const snapshot = (app: FastifyInstance, t: string, id: string) =>
  app.inject({ method: 'GET', url: `/api/v1/connector/apply/${id}/snapshot`, headers: bearer(t) });

/** The attempt's snapshot made ready, as the snapshot job leaves it for an exported PDF. */
async function makeReady(app: FastifyInstance, c: TestClient, id: string): Promise<void> {
  const stored = await app.storage.writeAttachment(PDF);
  const attachmentId = newId();
  const now = Date.now();
  await app.db
    .insert(attachments)
    .values({
      id: attachmentId,
      userId: c.userId,
      opportunityId: null,
      filename: 'Example Resume.pdf',
      mime: 'application/pdf',
      bytes: stored.bytes,
      sha256: stored.sha256,
      storedPath: stored.storedPath,
      createdAt: now,
    })
    .run();
  await app.db
    .update(applicationSubmissions)
    .set({ snapshotState: 'ready', resumeAttachmentId: attachmentId })
    .where(eq(applicationSubmissions.id, id))
    .run();
}

/** The job page the attempt's destination names: the form the extension is on. */
const pageOf = (ats: { url?: string | null }) => ats.url as string;

describe('the apply:assist scope (sec on #182)', () => {
  it('is minted only while assisted apply is on, alone or combined', async () => {
    const { app, a } = await boot({ submissions: false });
    for (const scopes of [['apply:assist'], ['capture:push', 'apply:assist']]) {
      const res = await mint(a, scopes);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.code).toBe('scope_unavailable');
    }
    expect((await mint(a, ['capture:push'])).statusCode).toBe(201);
    (app.config as { submissions?: boolean }).submissions = true;
    expect((await mint(a, ['apply:assist'])).statusCode).toBe(201);
  });

  it('records the scopes it was minted with, once each, and refuses one it does not know', async () => {
    const { app, a } = await boot(ON);
    const res = await mint(a, ['apply:assist', 'capture:push', 'apply:assist']);
    expect(res.json().scopes).toEqual(['apply:assist', 'capture:push']);
    const entry = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'device_token.created'))
      .get();
    expect((entry?.detail as { scopes: string[] }).scopes).toEqual([
      'apply:assist',
      'capture:push',
    ]);
    expect((await mint(a, ['apply:everything'])).statusCode).toBe(400);
  });
});

describe('GET /connector/apply/current (#182 criterion 2)', () => {
  it('returns the handed-off attempt whose destination is this page, with what was reviewed', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a, {
      fields: { email: 'applicant@example.com', phone: '+1 555 0100' },
    });
    const t = await token(a, ['apply:assist']);
    const res = await current(app, t, pageOf(s.ats));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      attempt: {
        id: s.id,
        opportunityId: s.oppId,
        opportunityTitle: 'Senior Platform Engineer',
        companyName: 'Example Corp',
        atsKind: 'ats_greenhouse',
        destinationUrl: expect.any(String),
        fields: { email: 'applicant@example.com', phone: '+1 555 0100' },
        answers: [],
        resume: {
          title: 'Example Resume',
          snapshotState: 'unsupported',
          filename: null,
          bytes: null,
        },
      },
      reason: null,
    });
  });

  it('gives the snapshot file when it is ready', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    await makeReady(app, a, s.id);
    const t = await token(a, ['apply:assist']);
    expect((await current(app, t, pageOf(s.ats))).json().attempt.resume).toEqual({
      title: 'Example Resume',
      snapshotState: 'ready',
      filename: 'Example Resume.pdf',
      bytes: PDF.length,
    });
  });

  it('names a miss: another job, an attempt not handed off, or none at all', async () => {
    const { app, a } = await boot(ON);
    const t = await token(a, ['apply:assist']);
    const nothing = await current(app, t, requisition().url!);
    expect(nothing.json()).toEqual({ attempt: null, reason: 'no_matching_attempt' });
    const s = await handedOffAttempt(app, a);
    const other = await current(app, t, requisition().url!);
    expect(other.json()).toEqual({ attempt: null, reason: 'no_matching_attempt' });
    // Once submitted, it is no longer the one to prefill.
    await api(a, 'POST', `/submissions/${s.id}/attest`, { moveToApplied: false });
    expect((await current(app, t, pageOf(s.ats))).json()).toEqual({
      attempt: null,
      reason: 'no_matching_attempt',
    });
  });

  it('never guesses between two handed-off attempts for one page', async () => {
    const { app, a } = await boot(ON);
    const first = await handedOffAttempt(app, a, { title: 'Platform Engineer' });
    const second = await handedOffAttempt(app, a, { title: 'Data Engineer' });
    // A re-application to the same requisition: the second now names the first's job.
    const row = await app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, first.id))
      .get();
    await app.db
      .update(applicationSubmissions)
      .set({ atsRef: row!.atsRef, atsExternalId: row!.atsExternalId })
      .where(eq(applicationSubmissions.id, second.id))
      .run();
    const t = await token(a, ['apply:assist']);
    expect((await current(app, t, pageOf(first.ats))).json()).toEqual({
      attempt: null,
      reason: 'several_handed_off',
    });
  });

  it('refuses an attempt whose fields no longer match what was reviewed', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a, { fields: { email: 'applicant@example.com' } });
    await app.db
      .update(applicationSubmissions)
      .set({ fields: { email: 'changed@example.com' } })
      .where(eq(applicationSubmissions.id, s.id))
      .run();
    const t = await token(a, ['apply:assist']);
    expect((await current(app, t, pageOf(s.ats))).json()).toEqual({
      attempt: null,
      reason: 'review_stale',
    });
  });

  it("never returns another user's attempt, even for its exact page", async () => {
    const { app, a, b } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    const theirs = await token(b, ['apply:assist']);
    expect((await current(app, theirs, pageOf(s.ats))).json()).toEqual({
      attempt: null,
      reason: 'no_matching_attempt',
    });
  });

  it('records the page by its host only: the audit entry, and a log line without the query', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    await current(app, t, pageOf(s.ats));
    const entry = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'submission.prefill_read'))
      .get();
    expect(entry?.detail).toMatchObject({
      host: new URL(pageOf(s.ats)).hostname,
      submissionId: s.id,
    });
    expect(JSON.stringify(entry?.detail)).not.toContain(s.ats.externalId);
    expect(
      loggedUrl(`/api/v1/connector/apply/current?url=${encodeURIComponent(pageOf(s.ats))}`),
    ).toBe('/api/v1/connector/apply/current?[redacted]');
  });
});

describe('GET /connector/apply/:id/snapshot (#182 criterion 3)', () => {
  it('streams the PDF of a handed-off attempt whose snapshot is ready', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    await makeReady(app, a, s.id);
    const t = await token(a, ['apply:assist']);
    const res = await snapshot(app, t, s.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.equals(PDF)).toBe(true);
    const entry = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'submission.snapshot_downloaded'))
      .get();
    expect(entry?.detail).toMatchObject({ submissionId: s.id, via: 'device' });
  });

  it('refuses, by name, a snapshot that is not ready', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a); // a local file: unsupported
    const t = await token(a, ['apply:assist']);
    const res = await snapshot(app, t, s.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('snapshot_not_ready');
  });

  it("is a 404 for an attempt not handed off, or another user's", async () => {
    const { app, a, b } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    await makeReady(app, a, s.id);
    const theirs = await token(b, ['apply:assist']);
    expect((await snapshot(app, theirs, s.id)).statusCode).toBe(404);
    const mine = await token(a, ['apply:assist']);
    await api(a, 'POST', `/submissions/${s.id}/attest`, { moveToApplied: false });
    expect((await snapshot(app, mine, s.id)).statusCode).toBe(404);
  });
});

describe('scopes refuse each other (#182 criterion 4; tl and sec)', () => {
  it('a capture:push token gets 403 on every apply route', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    const t = await token(a, ['capture:push']);
    expect((await current(app, t, pageOf(s.ats))).statusCode).toBe(403);
    expect((await snapshot(app, t, s.id)).statusCode).toBe(403);
  });

  it('an apply:assist token gets 403 on the capture route', async () => {
    const { app, a } = await boot(ON);
    const t = await token(a, ['apply:assist']);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connector/capture',
      headers: bearer(t),
      payload: { url: 'https://www.linkedin.com/in/someone/', title: 'x', text: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a combined token passes both', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    const t = await token(a, ['capture:push', 'apply:assist']);
    expect((await current(app, t, pageOf(s.ats))).statusCode).toBe(200);
    const captured = await app.inject({
      method: 'POST',
      url: '/api/v1/connector/capture',
      headers: bearer(t),
      payload: { url: 'https://www.linkedin.com/in/someone/', title: 'x', text: 'x' },
    });
    expect([401, 403]).not.toContain(captured.statusCode);
  });

  it('with the feature off, every apply route is a 404 whatever the token holds', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    const t = await token(a, ['capture:push', 'apply:assist']);
    (app.config as { submissions?: boolean }).submissions = false;
    expect((await current(app, t, pageOf(s.ats))).statusCode).toBe(404);
    expect((await snapshot(app, t, s.id)).statusCode).toBe(404);
  });

  it('without a token, or with a revoked one, nothing is read', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/connector/apply/${s.id}/snapshot` }))
        .statusCode,
    ).toBe(401);
    const minted = (await mint(a, ['apply:assist'])).json();
    await a.request({ method: 'DELETE', url: `/api/v1/device-tokens/${minted.id as string}` });
    expect((await current(app, minted.token as string, pageOf(s.ats))).statusCode).toBe(401);
  });
});

describe('rate limit (#182 criterion 5)', () => {
  it('a token gets 60 reads in its window, then 429', async () => {
    const { app, a } = await boot(ON);
    const t = await token(a, ['apply:assist']);
    const url = requisition().url!;
    for (let i = 0; i < 60; i += 1) expect((await current(app, t, url)).statusCode).toBe(200);
    expect((await current(app, t, url)).statusCode).toBe(429);
    // A different token has its own budget.
    expect((await current(app, await token(a, ['apply:assist']), url)).statusCode).toBe(200);
  });
});
