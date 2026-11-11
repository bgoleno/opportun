// The workflows of design.md 14.5 (https://github.com/bgoleno/opportun/issues/344, FR-T4 part 2):
// each starts an `invoke_workflow {name}` span where the table says, for its user, and the jobs
// it continues into carry its trace in jobs.trace_context (14.6). An enqueue that some other path
// shares starts its job's own trace. With collection off nothing of this is recorded.
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { trace } from '@opentelemetry/api';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLanguageModel } from '../../../packages/ai/src/providers';
import { jobs, obsSpans, obsTraces } from '../src/db/schema';
import { companyTagsJob } from '../src/jobs/companyTags';
import { rankWaitingJob } from '../src/jobs/discoveryRankWaiting';
import { discoveryRunJob } from '../src/jobs/discoveryRun';
import { gmailSyncJob, CLASSIFY_JOB_KIND } from '../src/jobs/gmailSync';
import { enqueueClassify } from '../src/jobs/mailIngest';
import type { JobContext, JobHandler } from '../src/jobs/registry';
import { obs, setCollecting } from '../src/obs';
import { flushSpans } from '../src/obs/tracing';
import { continuesTrace, workflow } from '../src/obs/workflow';
import { useApi } from './api';
import { connectGoogle, fakeGoogle, type FakeGoogle } from './fakeGoogle';
import type { TestClient } from './isolation';
import { withProviderResolver } from './providerDns';
import { BASE_DOC_ID, BASE_TEXT, createOpportunity, registerBase } from './resumeFixtures';

vi.mock('../../../packages/ai/src/providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/ai/src/providers')>();
  return { ...real, createLanguageModel: vi.fn() };
});

let google: FakeGoogle;
const boot = withProviderResolver(
  useApi(() => {
    google = fakeGoogle({ [BASE_DOC_ID]: { title: 'Jane Base Resume', text: BASE_TEXT } });
    return { build: { google } };
  }),
);
const PASSWORD = 'correct horse battery';

beforeEach(() => {
  vi.mocked(createLanguageModel).mockReset();
});

afterEach(async () => {
  await setCollecting(false);
});

async function workflowSpans(app: FastifyInstance) {
  await flushSpans();
  return (await app.db.select().from(obsSpans).all()).filter((s) =>
    s.name.startsWith('invoke_workflow '),
  );
}

const traceIdOf = (traceparent: string | null): string | undefined => traceparent?.split('-')[1];

describe('a chat turn is the tailoring_chat workflow (#344, 14.5)', () => {
  async function session(c: TestClient): Promise<string> {
    await connectGoogle(c);
    const key = await c.request({
      method: 'POST',
      url: '/api/v1/secrets',
      payload: { kind: 'ai_api_key', label: 'anthropic', value: 'sk-ant-test-key-0123456789' },
    });
    expect(key.statusCode).toBe(201);
    const baseId = await registerBase(c);
    const oppId = await createOpportunity(c);
    const resume = (
      await c.request({
        method: 'POST',
        url: '/api/v1/resumes',
        payload: { baseResumeId: baseId, opportunityId: oppId },
      })
    ).json() as { id: string };
    const s = await c.request({ method: 'POST', url: `/api/v1/resumes/${resume.id}/tailoring` });
    return (s.json() as { id: string }).id;
  }

  it('one trace: the workflow span with the session as its conversation, and the streamed call under it', async () => {
    const { app, a } = await boot();
    const sessionId = await session(a);
    await setCollecting(true);
    vi.mocked(createLanguageModel).mockReturnValue(
      new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'Here is a change.' },
              { type: 'text-end', id: 't' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 20, text: 20, reasoning: 0 },
                },
              },
            ],
          }),
        }),
      }),
    );
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/tailoring/${sessionId}/messages`,
      payload: { content: 'Make it about Go' },
    });
    expect(res.statusCode).toBe(200);
    await flushSpans();

    const all = await app.db.select().from(obsSpans).all();
    const wf = all.find((s) => s.name === 'invoke_workflow tailoring_chat');
    const inf = all.find((s) => s.task === 'resume.tailor');
    expect(wf).toBeDefined();
    expect(inf).toMatchObject({ parentSpanId: wf!.spanId, traceId: wf!.traceId });
    expect(inf!.attributes).toMatchObject({
      'gen_ai.request.stream': true,
      'gen_ai.conversation.id': sessionId,
    });
    expect(await app.db.select().from(obsTraces).all()).toEqual([
      expect.objectContaining({
        traceId: wf!.traceId,
        userId: a.userId,
        workflow: 'tailoring_chat',
        conversationId: sessionId,
        tasks: ['resume.tailor'],
      }),
    ]);
  });
});

describe('the mail_sync workflow continues into its classify jobs (#344, 14.5, 14.6)', () => {
  async function push(app: FastifyInstance, c: TestClient) {
    const token = (
      await c.request({
        method: 'POST',
        url: '/api/v1/device-tokens',
        payload: { name: 'MacBook connector', scopes: ['mail:push'], password: PASSWORD },
      })
    ).json() as { token: string };
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connector/mail/batch',
      headers: { authorization: `Bearer ${token.token}` },
      payload: {
        messages: [1, 2].map((n) => ({
          externalId: `apple-mail:apple-${n}@mail.example`,
          threadKey: `thread-${n}`,
          from: `Recruiter ${n} <r${n}@initech.example>`,
          to: ['me@example.com'],
          subject: `Role ${n}`,
          snippet: `Hello ${n}`,
          bodyText: `Hello ${n}. We are hiring.`,
          sentAt: Date.now() - n * 60_000,
        })),
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function classifyJobs(app: FastifyInstance) {
    return app.db.select().from(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).all();
  }

  it('a connector batch is one mail_sync workflow, and each classify job it queues carries its trace', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    await push(app, a);
    const [wf] = await workflowSpans(app);
    expect(wf).toMatchObject({ name: 'invoke_workflow mail_sync', userId: a.userId });
    const queued = await classifyJobs(app);
    expect(queued).toHaveLength(2);
    for (const j of queued) expect(traceIdOf(j.traceContext)).toBe(wf!.traceId);
  });

  it('with collection off the batch writes no trace context and no span', async () => {
    const { app, a } = await boot();
    await push(app, a);
    expect(await workflowSpans(app)).toEqual([]);
    for (const j of await classifyJobs(app)) expect(j.traceContext).toBeNull();
  });

  it('the same enqueue outside a workflow starts its own trace, even under some other span', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    const ctx = { userId: a.userId, isAdmin: false };
    await obs.span('http.client', { 'http.request.method': 'GET' }, async () => {
      expect(trace.getActiveSpan()).toBeDefined();
      expect(continuesTrace()).toBe(false);
      await enqueueClassify(app.db, ctx, '01a1c825-2bed-7d78-891e-ce1f8b129bf7');
    });
    await workflow('mail_sync', { userId: a.userId }, async () => {
      expect(continuesTrace()).toBe(true);
      await enqueueClassify(app.db, ctx, '01a1c825-2bed-7d78-891e-ce1f8b129bf8');
    });
    const byComm = new Map(
      (await classifyJobs(app)).map((j) => [
        (j.payload as { communicationId: string }).communicationId,
        j.traceContext,
      ]),
    );
    expect(byComm.get('01a1c825-2bed-7d78-891e-ce1f8b129bf7')).toBeNull();
    expect(byComm.get('01a1c825-2bed-7d78-891e-ce1f8b129bf8')).toMatch(/^00-[0-9a-f]{32}-/);
  });
});

describe('the job workflows start at their job (#344, 14.5)', () => {
  function jobCtx(app: FastifyInstance, userId: string): JobContext {
    return {
      jobId: '01a1c825-2bed-7d78-891e-ce1f8b129c00',
      userId,
      attempt: 1,
      maxAttempts: 1,
      services: app.jobs.services,
      setResult: async () => undefined,
      stopping: () => false,
    };
  }

  it.each([
    [
      'discovery.run',
      'discovery_run',
      discoveryRunJob,
      { sourceId: '01a1c825-2bed-7d78-891e-ce1f8b129c01' },
    ],
    ['discovery.rank_waiting', 'rank_backlog', rankWaitingJob, {}],
    ['gmail.sync', 'mail_sync', gmailSyncJob, {}],
    ['discovery.company_tags', 'company_tags', companyTagsJob, {}],
  ] as [string, string, JobHandler<unknown>, unknown][])(
    'job %s runs inside invoke_workflow %s, for its user',
    async (_kind, name, handler, payload) => {
      const { app, a } = await boot();
      await setCollecting(true);
      // Whether the job itself succeeds here (no source, no mailbox) is not what is tested.
      await handler.run(app.db, payload, jobCtx(app, a.userId)).catch(() => undefined);
      const spans = await workflowSpans(app);
      expect(spans.map((s) => [s.name, s.userId])).toEqual([[`invoke_workflow ${name}`, a.userId]]);
    },
  );
});

describe('a capture is the capture workflow (#344, 14.5)', () => {
  it('POST /capture runs inside invoke_workflow capture, its refused extraction under it', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/capture',
      // Pasted text, so no page is fetched. With no AI key the extraction is refused.
      payload: { text: 'Senior Engineer at Initech. Remote. Go and Kubernetes. Apply today.' },
    });
    expect(res.statusCode, res.body).toBe(503);
    const spans = await workflowSpans(app);
    expect(spans.map((s) => [s.name, s.userId, s.status])).toEqual([
      ['invoke_workflow capture', a.userId, 'error'],
    ]);
    // The refused extraction is under it: a refusal before the provider still has its span.
    const inference = (await app.db.select().from(obsSpans).all()).find(
      (s) => s.task === 'capture.extract',
    );
    expect(inference).toMatchObject({ parentSpanId: spans[0]!.spanId, errorType: 'no_key' });
  });
});
