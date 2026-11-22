// https://github.com/bgoleno/opportun/issues/606: the CLIs that set a password (the reset, and the
// demo's dedicated account) refuse, touching nothing, when their pepper version is not the one the
// server last booted with. qa's case: after a rotation to version 2, a from-source run with only
// OPPORTUN_PEPPER (so version 1, and the new secret) printed a password stamped v1 that never
// signed in, after the old one, the sessions and the device tokens were already gone.
//
// The server records the version it booted with (lib/pepperVersion.ts); with no record yet, a
// stored hash newer than the run's version refuses too. All values here are made up.
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main as createDemoAccount } from '../src/cli/createDemoAccount';
import { main as resetPassword } from '../src/cli/resetPassword';
import { DEMO_MARKER_KEY } from '../src/cli/seedDemo';
import type { Db } from '../src/db/client';
import { deviceTokens, sessions, settings, users } from '../src/db/schema';
import { createDeviceToken } from '../src/lib/deviceTokens';
import { hashPassword, hashVersion, pepperSet, type PepperSet } from '../src/lib/passwords';
import { PEPPER_VERSION_KEY, recordPepperVersion } from '../src/lib/pepperVersion';
import { createSession } from '../src/lib/sessions';
import { openTestDb, restartableTestApp } from './helpers';

const OLD = 'old-pepper-0123456789abcdef';
const NEW = 'new-pepper-0123456789abcdef';
const ROTATED = pepperSet(2, { 1: OLD, 2: NEW });
/** qa's run: OPPORTUN_PEPPER alone, the new secret under the default version 1. */
const STALE = pepperSet(1, { 1: NEW });
const ROTATED_ENV = {
  OPPORTUN_PEPPER: NEW,
  OPPORTUN_PEPPER_VERSION: '2',
  OPPORTUN_PEPPER_V1: OLD,
};
const STALE_ENV = { OPPORTUN_PEPPER: NEW };

let close: () => Promise<void>;
let db: Db;

beforeEach(async () => {
  const opened = await openTestDb();
  close = opened.close;
  db = opened.handle.db;
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

async function addUser(email: string, peppers: PepperSet): Promise<string> {
  const id = newId();
  const now = Date.now();
  await db
    .insert(users)
    .values({
      id,
      email,
      passwordHash: await hashPassword('the password before', peppers),
      displayName: email,
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await createSession(db, id, {});
  await createDeviceToken(
    db,
    { userId: id, isAdmin: false },
    { name: 'laptop', scopes: ['mail:push'] },
  );
  return id;
}

/** The user's row, sessions and device tokens, as stored: a refused run leaves them as they were. */
async function snapshot(id: string): Promise<string> {
  const user = await db.select().from(users).where(eq(users.id, id)).get();
  const s = await db.select().from(sessions).where(eq(sessions.userId, id)).all();
  const t = await db.select().from(deviceTokens).where(eq(deviceTokens.userId, id)).all();
  return JSON.stringify({ user, s, t });
}

const storedVersion = async (id: string) =>
  hashVersion((await db.select().from(users).where(eq(users.id, id)).get())!.passwordHash);

describe('#606: the reset CLI with a pepper version the server is not on', () => {
  it('refuses, naming the variables and the restart, and changes nothing', async () => {
    await recordPepperVersion(db, 2);
    const id = await addUser('ada@example.com', ROTATED);
    const before = await snapshot(id);
    const { out, err, io } = capture();
    expect(await resetPassword({ db, email: 'ada@example.com', io, peppers: STALE })).toBe(1);
    expect(out).toEqual([]);
    const said = err.join('\n');
    expect(said).toContain('pepper version 2');
    expect(said).toContain('OPPORTUN_PEPPER_VERSION');
    expect(said).toContain('OPPORTUN_PEPPER_V1');
    expect(said).toMatch(/restart/i);
    expect(said).toContain('Nothing changed.');
    // Names only: no secret is ever echoed.
    expect(said).not.toContain(NEW);
    expect(said).not.toContain(OLD);
    expect(await snapshot(id)).toBe(before);
  });

  it("goes ahead with the server's own version, and the hash names it", async () => {
    await recordPepperVersion(db, 2);
    const id = await addUser('ada@example.com', ROTATED);
    const { out, io } = capture();
    expect(await resetPassword({ db, email: 'ada@example.com', io, peppers: ROTATED })).toBe(0);
    expect(out).toHaveLength(1);
    expect(await storedVersion(id)).toBe(2);
  });

  it('a pepper the server runs without is refused too: unset them for this run', async () => {
    await recordPepperVersion(db, 0);
    const id = await addUser('ada@example.com', pepperSet(0, {}));
    const before = await snapshot(id);
    const { err, io } = capture();
    expect(await resetPassword({ db, email: 'ada@example.com', io, peppers: STALE })).toBe(1);
    expect(err.join('\n')).toContain('without a pepper');
    expect(await snapshot(id)).toBe(before);
  });

  it("no record yet: a stored hash newer than the run's version refuses", async () => {
    await addUser('rotated@example.com', ROTATED); // signed in since the rotation: stamped p2
    const id = await addUser('ada@example.com', pepperSet(1, { 1: OLD }));
    const before = await snapshot(id);
    const { err, io } = capture();
    expect(await resetPassword({ db, email: 'ada@example.com', io, peppers: STALE })).toBe(1);
    expect(err.join('\n')).toContain('version 2');
    // As actionable as the row-based refusals (tl's optional 3 on #627, #635): restart the server
    // once with its own variables, so it records its version, then run this again.
    expect(err.join('\n')).toMatch(/restart the server once with its own pepper variables/i);
    expect(await snapshot(id)).toBe(before);
  });

  it('no record and no newer hash: it goes ahead, as before', async () => {
    const id = await addUser('ada@example.com', pepperSet(1, { 1: NEW }));
    const { out, io } = capture();
    expect(await resetPassword({ db, email: 'ada@example.com', io, peppers: STALE })).toBe(0);
    expect(out).toHaveLength(1);
    expect(await storedVersion(id)).toBe(1);
  });
});

describe('#606: the demo dedicated-account CLI with a pepper version the server is not on', () => {
  const seeded = () =>
    db
      .insert(settings)
      .values({ key: DEMO_MARKER_KEY, userId: null, value: true, updatedAt: Date.now() })
      .run();
  const accountsNamed = async (email: string) =>
    await db.select().from(users).where(eq(users.email, email)).all();

  it('refuses before creating anything, naming the variables', async () => {
    await seeded();
    await recordPepperVersion(db, 2);
    const { out, err, io } = capture();
    const code = await createDemoAccount({
      db,
      env: { OPPORTUN_DEMO: '1', ...STALE_ENV },
      email: 'reporter@example.com',
      displayName: 'A Reporter',
      io,
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('OPPORTUN_PEPPER_VERSION');
    expect(await accountsNamed('reporter@example.com')).toEqual([]);
  });

  it("goes ahead with the server's own version, and the hash names it", async () => {
    await seeded();
    await recordPepperVersion(db, 2);
    const { out, io } = capture();
    const code = await createDemoAccount({
      db,
      env: { OPPORTUN_DEMO: '1', ...ROTATED_ENV },
      email: 'reporter@example.com',
      displayName: 'A Reporter',
      io,
    });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const [row] = await accountsNamed('reporter@example.com');
    expect(hashVersion(row!.passwordHash)).toBe(2);
  });
});

describe('#606: the server records the version it booted with', () => {
  it('on every boot, a lowered version and no pepper included', async () => {
    const read = async (d: Db) =>
      (await d.select().from(settings).where(eq(settings.key, PEPPER_VERSION_KEY)).get())?.value;
    const booted = await restartableTestApp({ peppers: ROTATED });
    try {
      expect(await read(booted.app().db)).toBe(2);
      const again = await booted.restart({ peppers: pepperSet(1, { 1: OLD }) });
      expect(await read(again.db)).toBe(1);
      const none = await booted.restart({ peppers: pepperSet(0, {}) });
      expect(await read(none.db)).toBe(0);
    } finally {
      await booted.close();
    }
  });
});
