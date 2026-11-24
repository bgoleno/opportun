// LinkedIn (https://github.com/bgoleno/opportun/issues/769): the identity half of its site module.
// Its other half is apps/server/src/sites/linkedin.ts. The server never contacts LinkedIn (C-1): a
// user's own browser sends a page they are viewing, and the server parses job-alert mail the user
// already has. So there are no fetch hosts and no api or mcp route, and the contract test fails if
// one is added.
//
// Bundled into the browser extension: imports nothing but ./types (see ./capture).
import { hostMatchesRule, type HostRule, type SiteIdentity } from './types';

/** The apex, its www host, or a two-letter country subdomain (uk., de.). */
const PAGES: readonly HostRule[] = [
  { pattern: /^(?:www\.|[a-z][a-z]\.)?linkedin\.com$/, example: 'www.linkedin.com' },
];
/** `/jobs/view/<id>` or `/jobs/view/<words>-<id>`, with an optional trailing slash, and both under
 *  `/comm`, which alert mail links to. */
const JOB_PATH = /^(?:\/comm)?\/jobs\/view\/([^/]+)\/?$/;
const JOB_ID = /^\d{1,20}$/;
/** After words: long enough that a title's year or level ("engineer-2024") is not read as an id. */
const SLUG_JOB_ID = /^\d{6,20}$/;
/** List views that name the posting open beside the list in `currentJobId`. */
const JOBS_LIST_PATH = /^\/jobs\/(?:search|search-results|collections)(?:\/|$)/;

/** The job id in a path, whatever the host, or null. */
function idInPath(pathname: string): string | null {
  const segment = JOB_PATH.exec(pathname)?.[1];
  if (segment === undefined) return null;
  if (JOB_ID.test(segment)) return segment;
  const hyphen = segment.lastIndexOf('-');
  const tail = segment.slice(hyphen + 1);
  return hyphen > 0 && SLUG_JOB_ID.test(tail) ? tail : null;
}

const onPages = (hostname: string): boolean => PAGES.some((r) => hostMatchesRule(hostname, r));

export const linkedin = {
  id: 'linkedin',
  label: 'LinkedIn',
  category: 'aggregator',
  fetchHosts: [],
  pageHosts: PAGES,
  // Trailing dots are ignored on the host here: a caller decides first, by its own rule, whether
  // the link is the site's (the server's siteOfUrl drops one trailing dot, linkOnHost none).
  jobFromUrl(url) {
    if (!onPages(url.hostname)) return null;
    const id = idInPath(url.pathname);
    return id === null ? null : { site: 'linkedin', board: null, id };
  },
  // The id in the path wins over one in the query.
  storedJobFromUrl(url) {
    if (!onPages(url.hostname)) return null;
    const open = JOBS_LIST_PATH.test(url.pathname) ? url.searchParams.get('currentJobId') : null;
    const id = idInPath(url.pathname) ?? open;
    return id !== null && JOB_ID.test(id) ? { site: 'linkedin', board: null, id } : null;
  },
  isJobId: (id) => JOB_ID.test(id),
  jobPageUrl(ref) {
    if (!JOB_ID.test(ref.id)) throw new Error('not a LinkedIn job id');
    return `https://www.linkedin.com/jobs/view/${ref.id}/`;
  },
  routes: {
    capture: { supplies: ['byId', 'description'] },
    alertEmail: { supplies: ['byId'] },
  },
  samples: {
    jobUrls: [
      'https://www.linkedin.com/jobs/view/1000000001/',
      'https://uk.linkedin.com/jobs/view/1000000001',
      'https://linkedin.com/jobs/view/1000000001/',
      'https://www.linkedin.com/jobs/view/staff-engineer-at-initech-1000000001',
    ],
    boardUrls: [],
  },
} as const satisfies SiteIdentity;
