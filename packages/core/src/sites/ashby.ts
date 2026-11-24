// Ashby (https://github.com/bgoleno/opportun/issues/769): the identity half of its site module.
// Its network half is apps/server/src/sites/ashby.ts. The rules below are moved unchanged from
// apps/server/src/lib/atsBoard.ts (boardFromUrl) and lib/atsJobRef.ts.
import { ATS_JOB_ID, ATS_SLUG, AtsOrgConfig } from './ats';
import {
  linkOnHost,
  segmentsOf,
  type BoardRef,
  type HostRule,
  type SiteIdentity,
  type SiteUrl,
} from './types';

/** The posting API's host, the one Ashby host the server fetches from. */
export const ASHBY_API_HOST = 'api.ashbyhq.com';

const API: readonly HostRule[] = [{ exact: ASHBY_API_HOST }];
const PAGES: readonly HostRule[] = [{ exact: 'jobs.ashbyhq.com' }];

/** A board page, or the API's `/posting-api/job-board/<slug>`. */
function boardFromUrl(url: SiteUrl): BoardRef | null {
  const segments = segmentsOf(url);
  let slug: string | undefined;
  if (linkOnHost(url, PAGES)) {
    slug = segments[0];
  } else if (linkOnHost(url, API) && segments[0] === 'posting-api' && segments[1] === 'job-board') {
    slug = segments[2];
  }
  const lower = slug?.toLowerCase();
  return lower !== undefined && ATS_SLUG.test(lower) ? { site: 'ashby', slug: lower } : null;
}

export const ashby: SiteIdentity = {
  id: 'ashby',
  label: 'Ashby',
  category: 'ats',
  sourceKind: 'ats_ashby',
  fetchHosts: API,
  pageHosts: PAGES,
  jobFromUrl(url) {
    // A job's page only: the API's link names a board and no job.
    const board = linkOnHost(url, PAGES) ? boardFromUrl(url) : null;
    const id = segmentsOf(url)[1];
    return board !== null && id !== undefined && ATS_JOB_ID.test(id)
      ? { site: 'ashby', board: board.slug, id }
      : null;
  },
  isJobId: (id) => ATS_JOB_ID.test(id),
  jobPageUrl(ref) {
    if (ref.board === null || !ATS_SLUG.test(ref.board)) throw new Error('not an Ashby board slug');
    if (!ATS_JOB_ID.test(ref.id)) throw new Error('not an Ashby job id');
    return `https://jobs.ashbyhq.com/${ref.board}/${ref.id}`;
  },
  board: {
    fromUrl: boardFromUrl,
    configSchema: AtsOrgConfig,
    pageUrl(board) {
      if (!ATS_SLUG.test(board.slug)) throw new Error('not an Ashby board slug');
      return `https://jobs.ashbyhq.com/${board.slug}`;
    },
  },
  routes: {
    api: {
      supplies: ['boardListing', 'description'],
      terms: {
        url: 'https://developers.ashbyhq.com/docs/public-job-posting-api',
        checked:
          "the posting API's documentation, which states no access terms; the full terms were not read for #769; in use before the registry",
        decision: 'allowed',
        issue: 'https://github.com/bgoleno/opportun/issues/769',
      },
    },
  },
  samples: {
    jobUrls: ['https://jobs.ashbyhq.com/initech/0c3f1a2b-3333-4d5e-8f90-abcdef012345'],
    boardUrls: [
      'https://jobs.ashbyhq.com/initech',
      'https://jobs.ashbyhq.com/Initech/',
      'https://api.ashbyhq.com/posting-api/job-board/initech',
    ],
  },
};
