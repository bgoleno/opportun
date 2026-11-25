// Lever (https://github.com/bgoleno/opportun/issues/769): the identity half of its site module.
// Its network half is apps/server/src/sites/lever.ts. The rules below are moved unchanged from
// apps/server/src/lib/atsBoard.ts (boardFromUrl) and lib/atsJobRef.ts.
import { ATS_JOB_ID, ATS_SLUG, AtsOrgConfig, orgBoards } from './ats';
import {
  linkOnHost,
  segmentsOf,
  type BoardRef,
  type HostRule,
  type SiteIdentity,
  type SiteUrl,
} from './types';

/** The postings API's host, the one Lever host the server fetches from. */
export const LEVER_API_HOST = 'api.lever.co';

const PAGES: readonly HostRule[] = [{ exact: 'jobs.lever.co' }];

/** A board page only: a link to the API names no board. */
function boardFromUrl(url: SiteUrl): BoardRef | null {
  if (!linkOnHost(url, PAGES)) return null;
  const slug = segmentsOf(url)[0]?.toLowerCase();
  return slug !== undefined && ATS_SLUG.test(slug) ? { site: 'lever', slug } : null;
}

export const lever: SiteIdentity = {
  id: 'lever',
  label: 'Lever',
  category: 'ats',
  sourceKind: 'ats_lever',
  fetchHosts: [{ exact: LEVER_API_HOST }],
  pageHosts: PAGES,
  jobFromUrl(url) {
    const board = boardFromUrl(url);
    const id = segmentsOf(url)[1];
    return board !== null && id !== undefined && ATS_JOB_ID.test(id)
      ? { site: 'lever', board: board.slug, id }
      : null;
  },
  isJobId: (id) => ATS_JOB_ID.test(id),
  jobPageUrl(ref) {
    if (ref.board === null || !ATS_SLUG.test(ref.board)) throw new Error('not a Lever board slug');
    if (!ATS_JOB_ID.test(ref.id)) throw new Error('not a Lever job id');
    return `https://jobs.lever.co/${ref.board}/${ref.id}`;
  },
  board: {
    fromUrl: boardFromUrl,
    configSchema: AtsOrgConfig,
    ...orgBoards('lever'),
    pageUrl(board) {
      if (!ATS_SLUG.test(board.slug)) throw new Error('not a Lever board slug');
      return `https://jobs.lever.co/${board.slug}`;
    },
  },
  routes: {
    api: {
      supplies: ['boardListing', 'description'],
      terms: {
        url: 'https://github.com/lever/postings-api',
        checked:
          "the postings API's documentation; the full terms were not read for #769; in use before the registry",
        decision: 'allowed',
        issue: 'https://github.com/bgoleno/opportun/issues/769',
      },
    },
  },
  samples: {
    jobUrls: ['https://jobs.lever.co/initech/5f1c2b9e-1111-4c2d-9a7e-0123456789ab'],
    boardUrls: ['https://jobs.lever.co/initech', 'https://jobs.lever.co/Initech/'],
  },
};
