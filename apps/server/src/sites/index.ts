// The server's site modules (https://github.com/bgoleno/opportun/issues/769): one line per site, in
// the order of packages/core's SITES, each the identity there plus its network half here. The
// contract test (test/siteContract.test.ts) runs every one through the same checks.
import { greenhouseModule } from './greenhouse';
import type { SiteModule } from './types';

export const SITE_MODULES: readonly SiteModule[] = [greenhouseModule];

export type { SiteApi, SiteModule } from './types';
