// The demo instance's nightly reset (issue #280, PR2): a thin JobHandler around seedDemo.
// The acceptance criterion is not the happy path, it is that a realistic, non-demo database
// survives a run completely untouched -- the delete seedDemo performs is bounded by construction
// (five pinned ids that do not exist on a real database), and this proves that bound holds
// through this job's own wrapper, not just inside seedDemo's own unit tests.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLog, jobs, users } from '../src/db/schema';
import { DEMO_SEED_ACK_KEY, UnexpectedUsersError } from '../src/cli/seedDemo';
import {
  DEMO_RESET_JOB_KIND,
  DemoCredentialsMissingError,
  runDemoReset,
} from '../src/jobs/demoReset';
import { enqueue } from '../src/jobs/runner';
import { readSchedules } from '../src/jobs/runner';
import { registerTwoUsers } from './isolation';
import { testApp } from './helpers';

// seedDemo loads its own Config from env (it also runs as a standalone CLI against a database
// the current process never booted), so this needs the same base vars loadConfig requires,
// not just the demo-specific ones -- not a fake masterKey the test app happens to use too,
// since none of these tests round-trip a secret through it. DATA_DIR must be the test app's
// own temp directory, passed in per test below, not a literal path: seedDemo constructs its
// own Storage from cfg.dataDir (issue #307, for the resume fixtures), which calls
// ensureDataDir and so actually creates the directory -- the same requirement test/seedDemo.ts
// documents and meets the same way, via openTestDb's own dataDir.
function demoEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    OPPORTUN_MASTER_KEY: randomBytes(32).toString('hex'),
    OPPORTUN_BASE_URL: 'https://demo.example.com',
    DATA_DIR: dataDir,
    OPPORTUN_DEMO: '1',
    [DEMO_SEED_ACK_KEY]: '1',
    OPPORTUN_DEMO_ADMIN_PASSWORD: 'demo-admin-password-1',
    OPPORTUN_DEMO_USER1_PASSWORD: 'demo-user1-password-1',
    OPPORTUN_DEMO_USER2_PASSWORD: 'demo-user2-password-1',
    OPPORTUN_DEMO_USER3_PASSWORD: 'demo-user3-password-1',
    OPPORTUN_DEMO_USER4_PASSWORD: 'demo-user4-password-1',
    OPPORTUN_DEMO_AI_KEY: 'sk-test-demo-key',
  };
}

describe('runDemoReset: a realistic non-demo database survives a run untouched (issue #280)', () => {
  it('refuses when a real, non-pinned user exists, and changes nothing about that user', async () => {
    const { app, dataDir } = await testApp({}, {});
    try {
      const { a } = await registerTwoUsers(app);
      const before = await app.db.select().from(users).where(eq(users.id, a.userId)).get();

      await expect(runDemoReset(app.db, demoEnv(dataDir))).rejects.toThrow(UnexpectedUsersError);

      const after = await app.db.select().from(users).where(eq(users.id, a.userId)).get();
      expect(after).toEqual(before);
      const allUsers = await app.db.select({ id: users.id }).from(users).all();
      expect(allUsers).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('refuses with a clear error when demo credentials are not fully set, touching nothing', async () => {
    const { app } = await testApp({}, {});
    try {
      await expect(runDemoReset(app.db, { OPPORTUN_DEMO: '1' })).rejects.toThrow(
        DemoCredentialsMissingError,
      );
      const allUsers = await app.db.select({ id: users.id }).from(users).all();
      expect(allUsers).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('seeds the five demo accounts on an empty database when credentials are present', async () => {
    const { app, dataDir } = await testApp({}, {});
    try {
      const report = await runDemoReset(app.db, demoEnv(dataDir));
      expect(report.deletedExisting).toBe(false);
      expect(report.userIds).toHaveLength(5);
    } finally {
      await app.close();
    }
  });
});

describe('demo reset schedule registration (issue #270 lesson)', () => {
  it('registers the schedule when the demo flag is set', async () => {
    const { app } = await testApp({ demo: true }, {});
    try {
      const schedules = await readSchedules(app.db);
      expect(schedules.some((s) => s.kind === DEMO_RESET_JOB_KIND)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('does not register the schedule on an ordinary (non-demo) deployment', async () => {
    const { app } = await testApp({}, {});
    try {
      const schedules = await readSchedules(app.db);
      expect(schedules.some((s) => s.kind === DEMO_RESET_JOB_KIND)).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('demoResetJob: materialises into a visible job (issue #272/#270 wiring-test shape)', () => {
  it('runs end to end: enqueue, drain, result and audit row', async () => {
    // A separate temp directory from the app's own: BuildOptions.env is fixed at testApp's
    // call site, before testApp's own dataDir exists, so this one is created and cleaned up
    // here rather than reused from the app (which is what the other tests above do instead).
    const demoDataDir = await mkdtemp(join(tmpdir(), 'opportun-demo-test-'));
    const { app } = await testApp({ demo: true }, { build: { env: demoEnv(demoDataDir) } });
    try {
      const jobId = await enqueue(app.db, DEMO_RESET_JOB_KIND, {});
      await app.jobs.drain();

      const row = await app.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      expect(row?.status).toBe('done');
      expect(row?.result).toMatchObject({ deletedExisting: false });
      expect((row?.result as { userIds: string[] }).userIds).toHaveLength(5);

      const entries = await app.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.event, 'demo.reset'))
        .all();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.detail).toMatchObject({ deletedExisting: false });
    } finally {
      await app.close();
      await rm(demoDataDir, { recursive: true, force: true });
    }
  });
});
