// Recording the application site's confirmation page from the extension (assisted apply M4,
// https://github.com/bgoleno/opportun/issues/121; design Part A 5.2 and 6.2, tl's four rulings on
// the issue). Every attempt is made through the real session routes (submissionFixtures.ts);
// tokens are minted through POST /device-tokens.
import { and, eq } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { activities, applicationSubmissions, auditLog, jobs, nextSteps } from '../src/db/schema';
import { loggedUrl } from '../src/app';
import { capturedPage } from '../src/jobs/postingReconcile';
import { FOLLOWUP_MS, followUpSubmissions } from '../src/repos/submissionOutcome';
import { useApi } from './api';
import { captureLogs } from './helpers';
import type { TestClient } from './isolation';
import { api, handedOffAttempt, submittedAttempt } from './submissionFixtures';

const logs = captureLogs();
const boot = useApi(() => ({ logStream: logs }));
const ON = { submissions: true };
const PASSWORD = 'correct horse battery';
/** Page text no audit entry, job, log line or AI prompt may carry. */
const SENTINEL = 'conf-page-sentinel-7Q2X';
const PAGE_TEXT = `Thank you for applying to Example Corp! ${SENTINEL} We will be in touch.`;

const minted = new Map<string, string>();

async function token(c: TestClient, scopes: string[]): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/device-tokens',
    payload: { name: 'Chrome', scopes, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(201);
  minted.set(res.json().token as string, res.json().id as string);
  return res.json().token as string;
}
const tokenIdOf = (t: string): string => minted.get(t)!;

const record = (
  app: FastifyInstance,
  t: string | null,
  id: string,
  body: Record<string, unknown>,
) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/connector/apply/${id}/confirmation`,
    headers: t === null ? {} : { authorization: `Bearer ${t}` },
    payload: body,
  });

/** The thank-you page on the attempt's own board, as Greenhouse shows it after Submit. */
const thanksOn = (ats: { org?: string | null; externalId: string }) =>
  `https://boards.greenhouse.io/${ats.org}/jobs/${ats.externalId}/confirmation`;

const page = (url: string, text = PAGE_TEXT) => ({ url, title: 'Thank you for applying', text });

const rowOf = async (app: FastifyInstance, id: string) =>
  (await app.db
    .select()
    .from(applicationSubmissions)
    .where(eq(applicationSubmissions.id, id))
    .get())!;

/** The opportunity's recorded confirmation pages (tl on #121: their own kind, never 'capture'). */
const pagesOf = (app: FastifyInstance, oppId: string) =>
  app.db
    .select()
    .from(activities)
    .where(and(eq(activities.opportunityId, oppId), eq(activities.kind, 'confirmation_page')))
    .all();

const auditOf = (app: FastifyInstance, event: string) =>
  app.db.select().from(auditLog).where(eq(auditLog.event, event)).all();

describe('POST /connector/apply/:id/confirmation (#121)', () => {
  it('confirms a submitted application from its confirmation page, with the page kept whole', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    const url = thanksOn(s.ats);

    // The query and fragment are not kept (sec on #188): they can carry a token.
    const res = await record(app, t, s.id, page(`${url}?token=app-secret-1#done`));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      submissionId: s.id,
      status: 'confirmed',
      confirmationKind: 'page',
      recorded: true,
    });

    const row = await rowOf(app, s.id);
    expect(row.status).toBe('confirmed');
    expect(row.confirmationKind).toBe('page');
    expect(row.confirmedAt).not.toBeNull();
    const [capture] = await pagesOf(app, s.oppId);
    expect(row.confirmationActivityId).toBe(capture!.id);
    expect(capture).toMatchObject({
      title: 'Confirmation page recorded (boards.greenhouse.io)',
      bodyMd: PAGE_TEXT,
      externalUrl: url,
    });
    expect(JSON.stringify(await app.db.select().from(activities).all())).not.toContain(
      'app-secret-1',
    );

    const [entry] = await auditOf(app, 'submission.confirmed');
    expect(entry!.detail).toEqual({
      submissionId: s.id,
      opportunityId: s.oppId,
      from: 'submitted',
      kind: 'page',
      deviceTokenId: tokenIdOf(t),
      host: 'boards.greenhouse.io',
    });
  });

  it('confirms an attempt with no confirmation seen, and closes the follow-up step', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    expect(await followUpSubmissions(app.db, s.submittedAt + FOLLOWUP_MS)).toBe(1);
    expect((await rowOf(app, s.id)).status).toBe('unknown');
    const stepId = (await rowOf(app, s.id)).followupNextStepId!;
    const t = await token(a, ['apply:assist']);

    const res = await record(app, t, s.id, page(thanksOn(s.ats)));
    expect(res.statusCode, res.body).toBe(200);
    expect((await rowOf(app, s.id)).status).toBe('confirmed');
    const step = await app.db.select().from(nextSteps).where(eq(nextSteps.id, stepId)).get();
    expect(step?.doneAt).not.toBeNull();
  });

  it('confirms once: a second page stores nothing and answers unchanged', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    expect((await record(app, t, s.id, page(thanksOn(s.ats)))).statusCode).toBe(200);
    const first = await rowOf(app, s.id);

    const again = await record(app, t, s.id, page(thanksOn(s.ats), 'A different page'));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({
      status: 'confirmed',
      confirmationKind: 'page',
      recorded: false,
    });
    expect(await pagesOf(app, s.oppId)).toHaveLength(1);
    expect(await rowOf(app, s.id)).toEqual(first);
    expect(await auditOf(app, 'submission.confirmed')).toHaveLength(1);
  });

  it('two pages recorded at once store one confirmation', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    const results = await Promise.all([
      record(app, t, s.id, page(thanksOn(s.ats))),
      record(app, t, s.id, page(thanksOn(s.ats))),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(results.map((r) => r.json().recorded).sort()).toEqual([false, true]);
    expect(await pagesOf(app, s.oppId)).toHaveLength(1);
  });

  it('a confirmation the user marked is backed by the page, and their note stays', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const marked = await api(a, 'POST', `/submissions/${s.id}/outcome`, {
      outcome: 'confirmed_by_user',
      note: 'Saw the thank-you screen',
    });
    expect(marked.statusCode, marked.body).toBe(200);
    const before = await rowOf(app, s.id);
    const noteId = before.confirmationActivityId!;
    const t = await token(a, ['apply:assist']);

    const res = await record(app, t, s.id, page(thanksOn(s.ats)));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'confirmed',
      confirmationKind: 'page',
      recorded: true,
    });
    const after = await rowOf(app, s.id);
    const [capture] = await pagesOf(app, s.oppId);
    expect(after.confirmationKind).toBe('page');
    expect(after.confirmationActivityId).toBe(capture!.id);
    // Confirmed when the user said so; the page is the evidence for that confirmation.
    expect(after.confirmedAt).toBe(before.confirmedAt);
    const note = await app.db.select().from(activities).where(eq(activities.id, noteId)).get();
    expect(note).toMatchObject({ kind: 'note', bodyMd: 'Saw the thank-you screen' });
    const [entry] = (await auditOf(app, 'submission.confirmed')).filter(
      (e) => (e.detail as { kind: string }).kind === 'page',
    );
    expect(entry!.detail).toMatchObject({ from: 'confirmed', upgradedFrom: 'user' });
  });

  it('an application an email confirmed stores nothing and answers unchanged', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    await app.db
      .update(applicationSubmissions)
      .set({ status: 'confirmed', confirmationKind: 'email', confirmedAt: Date.now() })
      .where(eq(applicationSubmissions.id, s.id))
      .run();
    const before = await rowOf(app, s.id);
    const t = await token(a, ['apply:assist']);

    const res = await record(app, t, s.id, page(thanksOn(s.ats)));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      submissionId: s.id,
      status: 'confirmed',
      confirmationKind: 'email',
      recorded: false,
    });
    expect(await pagesOf(app, s.oppId)).toHaveLength(0);
    expect(await rowOf(app, s.id)).toEqual(before);
  });

  it('never records "I submitted it": an application not yet submitted is refused', async () => {
    const { app, a } = await boot(ON);
    const s = await handedOffAttempt(app, a);
    const t = await token(a, ['apply:assist']);

    const res = await record(app, t, s.id, page(thanksOn(s.ats)));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('not_submitted');
    const row = await rowOf(app, s.id);
    expect(row.status).toBe('handed_off');
    expect(row.submittedAt).toBeNull();
    expect(await pagesOf(app, s.oppId)).toHaveLength(0);
    expect(await auditOf(app, 'submission.confirmed')).toHaveLength(0);
  });

  it('a refused application is not confirmed by a page', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const refused = await api(a, 'POST', `/submissions/${s.id}/outcome`, {
      outcome: 'ats_refused',
    });
    expect(refused.statusCode, refused.body).toBe(200);
    const t = await token(a, ['apply:assist']);

    const res = await record(app, t, s.id, page(thanksOn(s.ats)));
    expect(res.statusCode, res.body).toBe(409);
    expect((await rowOf(app, s.id)).status).toBe('rejected');
    expect(await pagesOf(app, s.oppId)).toHaveLength(0);
  });

  it("accepts the attempt's board on another host of the same ATS, whatever the slug's case", async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    const url = `https://job-boards.greenhouse.io/${s.ats.org!.toUpperCase()}/jobs/${s.ats.externalId}/confirmation`;

    const res = await record(app, t, s.id, page(url));
    expect(res.statusCode, res.body).toBe(200);
    expect((await pagesOf(app, s.oppId))[0]?.title).toBe(
      'Confirmation page recorded (job-boards.greenhouse.io)',
    );
  });

  it("on a Workday tenant's own host, takes its site's pages and a page naming no site", async () => {
    const { app, a } = await boot(ON);
    // Each attempt its own requisition, so none is a re-application.
    const workday = (n: number) => ({
      kind: 'ats_workday' as const,
      org: 'acme/External',
      externalId: `JR-00000${n}`,
      url: `https://acme.wd1.myworkdayjobs.com/en-US/External/job/X/Engineer_JR-00000${n}`,
    });
    const t = await token(a, ['apply:assist']);
    const refused = [
      // Another tenant's bare host: names no site, and is not the destination's origin (tl).
      'https://globex.wd1.myworkdayjobs.com/',
      'https://globex.wd1.myworkdayjobs.com/en-US/External/job/X/Engineer_JR-000001',
      'https://acme.wd1.myworkdayjobs.com/en-US/Internal/job/X/Engineer_JR-000001',
      'https://wd1.myworkdaysite.com/recruiting/globex/External/job/X',
    ];
    for (const [i, url] of refused.entries()) {
      const s = await submittedAttempt(app, a, { ats: workday(i + 1), title: `Role ${i}` });
      const res = await record(app, t, s.id, page(url));
      expect(res.statusCode, `${url}: ${res.body}`).toBe(422);
    }
    const s1 = await submittedAttempt(app, a, { ats: workday(7), title: 'Platform Engineer' });
    const thanks = `${workday(7).url}/apply/applyManually/thanks`;
    expect((await record(app, t, s1.id, page(thanks))).statusCode).toBe(200);
    const s2 = await submittedAttempt(app, a, { ats: workday(8), title: 'Data Engineer' });
    const root = 'https://acme.wd1.myworkdayjobs.com/';
    expect((await record(app, t, s2.id, page(root))).statusCode).toBe(200);
  });

  it('refuses a page from anywhere else with wrong_site, storing nothing and auditing the host only', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    const elsewhere = [
      // Another employer's board on the same ATS host.
      `https://boards.greenhouse.io/othercorp/jobs/${s.ats.externalId}/confirmation`,
      // The attempt's own origin, but a page that names no board: on a host every employer
      // shares, it could be anyone's.
      'https://boards.greenhouse.io/',
      // Another ATS.
      `https://jobs.lever.co/${s.ats.org}/0f3c/thanks`,
      // The company's own site, a lookalike, plain http, credentials in the URL.
      'https://examplecorp.example/careers/thanks',
      `https://boards.greenhouse.io.example.net/${s.ats.org}/jobs/${s.ats.externalId}`,
      `http://boards.greenhouse.io/${s.ats.org}/jobs/${s.ats.externalId}/confirmation`,
      `https://user:pw@boards.greenhouse.io/${s.ats.org}/jobs/${s.ats.externalId}/confirmation`,
      // Never LinkedIn or Indeed.
      `https://www.linkedin.com/jobs/view/${s.ats.externalId}/?gh_jid=${s.ats.externalId}`,
      `https://www.indeed.com/viewjob?jk=abc&gh_jid=${s.ats.externalId}`,
      'not a url',
    ];
    for (const url of elsewhere) {
      const res = await record(app, t, s.id, page(url));
      expect(res.statusCode, `${url}: ${res.body}`).toBe(422);
      expect(res.json().error.code, url).toBe('wrong_site');
    }
    const row = await rowOf(app, s.id);
    expect(row.status).toBe('submitted');
    expect(row.confirmationKind).toBeNull();
    expect(await pagesOf(app, s.oppId)).toHaveLength(0);

    const refused = await auditOf(app, 'submission.confirmation_refused');
    expect(refused).toHaveLength(elsewhere.length);
    expect(refused[0]!.detail).toEqual({
      submissionId: s.id,
      deviceTokenId: tokenIdOf(t),
      reason: 'wrong_site',
      host: 'boards.greenhouse.io',
    });
    expect(refused.at(-1)!.detail).toMatchObject({ host: null });
    // The host, never the path or query.
    expect(JSON.stringify(refused)).not.toContain('othercorp');
    expect(JSON.stringify(refused)).not.toContain('careers');
  });

  it("another user's application is a 404, and nothing is stored", async () => {
    const { app, a, b } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(b, ['apply:assist']);
    const res = await record(app, t, s.id, page(thanksOn(s.ats)));
    expect(res.statusCode, res.body).toBe(404);
    expect((await rowOf(app, s.id)).status).toBe('submitted');
    expect(await pagesOf(app, s.oppId)).toHaveLength(0);
  });

  it('takes an apply:assist token only, and is closed when the feature is off', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const capture = await token(a, ['capture:push']);
    expect((await record(app, capture, s.id, page(thanksOn(s.ats)))).statusCode).toBe(403);
    expect((await record(app, null, s.id, page(thanksOn(s.ats)))).statusCode).toBe(401);
    // A session cookie is not enough.
    const session = await a.request({
      method: 'POST',
      url: `/api/v1/connector/apply/${s.id}/confirmation`,
      payload: page(thanksOn(s.ats)),
    });
    expect(session.statusCode).toBe(401);
    const t = await token(a, ['apply:assist']);
    (app.config as { submissions?: boolean }).submissions = false;
    const off = await record(app, t, s.id, page(thanksOn(s.ats)));
    expect(off.statusCode).toBe(404);
    expect(off.json().error.code).toBe('feature_unavailable');
    expect(await pagesOf(app, s.oppId)).toHaveLength(0);
  });

  it('on the demo, or off, is a 404 before any token is looked at, and stores nothing (#189)', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    (app.config as { demo: boolean }).demo = true;
    const demo = await record(app, t, s.id, page(thanksOn(s.ats)));
    expect(demo.statusCode).toBe(404);
    expect(demo.json().error.code).toBe('feature_unavailable');
    (app.config as { demo: boolean }).demo = false;
    (app.config as { submissions?: boolean }).submissions = false;
    for (const bearerToken of [null, `odt_${'B'.repeat(43)}`]) {
      const res = await record(app, bearerToken, s.id, page(thanksOn(s.ats)));
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('feature_unavailable');
    }
    expect(await pagesOf(app, s.oppId)).toHaveLength(0);
    expect((await rowOf(app, s.id)).status).toBe('submitted');
  });

  it('takes at most 20,000 characters of page text, and nothing it does not know', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    const url = thanksOn(s.ats);
    expect((await record(app, t, s.id, page(url, 'x'.repeat(20_001)))).statusCode).toBe(400);
    expect((await record(app, t, s.id, page(url, ''))).statusCode).toBe(400);
    expect((await record(app, t, s.id, { ...page(url), status: 'confirmed' })).statusCode).toBe(
      400,
    );
    expect(await pagesOf(app, s.oppId)).toHaveLength(0);
    const res = await record(app, t, s.id, page(url, 'y'.repeat(20_000)));
    expect(res.statusCode, res.body).toBe(200);
    expect((await pagesOf(app, s.oppId))[0]?.bodyMd).toHaveLength(20_000);
  });

  it('keeps the page text out of every audit entry, job and log line', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    expect((await record(app, t, s.id, page(thanksOn(s.ats)))).statusCode).toBe(200);
    await app.jobs.drain();
    expect(JSON.stringify(await app.db.select().from(auditLog).all())).not.toContain(SENTINEL);
    expect(JSON.stringify(await app.db.select().from(jobs).all())).not.toContain(SENTINEL);
    expect(logs.text()).not.toContain(SENTINEL);
  });

  it('the user can delete the recorded page from the timeline; the application stays confirmed', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    expect((await record(app, t, s.id, page(thanksOn(s.ats)))).statusCode).toBe(200);
    const captureId = (await rowOf(app, s.id)).confirmationActivityId!;

    const deleted = await api(a, 'DELETE', `/activities/${captureId}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    const row = await rowOf(app, s.id);
    expect(row.confirmationActivityId).toBeNull();
    expect(row.status).toBe('confirmed');
    expect(await pagesOf(app, s.oppId)).toHaveLength(0);
  });
});

describe('a recorded confirmation page is not a posting capture (tl on #121)', () => {
  it('never reaches capturedPage, re-derive or hasCapturedPage, while a real capture still does', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const ctx = { userId: a.userId, isAdmin: false };
    const t = await token(a, ['apply:assist']);
    expect((await record(app, t, s.id, page(thanksOn(s.ats)))).statusCode).toBe(200);

    // Only the confirmation page: nothing to merge into the description or send to the AI.
    expect(await capturedPage(app.db, ctx, s.oppId)).toBeNull();
    const rederive = await api(a, 'POST', `/opportunities/${s.oppId}/posting/rederive`, {
      force: true,
    });
    expect(rederive.statusCode, rederive.body).toBe(409);
    expect(rederive.json().error.code).toBe('no_capture');
    const opp = await api(a, 'GET', `/opportunities/${s.oppId}`);
    expect(opp.json().hasCapturedPage).toBe(false);

    // A real capture, older than the confirmation page, is still the one the readers take.
    const captured = await api(a, 'POST', `/opportunities/${s.oppId}/activities`, {
      kind: 'capture',
      title: 'Captured from LinkedIn',
      bodyMd: 'About the job: build the platform.',
      occurredAt: Date.now() - 60_000,
      participants: [],
    });
    expect(captured.statusCode, captured.body).toBe(201);
    expect((await capturedPage(app.db, ctx, s.oppId))?.text).toBe(
      'About the job: build the platform.',
    );
    expect((await api(a, 'GET', `/opportunities/${s.oppId}`)).json().hasCapturedPage).toBe(true);
  });

  it('the timeline and the export carry it under its own kind', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    expect((await record(app, t, s.id, page(thanksOn(s.ats)))).statusCode).toBe(200);

    const timeline = await api(a, 'GET', `/opportunities/${s.oppId}/timeline`);
    expect(timeline.statusCode, timeline.body).toBe(200);
    expect(
      (timeline.json().items as { activityKind?: string; title?: string }[]).find(
        (i) => i.activityKind === 'confirmation_page',
      )?.title,
    ).toBe('Confirmation page recorded (boards.greenhouse.io)');

    const res = await a.request({ method: 'GET', url: '/api/v1/export' });
    expect(res.statusCode).toBe(200);
    const files = Object.fromEntries(
      Object.entries(unzipSync(new Uint8Array(res.rawPayload))).map(([k, v]) => [k, strFromU8(v)]),
    );
    const data = JSON.parse(files['export.json']!) as {
      tables: Record<string, { kind?: string; bodyMd?: string }[]>;
    };
    expect(data.tables.activities!.find((r) => r.kind === 'confirmation_page')?.bodyMd).toBe(
      PAGE_TEXT,
    );
    const summary = Object.entries(files).find(([k]) => k.startsWith('opportunities/'))![1];
    expect(summary).toContain(
      'confirmation_page: Confirmation page recorded (boards.greenhouse.io)',
    );
  });

  it('GET /submissions/:id shows the recorded page for its evidence card', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    const url = thanksOn(s.ats);
    expect((await record(app, t, s.id, page(url))).statusCode).toBe(200);
    const activityId = (await rowOf(app, s.id)).confirmationActivityId!;

    const detail = await api(a, 'GET', `/submissions/${s.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().confirmationPage).toEqual({
      activityId,
      url,
      host: 'boards.greenhouse.io',
      recordedAt: expect.any(Number),
      text: PAGE_TEXT,
    });
    expect(detail.json().confirmationEmail).toBeNull();

    // Deleted from the timeline: the card has nothing left to show.
    expect((await api(a, 'DELETE', `/activities/${activityId}`)).statusCode).toBe(204);
    expect((await api(a, 'GET', `/submissions/${s.id}`)).json().confirmationPage).toBeNull();
  });
});

const lookup = (app: FastifyInstance, t: string, url: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/connector/apply/confirmable?url=${encodeURIComponent(url)}`,
    headers: { authorization: `Bearer ${t}` },
  });

describe("tl's rulings from qa on #188: another job, and a deleted copy", () => {
  it("refuses another job's page on the same board with different_job, and keeps a page naming no job", async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    const other = `https://boards.greenhouse.io/${s.ats.org}/jobs/1234567/confirmation`;
    const res = await record(app, t, s.id, page(other));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('different_job');
    expect(await pagesOf(app, s.oppId)).toHaveLength(0);
    const [refusal] = await auditOf(app, 'submission.confirmation_refused');
    expect(refusal!.detail).toEqual({
      submissionId: s.id,
      deviceTokenId: tokenIdOf(t),
      reason: 'different_job',
      host: 'boards.greenhouse.io',
    });

    // A thank-you page that names no job at all, on the attempt's board, still counts.
    const noJob = `https://boards.greenhouse.io/${s.ats.org}/confirmation`;
    const ok = await record(app, t, s.id, page(noJob));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().recorded).toBe(true);
  });

  it('the posting page itself counts (Ashby may confirm at the posting address)', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    const res = await record(app, t, s.id, page(s.ats.url!));
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a page confirmation whose copy was deleted takes a new copy; with a copy, once', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    expect((await record(app, t, s.id, page(thanksOn(s.ats)))).statusCode).toBe(200);
    const first = await rowOf(app, s.id);
    expect((await api(a, 'DELETE', `/activities/${first.confirmationActivityId}`)).statusCode).toBe(
      204,
    );

    const again = await record(app, t, s.id, page(thanksOn(s.ats), 'The thank-you page, again'));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({
      status: 'confirmed',
      confirmationKind: 'page',
      recorded: true,
    });
    const after = await rowOf(app, s.id);
    const [copy] = await pagesOf(app, s.oppId);
    expect(copy?.bodyMd).toBe('The thank-you page, again');
    expect(after.confirmationActivityId).toBe(copy!.id);
    expect(after.confirmedAt).toBe(first.confirmedAt);
    expect(after.confirmationKind).toBe('page');
    expect(await auditOf(app, 'submission.confirmation_page_relinked')).toHaveLength(1);

    const third = await record(app, t, s.id, page(thanksOn(s.ats), 'And once more'));
    expect(third.json().recorded).toBe(false);
    expect(await pagesOf(app, s.oppId)).toHaveLength(1);
  });

  it('strips NUL from the page text before storing it (Postgres refuses it, tl on #188)', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    const res = await record(app, t, s.id, page(thanksOn(s.ats), 'Thank\u0000 you'));
    expect(res.statusCode, res.body).toBe(200);
    expect((await pagesOf(app, s.oppId))[0]?.bodyMd).toBe('Thank you');
  });

  it('four pages at once on a confirmation the user marked store one copy (the attempt lock)', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const marked = await api(a, 'POST', `/submissions/${s.id}/outcome`, {
      outcome: 'confirmed_by_user',
    });
    expect(marked.statusCode, marked.body).toBe(200);
    const t = await token(a, ['apply:assist']);
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) => record(app, t, s.id, page(thanksOn(s.ats), `Page ${i}`))),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect(results.filter((r) => r.json().recorded === true)).toHaveLength(1);
    expect(await pagesOf(app, s.oppId)).toHaveLength(1);
  });
});

describe('GET /connector/apply/confirmable (tl on #121)', () => {
  it('names the one submitted application the page may confirm, and nothing else of it', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a, { fields: { email: 'applicant@example.com' } });
    const t = await token(a, ['apply:assist']);
    const TAB_SECRET = `${thanksOn(s.ats)}?token=lookup-secret-9`;
    const res = await lookup(app, t, TAB_SECRET);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      attempt: {
        id: s.id,
        opportunityTitle: 'Senior Platform Engineer',
        companyName: 'Example Corp',
        status: 'submitted',
        confirmationKind: null,
      },
      reason: null,
      recordedFor: null,
    });
    expect(res.body).not.toContain('applicant@example.com');
    // The page's address is in no log line, and the audit keeps its host only.
    expect(logs.text()).not.toContain('lookup-secret-9');
    expect(
      loggedUrl(`/api/v1/connector/apply/confirmable?url=${encodeURIComponent(TAB_SECRET)}`),
    ).toBe('/api/v1/connector/apply/confirmable?[redacted]');
    const [entry] = await auditOf(app, 'submission.confirmable_read');
    expect(entry!.detail).toEqual({
      deviceTokenId: tokenIdOf(t),
      host: 'boards.greenhouse.io',
      submissionId: s.id,
    });
    expect(JSON.stringify(entry)).not.toContain('lookup-secret-9');
  });

  it('considers unknown, a user-marked confirmation, and a page confirmation whose copy was deleted', async () => {
    const { app, a } = await boot(ON);
    const t = await token(a, ['apply:assist']);

    const unknown = await submittedAttempt(app, a, { title: 'Platform Engineer' });
    expect(await followUpSubmissions(app.db, unknown.submittedAt + FOLLOWUP_MS)).toBe(1);
    expect((await lookup(app, t, thanksOn(unknown.ats))).json().attempt).toMatchObject({
      id: unknown.id,
      status: 'unknown',
    });

    const marked = await submittedAttempt(app, a, { title: 'Data Engineer' });
    await api(a, 'POST', `/submissions/${marked.id}/outcome`, { outcome: 'confirmed_by_user' });
    expect((await lookup(app, t, thanksOn(marked.ats))).json().attempt).toMatchObject({
      id: marked.id,
      status: 'confirmed',
      confirmationKind: 'user',
    });

    const paged = await submittedAttempt(app, a, { title: 'Site Engineer' });
    expect((await record(app, t, paged.id, page(thanksOn(paged.ats)))).statusCode).toBe(200);
    // With its copy: already recorded, and named.
    expect((await lookup(app, t, thanksOn(paged.ats))).json()).toEqual({
      attempt: null,
      reason: 'already_recorded',
      recordedFor: 'Site Engineer',
    });
    const copy = (await rowOf(app, paged.id)).confirmationActivityId!;
    await api(a, 'DELETE', `/activities/${copy}`);
    expect((await lookup(app, t, thanksOn(paged.ats))).json().attempt).toMatchObject({
      id: paged.id,
      confirmationKind: 'page',
    });
  });

  it('says why when there is no one application to name', async () => {
    const { app, a, b } = await boot(ON);
    const t = await token(a, ['apply:assist']);

    // Handed off: the user says "I submitted it" in Opportun first.
    const handed = await handedOffAttempt(app, a, { title: 'Handed Off Role' });
    expect((await lookup(app, t, thanksOn(handed.ats))).json()).toEqual({
      attempt: null,
      reason: 'needs_submitted_first',
      recordedFor: null,
    });

    // An email confirmation is not considered.
    const emailed = await submittedAttempt(app, a, { title: 'Emailed Role' });
    await app.db
      .update(applicationSubmissions)
      .set({ status: 'confirmed', confirmationKind: 'email', confirmedAt: Date.now() })
      .where(eq(applicationSubmissions.id, emailed.id))
      .run();
    expect((await lookup(app, t, thanksOn(emailed.ats))).json().reason).toBe('no_matching_attempt');

    // Another job's page on the same board, and another site.
    const s = await submittedAttempt(app, a, { title: 'Submitted Role' });
    const otherJob = `https://boards.greenhouse.io/${s.ats.org}/jobs/1234567/confirmation`;
    expect((await lookup(app, t, otherJob)).json().reason).toBe('no_matching_attempt');
    expect((await lookup(app, t, 'https://jobs.lever.co/examplecorp/x')).json().reason).toBe(
      'no_matching_attempt',
    );

    // Two submitted applications on the same board, and a page naming no job: no id is given.
    await submittedAttempt(app, a, { title: 'Second Submitted Role' });
    const both = `https://boards.greenhouse.io/examplecorp/confirmation`;
    expect((await lookup(app, t, both)).json()).toEqual({
      attempt: null,
      reason: 'several_matching',
      recordedFor: null,
    });

    // Another user's application is never named.
    const tb = await token(b, ['apply:assist']);
    expect((await lookup(app, tb, thanksOn(s.ats))).json().reason).toBe('no_matching_attempt');
  });

  it('decides nothing: the status changes after the lookup, and the POST refuses', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const t = await token(a, ['apply:assist']);
    expect((await lookup(app, t, thanksOn(s.ats))).json().attempt?.id).toBe(s.id);
    const refused = await api(a, 'POST', `/submissions/${s.id}/outcome`, {
      outcome: 'ats_refused',
    });
    expect(refused.statusCode, refused.body).toBe(200);
    const res = await record(app, t, s.id, page(thanksOn(s.ats)));
    expect(res.statusCode, res.body).toBe(409);
    expect(await pagesOf(app, s.oppId)).toHaveLength(0);
  });

  it('takes an apply:assist token only, and is closed when the feature is off', async () => {
    const { app, a } = await boot(ON);
    const s = await submittedAttempt(app, a);
    const capture = await token(a, ['capture:push']);
    expect((await lookup(app, capture, thanksOn(s.ats))).statusCode).toBe(403);
    const t = await token(a, ['apply:assist']);
    (app.config as { submissions?: boolean }).submissions = false;
    const off = await lookup(app, t, thanksOn(s.ats));
    expect(off.statusCode).toBe(404);
    expect(off.json().error.code).toBe('feature_unavailable');
  });
});
