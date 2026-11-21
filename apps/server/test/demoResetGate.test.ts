// The demo reset's gate (https://github.com/bgoleno/opportun/issues/618, criterion 4; tl's design
// on #618): a write from a request, a device token or a job that began before the nightly reset
// never lands in the account the reset reseeds under the same pinned id. Each case parks the
// other side at a race point, so the order is the test's, not the scheduler's.
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEMO_SEED_ACK_KEY } from '../src/cli/seedDemo';
import { DEMO_USERS } from '../src/cli/seedDemoFixture';
import { deviceTokens, jobs, opportunities, users } from '../src/db/schema';
import { runDemoResetGated } from '../src/jobs/demoReset';
import { registerJob, unregisterJob } from '../src/jobs/registry';
import { enqueue, runDueJobs } from '../src/jobs/runner';
import { DemoResetGate, DemoResetGateTimeout } from '../src/lib/demoResetGate';
import { racePoint, setRaceHook } from '../src/lib/racePoints';
import { testApp } from './helpers';
import { signIn, type TestClient } from './isolation';

afterEach(() => setRaceHook(undefined));

const PASSWORDS = {
  admin: 'demo-admin-password-1',
  user1: 'demo-user1-password-1',
} as const;

function demoEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    OPPORTUN_MASTER_KEY: randomBytes(32).toString('hex'),
    OPPORTUN_BASE_URL: 'https://demo.example.com',
    DATA_DIR: dataDir,
    OPPORTUN_DEMO: '1',
    [DEMO_SEED_ACK_KEY]: '1',
    OPPORTUN_DEMO_ADMIN_PASSWORD: PASSWORDS.admin,
    OPPORTUN_DEMO_USER1_PASSWORD: PASSWORDS.user1,
    OPPORTUN_DEMO_USER2_PASSWORD: 'demo-user2-password-1',
    OPPORTUN_DEMO_USER3_PASSWORD: 'demo-user3-password-1',
    OPPORTUN_DEMO_USER4_PASSWORD: 'demo-user4-password-1',
    OPPORTUN_DEMO_AI_KEY: 'sk-test-demo-key',
  };
}

/**
 * A point the test holds closed until it says so, and knows when something reached it. It also
 * notes whether the reset got inside the gate (demo.reset.locked), which is the order these tests
 * are about: timing alone (seedDemo's hashing takes a while) proves nothing.
 */
function parkAt(name: string) {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const arrived = new Promise<void>((r) => (reached = r));
  const seen = { resetInside: false };
  return {
    hook: async (point: string) => {
      if (point === 'demo.reset.locked') seen.resetInside = true;
      if (point !== name) return;
      reached();
      await gate;
    },
    arrived,
    seen,
    release: () => release(),
  };
}

/** Lets every pending callback run, so a promise that can settle has settled. */
const settle = () => new Promise((r) => setTimeout(r, 30));

/** Whether a promise has settled yet. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await settle();
  return done;
}

/** A demo server, seeded, with demo-user1 signed in: a shared account. */
async function seededDemo(limits?: { startMs?: number; holdMs?: number }) {
  const { app, dataDir } = await testApp(
    { demo: true },
    limits === undefined ? {} : { build: { demoResetLimits: limits } },
  );
  const env = demoEnv(dataDir);
  await runDemoResetGated(app.db, env, undefined);
  const gate = app.jobs.services.demoResetGate;
  if (gate === undefined) throw new Error('a demo server has a reset gate');
  const user1 = DEMO_USERS[1]!;
  const visitor = await signIn(app, user1.email, PASSWORDS.user1);
  return { app, env, gate, visitor, userId: user1.id };
}

/** A company no seeded account has, so each opportunity made here makes it new. */
const NEW_COMPANY = 'Gate Test Company';

const opportunityNamed = (title: string) => ({
  method: 'POST' as const,
  url: '/api/v1/opportunities',
  payload: { companyName: NEW_COMPANY, title, sourceKind: 'manual' },
});

describe('DemoResetGate', () => {
  it('the exclusive side waits for every holder, and new holders wait behind it', async () => {
    const gate = new DemoResetGate();
    const first = await gate.shared();
    let ran = false;
    const reset = gate.exclusive(async () => {
      ran = true;
    });
    expect(await settled(reset)).toBe(false);
    // Writer-preferring: a holder arriving now waits for the reset, not the other way round.
    const late = gate.shared();
    expect(await settled(late)).toBe(false);
    first.release();
    await reset;
    expect(ran).toBe(true);
    (await late).release();
    expect(gate.held).toBe(0);
  });

  it('a retained hold is given back only when every reference is released, once each', async () => {
    const gate = new DemoResetGate();
    const hold = await gate.shared();
    const kept = hold.retain()!;
    hold.release();
    hold.release();
    expect(gate.held).toBe(1);
    kept.release();
    expect(gate.held).toBe(0);
  });

  it('a hold given back stays given back: retain() then refuses, and the count never goes below 0', async () => {
    const gate = new DemoResetGate();
    const hold = await gate.shared();
    hold.release();
    expect(hold.ended).toBe(true);
    expect(hold.retain()).toBeNull();
    hold.release();
    expect(gate.held).toBe(0);
    // The gate still works for the next holder and the next reset.
    const next = await gate.shared();
    expect(gate.held).toBe(1);
    next.release();
    await gate.exclusive(async () => undefined, 20);
  });

  it('a hold never released is given back at its bound, and its holder is told', async () => {
    const gate = new DemoResetGate();
    let told = false;
    const hold = await gate.shared({ limitMs: 20, onExpire: () => (told = true) });
    let ran = false;
    await gate.exclusive(async () => {
      ran = true;
    }, 2_000);
    expect(ran).toBe(true);
    expect(told).toBe(true);
    expect(hold.ended).toBe(true);
    expect(hold.retain()).toBeNull();
    expect(gate.held).toBe(0);
  });

  it('a holder that never leaves makes the reset time out, running nothing, and lets holders in again', async () => {
    const gate = new DemoResetGate();
    await gate.shared();
    let ran = false;
    await expect(
      gate.exclusive(async () => {
        ran = true;
      }, 20),
    ).rejects.toBeInstanceOf(DemoResetGateTimeout);
    expect(ran).toBe(false);
    expect(await settled(gate.shared())).toBe(true);
  });
});

describe('the reset waits for a request already in, and a request that comes during it waits too', () => {
  it('a request parked mid-handler: the reset waits, the request completes, then the reset runs', async () => {
    const { app, env, gate, visitor, userId } = await seededDemo();
    try {
      // Parked outside any transaction (after its password check, before its insert), so only the
      // gate, not the database, can hold the reset back.
      const park = parkAt('deviceTokens.create.passwordChecked');
      setRaceHook(park.hook);
      const request = visitor.request({
        method: 'POST',
        url: '/api/v1/device-tokens',
        payload: { name: 'Chrome', scopes: ['capture:push'], password: PASSWORDS.user1 },
      });
      await park.arrived;
      const reset = runDemoResetGated(app.db, env, gate);
      expect(await settled(reset)).toBe(false);
      expect(park.seen.resetInside, 'the reset waits outside the gate').toBe(false);
      park.release();
      // It finished in the account it started in...
      expect((await request).statusCode).toBe(201);
      await reset;
      // ...and its token went with that account: none in the reseeded one.
      expect(
        await app.db.select().from(deviceTokens).where(eq(deviceTokens.userId, userId)).all(),
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('a request that arrives while the reset holds the gate waits, then finds its session gone (401)', async () => {
    const { app, env, gate, visitor } = await seededDemo();
    try {
      const park = parkAt('demo.reset.locked');
      setRaceHook(park.hook);
      const reset = runDemoResetGated(app.db, env, gate);
      await park.arrived;
      const request = visitor.request(opportunityNamed('Sent during the reset'));
      expect(await settled(request)).toBe(false);
      park.release();
      await reset;
      expect((await request).statusCode).toBe(401);
      const written = await app.db
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(eq(opportunities.title, 'Sent during the reset'))
        .all();
      expect(written).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('a request with no session or token does not wait for the reset', async () => {
    const { app, env, gate } = await seededDemo();
    try {
      const park = parkAt('demo.reset.locked');
      setRaceHook(park.hook);
      const reset = runDemoResetGated(app.db, env, gate);
      await park.arrived;
      const health = app.inject({ method: 'GET', url: '/healthz' });
      expect(await settled(health)).toBe(true);
      park.release();
      await reset;
    } finally {
      await app.close();
    }
  });

  it('a holder that never leaves makes the reset fail without reseeding', async () => {
    const { app, env, gate, visitor, userId } = await seededDemo();
    try {
      const made = await visitor.request(opportunityNamed('Kept: the reset did not run'));
      expect(made.statusCode).toBe(201);
      const before = await app.db.select().from(users).where(eq(users.id, userId)).get();
      const stuck = await gate.shared();
      await expect(runDemoResetGated(app.db, env, gate, { timeoutMs: 20 })).rejects.toBeInstanceOf(
        DemoResetGateTimeout,
      );
      stuck.release();
      expect(await app.db.select().from(users).where(eq(users.id, userId)).get()).toEqual(before);
      const kept = await app.db
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(eq(opportunities.title, 'Kept: the reset did not run'))
        .all();
      expect(kept).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe("a shared account's job and the reset", () => {
  const KIND = 'test.demo_reset_write';
  /** Writes an opportunity for the job's user: a job's write, as gmail.sync's or a drain's is. */
  function registerWriter(onRun: () => void = () => {}) {
    registerJob({
      kind: KIND,
      payloadSchema: z.object({ title: z.string() }),
      maxAttempts: 1,
      async run(db, payload: { title: string }, ctx) {
        onRun();
        // Outside any transaction, so only the gate can hold the reset back here.
        await racePoint('test.demo_reset_write.parked');
        const { createOpportunity } = await import('../src/repos/opportunities');
        await createOpportunity(
          db,
          { userId: ctx.userId!, isAdmin: false },
          {
            companyName: NEW_COMPANY,
            title: payload.title,
            sourceKind: 'manual',
          },
        );
      },
    });
  }
  afterEach(() => unregisterJob(KIND));

  it('a job parked inside its run: the reset waits for it, then runs', async () => {
    const { app, env, gate, userId } = await seededDemo();
    try {
      registerWriter();
      await enqueue(app.db, KIND, { title: 'A job before the reset' }, { userId });
      const park = parkAt('test.demo_reset_write.parked');
      setRaceHook(park.hook);
      const drain = runDueJobs(app.db, { services: app.jobs.services });
      await park.arrived;
      const reset = runDemoResetGated(app.db, env, gate);
      expect(await settled(reset)).toBe(false);
      expect(park.seen.resetInside, 'the reset waits outside the gate').toBe(false);
      park.release();
      await drain;
      await reset;
      expect(park.seen.resetInside).toBe(true);
      const left = await app.db
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(eq(opportunities.title, 'A job before the reset'))
        .all();
      expect(left).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('a job claimed before the reset, run after it, is discarded: its run never starts', async () => {
    const { app, env, gate, userId } = await seededDemo();
    try {
      let ran = false;
      registerWriter(() => (ran = true));
      await enqueue(app.db, KIND, { title: 'Claimed before the reset' }, { userId });
      const park = parkAt('demo.reset.locked');
      setRaceHook(park.hook);
      const reset = runDemoResetGated(app.db, env, gate);
      await park.arrived;
      // Claimed now, while the reset holds the gate: it waits for it.
      const drain = runDueJobs(app.db, { services: app.jobs.services });
      expect(await settled(drain)).toBe(false);
      park.release();
      await reset;
      await drain;
      expect(ran).toBe(false);
      const written = await app.db
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(eq(opportunities.title, 'Claimed before the reset'))
        .all();
      expect(written).toEqual([]);
      // Its row went with the old account, and nothing put it back.
      expect(await app.db.select().from(jobs).where(eq(jobs.kind, KIND)).all()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('off the demo there is no gate, and a job runs as before', async () => {
    const { app } = await testApp({ demo: false });
    try {
      expect(app.jobs.services.demoResetGate).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('no request holds the gate past the reset, whatever its client does', () => {
  /** A signed-in request over a real socket, which the test can abort. */
  async function overSocket(
    app: Awaited<ReturnType<typeof seededDemo>>['app'],
    visitor: TestClient,
  ) {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const abort = new AbortController();
    const response = fetch(`${address}/api/v1/device-tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': visitor.csrf,
        cookie: `opportun_session=${visitor.session}; opportun_csrf=${visitor.csrf}`,
      },
      body: JSON.stringify({ name: 'Chrome', scopes: ['capture:push'], password: PASSWORDS.user1 }),
      signal: abort.signal,
    }).catch(() => undefined);
    return { abort: () => abort.abort(), response, address };
  }

  it('a request whose client goes away while waiting for the reset gives its place back', async () => {
    const { app, env, gate, visitor } = await seededDemo();
    try {
      // Something holds the gate, so a reset waits, and a new request queues behind the reset.
      const other = await gate.shared();
      const reset = runDemoResetGated(app.db, env, gate);
      expect(await settled(reset)).toBe(false);
      const req = await overSocket(app, visitor);
      await settle();
      // Its client goes away while it waits.
      req.abort();
      await req.response;
      other.release();
      await reset;
      // It got its place after the reset and gave it straight back.
      await expect.poll(() => gate.held, { timeout: 2_000 }).toBe(0);
      await runDemoResetGated(app.db, env, gate, { timeoutMs: 500 });
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  });

  it('a client that goes away mid-handler: the hold stays until the handler is done, then the reset runs', async () => {
    const { app, env, gate, visitor, userId } = await seededDemo();
    try {
      const park = parkAt('deviceTokens.create.passwordChecked');
      setRaceHook(park.hook);
      const req = await overSocket(app, visitor);
      await park.arrived;
      req.abort();
      await req.response;
      await settle();
      expect(gate.held).toBe(1);
      const reset = runDemoResetGated(app.db, env, gate);
      expect(await settled(reset)).toBe(false);
      expect(park.seen.resetInside, 'the reset waits outside the gate').toBe(false);
      park.release();
      await reset;
      expect(park.seen.resetInside).toBe(true);
      // The handler finished in the account it started in, and its token went with it.
      expect(
        await app.db.select().from(deviceTokens).where(eq(deviceTokens.userId, userId)).all(),
      ).toEqual([]);
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  });

  it('a request whose body never finishes arriving is ended, and a reset started meanwhile runs', async () => {
    const { app, env, gate, visitor } = await seededDemo({ startMs: 100 });
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const { hostname, port } = new URL(address);
      // Headers and a promised body of 1000 bytes, of which only a few ever come.
      const socket = connect(Number(port), hostname);
      const ended = new Promise<void>((r) => socket.once('close', () => r()));
      socket.on('error', () => undefined);
      socket.write(
        [
          'POST /api/v1/device-tokens HTTP/1.1',
          `Host: ${hostname}`,
          'Content-Type: application/json',
          'Content-Length: 1000',
          `X-CSRF-Token: ${visitor.csrf}`,
          `Cookie: opportun_session=${visitor.session}; opportun_csrf=${visitor.csrf}`,
          '',
          '{"name":',
        ].join('\r\n'),
      );
      await expect.poll(() => gate.held, { timeout: 2_000 }).toBe(1);
      const reset = runDemoResetGated(app.db, env, gate, { timeoutMs: 5_000 });
      await reset;
      await ended;
      expect(gate.held).toBe(0);
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  });

  it('an instance job holds the gate too: the reset waits for it', async () => {
    const { app, env, gate } = await seededDemo();
    const KIND = 'test.demo_reset_instance';
    try {
      registerJob({
        kind: KIND,
        payloadSchema: z.object({}),
        maxAttempts: 1,
        async run() {
          await racePoint('test.demo_reset_instance.parked');
        },
      });
      await enqueue(app.db, KIND, {});
      const park = parkAt('test.demo_reset_instance.parked');
      setRaceHook(park.hook);
      const drain = runDueJobs(app.db, { services: app.jobs.services });
      await park.arrived;
      const reset = runDemoResetGated(app.db, env, gate);
      expect(await settled(reset)).toBe(false);
      expect(park.seen.resetInside, 'the reset waits outside the gate').toBe(false);
      park.release();
      await drain;
      await reset;
      expect(park.seen.resetInside).toBe(true);
    } finally {
      unregisterJob(KIND);
      await app.close();
    }
  });
});
