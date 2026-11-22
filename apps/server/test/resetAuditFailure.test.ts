// https://github.com/bgoleno/opportun/issues/661 (qa): both password resets wrote their audit row
// after the reset had committed and before the new password reached the operator. A failed audit
// write then left the account reset (hash, sessions, device tokens, providers, 2FA) with a password
// nobody was shown: locked out until reset again. Agreed on the issue (tl, sec): nothing is
// changed. The audit row is written in the reset's own transaction, so a failed write rolls the
// whole reset back, and the password is shown only once that transaction has committed.
//
// The failure is injected at the audit step itself: the real insert runs, through whatever
// executor the reset passed, and then the step throws. A row left behind afterwards would mean the
// write ran outside the reset's transaction.
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/resetPassword';
import type { Db } from '../src/db/client';
import { auditLog, deviceTokens, oauthAccounts, sessions, users } from '../src/db/schema';
import { createDeviceToken } from '../src/lib/deviceTokens';
import { hashPassword } from '../src/lib/passwords';
import { createSession } from '../src/lib/sessions';
import { useApi } from './api';
import { openTestDb } from './helpers';
import type { TestClient } from './isolation';

/** The audit event whose write fails, or null for none. */
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

const ctxOf = (userId: string) => ({ userId, isAdmin: false });

/** Everything a reset touches for `userId`, to compare before and after. */
async function credentials(db: Db, userId: string): Promise<string> {
  return JSON.stringify({
    user: await db.select().from(users).where(eq(users.id, userId)).get(),
    sessions: await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(sessions.id)
      .all(),
    tokens: await db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, userId))
      .orderBy(deviceTokens.id)
      .all(),
    providers: await db
      .select()
      .from(oauthAccounts)
      .where(eq(oauthAccounts.userId, userId))
      .orderBy(oauthAccounts.id)
      .all(),
  });
}

/** Gives `userId` all a reset takes away besides sessions: 2FA, a device token, a provider. */
async function arm(db: Db, userId: string): Promise<void> {
  const now = Date.now();
  await db
    .update(users)
    .set({ totpSecret: 'JBSWY3DPEHPK3PXP', totpEnabled: true, totpRecovery: ['x'] })
    .where(eq(users.id, userId))
    .run();
  await createDeviceToken(db, ctxOf(userId), { name: 'laptop', scopes: ['mail:push'] });
  await db
    .insert(oauthAccounts)
    .values({
      id: newId(),
      userId,
      provider: 'google',
      providerAccountId: `sub-${userId}`,
      tokens: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

const resetRows = async (db: Db, event: string) =>
  await db.select().from(auditLog).where(eq(auditLog.event, event)).all();

afterEach(() => {
  failing = null;
});

describe('CLI reset: a failed audit write changes nothing (#661)', () => {
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
        passwordHash: await hashPassword('old password that works'),
        displayName: email,
        isAdmin: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await createSession(db, id, {});
    await arm(db, id);
    return id;
  }

  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
    };
  };

  it('the account is exactly as it was, no password is printed, and it exits nonzero', async () => {
    const id = await addUser('reset-me@example.com');
    const before = await credentials(db, id);
    failing = 'auth.password_reset_cli';
    const { out, io } = capture();
    await expect(main({ db, email: 'reset-me@example.com', io })).rejects.toThrow(
      'audit write failed',
    );
    expect(out).toEqual([]);
    expect(await credentials(db, id)).toBe(before);
    expect(await resetRows(db, 'auth.password_reset_cli')).toHaveLength(0);
  });

  it('with the audit write working, the reset and its audit row land together', async () => {
    const id = await addUser('reset-me@example.com');
    const before = await credentials(db, id);
    const { out, io } = capture();
    expect(await main({ db, email: 'reset-me@example.com', io })).toBe(0);
    expect(out).toHaveLength(1);
    const temporary = out[0]!;
    expect(await credentials(db, id)).not.toBe(before);
    const rows = await resetRows(db, 'auth.password_reset_cli');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(id);
    // The audit row holds no secret (sec on #661).
    expect(JSON.stringify(rows)).not.toContain(temporary);
  });
});

describe('admin reset: a failed audit write changes nothing (#661)', () => {
  const boot = useApi();
  const reset = (c: TestClient, id: string) =>
    c.request({
      method: 'POST',
      url: `/api/v1/admin/users/${id}/reset-password`,
      payload: { password: 'correct horse battery' },
    });

  it('the target is exactly as it was, and the answer carries no password', async () => {
    const { app, a, b } = await boot();
    await arm(app.db, b.userId);
    const before = await credentials(app.db, b.userId);
    failing = 'admin.password_reset';
    const res = await reset(a, b.userId);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.json())).not.toMatch(/temporaryPassword/);
    expect(await credentials(app.db, b.userId)).toBe(before);
    expect(await resetRows(app.db, 'admin.password_reset')).toHaveLength(0);
  });

  it('with the audit write working, the reset and its audit row land together', async () => {
    const { app, a, b } = await boot();
    await arm(app.db, b.userId);
    const before = await credentials(app.db, b.userId);
    const res = await reset(a, b.userId);
    expect(res.statusCode).toBe(200);
    const { temporaryPassword } = res.json() as { temporaryPassword: string };
    expect(await credentials(app.db, b.userId)).not.toBe(before);
    const rows = await resetRows(app.db, 'admin.password_reset');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toEqual({ targetUserId: b.userId, unlinkedProviders: ['google'] });
    expect(JSON.stringify(rows)).not.toContain(temporaryPassword);
  });
});
