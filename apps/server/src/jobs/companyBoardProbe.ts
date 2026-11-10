// The board probe after a company suggestion (https://github.com/bgoleno/opportun/issues/221, #190
// N5a). For one new suggestion: find its job board with the detection ATS detection already does
// (public board APIs only, no AI call), read the board's listing once, and store on the company how
// many jobs it has open and how many of them the pre-filter passes for the user's active role
// targets. The recommendations page (#222) reads these to show what following the company would
// bring. Nothing here follows the company: a candidate's board source stays disabled.
//
// A company with no board is recorded as probed with no counts, so it is not probed again for want
// of an answer. A provider that is down is retried (AtsDetectTransientError, or the listing's own
// error), and nothing is stored until it answers.
import type { NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { SourceConfigError, type SourceContext } from '../adapters/discoverySource';
import type { Db } from '../db/client';
import { companies, roleTargets } from '../db/schema';
import { adapterBoardLookup } from '../lib/postingSearch';
import { prefilter } from '../lib/prefilter';
import type { UserCtx } from '../repos/base';
import { boardConfig, detectAts, type AtsKind } from './atsDetect';
import { requireService, type JobHandler } from './registry';
import { enqueue } from './runner';

export const BOARD_PROBE_KIND = 'company.board_probe'; // payload {companyId}
export const boardProbeDedupeKey = (companyId: string): string =>
  `${BOARD_PROBE_KIND}:${companyId}`;

export type BoardProbeOutcome =
  | {
      status: 'probed';
      /** The board found; null when the company has none. */
      kind: AtsKind | null;
      openJobs: number | null;
      /** Null with no active role target to judge against. */
      prefilterMatches: number | null;
    }
  | { status: 'skipped'; reason: 'missing' };

async function record(
  db: Db,
  ctx: UserCtx,
  companyId: string,
  counts: { openJobs: number | null; prefilterMatches: number | null },
): Promise<void> {
  // updatedAt stays: a probe is not the user's edit, and company.suggest lists by it.
  await db
    .update(companies)
    .set({
      boardProbedAt: Date.now(),
      boardOpenJobs: counts.openJobs,
      boardPrefilterMatches: counts.prefilterMatches,
    })
    .where(and(eq(companies.userId, ctx.userId), eq(companies.id, companyId)))
    .run();
}

/** How many of the postings the pre-filter passes for the user's active role targets. */
async function prefilterMatches(
  db: Db,
  ctx: UserCtx,
  postings: readonly NormalizedPosting[],
): Promise<number | null> {
  const targets = await db
    .select()
    .from(roleTargets)
    .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.active, true)))
    .all();
  if (targets.length === 0) return null;
  return postings.filter((p) => prefilter(p, targets)?.outcome === 'pass').length;
}

/** Probes one of the user's companies. Public board requests only; never an AI call. */
export async function probeCompanyBoard(
  db: Db,
  ctx: UserCtx,
  companyId: string,
  sctx: SourceContext,
): Promise<BoardProbeOutcome> {
  const detected = await detectAts(db, ctx, companyId, sctx);
  if (detected.status === 'skipped') return detected;
  if (detected.status === 'none') {
    await record(db, ctx, companyId, { openJobs: null, prefilterMatches: null });
    return { status: 'probed', kind: null, openJobs: null, prefilterMatches: null };
  }
  const board = {
    kind: detected.kind,
    slug: detected.org,
    ...(detected.host === undefined ? {} : { host: detected.host }),
  };
  let listing;
  try {
    listing = await adapterBoardLookup(sctx, board.kind, boardConfig(board));
  } catch (err) {
    // The board answered detection and then no longer exists: nothing to count, and a retry would
    // find the same. Any other failure is the provider's and is retried.
    if (!(err instanceof SourceConfigError)) throw err;
    await record(db, ctx, companyId, { openJobs: null, prefilterMatches: null });
    return { status: 'probed', kind: board.kind, openJobs: null, prefilterMatches: null };
  }
  // A Workday listing is read in part: its total is the board's, and the matches are among those read.
  const postings = Array.isArray(listing) ? listing : listing.postings;
  const openJobs = Array.isArray(listing) ? listing.length : listing.total;
  const matches = await prefilterMatches(db, ctx, postings);
  await record(db, ctx, companyId, { openJobs, prefilterMatches: matches });
  return { status: 'probed', kind: board.kind, openJobs, prefilterMatches: matches };
}

/** Queues a probe for one of the user's companies (at most one unfinished per company). */
export async function enqueueBoardProbe(db: Db, ctx: UserCtx, companyId: string): Promise<string> {
  return await enqueue(
    db,
    BOARD_PROBE_KIND,
    { companyId },
    { dedupeKey: boardProbeDedupeKey(companyId), userId: ctx.userId },
  );
}

const PayloadSchema = z.object({ companyId: z.string().min(1).max(64) });

export const companyBoardProbeJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: BOARD_PROBE_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 3,
  async run(db, payload, ctx) {
    if (ctx.userId === null) throw new Error(`${BOARD_PROBE_KIND} needs a user`);
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    const outcome = await probeCompanyBoard(db, user, payload.companyId, {
      fetch: requireService(ctx, 'sourceFetch'),
      log: requireService(ctx, 'log'),
    });
    await ctx.setResult(outcome);
  },
};
