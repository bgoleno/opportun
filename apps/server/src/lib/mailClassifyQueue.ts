// Queueing a stored message for classification (https://github.com/bgoleno/opportun/issues/788):
// the job's kind, its dedupe key and the enqueue call, in lib/ so lib/ and repos/ queue it without
// importing the mail-ingest job (jobs/mailIngest.ts), which runs it.
import type { Db } from '../db/client';
import { continuesTrace } from '../obs/workflow';
import type { UserCtx } from '../repos/base';
import { enqueue } from './jobQueue';
import { encryptSecret } from './secretBox';

export const CLASSIFY_JOB_KIND = 'comms.classify';

export const classifyDedupeKey = (communicationId: string): string =>
  `comms.classify:${communicationId}`;

/**
 * Queues classification of one stored message (at most one unfinished job per message).
 *
 * The body travels in the payload because it is not stored anywhere else (Plan 3 Task 1): the
 * classifier is the one consumer that needs the whole message, and the runner clears the field
 * when the job finishes. It is sealed first, with the instance's secretBox key (#175): clearing a
 * field does not erase it from disk (SQLite keeps the old row image in its WAL and free pages,
 * Postgres in dead tuples and WAL segments until reused), so only ciphertext is ever written.
 * A caller without a body (a replay, the backfill) omits it, and the classifier falls back to
 * the snippet.
 */
export async function enqueueClassify(
  db: Db,
  ctx: UserCtx,
  communicationId: string,
  body?: string,
) {
  return enqueue(
    db,
    CLASSIFY_JOB_KIND,
    body === undefined || body.length === 0
      ? { communicationId }
      : { communicationId, bodySealed: encryptSecret(db, body) },
    // Continues the mail_sync trace when queued from inside it (14.6), not otherwise.
    {
      dedupeKey: classifyDedupeKey(communicationId),
      userId: ctx.userId,
      continueTrace: continuesTrace(),
    },
  );
}
