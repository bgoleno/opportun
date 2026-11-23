// The env-gated e2e fakes (src/testSupport). These pin what apps/web/e2e relies on: the AI
// mock answers through the real router over loopback HTTP, the Gmail fixture mailbox flows
// through sync and classification, the source mock feeds discovery and board detection, and
// none of it can be switched on in production.
import { createServer } from 'node:net';
import { MatchReportSchema, runStructured, streamChat } from '@opportun/ai';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config';
import { auditLog, companies, users } from '../src/db/schema';
import { buildAiDeps } from '../src/lib/ai';
import { exchangeAndIdentify } from '../src/lib/oauthProviders';
import { testSupportFromEnv } from '../src/testSupport/index';
import { createPendingToken } from '../src/lib/twoFactor';
import { overMargin, peakSpend } from '../src/testSupport/mockAuth';
import { MATCH_REPORT, TAILOR_FIND } from '../src/testSupport/mockAi';
import { MOCK_RESUME_TEXT } from '../src/testSupport/mockDocs';
import { mockOAuthCode, mockOAuthFetch } from '../src/testSupport/mockOAuth';
import {
  FIXTURE_COMPANY,
  mockGreenhouseSource,
  mockSourceFetch,
} from '../src/testSupport/mockSources';
import { connectGoogle } from './fakeGoogle';
import { testApp } from './helpers';
import { PASSWORD, registerTwoUsers, setRegistrationOpen, type TestClient } from './isolation';
import { queryAll } from './db';

const CFG = {
  port: 0,
  host: '127.0.0.1',
  dataDir: '/unused',
  sqliteDir: '/unused',
  baseUrl: 'http://localhost:3000',
  masterKey: Buffer.alloc(32),
  logLevel: 'silent',
  db: { dialect: 'sqlite' },
  demo: false,
  aiAllowLoopbackHttp: false,
  telemetryAllowPrivate: false,
  trustedProxies: [],
} satisfies Config;

const ALL = {
  OPPORTUN_AI_MOCK: '1',
  OPPORTUN_DOCS_MOCK: '1',
  OPPORTUN_GMAIL_MOCK: '1',
  OPPORTUN_SOURCE_MOCK: '1',
  OPPORTUN_OAUTH_MOCK: '1',
  OPPORTUN_AUTH_MOCK: '1',
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()));
});

/** A listening app with every mock on (the AI mock calls back into it over loopback). */
async function mockedApp(): Promise<{ app: FastifyInstance; a: TestClient }> {
  const port = await freePort();
  const support = testSupportFromEnv(ALL, { ...CFG, port });
  if (support === undefined) throw new Error('mocks not enabled');
  const { app } = await testApp({ port }, { build: support.build, setup: support.register });
  open.push(app);
  await app.listen({ port, host: '127.0.0.1' });
  const { a } = await registerTwoUsers(app);
  return { app, a };
}

async function drainAll(app: FastifyInstance): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if ((await app.jobs.drain()) === 0) return;
  }
}

describe('testSupportFromEnv', () => {
  it('is off unless a flag is exactly 1', () => {
    expect(testSupportFromEnv({}, CFG)).toBeUndefined();
    expect(testSupportFromEnv({ OPPORTUN_AI_MOCK: 'true' }, CFG)).toBeUndefined();
    expect(testSupportFromEnv({ OPPORTUN_AI_MOCK: '1' }, CFG)?.enabled).toEqual([
      'OPPORTUN_AI_MOCK',
    ]);
  });

  it('refuses every mock under NODE_ENV=production', () => {
    for (const flag of Object.keys(ALL)) {
      expect(() => testSupportFromEnv({ [flag]: '1', NODE_ENV: 'production' }, CFG)).toThrow(
        /must not be set in production/,
      );
    }
  });

  it('wires only what each flag names', () => {
    const ai = testSupportFromEnv({ OPPORTUN_AI_MOCK: '1' }, CFG)?.build;
    expect(ai?.ai).toBeDefined();
    expect(ai?.documentStore).toBeUndefined();
    expect(ai?.google).toBeUndefined();
    const docs = testSupportFromEnv({ OPPORTUN_DOCS_MOCK: '1' }, CFG)?.build;
    expect(docs?.ai).toBeUndefined();
    expect(docs?.documentStore).toBeDefined();
    const sources = testSupportFromEnv({ OPPORTUN_SOURCE_MOCK: '1' }, CFG)?.build;
    expect(sources?.sourceFetch).toBe(mockSourceFetch);
    expect(sources?.ai).toBeUndefined();
    expect(sources?.google).toBeUndefined();
    expect(testSupportFromEnv({ OPPORTUN_SOURCE_MOCK: 'yes' }, CFG)).toBeUndefined();
    const oauth = testSupportFromEnv({ OPPORTUN_OAUTH_MOCK: '1' }, CFG)?.build;
    expect(oauth?.oauth?.fetch).toBe(mockOAuthFetch);
    expect(oauth?.google).toBeUndefined();
  });
});

describe('OAuth sign-in mock', () => {
  it('reports the identity encoded in the code, through the real exchange', async () => {
    const creds = { clientId: 'id', clientSecret: 'secret' };
    const code = mockOAuthCode({ id: '7', email: 'E2E@Example.com', emailVerified: false });
    for (const provider of ['github', 'google', 'linkedin'] as const) {
      await expect(
        exchangeAndIdentify(mockOAuthFetch, provider, {
          creds,
          code,
          redirectUri: 'http://localhost:3000/cb',
          codeVerifier: 'v'.repeat(43),
        }),
      ).resolves.toMatchObject({
        providerAccountId: '7',
        email: 'e2e@example.com',
        emailVerified: false,
      });
    }
    await expect(
      exchangeAndIdentify(mockOAuthFetch, 'github', {
        creds,
        code: 'not-a-mock-code',
        redirectUri: 'http://localhost:3000/cb',
      }),
    ).rejects.toThrow(/token endpoint: 400/);
  });
});

describe('AI mock', () => {
  it('answers structured and streaming tasks through the real router and records runs', async () => {
    const { app, a } = await mockedApp();
    const ctx = { userId: a.userId, isAdmin: true };
    const report = await runStructured(await buildAiDeps(app.db, ctx), 'resume.match', {
      system: 'Score it.',
      prompt: 'Go.',
      schema: MatchReportSchema,
    });
    expect(report).toEqual(MATCH_REPORT);

    const stream = await streamChat(await buildAiDeps(app.db, ctx), 'resume.tailor', {
      system: 'Tailor it.',
      messages: [{ role: 'user', content: 'Help' }],
    });
    let text = '';
    for await (const delta of stream.textStream) text += delta;
    expect(text).toContain(TAILOR_FIND);
    expect(MOCK_RESUME_TEXT).toContain(TAILOR_FIND);

    const runs = await queryAll(
      app,
      'SELECT task_key, status, provider FROM task_runs ORDER BY created_at, id',
    );
    expect(runs).toEqual([
      { task_key: 'resume.match', status: 'ok', provider: 'openai_compatible' },
      { task_key: 'resume.tailor', status: 'ok', provider: 'openai_compatible' },
    ]);
  });

  it('only answers loopback callers', async () => {
    const { app } = await mockedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/__mock/ai/v1/chat/completions',
      remoteAddress: '10.0.0.5',
      payload: { model: 'mock-resume.match', messages: [] },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Job run-now hook (#747)', () => {
  it('queues an allowed sweep due now, which the runner runs to done', async () => {
    const { app } = await mockedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/__mock/jobs/opportunity.dedupe_ai_pass/run',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    const { jobId } = res.json<{ jobId: string }>();
    await drainAll(app);
    const status = await app.inject({
      method: 'GET',
      url: `/__mock/jobs/${jobId}`,
      remoteAddress: '127.0.0.1',
    });
    // The hook owns the run, not the sweep's result: its shape is the job's own (#751 added
    // failed and capped), so only that the job ran to done with a result is asserted here.
    const body = status.json<{ status: string; result: Record<string, unknown> | null }>();
    expect(body.status).toBe('done');
    expect(body.result).toMatchObject({ scanned: 0 });
  });

  it('runs only the allowed kinds, answers only loopback callers, and is off without the AI mock', async () => {
    const { app } = await mockedApp();
    const other = await app.inject({
      method: 'POST',
      url: '/__mock/jobs/demo.reset/run',
      remoteAddress: '127.0.0.1',
    });
    expect(other.statusCode).toBe(404);
    expect(await queryAll(app, "SELECT id FROM jobs WHERE kind = 'demo.reset'")).toEqual([]);
    const remote = await app.inject({
      method: 'POST',
      url: '/__mock/jobs/opportunity.dedupe_ai_pass/run',
      remoteAddress: '10.0.0.5',
    });
    expect(remote.statusCode).toBe(403);

    const support = testSupportFromEnv({ OPPORTUN_SOURCE_MOCK: '1' }, CFG);
    const { app: plain } = await testApp({}, { build: support?.build, setup: support?.register });
    open.push(plain);
    const off = await plain.inject({
      method: 'POST',
      url: '/__mock/jobs/opportunity.dedupe_ai_pass/run',
      remoteAddress: '127.0.0.1',
    });
    expect(off.statusCode).toBe(404);
  });
});

describe('Gmail mock', () => {
  it('syncs the fixture mailbox: targeted creates, broadcast is spam, interview proposes', async () => {
    const { app, a } = await mockedApp();
    const contoso = await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { companyName: 'Contoso', title: 'Senior Product Manager', sourceKind: 'manual' },
    });
    const contosoId = contoso.json().id as string;
    await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${contosoId}/stage`,
      payload: { to: 'applied' },
    });
    await connectGoogle(a, 'gmail');
    const sync = await a.request({ method: 'POST', url: '/api/v1/integrations/gmail/sync' });
    expect(sync.statusCode).toBe(202);
    await drainAll(app);

    const spam = await a.request({ method: 'GET', url: '/api/v1/communications?view=spam' });
    expect(spam.json().items.map((c: { subject: string }) => c.subject)).toEqual([
      '50 hot remote jobs this week',
    ]);
    const opps = await a.request({ method: 'GET', url: '/api/v1/opportunities?q=Northwind' });
    expect(opps.json().items).toMatchObject([
      {
        companyName: 'Northwind Labs',
        title: 'Staff Platform Engineer',
        sourceKind: 'communication',
      },
    ]);
    const linked = await a.request({ method: 'GET', url: '/api/v1/communications?view=linked' });
    const interview = (
      linked.json().items as { id: string; subject: string; proposedTransition: string | null }[]
    ).find((c) => c.subject.startsWith('Interview availability'));
    expect(interview?.proposedTransition).toBe('in_process');
    const accepted = await a.request({
      method: 'POST',
      url: `/api/v1/communications/${interview?.id}/accept-transition`,
      payload: {},
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const after = await a.request({ method: 'GET', url: `/api/v1/opportunities/${contosoId}` });
    expect(after.json().stage).toBe('in_process');
  });
});

describe('Source mock', () => {
  it('runs a Greenhouse source on fixture postings, ranked by the AI mock', async () => {
    const { app, a } = await mockedApp();
    const created = await a.request({
      method: 'POST',
      url: '/api/v1/discovery/sources',
      payload: { kind: 'ats_greenhouse', config: { org: 'vandelay' } },
    });
    expect(created.statusCode, created.body).toBe(201);
    const run = await a.request({
      method: 'POST',
      url: `/api/v1/discovery/sources/${created.json().id as string}/run`,
    });
    expect(run.statusCode, run.body).toBe(202);
    await drainAll(app);
    const queue = await a.request({
      method: 'GET',
      url: '/api/v1/discovery/results?disposition=pending&sort=-ai_score',
    });
    const items = queue.json().items as {
      aiScore: number | null;
      posting: { company: string; title: string };
    }[];
    expect(items.map((r) => [r.posting.company, r.posting.title, r.aiScore])).toEqual([
      [FIXTURE_COMPANY, 'Staff Platform Engineer', 92],
      [FIXTURE_COMPANY, 'Senior Backend Engineer', 70],
      [FIXTURE_COMPANY, 'Office Coordinator', 18],
    ]);
  });

  it('suggests a company whose fixture board detection finds after accept', async () => {
    const { app, a } = await mockedApp();
    const suggest = await app.inject({
      method: 'POST',
      url: '/__mock/discovery/suggest-companies',
      payload: { email: 'Isolation-A@example.com' },
    });
    expect(suggest.json()).toEqual({ status: 'suggested', created: 1, dropped: 0 });
    const list = await a.request({ method: 'GET', url: '/api/v1/companies/suggestions' });
    const [company] = list.json().items as { id: string; name: string }[];
    expect(company?.name).toBe('Pied Piper');
    const accepted = await a.request({
      method: 'POST',
      url: `/api/v1/companies/${company?.id}/accept`,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    await drainAll(app);
    const after = await a.request({ method: 'GET', url: `/api/v1/companies/${company?.id}` });
    expect(after.json()).toMatchObject({
      status: 'followed',
      atsKind: 'ats_greenhouse',
      atsRef: 'piedpiper',
    });
    // The board probe queued by the suggestion ran against the same fixture board (#221).
    const probed = await app.db.select().from(companies).where(eq(companies.id, company!.id)).get();
    expect(probed?.boardProbedAt).not.toBeNull();
    expect(probed?.boardOpenJobs).toBeGreaterThan(0);
  });

  it('answers only fixture boards and only loopback callers', async () => {
    const miss = await mockSourceFetch('https://boards-api.greenhouse.io/v1/boards/initech', {
      allowHosts: [],
    });
    expect(miss.status).toBe(404);
    const elsewhere = await mockSourceFetch('https://api.lever.co/v0/postings/piedpiper', {
      allowHosts: [],
    });
    expect(elsewhere.status).toBe(404);
    const { app } = await mockedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/__mock/discovery/suggest-companies',
      remoteAddress: '10.0.0.5',
      payload: { email: 'isolation-a@example.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('answers a fixture board job by id, refuses any other, and lists the job requests (#748)', async () => {
    const hit = await mockSourceFetch(
      'https://boards-api.greenhouse.io/v1/boards/vandelayindustries/jobs/1003',
      { allowHosts: [] },
    );
    expect(hit.status).toBe(200);
    expect(JSON.parse(hit.body.toString('utf8'))).toMatchObject({ id: 1003 });
    const unknownJob = await mockSourceFetch(
      'https://boards-api.greenhouse.io/v1/boards/vandelayindustries/jobs/9999',
      { allowHosts: [] },
    );
    expect(unknownJob.status).toBe(404);
    const unknownBoard = await mockSourceFetch(
      'https://boards-api.greenhouse.io/v1/boards/initech/jobs/1003',
      { allowHosts: [] },
    );
    expect(unknownBoard.status).toBe(404);
    const { app } = await mockedApp();
    const listed = await app.inject({
      method: 'GET',
      url: '/__mock/discovery/job-checks',
      remoteAddress: '127.0.0.1',
    });
    expect(listed.json<{ checks: string[] }>().checks.slice(-3)).toEqual([
      'vandelayindustries/1003',
      'vandelayindustries/9999',
      'initech/1003',
    ]);
    const remote = await app.inject({
      method: 'GET',
      url: '/__mock/discovery/job-checks',
      remoteAddress: '10.0.0.5',
    });
    expect(remote.statusCode).toBe(403);
  });
});

describe('Sign-in budget record (#776)', () => {
  it('records each rate-limited auth request and re-authentication, with no secret, to loopback callers only', async () => {
    const { app, a } = await mockedApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '127.0.0.1',
      payload: { email: ' QA-776@Example.com ', password: 'not the password, twelve+' },
    });
    expect(login.statusCode).toBe(401);
    // A re-authentication: starting 2FA enrolment takes the current password.
    const enroll = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/enroll',
      payload: { password: 'wrong password, thirteen' },
    });
    expect(enroll.statusCode).toBe(403);
    const res = await app.inject({
      method: 'GET',
      url: '/__mock/auth/attempts',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    const { attempts } = res.json<{
      attempts: { route: string; reauth: boolean; email: string | null; status: number }[];
    }>();
    // mockedApp registered two users; then the sign-in and the enrolment above.
    expect(attempts.map((x) => [x.route, x.reauth, x.email, x.status])).toEqual([
      ['POST /api/v1/auth/register', false, null, 201],
      ['POST /api/v1/auth/register', false, null, 201],
      ['POST /api/v1/auth/login', false, 'qa-776@example.com', 401],
      ['POST /api/v1/auth/2fa/enroll', true, null, 403],
    ]);
    const text = JSON.stringify(attempts);
    expect(text).not.toContain('twelve');
    expect(text).not.toContain('thirteen');
    const remote = await app.inject({
      method: 'GET',
      url: '/__mock/auth/attempts',
      remoteAddress: '10.0.0.5',
    });
    expect(remote.statusCode).toBe(403);
  });

  it("answers each bucket's peak spend, keyed as its limiter keys it", async () => {
    const { app, a } = await mockedApp();
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '127.0.0.1',
        payload: { email: 'qa-776@example.com', password: 'not the password, twelve+' },
      });
    }
    await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/enroll',
      payload: { password: 'wrong password, thirteen' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/__mock/auth/budget',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    const { buckets } = res.json<{
      buckets: { bucket: string; limit: number; peak: number; requests: number }[];
    }>();
    const get = (key: string) => buckets.find((b) => b.bucket === key);
    expect(get('127.0.0.1|qa-776@example.com')).toMatchObject({ limit: 10, requests: 3 });
    expect(get('127.0.0.1|qa-776@example.com')?.peak).toBeCloseTo(3, 1);
    expect(get('login-email|qa-776@example.com')).toMatchObject({ limit: 30, requests: 3 });
    // Two registrations and three sign-ins share the per-IP ceiling.
    expect(get('ip|127.0.0.1')).toMatchObject({ limit: 100, requests: 5 });
    const reauth = buckets.filter((b) => b.bucket.startsWith('reauth|'));
    expect(reauth).toHaveLength(1);
    expect(reauth[0]).toMatchObject({ limit: 10, requests: 1 });
    expect(reauth[0]?.bucket).toMatch(/^reauth\|.+@/);
    const remote = await app.inject({
      method: 'GET',
      url: '/__mock/auth/budget',
      remoteAddress: '10.0.0.5',
    });
    expect(remote.statusCode).toBe(403);
  });
});

describe('Sign-in budget record, every sign-in limiter (#776, tl and sec on #829)', () => {
  const budget = async (app: FastifyInstance) =>
    (
      await app.inject({ method: 'GET', url: '/__mock/auth/budget', remoteAddress: '127.0.0.1' })
    ).json<{ buckets: { kind: string; bucket: string; limit: number; requests: number }[] }>()
      .buckets;

  it('counts the OAuth per-address ceiling, a 2FA verify per token owner, and the 2FA code limit', async () => {
    const { app, a } = await mockedApp();
    await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/github/start?mode=login',
      remoteAddress: '127.0.0.1',
    });
    const token = await createPendingToken(app.db, a.userId, { ip: '127.0.0.1' });
    for (const pendingToken of [token, 'not-a-pending-token']) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/2fa/verify',
        remoteAddress: '127.0.0.1',
        payload: { pendingToken, code: '000000' },
      });
    }
    await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/activate',
      payload: { code: '000000', password: 'wrong password, fourteen' },
    });
    const buckets = await budget(app);
    const get = (key: string) => buckets.find((b) => b.bucket === key);
    expect(get('oauth|127.0.0.1')).toMatchObject({ kind: 'oauth', limit: 30, requests: 1 });
    expect(get('2fa|127.0.0.1')).toMatchObject({ kind: '2fa', limit: 10, requests: 2 });
    expect(get('2fa-user|isolation-a@example.com')).toMatchObject({
      kind: '2fa-user',
      requests: 1,
    });
    expect(get('2fa-user|none|127.0.0.1')).toMatchObject({ kind: '2fa-user', requests: 1 });
    expect(get('2fa-code|isolation-a@example.com')).toMatchObject({ kind: '2fa-code', limit: 10 });
    expect(get('reauth|isolation-a@example.com')).toMatchObject({ kind: 'reauth', requests: 1 });
  });

  it('keeps no request the schema refused, and so no oversized email', async () => {
    const { app } = await mockedApp();
    const before = (await budget(app)).reduce((n, b) => n + b.requests, 0);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '127.0.0.1',
      payload: { email: `${'x'.repeat(5000)}@example.com`, password: 'not the password, twelve+' },
    });
    expect(res.statusCode).toBe(400);
    const listed = await app.inject({
      method: 'GET',
      url: '/__mock/auth/attempts',
      remoteAddress: '127.0.0.1',
    });
    expect(listed.body).not.toContain('xxxxxxxxxx');
    expect((await budget(app)).reduce((n, b) => n + b.requests, 0)).toBe(before);
  });
});

describe('Sign-in budget record, refunds (#776)', () => {
  it("gives a passed sign-in's per-account token back, as routes/auth.ts does", async () => {
    const { app } = await mockedApp();
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '127.0.0.1',
        payload: { email: 'isolation-a@example.com', password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
    }
    const res = await app.inject({
      method: 'GET',
      url: '/__mock/auth/budget',
      remoteAddress: '127.0.0.1',
    });
    const { buckets } = res.json<{ buckets: { bucket: string; peak: number }[] }>();
    const peak = (key: string) => buckets.find((b) => b.bucket === key)?.peak;
    expect(peak('127.0.0.1|isolation-a@example.com')).toBeCloseTo(3, 1);
    expect(peak('login-email|isolation-a@example.com')).toBeCloseTo(1, 1);
  });
});

describe('Sign-in budget record, flag off (#776)', () => {
  it('is not there without OPPORTUN_AUTH_MOCK', async () => {
    const support = testSupportFromEnv({ OPPORTUN_SOURCE_MOCK: '1' }, CFG);
    const { app } = await testApp({}, { build: support?.build, setup: support?.register });
    open.push(app);
    for (const url of ['/__mock/auth/attempts', '/__mock/auth/budget']) {
      const res = await app.inject({ method: 'GET', url, remoteAddress: '127.0.0.1' });
      expect(res.statusCode).toBe(404);
    }
    const signUp = await app.inject({
      method: 'POST',
      url: '/__mock/auth/users',
      remoteAddress: '127.0.0.1',
      payload: { email: 'qa-776-off@example.com', password: PASSWORD, displayName: 'Off' },
    });
    expect(signUp.statusCode).toBe(404);
  });
});

describe('Sign-up shortcut (#776)', () => {
  const body = (email: string) => ({ email, password: PASSWORD, displayName: 'QA Shortcut' });
  const post = (app: FastifyInstance, email: string, remoteAddress = '127.0.0.1') =>
    app.inject({ method: 'POST', url: '/__mock/auth/users', remoteAddress, payload: body(email) });

  it('never makes the first account, so never the admin', async () => {
    const support = testSupportFromEnv({ OPPORTUN_AUTH_MOCK: '1' }, CFG);
    const { app } = await testApp({}, { build: support?.build, setup: support?.register });
    open.push(app);
    const res = await post(app, 'qa-776-first@example.com');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'no_users_yet' } });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await app.db.select().from(users).all()).toEqual([]);
    expect(await app.db.select().from(auditLog).all()).toEqual([]);
  });

  it('signs up as /auth/register does, keeping its rules, with no limiter spent', async () => {
    const { app } = await mockedApp();
    // registerTwoUsers closed registration again: the shortcut keeps that rule.
    const closed = await post(app, 'qa-776-closed@example.com');
    expect(closed.statusCode).toBe(403);
    expect(closed.json()).toEqual({ error: { code: 'registration_closed' } });
    await setRegistrationOpen(app, true);
    const made = await post(app, 'QA-776-New@Example.com');
    expect(made.statusCode).toBe(201);
    const { user } = made.json<{ user: { id: string; email: string; isAdmin: boolean } }>();
    expect(user).toMatchObject({ email: 'qa-776-new@example.com', isAdmin: false });
    // The same session and CSRF cookies as a sign-up, and the session works.
    const cookies = [made.headers['set-cookie']].flat().join('; ');
    expect(cookies).toMatch(/opportun_session=/);
    expect(cookies).toMatch(/opportun_csrf=/);
    const session = /opportun_session=([^;]+)/.exec(cookies)?.[1] ?? '';
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { opportun_session: session },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { id: string } }>().user.id).toBe(user.id);
    // The same audit row as a sign-up through the form.
    const rows = (await app.db.select().from(auditLog).all()).filter((r) => r.userId === user.id);
    expect(rows.map((r) => [r.event, r.detail])).toEqual([['auth.register', { isAdmin: false }]]);
    // The same email refused as taken, as the route refuses it.
    expect((await post(app, 'qa-776-new@example.com')).statusCode).toBe(409);
    // Not a request to a limited route: the per-IP ceiling counts only mockedApp's two sign-ups.
    const budget = await app.inject({
      method: 'GET',
      url: '/__mock/auth/budget',
      remoteAddress: '127.0.0.1',
    });
    const { buckets } = budget.json<{ buckets: { bucket: string; requests: number }[] }>();
    expect(buckets.find((b) => b.bucket === 'ip|127.0.0.1')?.requests).toBe(2);
    // Loopback only, as a second guard.
    expect((await post(app, 'qa-776-remote@example.com', '10.0.0.5')).statusCode).toBe(403);
  });
});

describe('overMargin (#776, tl on #829)', () => {
  it('lets the OAuth ceiling reach 80% and every other kind half its limit', () => {
    expect(overMargin({ kind: 'oauth', peak: 23.7, limit: 30 })).toBe(false); // 79%
    expect(overMargin({ kind: 'oauth', peak: 24.3, limit: 30 })).toBe(true); // 81%
    expect(overMargin({ kind: 'login', peak: 4.9, limit: 10 })).toBe(false);
    expect(overMargin({ kind: 'login', peak: 5.1, limit: 10 })).toBe(true);
    expect(overMargin({ kind: 'ip', peak: 51, limit: 100 })).toBe(true);
  });
});

describe('peakSpend (#776)', () => {
  const W = 15 * 60_000;
  it('counts a burst, refills over time and stops at the limit', () => {
    const at = (ms: number) => ({ at: ms, refund: false });
    expect(peakSpend([], 10, W)).toBe(0);
    expect(peakSpend([at(0), at(1), at(2)], 10, W)).toBeCloseTo(3, 1);
    // A request every 90 s refills one token each time at 10 per 15 minutes: never above 1.
    expect(
      peakSpend(
        [0, 1, 2, 3, 4].map((i) => at(i * 90_000)),
        10,
        W,
      ),
    ).toBe(1);
    // Twelve at once: the bucket empties and the rest are refused.
    expect(
      peakSpend(
        Array.from({ length: 12 }, (_, i) => at(i)),
        10,
        W,
      ),
    ).toBe(10);
  });
  it('gives a refunded token straight back', () => {
    const ok = Array.from({ length: 5 }, (_, i) => ({ at: i, refund: true }));
    expect(peakSpend(ok, 30, W)).toBeCloseTo(1, 1);
  });
});

describe('Board listing control (#859)', () => {
  const read = async () => {
    const out: { id: string | null | undefined; descriptionMd: string | null | undefined }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the mock ignores its arguments
    for await (const item of mockGreenhouseSource.fetchPostings({} as any, {} as any, null)) {
      out.push({ id: item.posting.externalId, descriptionMd: item.posting.descriptionMd });
    }
    return out;
  };

  it('drops, appends and holds the next listings, counts them, and clears to loopback callers only', async () => {
    const { app } = await mockedApp();
    const set = (payload: unknown, remoteAddress = '127.0.0.1') =>
      app.inject({
        method: 'POST',
        url: '/__mock/discovery/listing',
        remoteAddress,
        payload: payload as object,
      });
    expect((await set({ drop: ['1003'] }, '10.0.0.5')).statusCode).toBe(403);
    expect((await set({ drop: ['not-an-id'] })).statusCode).toBe(400);
    const ok = await set({ drop: ['1003'], append: { '1002': ' Now also Kafka.' }, holdMs: 300 });
    expect(ok.statusCode).toBe(200);
    const started = Date.now();
    const rows = await read();
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(rows.map((r) => r.id)).toEqual(['1001', '1002']);
    expect(rows[1]?.descriptionMd).toMatch(/ Now also Kafka\.$/);
    const state = await app.inject({
      method: 'GET',
      url: '/__mock/discovery/listing',
      remoteAddress: '127.0.0.1',
    });
    expect(state.json()).toMatchObject({ reads: 1, listing: { drop: ['1003'], holdMs: 300 } });
    const cleared = await app.inject({
      method: 'DELETE',
      url: '/__mock/discovery/listing',
      remoteAddress: '127.0.0.1',
    });
    expect(cleared.statusCode).toBe(204);
    expect((await read()).map((r) => r.id)).toEqual(['1001', '1002', '1003']);
  });
});
