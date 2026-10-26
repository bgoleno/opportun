import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLanguageModel } from '../../../packages/ai/src/providers';
import { resumeMatchReports, settings } from '../src/db/schema';
import { budgetKey } from '../src/lib/ai';
import { useApi } from './api';
import { connectGoogle, fakeGoogle, type FakeGoogle } from './fakeGoogle';
import { assertIsolated, type TestClient } from './isolation';
import { BASE_DOC_ID, BASE_TEXT, createOpportunity, registerBase } from './resumeFixtures';
import { queryOne } from './db';

// The provider is always mocked: no network calls and no real keys in tests.
vi.mock('../../../packages/ai/src/providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/ai/src/providers')>();
  return { ...real, createLanguageModel: vi.fn() };
});

const newGoogle = (): FakeGoogle =>
  fakeGoogle({ [BASE_DOC_ID]: { title: 'Jane Base Resume', text: BASE_TEXT } });
let google: FakeGoogle;
const boot = useApi(() => {
  google = newGoogle();
  return { build: { google } };
});

beforeEach(() => {
  vi.mocked(createLanguageModel).mockReset();
});

type LanguageModelV4StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P>
    ? P
    : never;

const USAGE = {
  inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function streamParts(...deltas: string[]): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
  ];
}

function streamingModel(...deltas: string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: streamParts(...deltas) }) }),
  });
}

/** Streams some text, then the provider connection dies. */
function failingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => {
      const parts: LanguageModelV4StreamPart[] = [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Partial answer' },
      ];
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          // pull, not start: error() in start would discard the queued parts unread.
          pull(controller) {
            const part = parts.shift();
            if (part === undefined) controller.error(new Error('socket hang up'));
            else controller.enqueue(part);
          },
        }),
      };
    },
  });
}

const EDIT_REPLY = [
  'Your Go work maps well. ',
  'Here is one change.\n\n```json\n',
  '{"edits": [{"find": "Built the billing platform in Go", "replace": "Built the Go billing platform on Kubernetes", "rationale": "Mirrors the posting"}]}',
  '\n```',
];

async function addKey(c: TestClient) {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/secrets',
    payload: { kind: 'ai_api_key', label: 'anthropic', value: 'sk-ant-test-key-0123456789' },
  });
  expect(res.statusCode).toBe(201);
}

/** A connected user with a key, a tailored resume and its open session. */
async function setup(c: TestClient) {
  await connectGoogle(c);
  await addKey(c);
  const baseId = await registerBase(c);
  const oppId = await createOpportunity(c);
  const tailored = await c.request({
    method: 'POST',
    url: '/api/v1/resumes',
    payload: { baseResumeId: baseId, opportunityId: oppId },
  });
  const resume = tailored.json() as { id: string; docRef: string };
  const session = await c.request({
    method: 'POST',
    url: `/api/v1/resumes/${resume.id}/tailoring`,
  });
  expect(session.statusCode).toBe(200);
  return { resume, oppId, sessionId: session.json().id as string };
}

interface SseEvent {
  type: string;
  [k: string]: unknown;
}

function sseEvents(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice('data: '.length)) as SseEvent);
}

function send(c: TestClient, sessionId: string, content: string) {
  return c.request({
    method: 'POST',
    url: `/api/v1/tailoring/${sessionId}/messages`,
    payload: { content },
  });
}

function systemOf(model: MockLanguageModelV4, call = 0): string {
  const prompt = model.doStreamCalls.at(call)!.prompt;
  const sys = prompt.find((m) => m.role === 'system');
  return sys?.role === 'system' ? sys.content : '';
}

describe('tailoring sessions', () => {
  it('returns the same open session for a resume until it is completed', async () => {
    const { a } = await boot();
    const { resume, sessionId } = await setup(a);
    const again = await a.request({
      method: 'POST',
      url: `/api/v1/resumes/${resume.id}/tailoring`,
    });
    expect(again.json()).toMatchObject({ id: sessionId, messages: [], acceptedAt: null });
  });

  it('puts every active resume rule, fetched live, into the system prompt', async () => {
    const { a } = await boot();
    const { sessionId } = await setup(a);
    const rules = ['Never use the word "synergy".', 'Keep every bullet under 25 words.'];
    for (const [i, ruleText] of rules.entries()) {
      await a.request({
        method: 'POST',
        url: '/api/v1/resume-rules',
        payload: { ruleText, category: 'style', sortOrder: i },
      });
    }
    await a.request({
      method: 'POST',
      url: '/api/v1/resume-rules',
      payload: { ruleText: 'INACTIVE RULE TEXT', category: 'content', active: false },
    });
    const model = streamingModel('ok');
    vi.mocked(createLanguageModel).mockReturnValue(model);
    expect((await send(a, sessionId, 'Tailor this please')).statusCode).toBe(200);
    const system = systemOf(model);
    for (const rule of rules) expect(system).toContain(rule);
    expect(system).not.toContain('INACTIVE RULE TEXT');
    expect(system).toContain(BASE_TEXT);
    expect(system).toMatch(
      /<untrusted>\n[^]*We need Go, Kubernetes and Terraform\.[^]*\n<\/untrusted>/,
    );

    // Live: a rule added between calls shows up in the next call.
    await a.request({
      method: 'POST',
      url: '/api/v1/resume-rules',
      payload: { ruleText: 'Lead with impact.', category: 'style', sortOrder: 5 },
    });
    expect((await send(a, sessionId, 'Again')).statusCode).toBe(200);
    expect(systemOf(model, 1)).toContain('Lead with impact.');
  });

  describe('the match report in the system prompt (#303)', () => {
    function scoreModel(report: object): MockLanguageModelV4 {
      return new MockLanguageModelV4({
        doGenerate: {
          content: [{ type: 'text', text: JSON.stringify(report) }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: USAGE,
          warnings: [],
        },
      });
    }

    async function score(c: TestClient, resumeId: string, opportunityId: string, report: object) {
      vi.mocked(createLanguageModel).mockReturnValue(scoreModel(report));
      const res = await c.request({
        method: 'POST',
        url: `/api/v1/resumes/${resumeId}/match`,
        payload: { opportunityId },
      });
      expect(res.statusCode).toBe(200);
    }

    it('says no score has been run yet when the resume was never scored', async () => {
      const { a } = await boot();
      const { sessionId } = await setup(a);
      const model = streamingModel('ok');
      vi.mocked(createLanguageModel).mockReturnValue(model);
      expect((await send(a, sessionId, 'Tailor this please')).statusCode).toBe(200);
      expect(systemOf(model)).toContain(
        'No match score has been run yet for this resume against this job.',
      );
    });

    it('says no job is linked when the resume has been detached from its opportunity', async () => {
      const { a } = await boot();
      const { resume, sessionId } = await setup(a);
      const detach = await a.request({
        method: 'PATCH',
        url: `/api/v1/resumes/${resume.id}`,
        payload: { opportunityId: null },
      });
      expect(detach.statusCode).toBe(200);
      const model = streamingModel('ok');
      vi.mocked(createLanguageModel).mockReturnValue(model);
      expect((await send(a, sessionId, 'Tailor this please')).statusCode).toBe(200);
      expect(systemOf(model)).toContain(
        'No job is linked to this resume, so there is no match score.',
      );
    });

    it('renders the score, missing keywords, weak areas and summary once scored', async () => {
      const { a } = await boot();
      const { resume, oppId, sessionId } = await setup(a);
      const report = {
        score: 72,
        missingKeywords: ['Terraform'],
        weakAreas: [{ area: 'Kubernetes', suggestion: 'Name the clusters you ran' }],
        summary: 'Strong Go background; show infrastructure work.',
      };
      await score(a, resume.id, oppId, report);
      const model = streamingModel('ok');
      vi.mocked(createLanguageModel).mockReturnValue(model);
      expect((await send(a, sessionId, 'Tailor this please')).statusCode).toBe(200);
      const system = systemOf(model);
      expect(system).toContain('Score: 72/100');
      expect(system).toContain('Terraform');
      expect(system).toContain('Kubernetes');
      expect(system).toContain('Name the clusters you ran');
      expect(system).toContain('Strong Go background; show infrastructure work.');
      // Not stale: no tailoring session has completed since this score was taken.
      expect(system).toContain('No tailoring session has completed for this resume since.');
      expect(system).not.toContain('may no longer reflect');
    });

    it('flags the score as stale once a later tailoring session completes', async () => {
      const { a } = await boot();
      const { resume, oppId, sessionId } = await setup(a);
      const report = { score: 60, missingKeywords: [], weakAreas: [], summary: 'Decent fit.' };
      await score(a, resume.id, oppId, report);

      const completed = await a.request({
        method: 'POST',
        url: `/api/v1/tailoring/${sessionId}/complete`,
      });
      expect(completed.statusCode).toBe(200);

      // A new session, since the old one is closed -- the same resume, now carrying a score
      // that predates a completed session (the exact edit-then-rerun-then-review shape #303
      // describes: staleness is the normal mid-loop state, not an edge case).
      const next = await a.request({
        method: 'POST',
        url: `/api/v1/resumes/${resume.id}/tailoring`,
      });
      expect(next.statusCode).toBe(200);
      const nextSessionId = next.json().id as string;
      const model = streamingModel('ok');
      vi.mocked(createLanguageModel).mockReturnValue(model);
      expect((await send(a, nextSessionId, 'Review the changes')).statusCode).toBe(200);
      const system = systemOf(model);
      expect(system).toContain(
        'A tailoring session has completed since, so this may no longer reflect the current document.',
      );
      expect(system).toContain('suggest the user re-run the match score');
    });

    it('picks up a score run mid-session on the very next message, with no session restart', async () => {
      const { a } = await boot();
      const { resume, oppId, sessionId } = await setup(a);
      const model = streamingModel('first', 'second');
      vi.mocked(createLanguageModel).mockReturnValue(model);
      expect((await send(a, sessionId, 'Tailor this please')).statusCode).toBe(200);
      expect(systemOf(model, 0)).toContain('No match score has been run yet');

      const report = { score: 90, missingKeywords: [], weakAreas: [], summary: 'Great fit.' };
      await score(a, resume.id, oppId, report);
      vi.mocked(createLanguageModel).mockReturnValue(model);
      expect((await send(a, sessionId, 'Now review it')).statusCode).toBe(200);
      expect(systemOf(model, 1)).toContain('Score: 90/100');
      expect(systemOf(model, 1)).toContain('Great fit.');
    });

    it('prepends the match report when a user-edited prompt lacks the {{match_report}} placeholder', async () => {
      const { a } = await boot();
      const { resume, oppId, sessionId } = await setup(a);
      const report = { score: 55, missingKeywords: [], weakAreas: [], summary: 'A fit.' };
      await score(a, resume.id, oppId, report);

      const custom = await a.request({
        method: 'POST',
        url: '/api/v1/ai/prompts',
        payload: {
          taskKey: 'resume.tailor',
          body: '{{resume_rules}}\n\n{{base_resume}}\n\n{{jd_untrusted}}\n\nNo match-report placeholder here on purpose.',
        },
      });
      expect(custom.statusCode).toBe(201);
      const activated = await a.request({
        method: 'POST',
        url: `/api/v1/ai/prompts/${custom.json().id}/activate`,
      });
      expect(activated.statusCode).toBe(200);

      const model = streamingModel('ok');
      vi.mocked(createLanguageModel).mockReturnValue(model);
      expect((await send(a, sessionId, 'Tailor this please')).statusCode).toBe(200);
      expect(systemOf(model)).toContain('Score: 55/100');
    });
  });

  it('streams the reply as SSE, persists both turns and parses suggested edits', async () => {
    const { app, a } = await boot();
    const { sessionId } = await setup(a);
    vi.mocked(createLanguageModel).mockReturnValue(streamingModel(...EDIT_REPLY));
    const res = await send(a, sessionId, 'Tailor for Acme');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['content-security-policy']).toBeDefined();
    const events = sseEvents(res.body);
    expect(events[0]).toMatchObject({ type: 'start' });
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => e.text)
        .join(''),
    ).toBe(EDIT_REPLY.join(''));
    const done = events.at(-1)!;
    expect(done.type).toBe('done');
    const edits = [
      {
        find: 'Built the billing platform in Go',
        replace: 'Built the Go billing platform on Kubernetes',
        rationale: 'Mirrors the posting',
      },
    ];
    expect(done.message).toMatchObject({
      role: 'assistant',
      content: 'Your Go work maps well. Here is one change.',
      edits,
    });

    const session = await a.request({ method: 'GET', url: `/api/v1/tailoring/${sessionId}` });
    expect(session.json().messages).toEqual([
      {
        role: 'user',
        content: 'Tailor for Acme',
        at: expect.any(Number),
        edits: [],
        incomplete: false,
      },
      {
        role: 'assistant',
        content: 'Your Go work maps well. Here is one change.',
        at: expect.any(Number),
        edits,
        incomplete: false,
      },
    ]);
    // The chat never writes to the document (C-4).
    expect(google.batchUpdates).toEqual([]);
    // The run is referenced from the session.
    const row = (await queryOne(
      app,
      'SELECT task_run_ids FROM tailoring_sessions WHERE id = ?',
      sessionId,
    )) as { task_run_ids: string };
    const runIds = JSON.parse(row.task_run_ids) as string[];
    expect(runIds).toHaveLength(1);
    expect(
      await queryOne(app, 'SELECT task_key, status FROM task_runs WHERE id = ?', runIds[0]),
    ).toEqual({ task_key: 'resume.tailor', status: 'ok' });
  });

  it('streams through a real socket to a fetch reader', async () => {
    const { app, a } = await boot();
    const { sessionId } = await setup(a);
    vi.mocked(createLanguageModel).mockReturnValue(streamingModel(...EDIT_REPLY));
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/v1/tailoring/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': a.csrf,
        cookie: `opportun_session=${a.session}; opportun_csrf=${a.csrf}`,
      },
      body: JSON.stringify({ content: 'Over the wire' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    const events = sseEvents(body);
    expect(events.map((e) => e.type)).toEqual([
      'start',
      'delta',
      'delta',
      'delta',
      'delta',
      'done',
    ]);
  });

  it('a provider failure mid-stream keeps the user message and leaves the session resumable', async () => {
    const { a } = await boot();
    const { sessionId } = await setup(a);
    vi.mocked(createLanguageModel).mockReturnValue(failingModel());
    const res = await send(a, sessionId, 'First question');
    expect(res.statusCode).toBe(200);
    const events = sseEvents(res.body);
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'ai_unavailable',
      reason: 'provider_error',
    });
    expect(res.body).not.toContain('socket hang up');

    const after = (
      await a.request({ method: 'GET', url: `/api/v1/tailoring/${sessionId}` })
    ).json();
    expect(after.messages).toMatchObject([
      { role: 'user', content: 'First question', incomplete: false },
      { role: 'assistant', content: 'Partial answer', incomplete: true },
    ]);

    // Resume: the next message goes through, and the cut-off reply is not fed back to the model.
    const model = streamingModel('Full answer');
    vi.mocked(createLanguageModel).mockReturnValue(model);
    const retry = await send(a, sessionId, 'Second try');
    expect(sseEvents(retry.body).at(-1)).toMatchObject({ type: 'done' });
    const sent = model.doStreamCalls[0]!.prompt.filter((m) => m.role !== 'system');
    expect(sent.map((m) => m.role)).toEqual(['user', 'user']);
    expect(JSON.stringify(sent)).not.toContain('Partial answer');
    const final = (
      await a.request({ method: 'GET', url: `/api/v1/tailoring/${sessionId}` })
    ).json();
    expect(final.messages.map((m: { content: string }) => m.content)).toEqual([
      'First question',
      'Partial answer',
      'Second try',
      'Full answer',
    ]);
  });

  it('a failure before the stream opens answers 503 and still keeps the user message', async () => {
    const { app, a } = await boot();
    const { sessionId } = await setup(a);
    await app.db
      .insert(settings)
      .values({
        key: budgetKey(a.userId),
        userId: a.userId,
        value: { perTaskDailyUsd: 0 },
        updatedAt: 0,
      })
      .run();
    const res = await send(a, sessionId, 'Hello');
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toEqual({ code: 'ai_unavailable', reason: 'budget_exceeded' });
    const after = (
      await a.request({ method: 'GET', url: `/api/v1/tailoring/${sessionId}` })
    ).json();
    expect(after.messages).toMatchObject([{ role: 'user', content: 'Hello' }]);
  });

  it('applies edits to the document only from the explicit apply endpoint', async () => {
    const { a } = await boot();
    const { resume, sessionId } = await setup(a);
    const edits = [
      { find: 'Built the billing platform in Go', replace: 'Built the Go billing platform' },
    ];
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/tailoring/${sessionId}/suggestions/apply`,
      payload: { edits },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [{ index: 0, outcome: 'applied' }] });
    expect(google.batchUpdates).toEqual([
      {
        documentId: resume.docRef,
        requests: [
          {
            replaceAllText: {
              containsText: { text: edits[0]!.find, matchCase: true },
              replaceText: edits[0]!.replace,
            },
          },
        ],
      },
    ]);
    expect(google.docs.get(resume.docRef)!.text).toContain('Built the Go billing platform');
    // The base document is untouched.
    expect(google.docs.get(BASE_DOC_ID)!.text).toBe(BASE_TEXT);

    const stale = await a.request({
      method: 'POST',
      url: `/api/v1/tailoring/${sessionId}/suggestions/apply`,
      payload: { edits },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('edit_target_missing');
  });

  it('reports an edit an earlier one in the same batch already consumed (#146, Google Docs)', async () => {
    const { a } = await boot();
    const { resume, sessionId } = await setup(a);
    // Both target "Senior Engineer" (present originally, so the missing check passes for
    // both), but the first edit already replaces the one occurrence.
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/tailoring/${sessionId}/suggestions/apply`,
      payload: {
        edits: [
          { find: 'Senior Engineer', replace: 'Staff Engineer' },
          { find: 'Senior Engineer', replace: 'Principal Engineer' },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      results: [
        { index: 0, outcome: 'applied' },
        { index: 1, outcome: 'already_consumed' },
      ],
    });
    const text = google.docs.get(resume.docRef)!.text;
    expect(text).toContain('Staff Engineer');
    expect(text).not.toContain('Principal Engineer');
  });

  it("refuses to apply edits through another user's session", async () => {
    const { a, b } = await boot();
    const { sessionId } = await setup(a);
    await connectGoogle(b);
    const res = await b.request({
      method: 'POST',
      url: `/api/v1/tailoring/${sessionId}/suggestions/apply`,
      payload: { edits: [{ find: 'Jane Doe', replace: 'Mallory' }] },
    });
    expect(res.statusCode).toBe(404);
    expect(google.batchUpdates).toEqual([]);
    const msg = await send(b, sessionId, 'hi');
    expect(msg.statusCode).toBe(404);
  });

  it('completing a session accepts it and moves the resume to in_review', async () => {
    const { a } = await boot();
    const { resume, sessionId } = await setup(a);
    const res = await a.request({ method: 'POST', url: `/api/v1/tailoring/${sessionId}/complete` });
    expect(res.statusCode).toBe(200);
    expect(res.json().acceptedAt).toEqual(expect.any(Number));
    const r = await a.request({ method: 'GET', url: `/api/v1/resumes/${resume.id}` });
    expect(r.json().status).toBe('in_review');
    expect((await send(a, sessionId, 'more')).statusCode).toBe(409);
    const next = await a.request({ method: 'POST', url: `/api/v1/resumes/${resume.id}/tailoring` });
    expect(next.json().id).not.toBe(sessionId);
  });

  function scoreModel(report: object): MockLanguageModelV4 {
    return new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: JSON.stringify(report) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: USAGE,
        warnings: [],
      },
    });
  }

  function getMatch(c: TestClient, resumeId: string, opportunityId: string) {
    return c.request({
      method: 'GET',
      url: `/api/v1/resumes/${resumeId}/match?opportunityId=${opportunityId}`,
    });
  }

  it('match returns a schema-valid report, persists it, and surfaces it as not stale', async () => {
    const { a } = await boot();
    const { resume, oppId } = await setup(a);
    const report = {
      score: 72,
      missingKeywords: ['Terraform'],
      weakAreas: [{ area: 'Kubernetes', suggestion: 'Name the clusters you ran' }],
      summary: 'Strong Go background; show infrastructure work.',
    };
    const model = scoreModel(report);
    vi.mocked(createLanguageModel).mockReturnValue(model);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/resumes/${resume.id}/match`,
      payload: { opportunityId: oppId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ report, scoredAt: expect.any(Number), stale: false });
    const call = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(call).toContain('Built the billing platform in Go');
    expect(call).toContain('We need Go, Kubernetes and Terraform.');

    // The score survives independently of the mutation that produced it (#175).
    const stored = await getMatch(a, resume.id, oppId);
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toEqual(res.json());
  });

  it('a resume never scored against an opportunity has no match report', async () => {
    const { a } = await boot();
    const { resume, oppId } = await setup(a);
    const res = await getMatch(a, resume.id, oppId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });

  it('scoring again for the same pair replaces the report, latest-only (#175)', async () => {
    const { a } = await boot();
    const { resume, oppId } = await setup(a);
    const first = { score: 40, missingKeywords: ['Go'], weakAreas: [], summary: 'Early pass.' };
    vi.mocked(createLanguageModel).mockReturnValue(scoreModel(first));
    await a.request({
      method: 'POST',
      url: `/api/v1/resumes/${resume.id}/match`,
      payload: { opportunityId: oppId },
    });
    const second = { score: 85, missingKeywords: [], weakAreas: [], summary: 'Much better.' };
    vi.mocked(createLanguageModel).mockReturnValue(scoreModel(second));
    await a.request({
      method: 'POST',
      url: `/api/v1/resumes/${resume.id}/match`,
      payload: { opportunityId: oppId },
    });
    const res = await getMatch(a, resume.id, oppId);
    expect(res.json()).toMatchObject({ report: second });
  });

  it('a report is marked stale once a later tailoring session completes (#175)', async () => {
    const { a } = await boot();
    const { resume, oppId, sessionId } = await setup(a);
    const report = { score: 60, missingKeywords: [], weakAreas: [], summary: 'Decent fit.' };
    vi.mocked(createLanguageModel).mockReturnValue(scoreModel(report));
    const scored = await a.request({
      method: 'POST',
      url: `/api/v1/resumes/${resume.id}/match`,
      payload: { opportunityId: oppId },
    });
    expect(scored.json()).toMatchObject({ stale: false });

    const completed = await a.request({
      method: 'POST',
      url: `/api/v1/tailoring/${sessionId}/complete`,
    });
    expect(completed.statusCode).toBe(200);

    const after = await getMatch(a, resume.id, oppId);
    expect(after.json()).toMatchObject({ report, stale: true });
  });

  it('a session completed in the same millisecond as the score is still flagged stale (#294)', async () => {
    const { a } = await boot();
    const { resume, oppId, sessionId } = await setup(a);
    const report = { score: 55, missingKeywords: [], weakAreas: [], summary: 'Tie case.' };
    vi.mocked(createLanguageModel).mockReturnValue(scoreModel(report));
    // Time is pinned for both requests below, not merely left to run its course: scoredAt and
    // acceptedAt are each a separate Date.now() call (matchReports.ts, tailoring.ts), and the
    // bug this reproduces is specifically the case where both land in the exact same
    // millisecond. Relying on two real Date.now() calls to collide is what made the original
    // bug intermittent -- Mikal needed 10 of 18 attempts under load to catch it -- so this
    // forces the tie deterministically instead of hoping for it.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 22, 12, 0, 0));
      const scored = await a.request({
        method: 'POST',
        url: `/api/v1/resumes/${resume.id}/match`,
        payload: { opportunityId: oppId },
      });
      expect(scored.json()).toMatchObject({ stale: false });

      const completed = await a.request({
        method: 'POST',
        url: `/api/v1/tailoring/${sessionId}/complete`,
      });
      expect(completed.statusCode).toBe(200);

      const after = await getMatch(a, resume.id, oppId);
      expect(after.json()).toMatchObject({ report, stale: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('deleting the opportunity cascades to the match report (#175)', async () => {
    const { a, app } = await boot();
    const { resume, oppId } = await setup(a);
    const report = { score: 50, missingKeywords: [], weakAreas: [], summary: 'A fit.' };
    vi.mocked(createLanguageModel).mockReturnValue(scoreModel(report));
    await a.request({
      method: 'POST',
      url: `/api/v1/resumes/${resume.id}/match`,
      payload: { opportunityId: oppId },
    });

    const del = await a.request({ method: 'DELETE', url: `/api/v1/opportunities/${oppId}` });
    expect(del.statusCode).toBe(204);

    const survived = await app.db
      .select()
      .from(resumeMatchReports)
      .where(eq(resumeMatchReports.opportunityId, oppId))
      .all();
    expect(survived).toEqual([]);
  });

  it('match answers 503 when the model output never validates', async () => {
    const { a } = await boot();
    const { resume, oppId } = await setup(a);
    vi.mocked(createLanguageModel).mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: {
          content: [{ type: 'text', text: '{"score": 400}' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: USAGE,
          warnings: [],
        },
      }),
    );
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/resumes/${resume.id}/match`,
      payload: { opportunityId: oppId },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toEqual({ code: 'ai_unavailable', reason: 'invalid_output' });
  });

  describe('isolation', () => {
    const build = () => ({ google: newGoogle() });
    const create = async (c: TestClient) => (await setup(c)).sessionId;
    assertIsolated({
      name: 'tailoring session',
      build: build(),
      create,
      read: (c, id) => c.request({ method: 'GET', url: `/api/v1/tailoring/${id}` }),
    });
    assertIsolated({
      name: 'tailoring completion',
      build: build(),
      create,
      read: (c, id) => c.request({ method: 'POST', url: `/api/v1/tailoring/${id}/complete` }),
    });
    assertIsolated({
      name: 'resume match',
      build: build(),
      create: async (c) => {
        const { resume, oppId } = await setup(c);
        vi.mocked(createLanguageModel).mockReturnValue(
          new MockLanguageModelV4({
            doGenerate: {
              content: [
                {
                  type: 'text',
                  text: '{"score":1,"missingKeywords":[],"weakAreas":[],"summary":"s"}',
                },
              ],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: USAGE,
              warnings: [],
            },
          }),
        );
        return `${resume.id}|${oppId}`;
      },
      read: (c, ids) => {
        const [resumeId, opportunityId] = ids.split('|');
        return c.request({
          method: 'POST',
          url: `/api/v1/resumes/${resumeId}/match`,
          payload: { opportunityId: opportunityId! },
        });
      },
    });
    assertIsolated({
      name: 'resume match report (read)',
      build: build(),
      create: async (c) => {
        const { resume, oppId } = await setup(c);
        return `${resume.id}|${oppId}`;
      },
      read: (c, ids) => {
        const [resumeId, opportunityId] = ids.split('|');
        return getMatch(c, resumeId!, opportunityId!);
      },
    });
  });
});
