// The estimate line on a Recommended companies row (https://github.com/bgoleno/opportun/issues/301,
// N5b-c of #222), with the formulas in tl's note and his answers on #301. From what the page has
// already read, with no request of its own:
// - open: the jobs the board probe counted (board_open_jobs), or for a followed company the open
//   jobs at its source's latest successful run;
// - matches: what the title pre-filter passes (board_prefilter_matches) while it acts for this user
//   (its recall rule holds, and the company's source has it switched on; a company with no source
//   yet has the default a new source gets, on). Otherwise everything is ranked: the matches are
//   the open jobs;
// - new a day: 2% of the open jobs, or for a followed company the source's observed average once it
//   has 14 days of runs;
// - ranked a day: new a day times matches over open;
// - first run: at most 25 (the first-run cap), and at most the matches;
// - dollars: each count times the 30-day average cost of a rank call, the figure Discovery shows.
import type { DiscoverySource } from './api';
import type { CompanyView } from './companiesApi';
import type { SourceVolumeFigures } from './costFigures';

/** How many postings a board's first run ranks: the server's FIRST_RUN_RANK_CAP (jobs/discoveryRun.ts). */
export const FIRST_RUN_RANK_CAP = 25;
/** The share of a board's open jobs that is new each day until its own runs say otherwise. */
const NEW_PER_DAY_SHARE = 0.02;
/** The days of runs a source needs before its observed rate is used. */
const OBSERVED_AFTER_DAYS = 14;

export interface EstimateInputs {
  company: CompanyView;
  /** The company's board source, when it has one (followed, or made by the probe). */
  source: DiscoverySource | undefined;
  /** That source's figures from Discovery's cost figures. */
  volume: SourceVolumeFigures | undefined;
  /** The 30-day average cost of one rank call; null with no call in 30 days. */
  costPerCall: number | null;
  /** Whether the title pre-filter's recall holds, so that it acts for this user. */
  recallOn: boolean;
}

export interface Estimate {
  newPerDay: number;
  rankedPerDay: number;
  costPerDayUsd: number | null;
  /** Null for a followed company: its first run has happened. */
  firstRun: { count: number; usd: number | null } | null;
}

/** Null where there is nothing to say: no board, or no count of its open jobs. */
export function estimateOf(i: EstimateInputs): Estimate | null {
  const { company: c } = i;
  if (c.atsKind === 'none' || c.status === 'denied') return null;
  const followed = c.status === 'followed';
  const open = (followed ? i.volume?.openJobs : null) ?? c.boardOpenJobs ?? null;
  if (open === null) return null;

  // The share of the postings that gets ranked: the probe's matches over its open jobs, while the
  // pre-filter acts. Without a probe's counts, or with it not acting, all of them.
  const probeOpen = c.boardOpenJobs ?? null;
  const matches = c.boardPrefilterMatches ?? null;
  const acts = i.recallOn && (i.source?.prefilterEnabled ?? true) && matches !== null;
  const share = acts && probeOpen !== null && probeOpen > 0 ? matches / probeOpen : 1;

  const observed =
    followed && i.volume !== undefined && i.volume.days >= OBSERVED_AFTER_DAYS
      ? i.volume.newPerDay
      : null;
  const newPerDay = observed ?? open * NEW_PER_DAY_SHARE;
  const rankedPerDay = newPerDay * share;
  const cost = (count: number): number | null =>
    i.costPerCall === null ? null : count * i.costPerCall;

  const ranked = acts && matches !== null ? matches : open;
  return {
    newPerDay,
    rankedPerDay,
    costPerDayUsd: cost(rankedPerDay),
    firstRun: followed
      ? null
      : {
          count: Math.min(FIRST_RUN_RANK_CAP, ranked),
          usd: cost(Math.min(FIRST_RUN_RANK_CAP, ranked)),
        },
  };
}

function newText(n: number): string {
  if (n < 0.1) return 'under 0.1 new a day';
  return `about ${n < 10 ? n.toFixed(1).replace(/\.0$/, '') : Math.round(n)} new a day`;
}

function dollars(usd: number): string {
  return usd > 0 && usd < 0.01 ? 'under $0.01' : `$${usd.toFixed(2)}`;
}

/** "about 4 new a day, est. $0.06 a day; first run 25, $0.38" (tl's note), or without dollars. */
export function estimateText(e: Estimate): string {
  const first = e.firstRun;
  if (e.costPerDayUsd === null) {
    return first === null
      ? `${newText(e.newPerDay)} (cost not known yet)`
      : `${newText(e.newPerDay)}; first run ${first.count} ${first.count === 1 ? 'posting' : 'postings'} (cost not known yet)`;
  }
  const day = `${newText(e.newPerDay)}, est. ${dollars(e.costPerDayUsd)} a day`;
  return first === null || first.usd === null
    ? day
    : `${day}; first run ${first.count}, ${dollars(first.usd)}`;
}
