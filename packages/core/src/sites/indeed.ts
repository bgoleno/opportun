// Indeed (https://github.com/bgoleno/opportun/issues/769): the identity half of its site module.
// Its other half is apps/server/src/sites/indeed.ts. The rules below are moved unchanged from
// apps/server/src/lib/captureSites.ts and lib/alertParsers/indeed.ts, and
// packages/extension/src/canonical.ts. The server never contacts Indeed (C-2): a user's own
// browser sends a page they are viewing, and the server parses job-alert mail the user already
// has. So there are no fetch hosts and no api or mcp route, and the contract test fails if one
// is added.
//
// Bundled into the browser extension: imports nothing but ./types (see ./capture).
import { hostMatchesRule, type HostRule, type SiteIdentity } from './types';

/**
 * An Indeed job key (`jk`): hex, 8 to 32 characters. The one rule for what a job key is: the
 * alert parser, the server's capture and the extension all read it here, so an alert lead and a
 * capture of the same posting always agree on whether there is a job key at all.
 */
export const INDEED_JOB_KEY = /^[0-9a-f]{8,32}$/i;

/**
 * indeed.com and its www host only. Country sites (uk.indeed.com, indeed.co.uk) are out of scope
 * for https://github.com/bgoleno/opportun/issues/73 and stay unclaimed.
 */
const PAGES: readonly HostRule[] = [{ exact: 'indeed.com' }, { exact: 'www.indeed.com' }];

export const indeed = {
  id: 'indeed',
  label: 'Indeed',
  category: 'aggregator',
  fetchHosts: [],
  pageHosts: PAGES,
  // The job key of a single-posting URL, `/viewjob?jk=<jk>`. Trailing dots are ignored on the
  // host here: a caller decides first, by its own rule, whether the link is the site's (the
  // server's siteOfUrl drops one trailing dot, linkOnHost none).
  jobFromUrl(url) {
    if (!PAGES.some((r) => hostMatchesRule(url.hostname, r))) return null;
    if (url.pathname !== '/viewjob') return null;
    const jk = url.searchParams.get('jk');
    return jk !== null && INDEED_JOB_KEY.test(jk)
      ? { site: 'indeed', board: null, id: jk.toLowerCase() }
      : null;
  },
  isJobId: (id) => INDEED_JOB_KEY.test(id),
  jobPageUrl(ref) {
    if (!INDEED_JOB_KEY.test(ref.id)) throw new Error('not an Indeed job key');
    return `https://www.indeed.com/viewjob?jk=${ref.id.toLowerCase()}`;
  },
  routes: {
    capture: { supplies: ['byId', 'description'] },
    alertEmail: { supplies: ['byId'] },
  },
  samples: {
    jobUrls: [
      'https://www.indeed.com/viewjob?jk=0000000000000a01',
      'https://indeed.com/viewjob?jk=0000000000000A01&from=example',
    ],
    boardUrls: [],
  },
} as const satisfies SiteIdentity;
