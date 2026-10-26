import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli/resetPassword';
import type { Db } from '../src/db/client';
import { openTestDb } from './helpers';
import { auditLog, deviceTokens, sessions, users } from '../src/db/schema';
import { authenticateDeviceToken, createDeviceToken } from '../src/lib/deviceTokens';
import { hashPassword, verifyPassword } from '../src/lib/passwords';
import { createSession } from '../src/lib/sessions';

const OLD_PASSWORD = 'old password that works';

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

async function addUser(email: string): Promise<string> {
  const id = newId();
  const now = Date.now();
  await db
    .insert(users)
    .values({
      id,
      email,
      passwordHash: await hashPassword(OLD_PASSWORD),
      displayName: email,
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await createSession(db, id, {});
  await createSession(db, id, {});
  return id;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
  };
}

const userRow = async (id: string) =>
  (await db.select().from(users).where(eq(users.id, id)).get())!;
const sessionCount = async (id: string) =>
  (await db.select().from(sessions).where(eq(sessions.userId, id)).all()).length;

describe('reset password CLI', () => {
  it('revokes every device token the user has (compromise recovery cuts all credentials)', async () => {
    const id = await addUser('device-owner@example.com');
    const other = await addUser('device-bystander@example.com');
    const mine = await createDeviceToken(
      db,
      { userId: id, isAdmin: false },
      {
        name: 'laptop',
        scopes: ['mail:push'],
      },
    );
    const theirs = await createDeviceToken(
      db,
      { userId: other, isAdmin: false },
      {
        name: 'laptop',
        scopes: ['mail:push'],
      },
    );
    const { io } = capture();
    expect(await main({ db: db, email: 'device-owner@example.com', io })).toBe(0);
    expect(await authenticateDeviceToken(db, mine.token, 'mail:push')).toEqual({
      ok: false,
      status: 401,
    });
    expect((await authenticateDeviceToken(db, theirs.token, 'mail:push')).ok).toBe(true);
    const rows = await db.select().from(deviceTokens).all();
    expect(rows.find((r) => r.userId === id)?.revokedAt).not.toBeNull();
  });

  it('sets a new hash for the temporary password and ends every session', async () => {
    const id = await addUser('reset-me@example.com');
    const other = await addUser('bystander@example.com');
    const before = (await userRow(id)).passwordHash;
    const { out, err, io } = capture();

    const code = await main({ db: db, email: 'reset-me@example.com', io });

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    const temporary = out[0]!.trim();
    expect(temporary.length).toBeGreaterThanOrEqual(20);

    const after = (await userRow(id)).passwordHash;
    expect(after).not.toBe(before);
    expect(after).not.toContain(temporary);
    expect(await verifyPassword(after, temporary)).toBe(true);
    expect(await verifyPassword(after, OLD_PASSWORD)).toBe(false);
    expect(await sessionCount(id)).toBe(0);

    // Nobody else is touched.
    expect(await verifyPassword((await userRow(other)).passwordHash, OLD_PASSWORD)).toBe(true);
    expect(await sessionCount(other)).toBe(2);

    // The plaintext appears nowhere in the database (audit trail included).
    const dump = JSON.stringify(await db.select().from(auditLog).all());
    expect(dump.includes(temporary)).toBe(false);
  });

  it('matches the email case-insensitively and generates a fresh password each run', async () => {
    const id = await addUser('mixed@example.com');
    const first = capture();
    const second = capture();
    expect(await main({ db: db, email: '  Mixed@Example.com ', io: first.io })).toBe(0);
    expect(await main({ db: db, email: 'mixed@example.com', io: second.io })).toBe(0);
    expect(first.out[0]).not.toBe(second.out[0]);
    expect(await verifyPassword((await userRow(id)).passwordHash, second.out[0]!.trim())).toBe(
      true,
    );
  });

  it('exits nonzero on an unknown email and touches nothing', async () => {
    const id = await addUser('known@example.com');
    const before = (await userRow(id)).passwordHash;
    const { out, err, io } = capture();

    const code = await main({ db: db, email: 'nobody@example.com', io });

    expect(code).not.toBe(0);
    expect(out).toEqual([]);
    expect(err.join('')).toMatch(/no user/i);
    expect((await userRow(id)).passwordHash).toBe(before);
    expect(await sessionCount(id)).toBe(2);
  });

  it('exits nonzero with usage when no email is given', async () => {
    const { out, err, io } = capture();
    expect(await main({ db: db, email: undefined, io })).not.toBe(0);
    expect(out).toEqual([]);
    expect(err.join('')).toMatch(/usage/i);
  });
});
