// One-shot: the messages rejected before a reject cleared all it clears now lose the rest
// (repos/rejectedContent.ts, shared with the reject). After a backup, and with counts only of what
// it did: an audit row per user, and one log line for the whole of it.
//
// Two things are left as they are, and counted. An entry on a timeline that the user edited is
// theirs. The note of a stage change may say what a message said (it did, for a suggestion the user
// accepted), and cannot be tied to one message: those that may be a rejected message's are counted.
import { and, asc, eq, inArray, isNotNull, isNull, like, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { lockScope, withTransaction, type Db } from '../db/client';
import { communications, settings, stageHistory, users } from '../db/schema';
import { audit } from '../lib/audit';
import { enqueue } from '../lib/jobQueue';
import { racePoint } from '../lib/racePoints';
import type { Exec, UserCtx } from '../repos/base';
import { ownedBy } from '../repos/base';
import {
  CLEARED_ON_REJECT,
  clearCopies,
  STAGE_NOTE,
  stageNoteSubject,
} from '../repos/rejectedContent';
import { runBackup } from './backup';
import { requireService, type JobHandler } from './registry';

export const TIDY_REJECTED_KIND = 'comms.tidy_rejected';
/** Global marker (user_id NULL): every user's messages have been tidied. */
export const TIDY_REJECTED_MARKER_KEY = 'tidy_rejected:done';
/**
 * Messages in one transaction. Two thousand of one user's, in one, held the user's lock (and on
 * SQLite the write gate) for three seconds, and a capture waits five for it.
 */
const TIDY_BATCH = 100;

interface Counts {
  messages: number;
  entriesBlanked: number;
  entriesLeft: number;
  notesCleared: number;
  /** An upper bound: notes that may say what a rejected message said. */
  stageNotesLeft: number;
}
const none = (): Counts => ({
  messages: 0,
  entriesBlanked: 0,
  entriesLeft: 0,
  notesCleared: 0,
  stageNotesLeft: 0,
});

export interface TidyDeps {
  backup: () => Promise<unknown>;
  log?:
    | {
        info(attrs: object, message: string): void;
        warn(attrs: object, message: string): void;
      }
    | undefined;
  stopping?: () => boolean;
}

export type TidyOutcome =
  ({ status: 'done' } & Counts) | { status: 'backup_failed' | 'failed' | 'stopped' };

type ClearedField = keyof typeof CLEARED_ON_REJECT;

/** A rejected message that still holds something a reject clears. */
function leftOver(): SQL | undefined {
  const held = (Object.keys(CLEARED_ON_REJECT) as ClearedField[]).map((field) =>
    field === 'needsReview'
      ? eq(communications.needsReview, true)
      : // eslint-disable-next-line security/detect-object-injection -- a key of the constant itself
        isNotNull(communications[field]),
  );
  return and(isNotNull(communications.rejectedAt), or(...held));
}

/** The user's stage notes that may say what a message of theirs, rejected, said. */
async function stageNotesLeft(tx: Exec, ctx: UserCtx): Promise<number> {
  const notes = await tx
    .select({ note: stageHistory.note })
    .from(stageHistory)
    .where(and(ownedBy(stageHistory.userId, ctx), like(stageHistory.note, `${STAGE_NOTE}%`)))
    .all();
  const said = notes
    .map((n) => n.note ?? '')
    .filter((n) => n.startsWith(STAGE_NOTE))
    .map((n) => n.slice(STAGE_NOTE.length));
  if (said.length === 0) return 0;
  const there = await tx
    .select({ subject: communications.subject })
    .from(communications)
    .where(
      and(
        ownedBy(communications.userId, ctx),
        isNull(communications.rejectedAt),
        isNotNull(communications.subject),
      ),
    )
    .all();
  const subjects = new Set(there.map((m) => stageNoteSubject(m.subject)));
  return said.filter((s) => !subjects.has(s)).length;
}

/** The user's next rejected messages that still hold something, in a transaction of their own. */
async function tidyBatch(db: Db, ctx: UserCtx): Promise<Counts> {
  return await withTransaction(db, async (tx) => {
    // The user's lock before any row, as the reject (the rule is at submissionScope).
    await lockScope(tx, `user:${ctx.userId}`);
    await racePoint('tidy.locked');
    const counts = none();
    const batch = tx
      .select({ id: communications.id })
      .from(communications)
      .where(and(ownedBy(communications.userId, ctx), leftOver()))
      .orderBy(asc(communications.id))
      .limit(TIDY_BATCH);
    const rows = await tx
      .update(communications)
      .set({ ...CLEARED_ON_REJECT, updatedAt: Date.now() })
      .where(and(ownedBy(communications.userId, ctx), inArray(communications.id, batch)))
      .returning({
        id: communications.id,
        channel: communications.channel,
        externalId: communications.externalId,
        from: communications.from,
        sentAt: communications.sentAt,
      })
      .all();
    counts.messages = rows.length;
    for (const row of rows) {
      const copies = await clearCopies(tx, ctx, row);
      counts.entriesBlanked += copies.entriesBlanked;
      counts.entriesLeft += copies.entriesLeft;
      counts.notesCleared += copies.notesCleared;
    }
    return counts;
  });
}

function add(total: Counts, counts: Counts): void {
  for (const key of Object.keys(total) as (keyof Counts)[]) {
    // eslint-disable-next-line security/detect-object-injection -- a key of the object itself
    total[key] += counts[key];
  }
}

/**
 * One user's, a batch at a time: what waits for the user's lock (a save, a capture) has its turn
 * between two. What was done is on the audit trail when it ends, is stopped, or fails.
 */
async function tidyUser(
  db: Db,
  ctx: UserCtx,
  stopping: () => boolean,
): Promise<{ counts: Counts; stopped: boolean }> {
  const counts = none();
  let stopped = stopping();
  try {
    let more = true;
    while (more && !stopped) {
      const batch = await tidyBatch(db, ctx);
      add(counts, batch);
      more = batch.messages === TIDY_BATCH;
      stopped = more && stopping();
    }
  } finally {
    if (!stopped || counts.messages > 0) counts.stageNotesLeft = await stageNotesLeft(db, ctx);
    if (counts.messages > 0) {
      await audit(db, 'mail.rejected_tidied', { userId: ctx.userId, detail: { ...counts } });
    }
  }
  return { counts, stopped };
}

async function run(db: Db, deps: TidyDeps): Promise<TidyOutcome> {
  const left = await db
    .select({ id: communications.id })
    .from(communications)
    .where(leftOver())
    .limit(1)
    .all();
  if (left.length > 0) {
    try {
      await deps.backup();
    } catch (err) {
      deps.log?.warn(
        { err },
        'rejected messages not tidied, as the backup before it failed: tried again at the next start',
      );
      return { status: 'backup_failed' };
    }
  }
  const owners = await db
    .selectDistinct({ userId: communications.userId })
    .from(communications)
    .where(isNotNull(communications.rejectedAt))
    .orderBy(asc(communications.userId))
    .all();
  const total = none();
  for (const { userId } of owners) {
    const done = await tidyUser(db, { userId, isAdmin: false }, () => deps.stopping?.() === true);
    if (done.stopped) return { status: 'stopped' };
    add(total, done.counts);
  }
  await db
    .insert(settings)
    .values({
      key: TIDY_REJECTED_MARKER_KEY,
      userId: null,
      value: Date.now(),
      updatedAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
  deps.log?.info(
    {
      'opportun.count.messages': total.messages,
      'opportun.count.entries_blanked': total.entriesBlanked,
      'opportun.count.entries_left': total.entriesLeft,
      'opportun.count.notes_cleared': total.notesCleared,
      'opportun.count.stage_notes_left': total.stageNotesLeft,
    },
    'rejected messages tidied',
  );
  return { status: 'done', ...total };
}

/**
 * Tidies every user's rejected messages. Nothing is changed unless a backup has just succeeded, and
 * none is taken when there is nothing to change. A run that does not reach its end, whatever stops
 * it, is done again at the next start, for what is left: one backup at each start, at most.
 */
export async function tidyRejectedMessages(db: Db, deps: TidyDeps): Promise<TidyOutcome> {
  try {
    return await run(db, deps);
  } catch (err) {
    // Not the runner's to try again: each try takes a backup, and only so many backups are kept.
    deps.log?.warn({ err }, 'rejected messages not all tidied: tried again at the next start');
    return { status: 'failed' };
  }
}

/**
 * Queues the job at a start, until a run of it has reached its end: the job writes the marker, not
 * this. As enqueueRepairAlertLeadsOnce, nothing is queued while there are no users, so that a
 * database restored into a fresh install is tidied.
 */
export async function enqueueTidyRejectedOnce(db: Db): Promise<boolean> {
  const marker = await db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, TIDY_REJECTED_MARKER_KEY))
    .get();
  if (marker !== undefined) return false;
  const someone = await db.select({ id: users.id }).from(users).limit(1).all();
  if (someone.length === 0) return false;
  await enqueue(db, TIDY_REJECTED_KIND, {}, { dedupeKey: TIDY_REJECTED_KIND });
  return true;
}

const PayloadSchema = z.object({}).strict();

export const tidyRejectedJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: TIDY_REJECTED_KIND,
  payloadSchema: PayloadSchema,
  // A run cut off by a crash is one attempt, and the next start's recovery needs another.
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    const storage = requireService(ctx, 'storage');
    const outcome = await tidyRejectedMessages(db, {
      backup: () => runBackup(db, storage),
      log: ctx.services.log,
      stopping: () => ctx.stopping(),
    });
    await ctx.setResult(outcome);
  },
};
