// Discovery job kinds and shared constants, in a leaf module so the engine, ranking, lead
// resolution and the discovery repo can reference each other's kinds without import cycles.
// Each job module re-exports its own kind.

/** One run of one source; payload {sourceId}. */
export const DISCOVERY_RUN_KIND = 'discovery.run';
/** Ranks one stored result; payload {resultId}. */
export const DISCOVERY_RANK_KIND = 'discovery.rank';
/** Resolves one partial lead against ATS sources; payload {resultId}. */
export const LEAD_RESOLVE_KIND = 'discovery.lead_resolve';
/**
 * Reconciles one opportunity's posting against the company's own ATS board, after a browser
 * capture put the page text on it; payload {opportunityId}. Design D5 to D8.
 */
export const POSTING_RECONCILE_KIND = 'posting.reconcile';

/**
 * FR-O10: the later of two pending results with the same dedupe key from different sources is
 * a multi-posted job (often several recruiters posting one req). It is marked at insert with
 * this rationale prefix, and ranking caps its score at MULTI_POSTED_SCORE_CAP.
 */
export const MULTI_POSTED_PREFIX = '[multi-posted]';
export const MULTI_POSTED_SCORE_CAP = 40;
