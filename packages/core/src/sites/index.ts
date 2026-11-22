// The one list of job sites (https://github.com/bgoleno/opportun/issues/769). Every list that names
// a site is built from this one, and apps/server/src/sites/index.ts pairs each with its network
// half. A site not yet moved here is still written out where it is used, until step 6.
import { greenhouse } from './greenhouse';
import type { SiteIdentity } from './types';

export const SITES: readonly SiteIdentity[] = [greenhouse];

/** The ATS sites: those with a board. */
export const ATS_SITES: readonly SiteIdentity[] = SITES.filter((s) => s.board !== undefined);

export { ATS_JOB_ID, ATS_SLUG, AtsOrgConfig, linkOnHost, segmentsOf } from './ats';
export { GREENHOUSE_API_HOST, greenhouse } from './greenhouse';
export * from './types';
