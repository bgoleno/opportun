// The submission expiry sweep (assisted apply M1c, https://github.com/bgoleno/opportun/issues/116;
// design Part A 4.3): a review not handed off within 30 minutes, and a handoff left without an
// outcome for 14 days, become abandoned. The work is repos/submissionReview.ts sweepSubmissions;
// this registers it as a job. It acts on expired attempts only, one row at a time, each in its
// own conditional update, and never contacts anyone.
import { z } from 'zod';
import { SUBMISSION_EXPIRE_JOB_KIND, sweepSubmissions } from '../repos/submissionReview';
import type { JobHandler } from './registry';

export { SUBMISSION_EXPIRE_JOB_KIND };

/**
 * Every five minutes: a review lasts 30 minutes, so an expired one is marked within a few
 * minutes of its time. The handoff itself refuses an expired review on its own clock
 * regardless, so the sweep is bookkeeping, not the guard.
 */
export const SUBMISSION_EXPIRE_CRON = '*/5 * * * *';

export const submissionExpireJob: JobHandler<Record<string, never>> = {
  kind: SUBMISSION_EXPIRE_JOB_KIND,
  payloadSchema: z.object({}).strict() as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    const abandoned = await sweepSubmissions(db);
    // Each abandoned attempt has its own submission.abandoned audit entry; the count is the run's.
    await ctx.setResult({ abandoned });
  },
};
