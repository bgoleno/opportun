// The follow-up for applications with no confirmation (assisted apply M2a,
// https://github.com/bgoleno/opportun/issues/118; design Part A 5.5): the work is
// repos/submissionOutcome.ts followUpSubmissions; this registers it as a job. It acts on one
// attempt at a time, marks it `unknown` and gives the user a next step. It never retries,
// resubmits, sends or contacts anyone.
import { z } from 'zod';
import { followUpSubmissions } from '../repos/submissionOutcome';
import type { JobHandler } from './registry';

export const SUBMISSION_FOLLOWUP_JOB_KIND = 'submissions.followup';

/**
 * Hourly, so "no confirmation after 3 days" shows within the hour rather than up to a day late.
 * Seeded only while the feature is on (app.ts).
 */
export const SUBMISSION_FOLLOWUP_CRON = '20 * * * *';

export const submissionFollowupJob: JobHandler<Record<string, never>> = {
  kind: SUBMISSION_FOLLOWUP_JOB_KIND,
  payloadSchema: z.object({}).strict() as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    // Each marked attempt has its own submission.unknown audit entry; the count is the run's.
    await ctx.setResult({ marked: await followUpSubmissions(db) });
  },
};
