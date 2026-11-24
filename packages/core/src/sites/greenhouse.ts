// Greenhouse (https://github.com/bgoleno/opportun/issues/769): the identity half of its site
// module. Its network half is apps/server/src/sites/greenhouse.ts. The rules below are moved
// unchanged from apps/server/src/lib/atsBoard.ts (boardFromUrl) and lib/atsJobRef.ts.
import { greenhouseBoardJobUrl } from '../greenhouseJid';
import { ATS_JOB_ID, ATS_SLUG, AtsOrgConfig, orgBoards } from './ats';
import {
  linkOnHost,
  segmentsOf,
  type BoardRef,
  type HostRule,
  type JobRef,
  type SiteIdentity,
  type SiteUrl,
} from './types';

/** The Job Board API's host, the one Greenhouse host the server fetches from. */
export const GREENHOUSE_API_HOST = 'boards-api.greenhouse.io';

const API: readonly HostRule[] = [{ exact: GREENHOUSE_API_HOST }];
const PAGES: readonly HostRule[] = [
  { exact: 'boards.greenhouse.io' },
  { exact: 'job-boards.greenhouse.io' },
];

function boardFromUrl(url: SiteUrl): BoardRef | null {
  const segments = segmentsOf(url);
  let slug: string | undefined;
  if (linkOnHost(url, PAGES)) {
    // A board page, or the embed script's `/embed/job_board?for=<slug>`.
    slug = segments[0] === 'embed' ? (url.searchParams.get('for') ?? undefined) : segments[0];
  } else if (linkOnHost(url, API) && segments[0] === 'v1' && segments[1] === 'boards') {
    slug = segments[2];
  } else {
    return null;
  }
  const lower = slug?.toLowerCase();
  return lower !== undefined && ATS_SLUG.test(lower) ? { site: 'greenhouse', slug: lower } : null;
}

export const greenhouse: SiteIdentity = {
  id: 'greenhouse',
  label: 'Greenhouse',
  category: 'ats',
  sourceKind: 'ats_greenhouse',
  fetchHosts: API,
  pageHosts: PAGES,
  jobFromUrl(url) {
    const board = boardFromUrl(url);
    if (board === null) return null;
    // boards.greenhouse.io/<org>/jobs/<id> and the API's /v1/boards/<org>/jobs/<id>.
    const seg = segmentsOf(url);
    const raw = seg[1] === 'jobs' ? seg[2] : seg[3] === 'jobs' ? seg[4] : undefined;
    return raw !== undefined && ATS_JOB_ID.test(raw)
      ? { site: 'greenhouse', board: board.slug, id: raw }
      : null;
  },
  // A gh_jid link: a Greenhouse job embedded in a page on any host, so the board rule misses it.
  embeddedJobFromUrl(url) {
    const jid = url.searchParams.get('gh_jid');
    if (jid === null || !ATS_JOB_ID.test(jid)) return null;
    const board = url.searchParams.get('board')?.toLowerCase() ?? '';
    return { site: 'greenhouse', board: ATS_SLUG.test(board) ? board : null, id: jid };
  },
  isJobId: (id) => ATS_JOB_ID.test(id),
  jobPageUrl(ref: JobRef) {
    if (ref.board === null) throw new Error('a Greenhouse job page needs its board');
    return greenhouseBoardJobUrl(ref.board, ref.id);
  },
  board: {
    fromUrl: boardFromUrl,
    configSchema: AtsOrgConfig,
    ...orgBoards('greenhouse'),
    pageUrl(board) {
      if (!ATS_SLUG.test(board.slug)) throw new Error('not a Greenhouse board slug');
      return `https://boards.greenhouse.io/${board.slug}`;
    },
  },
  routes: {
    api: {
      supplies: ['boardListing', 'byId', 'description'],
      terms: {
        url: 'https://developers.greenhouse.io/job-board.html',
        checked:
          'not re-read for #769: the public Job Board API route was in use before the registry, carried over as allowed',
        decision: 'allowed',
        issue: 'https://github.com/bgoleno/opportun/issues/769',
      },
    },
  },
  samples: {
    jobUrls: [
      'https://boards.greenhouse.io/initech/jobs/4012345007',
      'https://job-boards.greenhouse.io/initech/jobs/4012345007',
      'https://boards-api.greenhouse.io/v1/boards/initech/jobs/4012345007',
    ],
    boardUrls: [
      'https://boards.greenhouse.io/initech',
      'https://job-boards.greenhouse.io/embed/job_board?for=initech',
      'https://boards-api.greenhouse.io/v1/boards/initech/jobs',
    ],
  },
};
