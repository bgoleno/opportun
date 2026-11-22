// Queueing a submission attempt's resume snapshot (https://github.com/bgoleno/opportun/issues/788):
// the job's kind, its dedupe key and the enqueue call, in lib/ so the submissions repo queues it
// without importing the snapshot job (jobs/submissionSnapshot.ts), which runs it. The payload is
// checked by that job's schema when it is queued (lib/jobQueue.ts, through the registry).
import type { Db } from '../db/client';
import { enqueue } from './jobQueue';

export const SNAPSHOT_JOB_KIND = 'submission.snapshot';

/** One unfinished snapshot job per attempt and chosen resume (jobs_unfinished_dedupe_uq). */
export const snapshotJobKey = (submissionId: string, resumeId: string | null): string =>
  `${SNAPSHOT_JOB_KIND}:${submissionId}:${resumeId ?? 'none'}`;

/** Queues the snapshot of `resumeId` for an attempt; a no-op while that one is queued or running. */
export async function enqueueSnapshot(
  db: Db,
  userId: string,
  submissionId: string,
  resumeId: string | null,
): Promise<void> {
  await enqueue(
    db,
    SNAPSHOT_JOB_KIND,
    { submissionId, resumeId },
    {
      dedupeKey: snapshotJobKey(submissionId, resumeId),
      userId,
    },
  );
}
