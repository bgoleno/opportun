// The AI trace dashboard's API (FR-T7; design.md 14.7, 14.12;
// https://github.com/bgoleno/opportun/issues/347). Every test inserts its own rows into
// obs_traces and obs_spans: the dashboard reads the tables, not the instrumentation (14.12).
import { newId } from '@opportun/core';
import { afterEach, describe, expect, it } from 'vitest';
import { obsSpans, obsTraces, resumes, tailoringSessions } from '../src/db/schema';
import { writeCollect } from '../src/obs/config';
import { setCollecting } from '../src/obs';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
type App = Awaited<ReturnType<typeof boot>>['app'];

afterEach(async () => {
  await setCollecting(false);
});

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

let seq = 0;
/** A distinct 32-hex trace id or 16-hex span id. */
function hex(len: number): string {
  seq += 1;
  return seq.toString(16).padStart(len, '0');
}

interface SpanIn {
  spanId?: string;
  parentSpanId?: string | null;
  name?: string;
  kind?: 'client' | 'internal' | 'consumer';
  startedAt?: number;
  durationMs?: number;
  status?: 'ok' | 'error';
  errorType?: string | null;
  attributes?: Record<string, unknown>;
  task?: string | null;
  model?: string | null;
  provider?: string | null;
}

interface TraceIn {
  traceId?: string;
  startedAt?: number;
  durationMs?: number;
  origin?: string;
  workflow?: string | null;
  feature?: string | null;
  conversationId?: string | null;
  status?: 'ok' | 'error';
  truncated?: boolean;
  spans?: SpanIn[];
}

/** Inserts one trace and its spans for a user, as the span store would have kept them. */
async function insertTrace(app: App, userId: string, t: TraceIn = {}): Promise<string> {
  const traceId = t.traceId ?? hex(32);
  const startedAt = t.startedAt ?? T0;
  const spans = t.spans ?? [
    { task: 'resume.tailor', model: 'claude-opus-5-5', provider: 'anthropic' },
  ];
  const tasks = [...new Set(spans.flatMap((s) => (s.task ? [s.task] : [])))];
  const models = [...new Set(spans.flatMap((s) => (s.model ? [s.model] : [])))];
  const providers = [...new Set(spans.flatMap((s) => (s.provider ? [s.provider] : [])))];
  await app.db
    .insert(obsTraces)
    .values({
      traceId,
      userId,
      startedAt,
      durationMs: t.durationMs ?? 1000,
      origin: t.origin ?? 'POST /api/v1/tailoring/:id/messages',
      workflow: t.workflow ?? null,
      feature: t.feature ?? 'resumes',
      conversationId: t.conversationId ?? null,
      tasks,
      models,
      providers,
      inputTokens: 100,
      outputTokens: 50,
      estCost: 0.0123,
      spanCount: spans.length,
      errorCount: spans.filter((s) => s.status === 'error').length,
      status: t.status ?? 'ok',
      truncated: t.truncated ?? false,
      updatedAt: startedAt,
    })
    .run();
  for (const s of spans) {
    await app.db
      .insert(obsSpans)
      .values({
        traceId,
        spanId: s.spanId ?? hex(16),
        parentSpanId: s.parentSpanId ?? null,
        userId,
        name: s.name ?? `chat ${s.model ?? 'model'}`,
        kind: s.kind ?? 'client',
        startedAt: s.startedAt ?? startedAt,
        durationMs: s.durationMs ?? 1000,
        status: s.status ?? 'ok',
        errorType: s.errorType ?? null,
        attributes: s.attributes ?? {},
        task: s.task ?? null,
        model: s.model ?? null,
        provider: s.provider ?? null,
      })
      .run();
  }
  return traceId;
}

interface TraceView {
  traceId: string;
  startedAt: number;
  conversationId: string | null;
  tasks: string[];
  status: string;
}

async function list(
  c: TestClient,
  query = '',
): Promise<{ collect: boolean; items: TraceView[]; next: string | null }> {
  const res = await c.request({ method: 'GET', url: `/api/v1/obs/traces${query}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const ids = (r: { items: TraceView[] }) => r.items.map((t) => t.traceId);

describe('GET /obs/traces (FR-T7)', () => {
  it('lists the caller’s traces, newest first, with the figures of each', async () => {
    const { app, b } = await boot();
    const old = await insertTrace(app, b.userId, { startedAt: T0 });
    const recent = await insertTrace(app, b.userId, { startedAt: T0 + HOUR });
    const r = await list(b);
    expect(ids(r)).toEqual([recent, old]);
    expect(r.items[0]).toMatchObject({
      traceId: recent,
      startedAt: T0 + HOUR,
      durationMs: 1000,
      origin: 'POST /api/v1/tailoring/:id/messages',
      feature: 'resumes',
      tasks: ['resume.tailor'],
      models: ['claude-opus-5-5'],
      providers: ['anthropic'],
      inputTokens: 100,
      outputTokens: 50,
      estCostUsd: 0.0123,
      spanCount: 1,
      errorCount: 0,
      status: 'ok',
      truncated: false,
    });
  });

  it('shows each user only their own traces, the admin included', async () => {
    const { app, a, b } = await boot();
    const ofA = await insertTrace(app, a.userId);
    const ofB = await insertTrace(app, b.userId);
    expect(ids(await list(a))).toEqual([ofA]);
    expect(ids(await list(b))).toEqual([ofB]);
  });

  it('says whether collection is on, and still lists what was collected before', async () => {
    const { app, a, b } = await boot();
    const kept = await insertTrace(app, b.userId);
    const off = await list(b);
    expect(off.collect).toBe(false);
    expect(ids(off)).toEqual([kept]);
    await writeCollect(app.db, true, { userId: a.userId });
    expect((await list(b)).collect).toBe(true);
  });

  it('filters by task, model and provider through the trace’s inference spans', async () => {
    const { app, b } = await boot();
    const tailor = await insertTrace(app, b.userId, {
      spans: [{ task: 'resume.tailor', model: 'claude-opus-5-5', provider: 'anthropic' }],
    });
    const both = await insertTrace(app, b.userId, {
      startedAt: T0 + 1,
      spans: [
        { task: 'resume.tailor', model: 'gpt-5', provider: 'openai' },
        { task: 'resume.match', model: 'claude-opus-5-5', provider: 'anthropic' },
      ],
    });
    expect(ids(await list(b, '?task=resume.match'))).toEqual([both]);
    expect(ids(await list(b, '?task=resume.tailor'))).toEqual([both, tailor]);
    expect(ids(await list(b, '?model=gpt-5'))).toEqual([both]);
    expect(ids(await list(b, '?provider=openai'))).toEqual([both]);
    expect(ids(await list(b, '?provider=anthropic'))).toEqual([both, tailor]);
    expect(ids(await list(b, '?task=resume.match&provider=openai'))).toEqual([both]);
    expect(ids(await list(b, '?model=nothing-like-it'))).toEqual([]);
  });

  it('a filter never matches through another user’s spans', async () => {
    const { app, a, b } = await boot();
    await insertTrace(app, a.userId, {
      spans: [{ task: 'resume.match', model: 'gpt-5', provider: 'openai' }],
    });
    const mine = await insertTrace(app, b.userId, { spans: [{ task: 'resume.tailor' }] });
    expect(ids(await list(b, '?task=resume.match'))).toEqual([]);
    expect(ids(await list(b, '?model=gpt-5'))).toEqual([]);
    expect(ids(await list(b))).toEqual([mine]);
  });

  it('a span of another user inside the caller’s trace matches no filter and is not shown', async () => {
    // The span store never writes this (14.6 gives each user's call its own trace), and nothing
    // in the schema forbids it: the span queries' own user scope is what keeps it out.
    const { app, a, b } = await boot();
    const mine = await insertTrace(app, b.userId, { spans: [{ task: 'resume.tailor' }] });
    await app.db
      .insert(obsSpans)
      .values({
        traceId: mine,
        spanId: 'f00000000000000f',
        parentSpanId: null,
        userId: a.userId,
        name: 'chat gpt-5',
        kind: 'client',
        startedAt: T0,
        durationMs: 5,
        status: 'ok',
        attributes: {},
        task: 'resume.match',
        model: 'gpt-5',
        provider: 'openai',
      })
      .run();
    expect(ids(await list(b, '?task=resume.match'))).toEqual([]);
    expect(ids(await list(b, '?provider=openai'))).toEqual([]);
    const filters = (await b.request({ method: 'GET', url: '/api/v1/obs/traces/filters' })).json();
    expect(filters.models).not.toContain('gpt-5');
    const detail = (await b.request({ method: 'GET', url: `/api/v1/obs/traces/${mine}` })).json();
    expect(detail.spans.map((s: { spanId: string }) => s.spanId)).not.toContain('f00000000000000f');
  });

  it('filters by status, time range and conversation', async () => {
    const { app, b } = await boot();
    const conv = newId();
    const failed = await insertTrace(app, b.userId, { startedAt: T0, status: 'error' });
    const turn1 = await insertTrace(app, b.userId, { startedAt: T0 + HOUR, conversationId: conv });
    const turn2 = await insertTrace(app, b.userId, {
      startedAt: T0 + 2 * HOUR,
      conversationId: conv,
    });
    const later = await insertTrace(app, b.userId, { startedAt: T0 + 3 * HOUR });
    expect(ids(await list(b, '?status=error'))).toEqual([failed]);
    expect(ids(await list(b, '?status=ok'))).toEqual([later, turn2, turn1]);
    expect(ids(await list(b, `?from=${T0 + HOUR}&to=${T0 + 2 * HOUR}`))).toEqual([turn2, turn1]);
    expect(ids(await list(b, `?from=${T0 + 3 * HOUR}`))).toEqual([later]);
    expect(ids(await list(b, `?to=${T0}`))).toEqual([failed]);
    expect(ids(await list(b, `?conversation=${conv}`))).toEqual([turn2, turn1]);
  });

  it('binds filter values: a value shaped like SQL matches nothing and leaks nothing', async () => {
    const { app, a, b } = await boot();
    await insertTrace(app, a.userId);
    await insertTrace(app, b.userId);
    for (const q of [
      `?model=${encodeURIComponent("x' OR '1'='1")}`,
      `?conversation=${encodeURIComponent("x' OR 1=1 --")}`,
      `?task=${encodeURIComponent("resume.tailor' OR 1=1 --")}`,
    ]) {
      const res = await b.request({ method: 'GET', url: `/api/v1/obs/traces${q}` });
      // Refused by the schema, or matched as a plain value: either way nothing comes back.
      if (res.statusCode === 200) expect(res.json().items, q).toEqual([]);
      else expect(res.statusCode, q).toBe(400);
    }
  });

  it('pages with a cursor, never repeating or skipping a trace', async () => {
    const { app, b } = await boot();
    const made: string[] = [];
    // Three share a start time, and with pages of two the first page ends inside that tie: the
    // cursor must break it by id, or the rest of the tie is skipped (tl on #361).
    for (const at of [T0, T0 + 1, T0 + 1, T0 + 1, T0 + 2])
      made.push(await insertTrace(app, b.userId, { startedAt: at }));
    const seen: string[] = [];
    let next: string | null = null;
    do {
      const page = await list(
        b,
        `?limit=2${next === null ? '' : `&cursor=${encodeURIComponent(next)}`}`,
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...ids(page));
      next = page.next;
    } while (next !== null);
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(made));
    // In the same order as one unpaged list.
    expect(seen).toEqual(ids(await list(b)));
  });

  it('refuses a malformed cursor, time or status', async () => {
    const { b } = await boot();
    for (const q of [
      '?cursor=nope',
      '?from=yesterday',
      '?status=maybe',
      '?limit=0',
      '?limit=1000',
    ]) {
      const res = await b.request({ method: 'GET', url: `/api/v1/obs/traces${q}` });
      expect(res.statusCode, q).toBe(400);
    }
  });

  it('needs a signed-in user', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'GET', url: '/api/v1/obs/traces' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /obs/traces/filters (FR-T7)', () => {
  it('offers the tasks, models and providers of the caller’s own spans only', async () => {
    const { app, a, b } = await boot();
    await insertTrace(app, a.userId, {
      spans: [{ task: 'resume.match', model: 'secret-model-of-a', provider: 'openai' }],
    });
    await insertTrace(app, b.userId, {
      spans: [
        { task: 'resume.tailor', model: 'claude-opus-5-5', provider: 'anthropic' },
        { task: 'resume.tailor', model: 'claude-haiku-5-5', provider: 'anthropic' },
        { name: 'POST', kind: 'internal' },
      ],
    });
    const res = await b.request({ method: 'GET', url: '/api/v1/obs/traces/filters' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      tasks: ['resume.tailor'],
      models: ['claude-haiku-5-5', 'claude-opus-5-5'],
      providers: ['anthropic'],
    });
  });
});

async function insertSession(
  app: App,
  userId: string,
): Promise<{ sessionId: string; resumeId: string }> {
  const resumeId = newId();
  const sessionId = newId();
  const now = Date.now();
  await app.db
    .insert(resumes)
    .values({
      id: resumeId,
      userId,
      kind: 'tailored',
      title: 'A resume',
      store: 'local_file',
      docRef: 'r.md',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await app.db
    .insert(tailoringSessions)
    .values({ id: sessionId, userId, resumeId, createdAt: now, updatedAt: now })
    .run();
  return { sessionId, resumeId };
}

describe('GET /obs/traces/:traceId (FR-T7)', () => {
  const ROOT = 'a000000000000001';
  const CHILD = 'a000000000000002';
  const GRANDCHILD = 'a000000000000003';

  it('returns every span with its parent, ordered by start', async () => {
    const { app, b } = await boot();
    const traceId = await insertTrace(app, b.userId, {
      workflow: 'capture',
      spans: [
        {
          spanId: GRANDCHILD,
          parentSpanId: CHILD,
          name: 'POST',
          startedAt: T0 + 20,
          durationMs: 300,
        },
        {
          spanId: ROOT,
          parentSpanId: null,
          name: 'invoke_workflow capture',
          kind: 'internal',
          startedAt: T0,
          durationMs: 1000,
        },
        {
          spanId: CHILD,
          parentSpanId: ROOT,
          name: 'chat claude-opus-5-5',
          startedAt: T0 + 10,
          durationMs: 500,
          task: 'capture.extract',
        },
      ],
    });
    const res = await b.request({ method: 'GET', url: `/api/v1/obs/traces/${traceId}` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.trace).toMatchObject({ traceId, workflow: 'capture' });
    expect(
      body.spans.map((s: { spanId: string; parentSpanId: string | null }) => [
        s.spanId,
        s.parentSpanId,
      ]),
    ).toEqual([
      [ROOT, null],
      [CHILD, ROOT],
      [GRANDCHILD, CHILD],
    ]);
    expect(body.spans[1]).toMatchObject({
      name: 'chat claude-opus-5-5',
      kind: 'client',
      startedAt: T0 + 10,
      durationMs: 500,
      task: 'capture.extract',
    });
  });

  it('is not found for another user’s trace, the admin included', async () => {
    const { app, a, b } = await boot();
    const ofB = await insertTrace(app, b.userId);
    const ofA = await insertTrace(app, a.userId);
    expect((await a.request({ method: 'GET', url: `/api/v1/obs/traces/${ofB}` })).statusCode).toBe(
      404,
    );
    expect((await b.request({ method: 'GET', url: `/api/v1/obs/traces/${ofA}` })).statusCode).toBe(
      404,
    );
    expect((await b.request({ method: 'GET', url: `/api/v1/obs/traces/${ofB}` })).statusCode).toBe(
      200,
    );
  });

  it('refuses a trace id that is not 32 hex digits', async () => {
    const { b } = await boot();
    const res = await b.request({
      method: 'GET',
      url: `/api/v1/obs/traces/${encodeURIComponent("x' OR 1=1")}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('shows only catalogued attributes, and never a row id', async () => {
    const { app, b } = await boot();
    const traceId = await insertTrace(app, b.userId, {
      spans: [
        {
          attributes: {
            'http.request.method': 'POST',
            'http.response.status_code': 200,
            'opportun.outbound.target': 'anthropic',
            // Row ids are local only and say nothing a reader needs: not displayed (tl on #347).
            'user.id': b.userId,
            'opportun.ai.prompt.id': newId(),
            'gen_ai.conversation.id': newId(),
            // Not in the catalog: an older row, or one written around the gate, is not shown.
            'gen_ai.input.messages': 'Dear Jane Doe, jane@example.com',
            'some.unknown.key': 'x',
          },
        },
      ],
    });
    const body = (await b.request({ method: 'GET', url: `/api/v1/obs/traces/${traceId}` })).json();
    expect(body.spans[0].attributes).toEqual({
      'http.request.method': 'POST',
      'http.response.status_code': 200,
      'opportun.outbound.target': 'anthropic',
    });
    expect(JSON.stringify(body)).not.toContain('jane@example.com');
  });

  it('names the prompt a span used by its task and version, never by its id', async () => {
    const { app, b } = await boot();
    const promptId = newId();
    const traceId = await insertTrace(app, b.userId, {
      spans: [
        {
          spanId: ROOT,
          task: 'resume.tailor',
          attributes: {
            'gen_ai.prompt.name': 'resume.tailor',
            'gen_ai.prompt.version': 3,
            'opportun.ai.prompt.id': promptId,
          },
        },
        // A name that is not a task key, or a version that is not a whole number, is no prompt.
        {
          spanId: CHILD,
          attributes: { 'gen_ai.prompt.name': 'Dear Jane', 'gen_ai.prompt.version': 1 },
        },
        {
          spanId: GRANDCHILD,
          attributes: { 'gen_ai.prompt.name': 'resume.tailor', 'gen_ai.prompt.version': 'v1' },
        },
      ],
    });
    const body = (await b.request({ method: 'GET', url: `/api/v1/obs/traces/${traceId}` })).json();
    const byId = new Map(body.spans.map((s: { spanId: string }) => [s.spanId, s]));
    expect(byId.get(ROOT)).toMatchObject({ prompt: { name: 'resume.tailor', version: 3 } });
    expect(byId.get(CHILD)).toMatchObject({ prompt: null });
    expect(byId.get(GRANDCHILD)).toMatchObject({
      prompt: { name: 'resume.tailor', version: null },
    });
    expect(JSON.stringify(body)).not.toContain(promptId);
  });

  it('links a chat trace to the caller’s own tailoring session, through its resume', async () => {
    const { app, a, b } = await boot();
    const mine = await insertSession(app, b.userId);
    const theirs = await insertSession(app, a.userId);
    const linked = await insertTrace(app, b.userId, { conversationId: mine.sessionId });
    // A conversation id that is not the caller's own session links nowhere.
    const foreign = await insertTrace(app, b.userId, { conversationId: theirs.sessionId });
    const gone = await insertTrace(app, b.userId, { conversationId: newId() });
    const get = async (id: string) =>
      (await b.request({ method: 'GET', url: `/api/v1/obs/traces/${id}` })).json();
    expect((await get(linked)).conversation).toEqual({
      id: mine.sessionId,
      resumeId: mine.resumeId,
    });
    expect((await get(foreign)).conversation).toBeNull();
    expect((await get(gone)).conversation).toBeNull();
  });
});
