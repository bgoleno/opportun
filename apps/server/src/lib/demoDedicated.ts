// The mark a dedicated demo account carries (https://github.com/bgoleno/opportun/issues/563; tl
// and sec on #542). A dedicated account is one the operator makes on a demo server for one person,
// with cli/createDemoAccount.ts, the only writer of the mark. The nightly reset's guard against
// running on a real database accepts a user that is not pinned only when it carries one.
//
// An instance row (user id null), keyed by the account's id and naming it in its value: not a
// user-scoped row, which would travel in that user's export and come back on an import (tl). The
// guard counts a user as marked only when the row under its key names that same user (sec). The
// reset deletes pinned users only, so it never deletes a mark.
import { and, isNull, like, notInArray } from 'drizzle-orm';
import type { Exec } from '../db/client';
import { settings, users } from '../db/schema';

export const DEDICATED_MARK_PREFIX = 'demo_dedicated_account:';

export const dedicatedMarkKey = (userId: string): string => `${DEDICATED_MARK_PREFIX}${userId}`;

/** Marks `userId` as a dedicated demo account. Only the CLI calls this. */
export async function writeDedicatedMark(tx: Exec, userId: string, now: number): Promise<void> {
  await tx
    .insert(settings)
    .values({ key: dedicatedMarkKey(userId), userId: null, value: { userId }, updatedAt: now })
    .run();
}

/**
 * The first user that is neither pinned nor marked, or null when every user that is not pinned
 * carries its own mark.
 */
export async function firstUnmarkedUser(
  db: Exec,
  pinnedIds: readonly string[],
): Promise<string | null> {
  const others = await db
    .select({ id: users.id })
    .from(users)
    .where(notInArray(users.id, [...pinnedIds]))
    .all();
  if (others.length === 0) return null;
  const marks = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(and(like(settings.key, `${DEDICATED_MARK_PREFIX}%`), isNull(settings.userId)))
    .all();
  // LIKE reads each "_" in the prefix as any one character, so a key is a mark only when it is
  // exactly the key of the user its value names.
  const marked = new Set(
    marks.flatMap((m) => {
      const named = (m.value as { userId?: unknown } | null)?.userId;
      return typeof named === 'string' && m.key === dedicatedMarkKey(named) ? [named] : [];
    }),
  );
  return others.find((u) => !marked.has(u.id))?.id ?? null;
}
