// ATS board detection (FR-D9). For one company: probe the public board APIs of the supported
// ATS providers (Greenhouse, Lever, Ashby) for likely org slugs derived from its name and
// domain; failing that, read the company's own careers page (safeFetch allowPublic: https only,
// prohibited hosts refused, private addresses blocked on every hop) and look for links to those
// boards. The first verified hit is written to the company (ats_kind, ats_ref, ats_verified_at)
// and becomes a discovery source.
//
// Workday (FR-D10) is addressed by tenant plus site on a host whose datacenter label cannot be
// guessed, so it is never probed from a name: a Workday board is learned only from a URL (the
// careers URL itself, or a Workday link on the careers page). Its weekly service window answers
// with redirects, 406, 422 and 5xx; every one of those is transient (AtsDetectTransientError),
// never a recorded 'none', or a Friday-night probe would mark the company boardless. Nothing found: ats_kind 'none', and the company asks the user
// for a careers URL when it has none (needsCareersUrl in the company API).
//
// Re-verification: a weekly instance job queues detection again for every followed company whose
// verification is older than 30 days (or that was never checked), which catches ATS migrations.
//
// Polling follows the company's status (FR-D5): a board source is enabled only while its company
// is followed, on the user's default cron (discovery_default_cron:<userId>, default 0 7 * * *).
// syncFollowedCompany applies a follow or unfollow; setDiscoveryDefaultCron moves the sources
// still on the old default when the user changes it.
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { type Db } from '../db/client';
import { companies } from '../db/schema';
import type { UserCtx } from '../repos/base';
import { requireService, type JobHandler } from './registry';
import {
  ATS_DETECT_KIND,
  ATS_REVERIFY_KIND,
  detectAts,
  enqueueAtsDetect,
  REVERIFY_AFTER_MS,
} from '../lib/atsDetect';

const PayloadSchema = z.object({ companyId: z.string().min(1).max(64) });

export const atsDetectJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: ATS_DETECT_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 3,
  async run(db, payload, ctx) {
    if (ctx.userId === null) throw new Error(`${ATS_DETECT_KIND} needs a user`);
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    const outcome = await detectAts(db, user, payload.companyId, {
      fetch: requireService(ctx, 'sourceFetch'),
      log: requireService(ctx, 'log'),
    });
    await ctx.setResult(outcome);
  },
};

/** Followed companies whose board check is missing or older than REVERIFY_AFTER_MS. */
export async function queueReverification(db: Db, now: number = Date.now()): Promise<number> {
  const stale = await db
    .select({ id: companies.id, userId: companies.userId })
    .from(companies)
    .where(
      and(
        eq(companies.status, 'followed'),
        or(isNull(companies.atsVerifiedAt), lt(companies.atsVerifiedAt, now - REVERIFY_AFTER_MS)),
      ),
    )
    .all();
  for (const c of stale) {
    await enqueueAtsDetect(db, { userId: c.userId, isAdmin: false }, c.id);
  }
  return stale.length;
}

export const atsReverifyJob: JobHandler<Record<string, never>> = {
  kind: ATS_REVERIFY_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  maxAttempts: 1,
  async run(db, _payload, ctx) {
    await ctx.setResult({ queued: await queueReverification(db) });
  },
};
