// Per-user settings stored under namespaced keys (`<name>:<userId>`, user_id set so they go
// with the account). Readers validate the stored value and fall back to their default.
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { settings } from '../db/schema';
import type { Exec, UserCtx } from './base';

export const userSettingKey = (name: string, userId: string): string => `${name}:${userId}`;

/** The user's value for `name` when it parses with `schema`, else `fallback`. */
export async function readUserSetting<T>(
  exec: Exec,
  ctx: UserCtx,
  name: string,
  schema: z.ZodType<T>,
  fallback: T,
): Promise<T> {
  const row = await exec
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.key, userSettingKey(name, ctx.userId)), eq(settings.userId, ctx.userId)))
    .get();
  if (row === undefined) return fallback;
  const parsed = schema.safeParse(row.value);
  return parsed.success ? parsed.data : fallback;
}

export async function writeUserSetting(
  exec: Exec,
  ctx: UserCtx,
  name: string,
  value: unknown,
): Promise<void> {
  const now = Date.now();
  await exec
    .insert(settings)
    .values({ key: userSettingKey(name, ctx.userId), userId: ctx.userId, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run();
}

/**
 * Whether the user has a row for `name` at all, regardless of what it holds. `readUserSetting`
 * alone cannot answer this: an explicit value that fails to parse and a setting that was never
 * written both return the fallback, which is right for applying the setting but wrong for
 * telling a user "you have not configured this" from "you configured it to this" (design
 * principle 6, docs/design.md: a degraded or defaulted path must be visible, not silent).
 */
export async function userSettingExists(exec: Exec, ctx: UserCtx, name: string): Promise<boolean> {
  const row = await exec
    .select({ key: settings.key })
    .from(settings)
    .where(and(eq(settings.key, userSettingKey(name, ctx.userId)), eq(settings.userId, ctx.userId)))
    .get();
  return row !== undefined;
}

/** Removes the user's row for `name`, reverting to whatever `readUserSetting`'s fallback is. */
export async function deleteUserSetting(exec: Exec, ctx: UserCtx, name: string): Promise<void> {
  await exec
    .delete(settings)
    .where(and(eq(settings.key, userSettingKey(name, ctx.userId)), eq(settings.userId, ctx.userId)))
    .run();
}

/** When the user's row for `name` was last written, or null when there is none. */
export async function userSettingUpdatedAt(
  exec: Exec,
  ctx: UserCtx,
  name: string,
): Promise<number | null> {
  const row = await exec
    .select({ updatedAt: settings.updatedAt })
    .from(settings)
    .where(and(eq(settings.key, userSettingKey(name, ctx.userId)), eq(settings.userId, ctx.userId)))
    .get();
  return row?.updatedAt ?? null;
}

/**
 * Writes `value` only when the user has no row for `name` yet, atomically: of two concurrent
 * callers exactly one insert lands and the other is a no-op. For write-once facts (a first
 * activation time) that a repeated read path may try to record more than once.
 */
export async function writeUserSettingOnce(
  exec: Exec,
  ctx: UserCtx,
  name: string,
  value: unknown,
): Promise<void> {
  await exec
    .insert(settings)
    .values({
      key: userSettingKey(name, ctx.userId),
      userId: ctx.userId,
      value,
      updatedAt: Date.now(),
    })
    .onConflictDoNothing({ target: settings.key })
    .run();
}
