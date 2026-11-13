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
import { REDACTED, redactDetail } from '../src/lib/audit';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { markPrefillRead } from '../src/repos/submissions';
import { api, handedOffAttempt, requisition, submittedAttempt } from './submissionFixtures';

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
  minted.set(res.json().token as string, res.json().id as string);
  return res.json().token as string;
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** Each minted token's device_tokens id, as the audit should record it. */
const minted = new Map<string, string>();
const tokenIdOf = (t: string): string => minted.get(t)!;

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
        firstRead: true,
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
      // Which token read it, so the owner knows which to revoke (tl on #185).
      deviceTokenId: tokenIdOf(t),
    });
    expect(JSON.stringify(entry?.detail)).not.toContain(s.ats.externalId);
    expect(
      loggedUrl(`/api/v1/connector/apply/current?url=${encodeURIComponent(pageOf(s.ats))}`),
    ).toBe('/api/v1/connector/apply/current?[redacted]');
  });
});

describe('what /current and the snapshot say about a deleted snapshot, and a stale review (tl on #185)', () => {
  it('a ready snapshot whose file was deleted reads "deleted", never "ready", and is not served', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    await makeReady(app, a, s.id);
    const before = await app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, s.id))
      .get();
    // Deleting the attachment clears the link (ON DELETE SET NULL); the stored state stays ready.
    await app.db.delete(attachments).where(eq(attachments.id, before!.resumeAttachmentId!)).run();
    const after = await app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, s.id))
      .get();
    expect(after?.snapshotState).toBe('ready');
    const t = await token(a, ['apply:assist']);
    expect((await current(app, t, pageOf(s.ats))).json().attempt.resume).toEqual({
      title: 'Example Resume',
      snapshotState: 'deleted',
      filename: null,
      bytes: null,
    });
    const res = await snapshot(app, t, s.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'snapshot_not_ready',
      snapshotState: 'deleted',
    });
  });

  it('the snapshot of an attempt whose fields changed after review is not served', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a, { fields: { email: 'applicant@example.com' } });
    await makeReady(app, a, s.id);
    await app.db
      .update(applicationSubmissions)
      .set({ fields: { email: 'changed@example.com' } })
      .where(eq(applicationSubmissions.id, s.id))
      .run();
    const t = await token(a, ['apply:assist']);
    const res = await snapshot(app, t, s.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('review_stale');
  });
});

describe('the audit keeps a token id, never a token (tl and the EM on #185)', () => {
  it('keeps a row id under a *TokenId key, and still redacts a credential, there or under token', () => {
    const id = '01a19edf-c436-7e06-879d-9d9be4b0f55f';
    expect(redactDetail({ deviceTokenId: id })).toEqual({ deviceTokenId: id });
    expect(redactDetail({ deviceTokenId: `odt_${'A'.repeat(43)}` })).toEqual({
      deviceTokenId: REDACTED,
    });
    expect(redactDetail({ token: id, apiKey: 'x', nested: { tokenId: 'secret-value' } })).toEqual({
      token: REDACTED,
      apiKey: REDACTED,
      nested: { tokenId: REDACTED },
    });
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
    expect(entry?.detail).toMatchObject({
      submissionId: s.id,
      via: 'device',
      deviceTokenId: tokenIdOf(t),
    });
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-disposition']).toContain('Example Resume.pdf');
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

describe('the guards no other test pins (tl on #185)', () => {
  it('a mail:push token is refused on the apply routes, and an apply:assist token on mail', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    const mail = await token(a, ['mail:push']);
    expect((await current(app, mail, pageOf(s.ats))).statusCode).toBe(403);
    expect((await snapshot(app, mail, s.id)).statusCode).toBe(403);
    const apply = await token(a, ['apply:assist']);
    const pushed = await app.inject({
      method: 'POST',
      url: '/api/v1/connector/mail/batch',
      headers: bearer(apply),
      payload: { messages: [] },
    });
    expect(pushed.statusCode).toBe(403);
  });

  it('a signed-in browser session alone reads nothing: these routes take a device token only', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    const res = await a.request({
      method: 'GET',
      url: `/api/v1/connector/apply/current?url=${encodeURIComponent(pageOf(s.ats))}`,
    });
    expect(res.statusCode).toBe(401);
    const file = await a.request({
      method: 'GET',
      url: `/api/v1/connector/apply/${s.id}/snapshot`,
    });
    expect(file.statusCode).toBe(401);
  });

  it('on the demo, every apply route is a 404, whatever the token holds', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    (app.config as { demo: boolean }).demo = true;
    expect((await current(app, t, pageOf(s.ats))).statusCode).toBe(404);
    expect((await snapshot(app, t, s.id)).statusCode).toBe(404);
  });

  it('with the feature off, the 404 comes before any token is looked at', async () => {
    const { app } = await boot({ submissions: false });
    for (const headers of [{}, bearer(`odt_${'B'.repeat(43)}`)]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/connector/apply/current?url=https%3A%2F%2Fexample.com%2F',
        headers,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('feature_unavailable');
    }
  });

  it('a draft or a reviewed attempt is never returned, even for its exact page', async () => {
    const { app, a } = await boot(ON);
    const draft = await handedOffAttempt(app, a, { stopAt: 'draft', title: 'Draft Role' });
    const reviewed = await handedOffAttempt(app, a, { stopAt: 'reviewed', title: 'Reviewed Role' });
    const t = await token(a, ['apply:assist']);
    for (const s of [draft, reviewed]) {
      expect((await current(app, t, pageOf(s.ats))).json()).toEqual({
        attempt: null,
        reason: 'no_matching_attempt',
      });
      expect((await snapshot(app, t, s.id)).statusCode).toBe(404);
    }
  });

  it('a percent-encoded spelling of /current still keeps the page out of the log', () => {
    expect(loggedUrl('/api/v1/connector/apply/curren%74?url=https%3A%2F%2Fx')).toBe(
      '/api/v1/connector/apply/curren%74?[redacted]',
    );
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

// #403 slice 2 (tl's design note with sec's rulings, condition 2): opening the popup on the
// handed-off posting fills it once. The server records the first read that returns the attempt,
// in the same statement that checks none was recorded, and says whether this read was it.
describe('the first read of a handed-off attempt (#403)', () => {
  const readAt = async (app: FastifyInstance, id: string) =>
    (
      await app.db
        .select({ at: applicationSubmissions.prefillReadAt })
        .from(applicationSubmissions)
        .where(eq(applicationSubmissions.id, id))
        .get()
    )?.at;

  it('the first read is first and records the time; a later one is not, and keeps it', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    expect(await readAt(app, s.id)).toBeNull();
    const before = Date.now();
    const first = await current(app, t, pageOf(s.ats));
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().attempt.firstRead).toBe(true);
    const at = await readAt(app, s.id);
    expect(at).toBeGreaterThanOrEqual(before);
    const again = await current(app, t, pageOf(s.ats));
    expect(again.json().attempt.id).toBe(s.id);
    expect(again.json().attempt.firstRead).toBe(false);
    expect(await readAt(app, s.id)).toBe(at);
  });

  it('two reads at once: exactly one is first', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    const reads = await Promise.all(
      Array.from({ length: 4 }, () => current(app, t, pageOf(s.ats))),
    );
    const firsts = reads.map((r) => r.json().attempt.firstRead as boolean);
    expect(firsts.filter(Boolean)).toHaveLength(1);
    expect(firsts).toHaveLength(4);
  });

  it('a miss records nothing: another posting, or an attempt that is not handed off', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    const reviewed = await handedOffAttempt(app, a, { stopAt: 'reviewed', title: 'Reviewed Role' });
    const t = await token(a, ['apply:assist']);
    expect((await current(app, t, requisition().url!)).json().attempt).toBeNull();
    expect((await current(app, t, pageOf(reviewed.ats))).json().attempt).toBeNull();
    expect(await readAt(app, s.id)).toBeNull();
    expect(await readAt(app, reviewed.id)).toBeNull();
  });

  // The lookup and the mark are two statements: an attempt submitted in between is not marked.
  it('an attempt no longer handed off is never marked, even called directly', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const ctx = { userId: a.userId, isAdmin: false };
    expect(await markPrefillRead(app.db, ctx, s.id)).toBe(false);
    expect(await readAt(app, s.id)).toBeNull();
  });

  it("the attempt's own view carries the time, for the Open step's line", async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    expect((await api(a, 'GET', `/submissions/${s.id}`)).json().prefillReadAt).toBeNull();
    await current(app, t, pageOf(s.ats));
    const after = (await api(a, 'GET', `/submissions/${s.id}`)).json();
    expect(after.prefillReadAt).toBe(await readAt(app, s.id));
    expect(typeof after.prefillReadAt).toBe('number');
  });
});
