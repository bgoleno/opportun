// A demo request still running when its hold on the reset's gate ends writes nothing into the
// account the reset reseeds (https://github.com/bgoleno/opportun/issues/684, sec's triage of qa's
// third pass). A request may spend START_LIMIT_MS before its handler runs and then make an AI call
// of up to AI_CALL_LIMIT_MS, more than the hold's bound: the reset then ran while the call was
// still out, and the handler's writes after it (the call's own task run, a ranking) landed in the
// fresh account. Each demo AI call now also ends when the request's hold is about to, so the
// handler's writes come while it still holds the gate, and the reset replaces them.
import { enqueue } from '../src/lib/jobQueue';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { liveMessage } from '../../../packages/ai/src/anthropicBatch.fixtures';
import { DEMO_SEED_ACK_KEY } from '../src/lib/demo/seed';
import { DEMO_USERS } from '../src/lib/demo/fixture';
import { taskRuns } from '../src/db/schema';
import { runDemoResetGated } from '../src/jobs/demoReset';
import { registerJob, unregisterJob } from '../src/jobs/registry';
import { runDueJobs } from '../src/jobs/runner';
import {
  currentHoldStop,
  DemoResetGate,
  HOLD_LIMIT_MS,
  runWithHoldStop,
} from '../src/lib/demoResetGate';
import { REFERRAL_TASK } from '../src/routes/referrals';
import { testApp } from './helpers';
import { signIn } from './isolation';
import { PATIENCE_MS } from './patience';

afterEach(() => vi.unstubAllGlobals());

const USER1_PASSWORD = 'demo-user1-password-1';

function demoEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    OPPORTUN_MASTER_KEY: randomBytes(32).toString('hex'),
    OPPORTUN_BASE_URL: 'https://demo.example.com',
    DATA_DIR: dataDir,
    OPPORTUN_DEMO: '1',
    [DEMO_SEED_ACK_KEY]: '1',
    OPPORTUN_DEMO_ADMIN_PASSWORD: 'demo-admin-password-1',
    OPPORTUN_DEMO_USER1_PASSWORD: USER1_PASSWORD,
    OPPORTUN_DEMO_USER2_PASSWORD: 'demo-user2-password-1',
    OPPORTUN_DEMO_USER3_PASSWORD: 'demo-user3-password-1',
    OPPORTUN_DEMO_USER4_PASSWORD: 'demo-user4-password-1',
    OPPORTUN_DEMO_AI_KEY: 'sk-ant-made-up-demo-key-0123456789',
  };
}

/**
 * The provider: answers once `answer` resolves (the test resolves it after the reset is done, so
 * the order is the test's, not the scheduler's), or fails when the request's signal aborts.
 */
function heldProvider(answer: Promise<unknown>) {
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      void answer.then(() => resolve());
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason ?? new Error('aborted'));
      });
    });
    return new Response(JSON.stringify(liveMessage(JSON.stringify({ ranking: [] }))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * A demo server with these limits, a signed-in visitor, and a request of theirs that makes an AI
 * call. `send` waits until the call is out. It handles the request from the moment it is sent
 * (`settled`): one the server ends is rejected while the test is waiting for something else, and
 * Vitest fails a run with a rejection nothing handles yet (#939).
 */
async function visitorWithAiCall(limits: {
  holdMs: number;
  aiCallMs: number;
  stopMarginMs: number;
}) {
  const { app, dataDir } = await testApp({ demo: true }, { build: { demoResetLimits: limits } });
  const env = demoEnv(dataDir);
  await runDemoResetGated(app.db, env, undefined);
  const gate = app.jobs.services.demoResetGate;
  if (gate === undefined) throw new Error('a demo server has a reset gate');
  const user1 = DEMO_USERS[1]!;
  const visitor = await signIn(app, user1.email, USER1_PASSWORD);
  const opp = await visitor.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName: 'Hold Deadline Co', title: 'Engineer', sourceKind: 'manual' },
  });
  expect(opp.statusCode, opp.body).toBe(201);
  const contact = await visitor.request({
    method: 'POST',
    url: '/api/v1/network',
    payload: { name: 'Jane Doe', company: 'Hold Deadline Co' },
  });
  expect(contact.statusCode, contact.body).toBe(201);
  const send = async (fetchMock: ReturnType<typeof heldProvider>) => {
    const request = visitor.request({
      method: 'GET',
      url: `/api/v1/opportunities/${(opp.json() as { id: string }).id}/referral-candidates?rank=true`,
    });
    const settled = Promise.allSettled([request]).then(([r]) => r);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: PATIENCE_MS });
    return { settled };
  };
  return { app, env, gate, user1, send };
}

describe('a demo request that outlives its hold writes nothing after the reset (#684)', () => {
  it('its AI call ends before the hold does, so the reset replaces what it wrote', async () => {
    // The hold's bound is shorter than the AI call's own limit, as the start limit plus the AI
    // limit are longer than the hold in production (20 s + 40 s > 50 s), so only the stop (2 s in)
    // can end the call. Seconds from the stop to the bound, as in production (5 s): a busy machine
    // must not reach the bound (#939). The reset waits until after the stop, not until the bound:
    // with no stop it fails there.
    const { app, env, gate, user1, send } = await visitorWithAiCall({
      holdMs: 10_000,
      aiCallMs: 20_000,
      stopMarginMs: 8_000,
    });
    try {
      let resetFinished!: () => void;
      const afterReset = new Promise<void>((r) => (resetFinished = r));
      const fetchMock = heldProvider(afterReset);

      // The ranking request makes its AI call; the reset starts while the call is out.
      const { settled } = await send(fetchMock);
      const runsNow = () =>
        app.db
          .select({ id: taskRuns.id, createdAt: taskRuns.createdAt })
          .from(taskRuns)
          .where(and(eq(taskRuns.userId, user1.id), eq(taskRuns.taskKey, REFERRAL_TASK)))
          .all();
      // What the request wrote, once it has let go of the gate and before the reset replaces it.
      let written: Awaited<ReturnType<typeof runsNow>> = [];
      const exclusive = gate.exclusive.bind(gate);
      vi.spyOn(gate, 'exclusive').mockImplementation((fn, timeoutMs) =>
        exclusive(async () => {
          written = await runsNow();
          return fn();
        }, timeoutMs),
      );
      await runDemoResetGated(app.db, env, gate, { timeoutMs: 8_000 });
      const resetAt = Date.now();
      // Only now may the provider answer: a call still out gets its answer after the reset.
      resetFinished();
      const outcome = await settled;
      // Let anything the handler still had to do run.
      await vi.waitFor(() => expect(gate.held).toBe(0), { timeout: PATIENCE_MS });
      await new Promise((r) => setTimeout(r, 300));

      // Nothing the request wrote is left in the reseeded account, and nothing came after: on main
      // its task run (and its ranking) came after the reset.
      expect(written, 'the task run written before the reset').toHaveLength(1);
      const runs = await runsNow();
      expect(
        runs.filter((r) => r.createdAt >= resetAt || r.id === written[0]!.id),
        'a referral task run that outlived the reset, or was written after it',
      ).toEqual([]);
      // And the client is answered (without a ranking): the stop came in time for its reply.
      expect(outcome, 'the request').toMatchObject({
        status: 'fulfilled',
        value: { statusCode: 200 },
      });
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  }, 40_000);

  it('a request still running at the bound is ended: its client sees the connection closed (#618, #939)', async () => {
    const { app, gate, send } = await visitorWithAiCall({
      holdMs: 2_500,
      aiCallMs: 20_000,
      stopMarginMs: 500,
    });
    try {
      // A provider call that does not end at the stop, as a handler too slow to finish by the
      // bound: it ends when the test says, after the client has seen its connection closed.
      let endCall!: () => void;
      const ended = new Promise<void>((r) => (endCall = r));
      let stopped: AbortSignal | null | undefined;
      const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
        stopped = init?.signal;
        await ended;
        throw init?.signal?.reason ?? new Error('not aborted');
      });
      vi.stubGlobal('fetch', fetchMock);
      const { settled } = await send(fetchMock);
      // The bound gives the gate back with the handler still running, so a reset need not wait for
      // it. The request is rejected meanwhile, with the test waiting for something else.
      await vi.waitFor(() => expect(gate.held).toBe(0), { timeout: PATIENCE_MS });
      expect(await settled).toMatchObject({
        status: 'rejected',
        reason: { code: 'LIGHT_ECONNRESET' },
      });
      expect(stopped?.aborted, 'told to stop before it was ended').toBe(true);
      endCall();
      // The handler's end, with no client left, is nobody's unhandled rejection either.
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  }, 40_000);
});

describe("a hold's stop signal (#684)", () => {
  // The gate's timers only, moved by the test: no wall clock to be late by (#948).
  const handTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  afterEach(() => vi.useRealTimers());

  it('fires the margin before the bound, not at a release, and is what the held work sees', async () => {
    handTimers();
    const gate = new DemoResetGate({ stopMarginMs: 100 });
    const hold = await gate.shared({ limitMs: 300 });
    const done = await gate.shared({ limitMs: 300 });
    done.release();
    expect(done.signal.aborted, 'a release does not abort').toBe(false);
    expect(currentHoldStop()).toBeUndefined();
    const seen = await runWithHoldStop(hold.signal, async () => {
      await new Promise((r) => setImmediate(r));
      return currentHoldStop();
    });
    expect(seen).toBe(hold.signal);
    vi.advanceTimersByTime(199);
    expect(hold.signal.aborted, 'not before the margin').toBe(false);
    vi.advanceTimersByTime(1);
    expect(hold.signal.aborted, 'at the margin').toBe(true);
    expect(hold.ended, 'the hold is still held at the stop').toBe(false);
    vi.advanceTimersByTime(99);
    expect(hold.ended, 'not before the bound').toBe(false);
    vi.advanceTimersByTime(1);
    expect(hold.ended, 'at the bound').toBe(true);
    expect(done.signal.aborted, 'nor does anything after a release').toBe(false);
  });

  it('a margin as long as the hold stops it at once, while it is still held', async () => {
    handTimers();
    const gate = new DemoResetGate({ stopMarginMs: 1_000 });
    const hold = await gate.shared({ limitMs: 500 });
    vi.advanceTimersByTime(0);
    expect(hold.signal.aborted).toBe(true);
    expect(hold.ended).toBe(false);
    vi.advanceTimersByTime(499);
    expect(hold.ended).toBe(false);
  });

  it("a gated job is told to stop (ctx.stopping) at its hold's stop signal, before the bound (tl on #704)", async () => {
    const { app } = await testApp({ demo: true });
    const KIND = 'test.demo_hold_stopping';
    // The stop comes 50 ms in, the bound 50 s in: whatever the job sees while it holds the gate is
    // the signal's doing, however late the host lets it look.
    const gate = new DemoResetGate({ stopMarginMs: HOLD_LIMIT_MS - 50 });
    const seen = { stopped: false, heldThen: -1 };
    try {
      registerJob({
        kind: KIND,
        payloadSchema: z.object({}),
        maxAttempts: 1,
        async run(_db, _payload, ctx) {
          const started = Date.now();
          while (Date.now() - started < PATIENCE_MS) {
            if (ctx.stopping()) {
              seen.stopped = true;
              seen.heldThen = gate.held;
              return;
            }
            await new Promise((r) => setTimeout(r, 10));
          }
        },
      });
      await enqueue(app.db, KIND, {});
      await runDueJobs(app.db, { services: { ...app.jobs.services, demoResetGate: gate } });
      expect(seen.stopped, 'told to stop').toBe(true);
      expect(seen.heldThen, 'while it still holds the gate').toBe(1);
    } finally {
      unregisterJob(KIND);
      await app.close();
    }
  });

  it("a demo job's run sees its hold's stop signal; a job with no hold sees none", async () => {
    const { app } = await testApp({ demo: true });
    const KIND = 'test.demo_hold_stop';
    const seen: (AbortSignal | undefined)[] = [];
    try {
      registerJob({
        kind: KIND,
        payloadSchema: z.object({}),
        maxAttempts: 1,
        async run() {
          seen.push(currentHoldStop());
        },
      });
      // An instance job (no user) holds the gate on a demo server.
      await enqueue(app.db, KIND, {});
      await runDueJobs(app.db, { services: app.jobs.services });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeInstanceOf(AbortSignal);
      expect(seen[0]?.aborted).toBe(false);
      // Off the demo (no gate in the services) there is nothing to stop on.
      await enqueue(app.db, KIND, {});
      await runDueJobs(app.db, { services: {} });
      expect(seen[1]).toBeUndefined();
    } finally {
      unregisterJob(KIND);
      await app.close();
    }
  });
});
