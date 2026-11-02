// The resume snapshot of an application attempt (assisted apply M1b,
// https://github.com/bgoleno/opportun/issues/115; design Part A 4.4 and 6.3, as amended by the
// Tech Lead on #115). It exports the attempt's resume through its own store as a PDF, stores
// the bytes as an attachments row on the opportunity, and records the hash on the attempt, so
// the record stays true after the document is edited or deleted. The hash, title and store are
// kept on the attempt for good; the file itself is an ordinary attachment, which the user can
// still delete (the attempt then keeps the hash and loses the file; sec on #131).
//
// The resume is read from the stored attempt and the user's own resumes row, never from a
// request: the payload names the attempt and the resume chosen, both ids, and the job acts only
// while the attempt still names that resume. A store with no PDF to give says
// `export_unsupported`, and the attempt records `unsupported` with no hash; text is never
// stored in place of a PDF. Export failures the store calls retryable are retried by the
// runner while attempts remain; a permanent one, or the last attempt, records `failed` with the
// store's code and ends the job normally (done, not dead): the user retries by choosing the
// resume again (PATCH resumeId), which queues a new snapshot.
//
// One job per chosen resume (tl on #131): the dedupe key names the attempt and the resume, so a
// newly chosen resume gets a job of its own with its full tries and no inherited backoff, and a
// job whose resume is no longer chosen does nothing.
//
// A stale snapshot never lands. Every write is conditional on the attempt still being a draft,
// still pending, and still naming the resume that was exported; when it is not, the write (and
// its attachments row, in the same transaction) is dropped. Choosing the same resume again while
// its job is still queued or running cannot queue a second one (same key), so after every write
// the job looks again and exports once more if the attempt is pending again for its resume. The
// reconciling pass below catches what is left: a draft still pending with no job to settle it
// (a choice that landed between that last look and the job's end, a job that died, an enqueue
// that never happened).
import { newId } from '@opportun/core';
import { and, asc, eq, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import {
  DocumentExportError,
  type DocumentExportFailure,
  type DocumentExportResult,
  type DocumentStore,
} from '../adapters/documentStore';
import { withTransaction } from '../db/client';
import type { Db } from '../db/client';
import { applicationSubmissions, attachments, resumes } from '../db/schema';
import { racePoint } from '../lib/racePoints';
import type { UserCtx } from '../repos/base';
import { requireService, type JobContext, type JobHandler, type JobServices } from './registry';
import { enqueue } from './runner';

export const SNAPSHOT_JOB_KIND = 'submission.snapshot';

/** One unfinished snapshot job per attempt and chosen resume (jobs_unfinished_dedupe_uq). */
export const snapshotJobKey = (submissionId: string, resumeId: string | null): string =>
  `${SNAPSHOT_JOB_KIND}:${submissionId}:${resumeId ?? 'none'}`;

/** Design 6.3: three tries with the runner's backoff, then the attempt shows the failure. */
export const SNAPSHOT_MAX_ATTEMPTS = 3;

/**
 * How many exports one run makes for its resume when the user keeps choosing it again while the
 * job runs, before it lets the runner try later. Nobody re-chooses faster than an export.
 */
const MAX_ROUNDS = 3;

const Payload = z
  .object({ submissionId: z.string().min(1), resumeId: z.string().min(1).nullable() })
  .strict();
type Payload = z.infer<typeof Payload>;

/** Queues the snapshot of `resumeId` for an attempt; a no-op while that one is queued or running. */
export async function enqueueSnapshot(
  db: Db,
  userId: string,
  submissionId: string,
  resumeId: string | null,
): Promise<void> {
  await enqueue(db, SNAPSHOT_JOB_KIND, { submissionId, resumeId } satisfies Payload, {
    dedupeKey: snapshotJobKey(submissionId, resumeId),
    userId,
  });
}

type Resume = typeof resumes.$inferSelect;

/** The attempt changed under this run (another resume, cancelled, or already settled). */
class Superseded extends Error {
  constructor() {
    super('snapshot superseded');
    this.name = 'Superseded';
  }
}

/** The store that holds this resume; the same choice routes/resumes.ts storeFor makes. */
function storeOf(ctx: JobContext, store: Resume['store']): DocumentStore {
  if (store === 'reactive_resume') return requireService(ctx, 'reactiveResumeStore');
  if (store === 'local_file') return requireService(ctx, 'localFileStore');
  return requireService(ctx, 'documentStore');
}

/** Only a draft whose snapshot is still pending, for the resume this run exported, is written. */
const stillWanted = (submissionId: string, userId: string, resumeId: string | null) =>
  and(
    eq(applicationSubmissions.id, submissionId),
    eq(applicationSubmissions.userId, userId),
    eq(applicationSubmissions.status, 'draft'),
    eq(applicationSubmissions.snapshotState, 'pending'),
    resumeId === null
      ? isNull(applicationSubmissions.resumeId)
      : eq(applicationSubmissions.resumeId, resumeId),
  );

type Outcome =
  | { kind: 'ready'; result: Extract<DocumentExportResult, { ok: true }> }
  | { kind: 'unsupported' }
  | { kind: 'failed'; code: DocumentExportFailure };

/**
 * Records the outcome for `resume`, if the attempt still wants it. Throws Superseded when it
 * does not; for `ready`, the attachments row is inserted in the same transaction, so it goes
 * with the dropped write.
 */
async function record(
  db: Db,
  services: Pick<JobServices, 'storage'>,
  row: { id: string; userId: string; opportunityId: string },
  resume: Resume | null,
  outcome: Outcome,
): Promise<void> {
  // Written before the transaction (content-addressed, so a dropped write leaves only a file the
  // attachment sweep collects once its grace period has passed).
  const stored =
    outcome.kind === 'ready' ? await services.storage.writeAttachment(outcome.result.bytes) : null;
  await racePoint('submissions.snapshot.beforeWrite');
  await withTransaction(db, async (tx) => {
    const now = Date.now();
    let attachmentId: string | null = null;
    if (outcome.kind === 'ready' && stored !== null) {
      attachmentId = newId();
      await tx
        .insert(attachments)
        .values({
          id: attachmentId,
          userId: row.userId,
          opportunityId: row.opportunityId,
          filename: outcome.result.filename,
          mime: outcome.result.mime,
          bytes: stored.bytes,
          sha256: stored.sha256,
          storedPath: stored.storedPath,
          createdAt: now,
        })
        .run();
    }
    const where = stillWanted(row.id, row.userId, resume?.id ?? null);
    const changed = await tx
      .update(applicationSubmissions)
      .set({
        snapshotState:
          outcome.kind === 'ready'
            ? 'ready'
            : outcome.kind === 'unsupported'
              ? 'unsupported'
              : 'failed',
        snapshotError:
          outcome.kind === 'ready'
            ? null
            : outcome.kind === 'unsupported'
              ? 'export_unsupported'
              : outcome.code,
        resumeAttachmentId: attachmentId,
        resumeSha256: stored?.sha256 ?? null,
        ...(resume === null
          ? {}
          : { resumeTitle: resume.title, resumeStore: resume.store, resumeDocRef: resume.docRef }),
        updatedAt: now,
      })
      .where(where)
      .returning({ id: applicationSubmissions.id });
    if (changed.length === 0) throw new Superseded(); // rolls back the attachments row too
  });
}

/**
 * The export, or the store's code to record when it cannot be retried (now or ever). A
 * retryable failure with tries left, or anything the store did not classify, is thrown.
 */
async function exportOnce(
  ctx: JobContext,
  store: DocumentStore,
  userCtx: UserCtx,
  resume: Resume,
): Promise<Outcome> {
  let result: DocumentExportResult;
  try {
    // The user's own stored ref (sec on #115): never anything a request carried.
    result = await store.exportFile(userCtx, resume.docRef);
  } catch (err) {
    if (!(err instanceof DocumentExportError)) throw err;
    if (err.retryable && ctx.attempt < ctx.maxAttempts) throw err;
    return { kind: 'failed', code: err.code };
  }
  return result.ok ? { kind: 'ready', result } : { kind: 'unsupported' };
}

type SubmissionRow = typeof applicationSubmissions.$inferSelect;

/**
 * The attempt, when this job still has work on it: a draft, pending, naming this job's resume or
 * none (a chosen resume deleted since, which this job records). Undefined otherwise.
 */
async function wanted(
  db: Db,
  userId: string,
  payload: Payload,
): Promise<SubmissionRow | undefined> {
  const row = await db
    .select()
    .from(applicationSubmissions)
    .where(
      and(
        eq(applicationSubmissions.id, payload.submissionId),
        eq(applicationSubmissions.userId, userId),
      ),
    )
    .get();
  if (row === undefined || row.status !== 'draft' || row.snapshotState !== 'pending') return;
  // Another resume chosen since has a job of its own.
  if (row.resumeId !== null && row.resumeId !== payload.resumeId) return;
  return row;
}

export const submissionSnapshotJob: JobHandler<Payload> = {
  kind: SNAPSHOT_JOB_KIND,
  payloadSchema: Payload,
  maxAttempts: SNAPSHOT_MAX_ATTEMPTS,
  async run(db, payload, ctx) {
    // Enqueued with the owner's id (repos/submissions.ts); without one there is no user to act for.
    if (ctx.userId === null) return;
    const userCtx: UserCtx = { userId: ctx.userId, isAdmin: false };
    const storage = requireService(ctx, 'storage');
    let outcomeKind: Outcome['kind'] | 'skipped' = 'skipped';
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const row = await wanted(db, userCtx.userId, payload);
      if (row === undefined) {
        // Nothing (more) to do: settled, cancelled, or another resume chosen.
        await ctx.setResult({ outcome: outcomeKind });
        return;
      }
      const resume =
        row.resumeId === null
          ? undefined
          : await db
              .select()
              .from(resumes)
              .where(and(eq(resumes.id, row.resumeId), eq(resumes.userId, userCtx.userId)))
              .get();
      try {
        // A resume deleted after it was chosen has nothing to export until another is chosen.
        const outcome: Outcome =
          resume === undefined
            ? { kind: 'failed', code: 'not_found' }
            : await exportOnce(ctx, storeOf(ctx, resume.store), userCtx, resume);
        await record(db, { storage }, row, resume ?? null, outcome);
        outcomeKind = outcome.kind;
      } catch (err) {
        // The attempt changed while this ran: look again.
        if (err instanceof Superseded) continue;
        if (ctx.attempt < ctx.maxAttempts) throw err; // the runner tries again after its backoff
        // The last try failed for a reason the store did not classify (a throw of its own, or
        // our storage or database). Settle the attempt anyway, so it never stays pending.
        try {
          await record(db, { storage }, row, resume ?? null, {
            kind: 'failed',
            code: 'unavailable',
          });
          outcomeKind = 'failed';
        } catch (again) {
          if (again instanceof Superseded) continue;
          throw again;
        }
      }
      // Written. Choosing this same resume again from here on could not queue a job of its own
      // (this one still counts as running), so look again before ending (tl on #131).
      await racePoint('submissions.snapshot.afterWrite');
    }
    throw new Error('snapshot: the same resume kept being chosen again; trying again later');
  },
};

/**
 * How long a draft may sit pending before the reconciling pass queues its snapshot again. Well
 * past a normal export, so the pass never races the job a choice just queued.
 */
export const SNAPSHOT_PENDING_GRACE_MS = 5 * 60 * 1000;
export const SNAPSHOT_RECONCILE_JOB_KIND = 'submissions.snapshot_reconcile';
/** Every ten minutes; seeded only while the feature is on (app.ts). */
export const SNAPSHOT_RECONCILE_CRON = '*/10 * * * *';
/** Drafts one pass looks at, oldest first; the next pass takes the rest. */
const RECONCILE_BATCH = 200;

/**
 * Queues the snapshot for every draft that has been pending longer than the grace period (tl on
 * #131). Queueing is a no-op while that attempt's job for its resume is queued or running, so
 * this only starts work for a draft nothing will otherwise settle: one whose job ended before a
 * later choice of the same resume, died, or was never queued (a create interrupted between its
 * insert and its enqueue, or a row from before the snapshot existed).
 */
export async function reconcilePendingSnapshots(
  db: Db,
  opts: { now?: number } = {},
): Promise<{ checked: number }> {
  const before = (opts.now ?? Date.now()) - SNAPSHOT_PENDING_GRACE_MS;
  const stale = await db
    .select({
      id: applicationSubmissions.id,
      userId: applicationSubmissions.userId,
      resumeId: applicationSubmissions.resumeId,
    })
    .from(applicationSubmissions)
    .where(
      and(
        eq(applicationSubmissions.status, 'draft'),
        eq(applicationSubmissions.snapshotState, 'pending'),
        lt(applicationSubmissions.updatedAt, before),
      ),
    )
    .orderBy(asc(applicationSubmissions.updatedAt))
    .limit(RECONCILE_BATCH)
    .all();
  for (const row of stale) await enqueueSnapshot(db, row.userId, row.id, row.resumeId);
  return { checked: stale.length };
}

export const snapshotReconcileJob: JobHandler<Record<string, never>> = {
  kind: SNAPSHOT_RECONCILE_JOB_KIND,
  payloadSchema: z.object({}).strict() as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    await ctx.setResult(await reconcilePendingSnapshots(db));
  },
};
