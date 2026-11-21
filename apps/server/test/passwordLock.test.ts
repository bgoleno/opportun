// whilePasswordCurrent (https://github.com/bgoleno/opportun/issues/561): the write runs only while
// the verified hash is still the user's; the rehash, when asked, is the check itself; and the
// write shares the check's transaction.
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { settings, users } from '../src/db/schema';
import { whilePasswordCurrent } from '../src/lib/passwordLock';
import { openTestDb } from './helpers';

let close: () => Promise<void>;
let db: Db;
let userId: string;

beforeEach(async () => {
  const opened = await openTestDb();
  close = opened.close;
  db = opened.handle.db;
  userId = newId();
  const now = Date.now();
  await db
    .insert(users)
    .values({
      id: userId,
      email: 'u@example.com',
      passwordHash: 'hash-1',
      displayName: 'U',
      createdAt: now,
      updatedAt: now,
    })
    .run();
});

afterEach(async () => {
  await close();
});

const hashOf = async () =>
  (await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, userId)).get())!.h;
const mark = (tx: Parameters<Parameters<typeof whilePasswordCurrent>[3]>[0]) =>
  tx.insert(settings).values({ key: 'k', userId: null, value: true, updatedAt: 0 }).run();
const marked = async () =>
  (await db.select().from(settings).where(eq(settings.key, 'k')).get()) !== undefined;

describe('whilePasswordCurrent', () => {
  it('runs the write while the verified hash is current, and returns its value', async () => {
    const r = await whilePasswordCurrent(db, userId, 'hash-1', async (tx) => {
      await mark(tx);
      return 7;
    });
    expect(r).toEqual({ current: true, value: 7 });
    expect(await marked()).toBe(true);
  });

  it('writes nothing once the hash has changed', async () => {
    await db.update(users).set({ passwordHash: 'hash-2' }).where(eq(users.id, userId)).run();
    const r = await whilePasswordCurrent(db, userId, 'hash-1', async (tx) => await mark(tx));
    expect(r).toEqual({ current: false });
    expect(await marked()).toBe(false);
  });

  it('with a rehash: stores it while current, and never over a changed hash', async () => {
    const r = await whilePasswordCurrent(db, userId, 'hash-1', async () => 1, {
      rehashTo: 'hash-1-peppered',
    });
    expect(r.current).toBe(true);
    expect(await hashOf()).toBe('hash-1-peppered');
    const stale = await whilePasswordCurrent(db, userId, 'hash-1', async () => 1, {
      rehashTo: 'hash-1-again',
    });
    expect(stale).toEqual({ current: false });
    expect(await hashOf()).toBe('hash-1-peppered');
  });

  it('the write shares the transaction: a write that throws takes the rehash back with it', async () => {
    await expect(
      whilePasswordCurrent(
        db,
        userId,
        'hash-1',
        async () => {
          throw new Error('write failed');
        },
        { rehashTo: 'hash-1-peppered' },
      ),
    ).rejects.toThrow('write failed');
    expect(await hashOf()).toBe('hash-1');
  });
});
