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
import type { FastifyBaseLogger } from 'fastify';
import { credsFromEnv, seedDemo, type SeedDemoReport } from '../cli/seedDemo';
import type { Db } from '../db/client';
import { audit } from '../lib/audit';
import { DemoResetGateTimeout, type DemoResetGate } from '../lib/demoResetGate';
import { racePoint } from '../lib/racePoints';
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

/**
 * The reset behind the gate (#618, lib/demoResetGate.ts): it waits until no request or shared demo
 * account's job is in, holds new ones off while it deletes and reseeds, and gives up, resetting
 * nothing, when they are not all out in time. Giving up throws, so the job fails and retries
 * later: no reset is better than one that lets an old write land in the reseeded accounts. With
 * no gate (the seed CLI, and a server that is not a demo) it is the plain reset.
 */
export async function runDemoResetGated(
  db: Db,
  env: NodeJS.ProcessEnv,
  gate: DemoResetGate | undefined,
  opts: { timeoutMs?: number; log?: FastifyBaseLogger } = {},
): Promise<SeedDemoReport> {
  if (gate === undefined) return runDemoReset(db, env);
  try {
    return await gate.exclusive(async () => {
      await racePoint('demo.reset.locked');
      return runDemoReset(db, env);
    }, opts.timeoutMs);
  } catch (err) {
    if (err instanceof DemoResetGateTimeout) {
      opts.log?.warn(
        { 'opportun.demo_reset.holders': gate.held },
        'demo reset waited too long for requests or jobs in flight; not reset, will retry',
      );
    }
    throw err;
  }
}

export const demoResetJob: JobHandler<Record<string, never>> = {
  kind: DEMO_RESET_JOB_KIND,
  payloadSchema: z.object({}).strict() as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    const report = await runDemoResetGated(
      db,
      requireService(ctx, 'env'),
      ctx.services.demoResetGate,
      ctx.services.log === undefined ? {} : { log: ctx.services.log },
    );
    await ctx.setResult(report);
    // Durable, queryable record that a reset ran and what it did (design principle 6), the
    // same reasoning as attachments.swept and jobs.pruned: never the credentials, just counts.
    await audit(db, 'demo.reset', { detail: { ...report } });
  },
};
