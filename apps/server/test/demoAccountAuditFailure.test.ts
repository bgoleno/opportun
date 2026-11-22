// https://github.com/bgoleno/opportun/issues/802: the dedicated demo account CLI wrote its audit
// row after the account had committed, and showed the password first (#567), so a failed audit
// write left an account no audit row records. As #723 does for a reset: the audit row commits with
// the account, and the password is shown only after that commit. A failed write creates nothing.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main as createDemoAccount } from '../src/cli/createDemoAccount';
import type { Db } from '../src/db/client';
import { users } from '../src/db/schema';
import { DEMO_SEED_ACK_KEY, seedDemo, type SeedDemoCredentials } from '../src/lib/demo/seed';
import { openTestDb } from './helpers';

let failing: string | null = null;

vi.mock('../src/lib/audit', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/audit')>();
  return {
    ...real,
    audit: async (...args: Parameters<typeof real.audit>) => {
      await real.audit(...args);
      if (args[1] === failing) throw new Error('audit write failed');
    },
  };
});

const CREDS: SeedDemoCredentials = {
  adminPassword: 'demo admin password 1!',
  userPasswords: [
    'demo user1 password 1!',
    'demo user2 password 1!',
    'demo user3 password 1!',
    'demo user4 password 1!',
  ],
  aiApiKey: 'sk-ant-demo-fixture-key',
};

let close: () => Promise<void>;
let db: Db;
// A literal object, never process.env (seedDemo.test.ts says why).
let ENV: NodeJS.ProcessEnv;

beforeEach(async () => {
  const opened = await openTestDb();
  close = opened.close;
  db = opened.handle.db;
  ENV = {
    OPPORTUN_MASTER_KEY: 'ab'.repeat(32),
    OPPORTUN_DEMO: '1',
    [DEMO_SEED_ACK_KEY]: '1',
    OPPORTUN_BASE_URL: 'http://localhost:8080',
    DATA_DIR: opened.dataDir,
  };
});

afterEach(async () => {
  failing = null;
  await close();
});

describe('the dedicated account CLI: the audit row commits with the account (#802)', () => {
  it('a failed audit write creates no account and shows no password', async () => {
    await seedDemo(db, CREDS, undefined, ENV);
    const email = 'reporter@example.com';
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
    failing = 'demo.dedicated_account_created';
    // As the reset CLI does (#723): the failure propagates, and the CLI exits nonzero.
    await expect(
      createDemoAccount({ db, env: ENV, email, displayName: 'A Reporter', io }),
    ).rejects.toThrow('audit write failed');
    failing = null;
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(await db.select().from(users).where(eq(users.email, email)).get()).toBeUndefined();
    // Run again with the audit write working, it creates the account.
    const again = await createDemoAccount({
      db,
      env: ENV,
      email,
      displayName: 'A Reporter',
      io: { stdout: () => {}, stderr: () => {} },
    });
    expect(again).toBe(0);
  });
});
