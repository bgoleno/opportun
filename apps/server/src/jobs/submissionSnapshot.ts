// The resume snapshot of an application attempt (assisted apply M1b,
// https://github.com/bgoleno/opportun/issues/115; design Part A 4.4 and 6.3, as amended by the
// Tech Lead on #115). It exports the attempt's resume through its own store as a PDF, stores
// the bytes as an attachments row on the opportunity, and records the hash on the attempt, so
// the record stays true after the document is edited or deleted.
//
// The resume is read from the stored attempt and the user's own resumes row, never from a
// request: the payload is the attempt's id alone. A store with no PDF to give says
// `export_unsupported`, and the attempt records `unsupported` with no hash; text is never
// stored in place of a PDF. Export failures the store calls retryable are retried by the
// runner while attempts remain; a permanent one, or the last attempt, records `failed` with the
// store's code and ends the job normally (done, not dead): the user retries by choosing the
// resume again (PATCH resumeId), which queues a new snapshot.
//
// A stale snapshot never lands. The user can choose another resume while an export runs. Every
// write is conditional on the attempt still being a draft, still pending, and still naming the
// resume that was exported; when it is not, the write (and its attachments row, in the same
// transaction) is dropped and the job exports the resume the attempt names now. While this job
// is queued or running, the dedupe key keeps a second one from being queued, so this loop is
// what catches a change made mid-export.
import { newId } from '@opportun/core';
import { and, eq, isNull } from 'drizzle-orm';
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

export const SNAPSHOT_JOB_KIND = 'submission.snapshot';

/** One unfinished snapshot job per attempt (jobs_unfinished_dedupe_uq). */
export const snapshotJobKey = (submissionId: string): string =>
  `${SNAPSHOT_JOB_KIND}:${submissionId}`;

/** Design 6.3: three tries with the runner's backoff, then the attempt shows the failure. */
export const SNAPSHOT_MAX_ATTEMPTS = 3;

/**
 * How many times one run follows the user to a newly chosen resume before it gives up and lets
 * the runner try later. A person switching resumes cannot outpace an export many times over.
 */
const MAX_ROUNDS = 3;

const Payload = z.object({ submissionId: z.string().min(1) }).strict();
type Payload = z.infer<typeof Payload>;

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

export const submissionSnapshotJob: JobHandler<Payload> = {
  kind: SNAPSHOT_JOB_KIND,
  payloadSchema: Payload,
  maxAttempts: SNAPSHOT_MAX_ATTEMPTS,
  async run(db, payload, ctx) {
    // Enqueued with the owner's id (repos/submissions.ts); without one there is no user to act for.
    if (ctx.userId === null) return;
    const userCtx: UserCtx = { userId: ctx.userId, isAdmin: false };
    const storage = requireService(ctx, 'storage');
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const row = await db
        .select()
        .from(applicationSubmissions)
        .where(
          and(
            eq(applicationSubmissions.id, payload.submissionId),
            eq(applicationSubmissions.userId, userCtx.userId),
          ),
        )
        .get();
      // Gone, no longer a draft, or already settled: nothing is wanted any more.
      if (row === undefined || row.status !== 'draft' || row.snapshotState !== 'pending') {
        await ctx.setResult({ outcome: 'skipped' });
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
        if (resume === undefined) {
          // The resume was deleted after it was chosen: nothing to export until another is.
          await record(db, { storage }, row, null, { kind: 'failed', code: 'not_found' });
          await ctx.setResult({ outcome: 'failed' });
          return;
        }
        const outcome = await exportOnce(ctx, storeOf(ctx, resume.store), userCtx, resume);
        await record(db, { storage }, row, resume, outcome);
        await ctx.setResult({ outcome: outcome.kind });
        return;
      } catch (err) {
        // The attempt changed while this ran: look again and export what it names now.
        if (err instanceof Superseded) continue;
        if (ctx.attempt < ctx.maxAttempts) throw err; // the runner tries again after its backoff
        // The last try failed for a reason the store did not classify (a throw of its own, or
        // our storage or database). Settle the attempt anyway, so it never stays pending.
        try {
          await record(db, { storage }, row, resume ?? null, {
            kind: 'failed',
            code: 'unavailable',
          });
        } catch (again) {
          if (again instanceof Superseded) continue;
          throw again;
        }
        await ctx.setResult({ outcome: 'failed' });
        return;
      }
    }
    throw new Error('snapshot: the chosen resume kept changing; trying again later');
  },
};
