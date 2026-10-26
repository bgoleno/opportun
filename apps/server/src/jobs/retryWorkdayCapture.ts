// Retries the detail fetch for a Workday posting left bare after it failed once (issue #101).
//
// Why the obvious paths do not already do this: workdaySource.fetchPostings' known.has(id)
// check (adapters/sources/workday.ts) skips re-fetching a posting's detail once any row with
// that external id exists, bare or not, and jobs/leadResolve.ts's recovery route goes through
// the exact same generator with the same knownExternalIds wiring. Neither a normal discovery
// run nor the one mechanism meant to recover a needs_capture lead ever gives a failed detail
// fetch a second try.
//
// Blast radius, deliberately narrow: this touches neither knownExternalIds nor fetchPostings.
// Teaching knownExternalIds to distinguish "known and described" from "known but bare" would
// change a capability every current and future discovery adapter shares; this is instead a
// dedicated path only the recovery route uses, keyed directly off a row's own stored
// postingUrl (parsed the same way a link in free text is, lib/atsJobRef's workdayPosting), with
// no listing walk and nothing else in discovery touched.
//
// Two bounds, for two different failure modes:
//
//   Per host, per run (CAPTURE_RETRY_MAX_PER_HOST_PER_RUN): workdaySource.fetchPostings' own
//   WORKDAY_MAX_DETAILS_PER_RUN cap is per-tenant for free, because one run only ever talks to
//   one source's host. This sweep is global -- one run can hold bare rows from many different
//   tenants -- so without its own per-host limit, an instance that has accumulated enough of
//   them for one tenant would fire a burst of detail requests at that one host in a tight loop,
//   which is exactly the shape of traffic that gets an integration rate-limited or blocked.
//   Reuses WORKDAY_PAGE_SIZE (20) as the number: no more per-tenant traffic in one sweep than one
//   ordinary listing page already causes.
//
//   Age (CAPTURE_RETRY_MAX_AGE_MS): past 14 days, a still-bare row stops being retried -- a
//   requisition that was pulled or a tenant that moved is not coming back. Leaving the row at
//   needs_capture forever would make it indistinguishable from one nobody has tried yet, so
//   crossing the age bound moves it to the new terminal resolution capture_failed instead
//   (packages/core/src/schemas/discovery.ts) -- a plain TEXT column with no DB-level enum
//   constraint (apps/server/drizzle/0000_init.sql), so this needed no migration, only the new
//   value and the two web call sites that branch on resolution (QueueRow's chip, QueueDialogs'
//   manual-capture offer, which capture_failed gets too: the one thing left that can still fill
//   in a description by hand).
import { dedupeKey, NormalizedPostingSchema, type NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  fetchWorkdayDetail,
  mapWorkdayPosting,
  WORKDAY_PAGE_SIZE,
  type WorkdayBoard,
} from '../adapters/sources/workday';
import type { Db } from '../db/client';
import { discoveryResults } from '../db/schema';
import { workdayPosting } from '../lib/atsJobRef';
import { sanitizePosting } from '../lib/postingSanitize';
import { boardFromUrl } from './atsDetect';
import { requireService, type JobHandler } from './registry';

export const RETRY_WORKDAY_CAPTURE_KIND = 'discovery.retry_workday_capture';
/** Daily: one GET per still-bare posting is cheap, and this recovers quickly from a transient
 *  failure rather than leaving a user waiting out the age bound for nothing. */
export const RETRY_WORKDAY_CAPTURE_CRON = '30 6 * * *';
/** Past this age a still-bare row moves to capture_failed instead of being retried again. */
export const CAPTURE_RETRY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Detail requests one sweep makes at most, for one host at most -- see the file comment. */
export const CAPTURE_RETRY_MAX_PER_HOST_PER_RUN = WORKDAY_PAGE_SIZE;

export interface CaptureRetryOutcome {
  /** Rows this sweep attempted a detail fetch for (within the age bound, under the host cap). */
  scanned: number;
  /** Rows whose detail fetch succeeded this time and were updated to full. */
  described: number;
  /** Rows that crossed the age bound this run and moved to capture_failed. */
  abandoned: number;
}

/** The board and CXS path a stored, bare Workday posting's own postingUrl still names. */
function workdayTargetOf(
  postingUrl: string | null | undefined,
): { board: WorkdayBoard; externalPath: string } | null {
  if (postingUrl == null) return null;
  const found = boardFromUrl(postingUrl);
  if (found === null || found.kind !== 'ats_workday' || found.host === undefined) return null;
  const cut = found.slug.indexOf('/');
  if (cut < 0) return null;
  let url: URL;
  try {
    url = new URL(postingUrl);
  } catch {
    return null;
  }
  const path = workdayPosting(url);
  if (path === null) return null;
  return {
    board: { host: found.host, tenant: found.slug.slice(0, cut), site: found.slug.slice(cut + 1) },
    externalPath: path.externalPath,
  };
}

/**
 * Retries the detail fetch for every still-bare Workday posting, across every user: a
 * maintenance sweep, not something a user waits on, the same shape as atsDetect.ts's
 * queueReverification. A row past the age bound is moved to capture_failed without a fetch;
 * everything else is attempted, up to CAPTURE_RETRY_MAX_PER_HOST_PER_RUN per tenant.
 */
export async function retryWorkdayCapture(
  db: Db,
  sctx: {
    fetch: Parameters<typeof fetchWorkdayDetail>[0]['fetch'];
    log: { warn: (obj: unknown, msg: string) => void };
  },
  now: number = Date.now(),
): Promise<CaptureRetryOutcome> {
  const rows = await db
    .select({
      id: discoveryResults.id,
      userId: discoveryResults.userId,
      posting: discoveryResults.posting,
      createdAt: discoveryResults.createdAt,
    })
    .from(discoveryResults)
    .where(eq(discoveryResults.resolution, 'needs_capture'))
    .all();

  let scanned = 0;
  let described = 0;
  let abandoned = 0;
  const perHost = new Map<string, number>();
  for (const row of rows) {
    const parsed = NormalizedPostingSchema.safeParse(row.posting);
    if (!parsed.success) continue;
    const stored = parsed.data;
    const target = workdayTargetOf(stored.postingUrl);
    if (target === null) continue; // Not a Workday posting; not this sweep's to touch.

    if (now - row.createdAt > CAPTURE_RETRY_MAX_AGE_MS) {
      await db
        .update(discoveryResults)
        .set({ resolution: 'capture_failed', updatedAt: now })
        .where(and(eq(discoveryResults.userId, row.userId), eq(discoveryResults.id, row.id)))
        .run();
      abandoned += 1;
      continue;
    }

    const host = target.board.host;
    const used = perHost.get(host) ?? 0;
    if (used >= CAPTURE_RETRY_MAX_PER_HOST_PER_RUN) continue; // This tenant's share is spent; tomorrow.
    perHost.set(host, used + 1);

    scanned += 1;
    let detail: unknown;
    try {
      detail = await fetchWorkdayDetail(sctx, target.board, target.externalPath);
    } catch (err) {
      // A tenant in its weekly maintenance window, or any other transient failure, costs this
      // row nothing beyond staying bare for another day: the next sweep tries again.
      sctx.log.warn({ resultId: row.id, host, err }, 'workday capture retry failed');
      continue;
    }
    if (detail === null) continue; // Still gone or still unusable; try again tomorrow.
    const refreshed: NormalizedPosting = sanitizePosting({
      ...mapWorkdayPosting(
        target.board,
        { externalPath: target.externalPath, title: stored.title },
        detail,
      ),
      // The id that identifies this row never changes just because the description finally
      // arrived: keep what first ingest stored rather than trust whatever the detail re-derives.
      externalId: stored.externalId,
    });
    const check = NormalizedPostingSchema.safeParse(refreshed);
    if (!check.success) continue;
    await db
      .update(discoveryResults)
      .set({
        posting: check.data,
        dedupeKey: dedupeKey(check.data.company, check.data.title, check.data.location),
        resolution: 'full',
        updatedAt: now,
      })
      .where(and(eq(discoveryResults.userId, row.userId), eq(discoveryResults.id, row.id)))
      .run();
    described += 1;
  }
  return { scanned, described, abandoned };
}

const PayloadSchema = z.object({}).strict() as unknown as z.ZodType<Record<string, never>>;

export const retryWorkdayCaptureJob: JobHandler<Record<string, never>> = {
  kind: RETRY_WORKDAY_CAPTURE_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 1,
  async run(db, _payload, ctx) {
    const outcome = await retryWorkdayCapture(db, {
      fetch: requireService(ctx, 'sourceFetch'),
      log: requireService(ctx, 'log'),
    });
    await ctx.setResult(outcome);
  },
};
