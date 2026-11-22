// Dedicated accounts on a demo server (https://github.com/bgoleno/opportun/issues/563, from the
// owner's decision 133 and tl and sec's review on #542). An account the operator makes for one
// person (a journalist, say) is created by a CLI that also marks it. The nightly reset still
// deletes and reseeds the pinned accounts only, and its guard against running on a real database
// becomes "every user that is not pinned carries the mark": a real database, whose users carry
// none, still refuses.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, like, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main as createDemoAccount } from '../src/cli/createDemoAccount';
import {
  DEMO_MARKER_KEY,
  DEMO_SEED_ACK_KEY,
  UnexpectedUsersError,
  seedDemo,
  type SeedDemoCredentials,
} from '../src/lib/demo/seed';
import { DEMO_USERS } from '../src/lib/demo/fixture';
import { rawRun, type Db } from '../src/db/client';
import { companies, settings, users } from '../src/db/schema';
import { DEDICATED_MARK_PREFIX, dedicatedMarkKey } from '../src/lib/demoDedicated';
import { verifyPassword } from '../src/lib/passwords';
import { isRegistrationOpen, registerUser } from '../src/lib/registration';
import { openTestDb } from './helpers';

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
  await close();
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
  };
}

const JOURNALIST = { email: 'reporter@example.com', displayName: 'A Reporter' };

/** The CLI, as the operator runs it, on a seeded demo. Returns the new user's row. */
async function createDedicated(email = JOURNALIST.email, displayName = JOURNALIST.displayName) {
  const c = capture();
  const code = await createDemoAccount({ db, env: ENV, email, displayName, io: c.io });
  expect(code, c.err.join('\n')).toBe(0);
  const row = await db.select().from(users).where(eq(users.email, email)).get();
  return { row: row!, out: c.out, err: c.err };
}

/** A user that is not pinned, inserted as any other route would, with no mark. */
async function addUnmarkedUser(id: string, email: string) {
  const now = Date.now();
  await db
    .insert(users)
    .values({
      id,
      email,
      passwordHash: 'x',
      displayName: email,
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe('the dedicated account CLI (#563)', () => {
  it('creates a non-admin account, marks it, and shows its password once', async () => {
    await seedDemo(db, CREDS, undefined, ENV);
    const { row, out, err } = await createDedicated();
    expect(row.isAdmin).toBe(false);
    expect(row.displayName).toBe(JOURNALIST.displayName);
    // The password is the one line on stdout, and nowhere else: not on stderr.
    expect(out).toHaveLength(1);
    const password = out[0]!;
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect(err.join('\n')).not.toContain(password);
    expect(await verifyPassword(row.passwordHash, password)).toBe(true);
    // The mark: an instance row (no user id, so it never travels in the user's export) naming it.
    const mark = await db
      .select()
      .from(settings)
      .where(eq(settings.key, dedicatedMarkKey(row.id)))
      .get();
    expect(mark).toMatchObject({ userId: null, value: { userId: row.id } });
  });

  // tl on #567 (#570): the account and its mark have committed by the audit write, so a failure
  // there must not leave an account whose password nobody was shown.
  it('shows the password even when the audit write fails after the account is made', async () => {
    await seedDemo(db, CREDS, undefined, ENV);
    await rawRun(db, sql`DROP TABLE audit_log`);
    const c = capture();
    await expect(createDemoAccount({ db, env: ENV, ...JOURNALIST, io: c.io })).rejects.toThrow();
    const row = await db.select().from(users).where(eq(users.email, JOURNALIST.email)).get();
    expect(row).toBeDefined();
    expect(c.out).toHaveLength(1);
    expect(await verifyPassword(row!.passwordHash, c.out[0]!)).toBe(true);
  });

  it('never opens registration, and its rows match a registered account on everything else', async () => {
    await seedDemo(db, CREDS, undefined, ENV);
    expect(await isRegistrationOpen(db)).toBe(false);
    const { row } = await createDedicated();
    expect(await isRegistrationOpen(db)).toBe(false);
    // The same account through the registration helper (opened for the comparison only, on a
    // fresh database, after one first account so this one is not the admin).
    const other = await openTestDb();
    try {
      await registerUser(other.handle.db, {
        email: 'first@example.com',
        passwordHash: 'x',
        displayName: 'First',
      });
      await other.handle.db
        .update(settings)
        .set({ value: true })
        .where(eq(settings.key, 'registration_open'))
        .run();
      const registered = await registerUser(other.handle.db, {
        email: JOURNALIST.email,
        passwordHash: row.passwordHash,
        displayName: JOURNALIST.displayName,
      });
      const strip = (u: typeof users.$inferSelect) => ({
        ...u,
        id: '',
        createdAt: 0,
        updatedAt: 0,
        lastSeenAt: null,
      });
      expect(strip(row)).toEqual(strip(registered));
    } finally {
      await other.close();
    }
  });

  it('refuses off a demo server, before the demo is seeded, and for an email in use', async () => {
    const off = capture();
    expect(
      await createDemoAccount({
        db,
        env: { ...ENV, OPPORTUN_DEMO: undefined },
        ...JOURNALIST,
        io: off.io,
      }),
    ).not.toBe(0);
    const unseeded = capture();
    expect(await createDemoAccount({ db, env: ENV, ...JOURNALIST, io: unseeded.io })).not.toBe(0);
    expect(await db.select().from(users).all()).toEqual([]);
    await seedDemo(db, CREDS, undefined, ENV);
    const taken = capture();
    expect(
      await createDemoAccount({
        db,
        env: ENV,
        email: DEMO_USERS[1]!.email,
        displayName: 'Someone',
        io: taken.io,
      }),
    ).not.toBe(0);
    expect(
      await db
        .select()
        .from(settings)
        .where(like(settings.key, `${DEDICATED_MARK_PREFIX}%`))
        .all(),
    ).toEqual([]);
    expect(taken.out).toEqual([]);
  });
});

describe('the nightly reset with a dedicated account (#563)', () => {
  it('runs, and leaves the marked account, its data and its mark as they were', async () => {
    await seedDemo(db, CREDS, undefined, ENV);
    const { row } = await createDedicated();
    const now = Date.now();
    await db
      .insert(companies)
      .values({
        id: 'reporter-co',
        userId: row.id,
        name: 'Reporter Co',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await seedDemo(db, CREDS, undefined, ENV);
    expect(await db.select().from(users).where(eq(users.id, row.id)).get()).toEqual(row);
    expect(
      await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.userId, row.id))
        .all(),
    ).toEqual([{ id: 'reporter-co' }]);
    expect(
      await db
        .select()
        .from(settings)
        .where(eq(settings.key, dedicatedMarkKey(row.id)))
        .get(),
    ).toMatchObject({ value: { userId: row.id } });
    // The pinned accounts were reseeded, demo-admin still the admin.
    const admin = await db.select().from(users).where(eq(users.id, DEMO_USERS[0]!.id)).get();
    expect(admin?.isAdmin).toBe(true);
  });

  it('still refuses when a user that is not pinned carries no mark', async () => {
    await seedDemo(db, CREDS, undefined, ENV);
    await createDedicated();
    await addUnmarkedUser('stray-user', 'stray@example.com');
    await expect(seedDemo(db, CREDS, undefined, ENV)).rejects.toThrow(UnexpectedUsersError);
  });

  it("refuses when a mark names another user: the row's value must be this user's id", async () => {
    await seedDemo(db, CREDS, undefined, ENV);
    const { row } = await createDedicated();
    await addUnmarkedUser('stray-user', 'stray@example.com');
    // The stray's key, but naming the dedicated user: not a mark for the stray.
    await db
      .insert(settings)
      .values({
        key: dedicatedMarkKey('stray-user'),
        userId: null,
        value: { userId: row.id },
        updatedAt: Date.now(),
      })
      .run();
    await expect(seedDemo(db, CREDS, undefined, ENV)).rejects.toThrow(UnexpectedUsersError);
  });

  // tl on #567 (#570): a mark counts only under its own key. A row under another key that names
  // the user is not that user's mark, whatever its value says.
  it("refuses when the only row naming a user is under another account's key", async () => {
    await seedDemo(db, CREDS, undefined, ENV);
    await addUnmarkedUser('stray-user', 'stray@example.com');
    await db
      .insert(settings)
      .values({
        key: dedicatedMarkKey('someone-else'),
        userId: null,
        value: { userId: 'stray-user' },
        updatedAt: Date.now(),
      })
      .run();
    await expect(seedDemo(db, CREDS, undefined, ENV)).rejects.toThrow(UnexpectedUsersError);
  });

  it('a real database (users, no marks, no demo marker) still refuses, and nothing is deleted', async () => {
    await addUnmarkedUser('owner', 'owner@example.com');
    await expect(seedDemo(db, CREDS, undefined, ENV)).rejects.toThrow(UnexpectedUsersError);
    expect(await db.select({ id: users.id }).from(users).all()).toEqual([{ id: 'owner' }]);
    expect(await db.select().from(settings).where(eq(settings.key, DEMO_MARKER_KEY)).get()).toBe(
      undefined,
    );
  });
});

describe('only the CLI writes the mark (#563)', () => {
  it('the mark prefix is written in one place under src: lib/demoDedicated.ts, called by the CLI', async () => {
    const src = join(__dirname, '../src');
    const { readdir } = await import('node:fs/promises');
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    await walk(src);
    const using: string[] = [];
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      if (text.includes('demo_dedicated_account') || text.includes('writeDedicatedMark')) {
        using.push(f.slice(src.length + 1));
      }
    }
    expect(using.sort()).toEqual(['cli/createDemoAccount.ts', 'lib/demoDedicated.ts']);
  });
});
