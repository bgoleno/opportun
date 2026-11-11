// The nightly network probe (https://github.com/bgoleno/opportun/issues/296, tl's design and sec's
// review there). A company where the user knows someone, not followed, not denied and never probed,
// gets one board probe on a later night, so the tagging has its job titles and its row shows the
// board and the estimate without a click.
//
// Off unless the user turns it on (NETWORK_BOARD_CHECK_SETTING): nobody clicks for these requests.
// What leaves the server: board names guessed from the company's name and domain, sent to the
// public board APIs of Greenhouse, Lever and Ashby only (detection's `boardApisOnly`), never the
// company's own careers page and never a Workday site. At most NETWORK_PROBES_PER_NIGHT companies
// a night for each user, through the vendor queue, one of this kind at a time on the instance.
//
// A vendor that says slow down (a 429 or a 5xx) ends that user's night: the probe makes no request
// after it, and the user's pending probes are cancelled. The rest wait for the next night.
import { CronExpressionParser } from 'cron-parser';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { SourceContext } from '../adapters/discoverySource';
import type { Db } from '../db/client';
import { jsonText } from '../db/dialect';
import { companies, jobs, networkContacts, users } from '../db/schema';
import type { UserCtx } from '../repos/base';
import { readUserSetting } from '../repos/userSettings';
import { recordNone } from './atsDetect';
import { probeCompanyBoard, recordProbe } from './companyBoardProbe';
import { requireService, type JobHandler } from './registry';
import { cancelJob } from './runner';
import { enqueueVendorCheck } from './vendorCheckQueue';

export const NETWORK_PROBE_KIND = 'company.network_probe';
export const NETWORK_PROBE_SWEEP_KIND = 'company.network_probe_sweep';
/** Each night before the tagging (05:45), so the titles are there when it runs. */
export const NETWORK_PROBE_SWEEP_CRON = '15 5 * * *';
export const NETWORK_PROBES_PER_NIGHT = 20;
/** A company whose provider failed on this many nights is recorded as having no board. */
export const NETWORK_PROBE_FAILED_NIGHTS = 3;
export const NETWORK_BOARD_CHECK_SETTING = 'network_board_check';
/** The reason on a probe cancelled because a vendor said slow down. */
export const NETWORK_PROBE_STOPPED =
  'a board provider asked to slow down: the rest wait for the next night';

export const networkProbeDedupeKey = (companyId: string): string =>
  `${NETWORK_PROBE_KIND}:${companyId}`;

/** Whether the user has turned the nightly network probe on. Off by default. */
export async function readNetworkBoardCheck(db: Db, ctx: UserCtx): Promise<boolean> {
  return await readUserSetting(db, ctx, NETWORK_BOARD_CHECK_SETTING, z.boolean(), false);
}

/**
 * When tonight's run started: the latest scheduled sweep at or before `now`, in the scheduler's own
 * time (runner.ts). Every probe queued since then is tonight's, whatever became of it, so a second
 * run the same night counts the first one's.
 */
export function nightStart(now: number): number {
  return CronExpressionParser.parse(NETWORK_PROBE_SWEEP_CRON, {
    currentDate: new Date(now + 1),
  })
    .prev()
    .getTime();
}

/** How many of the user's network probes were queued since `since`, in any state. */
async function takenSince(db: Db, ctx: UserCtx, since: number): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, NETWORK_PROBE_KIND),
        eq(jobs.userId, ctx.userId),
        gte(jobs.createdAt, since),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Whether a vendor said slow down to one of the user's probes since `since`: the probe that was
 * told (its result says so) or one cancelled because of it. Then the rest of the night waits.
 */
async function stoppedSince(db: Db, ctx: UserCtx, since: number): Promise<boolean> {
  const row = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, NETWORK_PROBE_KIND),
        eq(jobs.userId, ctx.userId),
        gte(jobs.createdAt, since),
        or(
          eq(jobs.lastError, NETWORK_PROBE_STOPPED),
          eq(jsonText(jobs.result, 'reason'), 'slow_down'),
        ),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}

/**
 * Up to `limit` of the user's companies to probe: a current contact there, not followed, not
 * denied, never probed, and not yet given up on. Most contacts first, then by name.
 */
export async function pickNetworkCompanies(db: Db, ctx: UserCtx, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const contacts = count(networkContacts.id);
  const rows = await db
    .select({ id: companies.id, contacts })
    .from(companies)
    .innerJoin(
      networkContacts,
      and(
        eq(networkContacts.currentCompanyId, companies.id),
        eq(networkContacts.userId, ctx.userId),
      ),
    )
    .where(
      and(
        eq(companies.userId, ctx.userId),
        inArray(companies.status, ['none', 'suggested']),
        isNull(companies.boardProbedAt),
        lt(companies.boardProbeFailedNights, NETWORK_PROBE_FAILED_NIGHTS),
      ),
    )
    .groupBy(companies.id, companies.name)
    .orderBy(desc(contacts), asc(companies.name), asc(companies.id))
    .limit(limit)
    .all();
  return rows.map((r) => r.id);
}

/**
 * Queues tonight's probes for one user: none when the setting is off, and never more than
 * NETWORK_PROBES_PER_NIGHT since tonight's run started. Returns how many it queued.
 */
export async function queueNightForUser(db: Db, ctx: UserCtx, now: number): Promise<number> {
  if (!(await readNetworkBoardCheck(db, ctx))) return 0;
  const since = nightStart(now);
  if (await stoppedSince(db, ctx, since)) return 0;
  const room = NETWORK_PROBES_PER_NIGHT - (await takenSince(db, ctx, since));
  const picks = await pickNetworkCompanies(db, ctx, room);
  for (const companyId of picks) {
    await enqueueVendorCheck(
      db,
      ctx,
      NETWORK_PROBE_KIND,
      { companyId },
      networkProbeDedupeKey(companyId),
    );
  }
  return picks.length;
}

/** The nightly sweep: each user's setting is read at the start of that user's run. */
export async function sweepNetworkProbes(db: Db, now: number = Date.now()): Promise<number> {
  const all = await db.select({ id: users.id }).from(users).all();
  let queued = 0;
  for (const { id } of all)
    queued += await queueNightForUser(db, { userId: id, isAdmin: false }, now);
  return queued;
}

/** Cancels the user's pending network probes: a vendor said slow down. */
async function stopTheNight(db: Db, ctx: UserCtx): Promise<number> {
  const pending = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, NETWORK_PROBE_KIND),
        eq(jobs.userId, ctx.userId),
        eq(jobs.status, 'pending'),
      ),
    )
    .all();
  let cancelled = 0;
  for (const { id } of pending) {
    if ((await cancelJob(db, id, NETWORK_PROBE_STOPPED)) !== undefined) cancelled += 1;
  }
  return cancelled;
}

/**
 * The probe's fetch for this job: it refuses every request after a vendor answered 429 or 5xx, so
 * detection's remaining guesses go nowhere. (Detection counts a refused request as a failed
 * guess and ends by throwing its transient error, which the job turns into the night's end.)
 */
function slowDownGuard(sctx: SourceContext): { sctx: SourceContext; slowedDown: () => boolean } {
  let slowedDown = false;
  const fetch: SourceContext['fetch'] = async (url, opts) => {
    if (slowedDown) throw new Error('the board provider asked to slow down');
    const res = await sctx.fetch(url, opts);
    if (res.status === 429 || res.status >= 500) slowedDown = true;
    return res;
  };
  return { sctx: { ...sctx, fetch }, slowedDown: () => slowedDown };
}

export type NetworkProbeOutcome =
  | { status: 'probed'; board: boolean }
  | { status: 'skipped'; reason: 'off' | 'stopped' | 'missing' | 'followed' | 'denied' | 'probed' }
  | { status: 'failed'; reason: 'slow_down' | 'error'; givenUp: boolean };

/** One company's probe: everything is checked again first, since the pick was made hours ago. */
export async function runNetworkProbe(
  db: Db,
  ctx: UserCtx,
  companyId: string,
  sctx: SourceContext,
): Promise<NetworkProbeOutcome> {
  if (!(await readNetworkBoardCheck(db, ctx))) return { status: 'skipped', reason: 'off' };
  if (await stoppedSince(db, ctx, nightStart(Date.now()))) {
    return { status: 'skipped', reason: 'stopped' };
  }
  const company = await db
    .select({
      status: companies.status,
      boardProbedAt: companies.boardProbedAt,
      failedNights: companies.boardProbeFailedNights,
    })
    .from(companies)
    .where(and(eq(companies.userId, ctx.userId), eq(companies.id, companyId)))
    .get();
  if (company === undefined) return { status: 'skipped', reason: 'missing' };
  // Denied: no request at all. Followed: Follow's own detection runs, with the source enabled.
  if (company.status === 'denied') return { status: 'skipped', reason: 'denied' };
  if (company.status === 'followed') return { status: 'skipped', reason: 'followed' };
  if (company.boardProbedAt !== null) return { status: 'skipped', reason: 'probed' };
  const guard = slowDownGuard(sctx);
  try {
    const outcome = await probeCompanyBoard(db, ctx, companyId, guard.sctx, {
      boardApisOnly: true,
    });
    return { status: 'probed', board: outcome.status === 'probed' && outcome.kind !== null };
  } catch (err) {
    // A vendor error records nothing about the board: the company is picked again on a later night,
    // unless this was its last allowed failure.
    sctx.log.warn(
      { 'opportun.company.id': companyId, 'error.type': err instanceof Error ? err.name : 'Error' },
      'network board probe failed',
    );
    const failedNights = company.failedNights + 1;
    await db
      .update(companies)
      .set({ boardProbeFailedNights: failedNights })
      .where(and(eq(companies.userId, ctx.userId), eq(companies.id, companyId)))
      .run();
    const givenUp = failedNights >= NETWORK_PROBE_FAILED_NIGHTS;
    if (givenUp) {
      await recordNone(db, ctx, companyId);
      await recordProbe(db, ctx, companyId, { openJobs: null, prefilterMatches: null });
    }
    if (!guard.slowedDown()) return { status: 'failed', reason: 'error', givenUp };
    await stopTheNight(db, ctx);
    return { status: 'failed', reason: 'slow_down', givenUp };
  }
}

const PayloadSchema = z.object({ companyId: z.string().min(1).max(64) });

export const networkProbeJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: NETWORK_PROBE_KIND,
  payloadSchema: PayloadSchema,
  // Never retried the same night: a failure waits for a later night's pick.
  maxAttempts: 1,
  async run(db, payload, ctx) {
    if (ctx.userId === null) throw new Error(`${NETWORK_PROBE_KIND} needs a user`);
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    await ctx.setResult(
      await runNetworkProbe(db, user, payload.companyId, {
        fetch: requireService(ctx, 'sourceFetch'),
        log: requireService(ctx, 'log'),
      }),
    );
  },
};

export const networkProbeSweepJob: JobHandler<Record<string, never>> = {
  kind: NETWORK_PROBE_SWEEP_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  maxAttempts: 2,
  async run(db, _payload, ctx) {
    // Counts only: no company names in the job's result.
    await ctx.setResult({ queued: await sweepNetworkProbes(db) });
  },
};
