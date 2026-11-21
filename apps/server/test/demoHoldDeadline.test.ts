// A demo request still running when its hold on the reset's gate ends writes nothing into the
// account the reset reseeds (https://github.com/bgoleno/opportun/issues/684, sec's triage of qa's
// third pass). A request may spend START_LIMIT_MS before its handler runs and then make an AI call
// of up to AI_CALL_LIMIT_MS, more than the hold's bound: the reset then ran while the call was
// still out, and the handler's writes after it (the call's own task run, a ranking) landed in the
// fresh account. Each demo AI call now also ends when the request's hold is about to, so the
// handler's writes come while it still holds the gate, and the reset replaces them.
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { liveMessage } from '../../../packages/ai/src/anthropicBatch.fixtures';
import { DEMO_SEED_ACK_KEY } from '../src/cli/seedDemo';
import { DEMO_USERS } from '../src/cli/seedDemoFixture';
import { taskRuns } from '../src/db/schema';
import { runDemoResetGated } from '../src/jobs/demoReset';
import { registerJob, unregisterJob } from '../src/jobs/registry';
import { enqueue, runDueJobs } from '../src/jobs/runner';
import { currentHoldStop, DemoResetGate, runWithHoldStop } from '../src/lib/demoResetGate';
import { REFERRAL_TASK } from '../src/routes/referrals';
import { testApp } from './helpers';
import { signIn } from './isolation';

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

describe('a demo request that outlives its hold writes nothing after the reset (#684)', () => {
  it('its AI call ends before the hold does, so the reset replaces what it wrote', async () => {
    // The hold's bound is shorter than the AI call's own limit, as the start limit plus the AI
    // limit are longer than the hold in production (20 s + 40 s > 50 s).
    const { app, dataDir } = await testApp(
      { demo: true },
      { build: { demoResetLimits: { holdMs: 600, aiCallMs: 3_000, stopMarginMs: 150 } } },
    );
    try {
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
      let resetFinished!: () => void;
      const afterReset = new Promise<void>((r) => (resetFinished = r));
      const fetchMock = heldProvider(afterReset);

      // The ranking request makes its AI call; the reset starts while the call is out.
      const ranking = visitor.request({
        method: 'GET',
        url: `/api/v1/opportunities/${(opp.json() as { id: string }).id}/referral-candidates?rank=true`,
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 2_000 });
      await runDemoResetGated(app.db, env, gate, { timeoutMs: 5_000 });
      const resetAt = Date.now();
      // Only now may the provider answer: a call still out gets its answer after the reset.
      resetFinished();
      await Promise.allSettled([ranking]);
      // Let anything the handler still had to do run.
      await vi.waitFor(() => expect(gate.held).toBe(0), { timeout: 5_000 });
      await new Promise((r) => setTimeout(r, 300));

      // Nothing the request wrote is left in the reseeded account: on main its task run (and
      // its ranking) came after the reset.
      const runs = await app.db
        .select({ createdAt: taskRuns.createdAt })
        .from(taskRuns)
        .where(and(eq(taskRuns.userId, user1.id), eq(taskRuns.taskKey, REFERRAL_TASK)))
        .all();
      expect(
        runs.filter((r) => r.createdAt >= resetAt),
        'a referral task run written after the reset',
      ).toEqual([]);
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  }, 20_000);
});

describe("a hold's stop signal (#684)", () => {
  it('fires the margin before the bound, not at a release, and is what the held work sees', async () => {
    const gate = new DemoResetGate({ stopMarginMs: 100 });
    const hold = await gate.shared({ limitMs: 300 });
    const done = await gate.shared({ limitMs: 300 });
    done.release();
    expect(done.signal.aborted, 'a release does not abort').toBe(false);
    expect(currentHoldStop()).toBeUndefined();
    const seen = await runWithHoldStop(hold.signal, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return currentHoldStop();
    });
    expect(seen).toBe(hold.signal);
    const started = Date.now();
    await new Promise<void>((r) => hold.signal.addEventListener('abort', () => r()));
    const at = Date.now() - started;
    expect(at).toBeGreaterThanOrEqual(150);
    expect(at).toBeLessThan(280);
    expect(hold.ended, 'the hold is still held at the stop').toBe(false);
    await vi.waitFor(() => expect(hold.ended).toBe(true));
  });

  it('with no margin left, the stop comes with the bound', async () => {
    const gate = new DemoResetGate({ stopMarginMs: 1_000 });
    const hold = await gate.shared({ limitMs: 50 });
    await vi.waitFor(() => expect(hold.signal.aborted).toBe(true), { timeout: 500 });
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
