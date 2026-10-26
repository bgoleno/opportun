// The env-gated e2e fakes (src/testSupport). These pin what apps/web/e2e relies on: the AI
// mock answers through the real router over loopback HTTP, the Gmail fixture mailbox flows
// through sync and classification, the source mock feeds discovery and board detection, and
// none of it can be switched on in production.
import { createServer } from 'node:net';
import { MatchReportSchema, runStructured, streamChat } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config';
import { buildAiDeps } from '../src/lib/ai';
import { exchangeAndIdentify } from '../src/lib/oauthProviders';
import { testSupportFromEnv } from '../src/testSupport/index';
import { MATCH_REPORT, TAILOR_FIND } from '../src/testSupport/mockAi';
import { MOCK_RESUME_TEXT } from '../src/testSupport/mockDocs';
import { mockOAuthCode, mockOAuthFetch } from '../src/testSupport/mockOAuth';
import { FIXTURE_COMPANY, mockSourceFetch } from '../src/testSupport/mockSources';
import { connectGoogle } from './fakeGoogle';
import { testApp } from './helpers';
import { registerTwoUsers, type TestClient } from './isolation';
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
  trustedProxies: [],
} satisfies Config;

const ALL = {
  OPPORTUN_AI_MOCK: '1',
  OPPORTUN_DOCS_MOCK: '1',
  OPPORTUN_GMAIL_MOCK: '1',
  OPPORTUN_SOURCE_MOCK: '1',
  OPPORTUN_OAUTH_MOCK: '1',
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
    expect(suggest.json()).toEqual({ status: 'suggested', created: 1 });
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
});
