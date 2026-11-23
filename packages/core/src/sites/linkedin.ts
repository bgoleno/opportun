// LinkedIn (https://github.com/bgoleno/opportun/issues/769): the identity half of its site module.
// Its other half is apps/server/src/sites/linkedin.ts. The rules below are moved unchanged from
// apps/server/src/lib/captureSites.ts and packages/extension/src/canonical.ts. The server never
// contacts LinkedIn (C-1): a user's own browser sends a page they are viewing, and the server
// parses job-alert mail the user already has. So there are no fetch hosts and no api or mcp
// route, and the contract test fails if one is added.
//
// Bundled into the browser extension: imports nothing but ./types (see ./capture).
import { hostMatchesRule, type HostRule, type SiteIdentity } from './types';

/** The apex, its www host, or a two-letter country subdomain (uk., de.). */
const PAGES: readonly HostRule[] = [
  { pattern: /^(?:www\.|[a-z][a-z]\.)?linkedin\.com$/, example: 'www.linkedin.com' },
];
/** `/jobs/view/<id>` with an optional trailing slash; ids are digits. */
const JOB_PATH = /^\/jobs\/view\/(\d{1,20})\/?$/;
const JOB_ID = /^\d{1,20}$/;

export const linkedin = {
  id: 'linkedin',
  label: 'LinkedIn',
  category: 'aggregator',
  fetchHosts: [],
  pageHosts: PAGES,
  // Trailing dots are ignored on the host here: a caller decides first, by its own rule, whether
  // the link is the site's (the server's siteOfUrl drops one trailing dot, linkOnHost none).
  jobFromUrl(url) {
    if (!PAGES.some((r) => hostMatchesRule(url.hostname, r))) return null;
    const id = JOB_PATH.exec(url.pathname)?.[1];
    return id === undefined ? null : { site: 'linkedin', board: null, id };
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
    ],
    boardUrls: [],
  },
} as const satisfies SiteIdentity;
