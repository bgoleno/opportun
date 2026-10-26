// Nightly reset for the invitation-only demo instance (issue #280, PR2). Deliberately thin:
// the destructive work (a delete scoped to five pinned user ids, gated by an in-database
// marker, then a reseed) lives entirely in cli/seedDemo.ts's seedDemo(), which the delete-
// and-reseed design made a single function precisely so a caller never orchestrates the two
// steps itself and has to keep them consistent. This file is a JobHandler around that one
// call, plus the credentials it needs to make it.
//
// Three safety layers guard the delete inside seedDemo, and only the first two are safety:
// the pinned ids do not exist on a real database, so the delete finds nothing there by
// construction; the in-database marker (a settings row only seedDemo writes) refuses a delete
// against pinned ids that exist without it; and this job's own schedule being registered only
// when Config.demo is true is tidiness, not a guard -- registered unconditionally, the job
// would still delete zero rows on a real database, because the first two layers do not depend
// on how the job was invoked.
import { credsFromEnv, seedDemo, type SeedDemoReport } from '../cli/seedDemo';
import type { Db } from '../db/client';
import { audit } from '../lib/audit';
import { requireService, type JobHandler } from './registry';
import { z } from 'zod';

export const DEMO_RESET_JOB_KIND = 'demo.reset';
/** 04:30: after the 03:00 backup and the other nightly maintenance jobs. No ordering
 *  dependency on any of them -- the data this resets is invented fixture content, fully
 *  reproducible by re-running seedDemo, not something that needs to survive in a backup. */
export const DEMO_RESET_CRON = '30 4 * * *';

export class DemoCredentialsMissingError extends Error {}

/**
 * The testable core, taking env as an explicit parameter (#292) rather than reading
 * process.env directly, so a test passes a literal object and the real one is never touched.
 * The JobHandler below is the only caller that lets env default.
 */
export async function runDemoReset(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<SeedDemoReport> {
  const creds = credsFromEnv(env);
  if (creds === undefined) {
    throw new DemoCredentialsMissingError(
      'refusing to reset: OPPORTUN_DEMO_ADMIN_PASSWORD, OPPORTUN_DEMO_USER1..4_PASSWORD and ' +
        'OPPORTUN_DEMO_AI_KEY (or OPPORTUN_DEMO_AI_KEY_FILE) must all be set. This mirrors the ' +
        "seedDemo CLI's own usage check, reached here instead of at a terminal.",
    );
  }
  return seedDemo(db, creds, now, env);
}

export const demoResetJob: JobHandler<Record<string, never>> = {
  kind: DEMO_RESET_JOB_KIND,
  payloadSchema: z.object({}).strict() as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    const report = await runDemoReset(db, requireService(ctx, 'env'));
    await ctx.setResult(report);
    // Durable, queryable record that a reset ran and what it did (design principle 6), the
    // same reasoning as attachments.swept and jobs.pruned: never the credentials, just counts.
    await audit(db, 'demo.reset', { detail: { ...report } });
  },
};
