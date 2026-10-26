// Giving a stored message a body on disk, which production can no longer do (issue #53).
//
// `upsertInbound` has no body parameter any more: the mail ingest path stopped writing bodies in
// Plan 3 Task 1, the LinkedIn importer went on writing them because the rule lived in the callers
// rather than in the writer they share, and the parameter is gone so that nothing can write one
// again. Rows stored before that still carry a `body_ref`, and the code that reads it (the
// classifier's fallback chain, find-posting, the purge, and the release once a classification has
// read it) is still live for them. These helpers are how a test makes one of those rows.
import { and, eq } from 'drizzle-orm';
import { communications } from '../src/db/schema';
import type { Db } from '../src/db/client';
import type { Storage } from '../src/lib/storage';

/** Points a row at a body reference without writing a file, for a test that fakes the read. */
export async function pointAtStoredBody(
  db: Db,
  userId: string,
  id: string,
  ref: string,
): Promise<string> {
  await db
    .update(communications)
    .set({ bodyRef: ref })
    .where(and(eq(communications.userId, userId), eq(communications.id, id)))
    .run();
  return ref;
}

/** Writes the body to storage and points the row at it, as every message was stored before. */
export async function storeBodyFor(
  app: { db: Db; storage: Storage },
  userId: string,
  id: string,
  body: string,
): Promise<string> {
  const { storedPath } = await app.storage.writeAttachment(Buffer.from(body, 'utf8'));
  return await pointAtStoredBody(app.db, userId, id, storedPath);
}
