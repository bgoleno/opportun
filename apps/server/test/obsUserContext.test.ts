// The user in the context (design.md 14.6; https://github.com/bgoleno/opportun/issues/343): the
// HTTP plugin and the job runner put the request's or the job's user in the context, under the
// key packages/ai defines, so the AI router can tell a call for the same user (a child span) from
// one for another (a new trace). The user goes on the span's parent, not on an outer context, so
// a job always starts from the root: it never inherits the caller's span or user.
import { context, ROOT_CONTEXT, trace, type Context } from '@opentelemetry/api';
import { USER_CONTEXT_KEY, userInContext } from '@opportun/ai';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { jobs } from '../src/db/schema';
import { registerJob, unregisterJob } from '../src/jobs/registry';
import { enqueue, runDueJobs } from '../src/jobs/runner';
import { obs, setCollecting } from '../src/obs';
import { obsHttpPlugin } from '../src/plugins/obsHttp';
import { useApi } from './api';
import { useInMemoryTracing } from './otelProvider';

const boot = useApi();
const exporter = useInMemoryTracing();

interface Seen {
  user: string | undefined;
  spanId: string | undefined;
}
const seen: Seen[] = [];
function look(): void {
  seen.push({ user: userInContext(), spanId: trace.getActiveSpan()?.spanContext().spanId });
}

const KIND = 'test.obs-user-ctx';
registerJob({
  kind: KIND,
  payloadSchema: z.object({}),
  maxAttempts: 1,
  run: async () => {
    // After an await too: the context must hold for the whole handler.
    await new Promise((r) => setImmediate(r));
    look();
  },
});

const bare: FastifyInstance[] = [];
afterEach(async () => {
  seen.length = 0;
  await setCollecting(false);
  await Promise.all(bare.splice(0).map((s) => s.close()));
});
afterAll(() => unregisterJob(KIND));

/** Another user's request span, active around the runner, which a job must not inherit. */
function insideSomeoneElsesSpan<T>(fn: () => Promise<T>): Promise<T> {
  const s = obs.startSpan('http.server', { 'http.request.method': 'GET', 'http.route': '/x' });
  const ctx: Context = s.context.setValue(USER_CONTEXT_KEY, 'someone-else');
  return context.with(ctx, fn).finally(() => s.end());
}

describe('the job runner puts the job user in the context (#343, 14.6)', () => {
  it("a user's job: its user, in a new trace, whatever the caller's context holds", async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    await enqueue(app.db, KIND, {}, { userId: a.userId });
    await insideSomeoneElsesSpan(() => runDueJobs(app.db));
    expect(seen.map((s) => s.user)).toEqual([a.userId]);
    const [span] = exporter.getFinishedSpans().filter((s) => s.name === `job ${KIND}`);
    expect(seen[0]?.spanId).toBe(span?.spanContext().spanId);
    expect(span?.parentSpanContext).toBeUndefined();
  });

  it('an instance job: no user, even inside a request of a user', async () => {
    const { app } = await boot();
    await setCollecting(true);
    await enqueue(app.db, KIND, {});
    await insideSomeoneElsesSpan(() => runDueJobs(app.db));
    expect(seen.map((s) => s.user)).toEqual([undefined]);
  });

  it("a continued job: its user, and the stored trace's span as the parent", async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    const TRACE = '0af7651916cd43dd8448eb211c80319c';
    const SPAN = 'b7ad6b7169203331';
    const id = await enqueue(app.db, KIND, {}, { userId: a.userId });
    await app.db
      .update(jobs)
      .set({ traceContext: `00-${TRACE}-${SPAN}-01` })
      .where(eq(jobs.id, id))
      .run();
    await runDueJobs(app.db);
    expect(seen.map((s) => s.user)).toEqual([a.userId]);
    const [span] = exporter.getFinishedSpans().filter((s) => s.name === `job ${KIND}`);
    expect(span?.spanContext().traceId).toBe(TRACE);
    expect(span?.parentSpanContext?.spanId).toBe(SPAN);
  });

  it('with collection off: one check, nothing added to the context', async () => {
    const { app, a } = await boot();
    await enqueue(app.db, KIND, {}, { userId: a.userId });
    await runDueJobs(app.db);
    expect(seen).toEqual([{ user: undefined, spanId: undefined }]);
  });
});

/**
 * The plugin, then hooks registered after it that resolve the user the way the session plugin
 * (async onRequest, after a lookup) and a connector route's device auth (route onRequest) do.
 */
async function server(): Promise<FastifyInstance> {
  const s = Fastify();
  bare.push(s);
  await s.register(obsHttpPlugin);
  s.decorateRequest('userCtx', null);
  s.decorateRequest('deviceCtx', null);
  s.addHook('onRequest', async (req) => {
    await new Promise((r) => setImmediate(r)); // the session lookup's await
    const user = req.headers['x-test-user'];
    req.userCtx = typeof user === 'string' ? { userId: user, isAdmin: false } : null;
  });
  const handler = async () => {
    look();
    return { ok: true };
  };
  s.post('/api/v1/who', handler);
  s.post(
    '/api/v1/device/who',
    {
      onRequest: async (req) => {
        await new Promise((r) => setImmediate(r));
        req.deviceCtx = { userId: 'device-user', isAdmin: false, tokenId: 't', scopes: [] };
      },
    },
    handler,
  );
  s.post('/api/v1/request-context', async (req) => {
    seen.push({
      user: req.obsContext === null ? undefined : userInContext(req.obsContext),
      spanId: undefined,
    });
    return { ok: true };
  });
  await s.ready();
  return s;
}

describe('the HTTP plugin puts the request user in the context (#343, 14.6)', () => {
  it('a signed-in request: its user, set after the session lookup, in the request span', async () => {
    await boot();
    await setCollecting(true);
    const s = await server();
    const res = await s.inject({
      method: 'POST',
      url: '/api/v1/who',
      headers: { 'x-test-user': 'user-1' },
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(200);
    const server_ = exporter.getFinishedSpans().find((x) => x.name.startsWith('POST'));
    expect(seen).toEqual([{ user: 'user-1', spanId: server_?.spanContext().spanId }]);
  });

  it('a device-token request: the token user', async () => {
    await boot();
    await setCollecting(true);
    const s = await server();
    await s.inject({ method: 'POST', url: '/api/v1/device/who', payload: {} });
    expect(seen.map((x) => x.user)).toEqual(['device-user']);
  });

  it('a request nobody signed in to: no user', async () => {
    await boot();
    await setCollecting(true);
    const s = await server();
    await s.inject({ method: 'POST', url: '/api/v1/who', payload: {} });
    expect(seen.map((x) => x.user)).toEqual([undefined]);
  });

  it('request.obsContext carries the user too, for a handler that passes it on', async () => {
    await boot();
    await setCollecting(true);
    const s = await server();
    await s.inject({
      method: 'POST',
      url: '/api/v1/request-context',
      headers: { 'x-test-user': 'user-2' },
      payload: {},
    });
    expect(seen.map((x) => x.user)).toEqual(['user-2']);
  });

  it('with collection off: nothing added to the context', async () => {
    await boot();
    const s = await server();
    await s.inject({
      method: 'POST',
      url: '/api/v1/who',
      headers: { 'x-test-user': 'user-1' },
      payload: {},
    });
    expect(seen).toEqual([{ user: undefined, spanId: undefined }]);
  });
});

// A context made by hand stays usable: the key is the package's, not a copy.
it('the key is the one @opportun/ai reads', () => {
  expect(userInContext(ROOT_CONTEXT.setValue(USER_CONTEXT_KEY, 'u'))).toBe('u');
});
