// The nightly network probe (https://github.com/bgoleno/opportun/issues/296, tl's design and sec's
// review there). A company where the user knows someone, not followed, not denied and never probed,
// gets one board probe on a later night, so the tagging has its job titles and its row shows the
// board and the estimate without a click.
//
// On unless the user turns it off (NETWORK_BOARD_CHECK_SETTING), as the owner decided: a feature is
// on by default with an option to disable it. Nobody clicks for these requests, so what follows
// is not loosened for it. What leaves the server: board names guessed from the company's name and domain, sent to the
// public board APIs of Greenhouse, Lever and Ashby only (detection's `boardApisOnly`), never the
// company's own careers page and never a Workday site. At most NETWORK_PROBES_PER_NIGHT companies
// a night for each user, through the vendor queue, one of this kind at a time on the instance.
//
// A vendor that says slow down (a 429 or a 5xx) ends that user's night: the probe makes no request
// after it, and the user's pending probes are cancelled. The rest wait for the next night. It also
// stops this job's requests to that vendor for every user until the next night's sweep; the other
// two vendors go on.
import { CronExpressionParser } from 'cron-parser';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import type { SourceContext } from '../adapters/discoverySource';
import type { Db } from '../db/client';
import { jsonText } from '../db/dialect';
import { companies, jobs, networkContacts, settings, users } from '../db/schema';
import { FetchBlockedError, type FetchBlockedReason } from '../lib/safeFetch';
import type { UserCtx } from '../repos/base';
import { userSettingKey } from '../repos/userSettings';
import { ATS_PROBES, recordNone, type AtsKind } from './atsDetect';
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
/** The longest a company that stopped a vendor is left out of the nightly pick (#518). */
export const NETWORK_PROBE_PARK_MAX_NIGHTS = 8;
/** The reason on a probe cancelled because a vendor said slow down. */
export const NETWORK_PROBE_STOPPED =
  'a board provider asked to slow down: the rest wait for the next night';

export const networkProbeDedupeKey = (companyId: string): string =>
  `${NETWORK_PROBE_KIND}:${companyId}`;

/**
 * Whether the nightly network probe runs for the user: on when nothing is stored (a user who never
 * changed it, existing users included), or when the stored value is on; off for any other stored
 * value. Not readUserSetting: it gives its fallback, here on, for a stored value that fails its
 * schema too, so a damaged off would read as on (sec, criterion 15 on #296). The job and the
 * Settings page both read this, so the page shows what the job will do.
 */
export async function readNetworkBoardCheck(db: Db, ctx: UserCtx): Promise<boolean> {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.key, userSettingKey(NETWORK_BOARD_CHECK_SETTING, ctx.userId)),
        eq(settings.userId, ctx.userId),
      ),
    )
    .get();
  return row === undefined || row.value === true;
}

/** The instance-wide row that says a vendor asked this job to slow down, and when. */
export const vendorStopKey = (kind: AtsKind): string => `network_probe_vendor_stop.${kind}`;

/**
 * Whether a vendor said slow down to this job tonight, for any user: its stop row was written
 * since tonight's sweep began (sec, criterion 16 on #296). The row belongs to the instance
 * (user_id null, as obs_collect's), so no user's export carries it, and it is in the database, so
 * a restart the same night does not start the requests again.
 */
async function vendorStopped(db: Db, kind: AtsKind, now: number): Promise<boolean> {
  const row = await db
    .select({ at: settings.updatedAt })
    .from(settings)
    .where(and(eq(settings.key, vendorStopKey(kind)), isNull(settings.userId)))
    .get();
  return row !== undefined && row.at >= nightStart(now);
}

/**
 * Stops this job's requests to a vendor for every user until the next night's sweep. An upsert
 * that sets the time, never a read and a rewrite, so two probes told at once cannot lose it.
 */
async function stopVendor(db: Db, kind: AtsKind, now: number): Promise<void> {
  await db
    .insert(settings)
    .values({ key: vendorStopKey(kind), userId: null, value: now, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: now, updatedAt: now } })
    .run();
}

/** The vendor a board API request goes to, by its fixed host. */
const VENDOR_OF_HOST: ReadonlyMap<string, AtsKind> = new Map(
  ATS_PROBES.map((p) => [p.host, p.kind]),
);

function vendorOf(url: string): AtsKind | undefined {
  try {
    return VENDOR_OF_HOST.get(new URL(url).hostname);
  } catch {
    return undefined;
  }
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

/**
 * The start of the night `nights` after tonight's. Noon of that day, then back to its 05:15, so a
 * daylight-saving change in between (a 23- or 25-hour day) still lands on that night.
 */
function nightsAfter(now: number, nights: number): number {
  return nightStart(nightStart(now) + nights * 24 * 60 * 60_000 + 7 * 60 * 60_000);
}

/**
 * When a company whose own request stopped a vendor tonight is picked again (#518, tl's design):
 * after 2^(stops-1) nights out of the pick, at most NETWORK_PROBE_PARK_MAX_NIGHTS. The doubling
 * bounds how often one company whose request always fails can stop its vendor for every user.
 */
export function parkedUntil(now: number, stops: number): number {
  const nights = Math.min(2 ** Math.max(stops - 1, 0), NETWORK_PROBE_PARK_MAX_NIGHTS);
  return nightsAfter(now, nights + 1);
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
 * The board kinds this job may check: the three it guesses on. A company with any other board on
 * record (a Workday board, found from its careers URL while it was followed) is not this job's.
 * Under boardApisOnly detection skips that board, so its guesses missing would record "none" over
 * it (tl's blocking 1 on #462, https://github.com/bgoleno/opportun/pull/462).
 */
const NETWORK_BOARD_KINDS: readonly AtsKind[] = ATS_PROBES.map((p) => p.kind);

/** Whether this job may probe a company with `atsKind` on record: none yet, or one of the three. */
function isNetworkBoardKind(atsKind: string | null): boolean {
  return atsKind === null || (NETWORK_BOARD_KINDS as readonly string[]).includes(atsKind);
}

/**
 * Up to `limit` of the user's companies to probe: a current contact there, not followed, not
 * denied, never probed, not yet given up on, and no board on record but one of the three.
 * Most contacts first, then by name.
 */
export async function pickNetworkCompanies(
  db: Db,
  ctx: UserCtx,
  limit: number,
  tonight: number,
): Promise<string[]> {
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
        // Parked after stopping a vendor (#518): not picked until its park ends.
        or(isNull(companies.boardProbeParkedUntil), lte(companies.boardProbeParkedUntil, tonight)),
        or(isNull(companies.atsKind), inArray(companies.atsKind, [...NETWORK_BOARD_KINDS])),
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
  const picks = await pickNetworkCompanies(db, ctx, room, since);
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
 * safeFetch's refusals that come after the vendor answered: a body over the cap, or a redirect it
 * will not follow (to another host or scheme, or past the limit). Every other error from the fetch
 * means the request got no answer at all.
 */
const ANSWERED_REFUSALS: ReadonlySet<FetchBlockedReason> = new Set([
  'too_large',
  'redirect_blocked',
  'host_not_allowed',
  'scheme',
]);

/**
 * The probe's fetch for this job.
 * - Before each request it reads whether that request's vendor is stopped tonight for the
 *   instance, so a probe already running for another user stops asking it from its next request on.
 * - After this probe is told 429 or 5xx, or a request gets no answer at all (a failed DNS lookup,
 *   a refused connection, a timeout, a TLS failure, a board host resolving to a private address),
 *   it stops that vendor for the instance, and refuses every further request of its own, so
 *   detection's remaining guesses go nowhere. tl's ruling on #462
 *   (https://github.com/bgoleno/opportun/pull/462): neither says anything about the company's
 *   board, so neither may count toward "no board"; on an instance with no network, every night's
 *   companies would otherwise reach the failed-night limit and be recorded as having none.
 * Detection counts a refused request as a failed guess and ends by throwing its transient error,
 * so a refusal never records "no board"; the job then tells the two cases apart.
 */
function slowDownGuard(
  db: Db,
  sctx: SourceContext,
): { sctx: SourceContext; slowedDown: () => boolean; skippedStopped: () => boolean } {
  let slowedDown = false;
  let skippedStopped = false;
  const fetch: SourceContext['fetch'] = async (url, opts) => {
    if (slowedDown) throw new Error('the board provider asked to slow down');
    const vendor = vendorOf(url);
    if (vendor !== undefined && (await vendorStopped(db, vendor, Date.now()))) {
      skippedStopped = true;
      throw new Error('this board provider asked to slow down tonight');
    }
    let res;
    try {
      res = await sctx.fetch(url, opts);
    } catch (err) {
      if (!(err instanceof FetchBlockedError && ANSWERED_REFUSALS.has(err.reason))) {
        slowedDown = true;
        if (vendor !== undefined) await stopVendor(db, vendor, Date.now());
      }
      throw err;
    }
    if (res.status === 429 || res.status >= 500) {
      slowedDown = true;
      if (vendor !== undefined) await stopVendor(db, vendor, Date.now());
    }
    return res;
  };
  return {
    sctx: { ...sctx, fetch },
    slowedDown: () => slowedDown,
    skippedStopped: () => skippedStopped,
  };
}

export type NetworkProbeOutcome =
  | { status: 'probed'; board: boolean }
  | {
      status: 'skipped';
      reason:
        | 'off'
        | 'stopped'
        | 'vendor_stopped'
        | 'missing'
        | 'followed'
        | 'denied'
        | 'probed'
        | 'other_board';
    }
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
      stops: companies.boardProbeStops,
      parkedUntil: companies.boardProbeParkedUntil,
      atsKind: companies.atsKind,
    })
    .from(companies)
    .where(and(eq(companies.userId, ctx.userId), eq(companies.id, companyId)))
    .get();
  if (company === undefined) return { status: 'skipped', reason: 'missing' };
  // Denied: no request at all. Followed: Follow's own detection runs, with the source enabled.
  if (company.status === 'denied') return { status: 'skipped', reason: 'denied' };
  if (company.status === 'followed') return { status: 'skipped', reason: 'followed' };
  if (company.boardProbedAt !== null) return { status: 'skipped', reason: 'probed' };
  if (!isNetworkBoardKind(company.atsKind)) return { status: 'skipped', reason: 'other_board' };
  const guard = slowDownGuard(db, sctx);
  const thisCompany = and(eq(companies.userId, ctx.userId), eq(companies.id, companyId));
  // An answered probe ends any park (#518): the vendor answers this company's requests again.
  const unpark = async () => {
    if (company.stops === 0 && company.parkedUntil === null) return;
    await db
      .update(companies)
      .set({ boardProbeStops: 0, boardProbeParkedUntil: null })
      .where(thisCompany)
      .run();
  };
  try {
    const outcome = await probeCompanyBoard(db, ctx, companyId, guard.sctx, {
      boardApisOnly: true,
    });
    await unpark();
    return { status: 'probed', board: outcome.status === 'probed' && outcome.kind !== null };
  } catch (err) {
    // A vendor stopped tonight was not asked, and its board may be the one: nothing is recorded,
    // not "no board" and not a failed night, and the company waits for a later night (criterion 16).
    if (guard.skippedStopped() && !guard.slowedDown()) {
      return { status: 'skipped', reason: 'vendor_stopped' };
    }
    sctx.log.warn(
      { 'opportun.company.id': companyId, 'error.type': err instanceof Error ? err.name : 'Error' },
      'network board probe failed',
    );
    // Told to slow down, or no answer at all (slowDownGuard): the night stops, and nothing is
    // recorded for this company, not a failed night and not "no board" (sec's criterion 12, and
    // tl's ruling on #462). It is picked again on a later night.
    // This company's own request stopped the vendor for every user tonight, so it is parked out
    // of the pick for a while (#518, tl's design). Only here: a probe that skipped an already
    // stopped vendor (above) neither parks nor unparks it. Its board stays as it was, and so do its
    // failed nights.
    if (guard.slowedDown()) {
      const stops = Number(company.stops) + 1;
      await db
        .update(companies)
        .set({ boardProbeStops: stops, boardProbeParkedUntil: parkedUntil(Date.now(), stops) })
        .where(thisCompany)
        .run();
      await stopTheNight(db, ctx);
      return { status: 'failed', reason: 'slow_down', givenUp: false };
    }
    // A vendor answered, and the answer could not be used: that is a failed night. The company is
    // picked again on a later night, unless this was its last allowed failure.
    const failedNights = company.failedNights + 1;
    await db
      .update(companies)
      .set({ boardProbeFailedNights: failedNights })
      .where(thisCompany)
      .run();
    await unpark();
    const givenUp = failedNights >= NETWORK_PROBE_FAILED_NIGHTS;
    if (givenUp) {
      // "No board" only when none is on record. Detection can have found the board this night or
      // an earlier one (recordHit) before the listing read failed: giving up then keeps the board,
      // and only stops the company holding a slot (tl's blocking 2 on #462).
      const now = await db
        .select({ atsKind: companies.atsKind })
        .from(companies)
        .where(and(eq(companies.userId, ctx.userId), eq(companies.id, companyId)))
        .get();
      if (now === undefined || now.atsKind === null || now.atsKind === 'none') {
        await recordNone(db, ctx, companyId);
      }
      await recordProbe(db, ctx, companyId, { openJobs: null, prefilterMatches: null });
    }
    return { status: 'failed', reason: 'error', givenUp };
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
