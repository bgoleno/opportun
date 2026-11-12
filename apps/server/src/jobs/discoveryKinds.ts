// Discovery job kinds and shared constants, in a leaf module so the engine, ranking, lead
// resolution and the discovery repo can reference each other's kinds without import cycles.
// Each job module re-exports its own kind.

/** One run of one source; payload {sourceId}. */
export const DISCOVERY_RUN_KIND = 'discovery.run';
/** Ranks one stored result; payload {resultId}. */
export const DISCOVERY_RANK_KIND = 'discovery.rank';
/** Ranks one user's postings waiting for the discovery budget; no payload. */
export const RANK_WAITING_KIND = 'discovery.rank_waiting';
/**
 * Sends one user's postings waiting for a ranking batch, as one batch (#441); no payload. "send",
 * not "submit": here that word names sending an application (submissionRouteShape.test.ts).
 */
export const RANK_BATCH_SEND_KIND = 'discovery.rank_batch_send';
/** Collects one ranking batch's results (#441); payload {batchId}. */
export const RANK_BATCH_COLLECT_KIND = 'discovery.rank_batch_collect';
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
