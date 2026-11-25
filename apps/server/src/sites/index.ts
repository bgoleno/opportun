// The server's site modules (https://github.com/bgoleno/opportun/issues/769): one line per site, in
// the order of packages/core's SITES, each the identity there plus its network half here. The
// contract test (test/siteContract.test.ts) runs every one through the same checks.
import { ashbyModule } from './ashby';
import { greenhouseModule } from './greenhouse';
import { indeedModule } from './indeed';
import { leverModule } from './lever';
import { linkedinModule } from './linkedin';
import type { SiteModule } from './types';

export const SITE_MODULES: readonly SiteModule[] = [
  greenhouseModule,
  leverModule,
  ashbyModule,
  linkedinModule,
  indeedModule,
];

/** The sites whose boards a company's name may be tried on, in the order they are tried. */
export const SLUG_SITES: readonly SiteModule[] = SITE_MODULES.filter(
  (m) => m.api?.slugAddressed === true,
);

/** The site a board source kind names, or undefined (a kind whose site has not moved, or none). */
export function siteOfKind(kind: string): SiteModule | undefined {
  return SITE_MODULES.find((m) => m.identity.sourceKind === kind);
}

export type { CaptureInputPage, SiteAlertEmail, SiteApi, SiteCapture, SiteModule } from './types';
