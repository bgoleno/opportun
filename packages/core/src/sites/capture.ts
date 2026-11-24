// The job sites the browser extension captures from (https://github.com/bgoleno/opportun/issues/769),
// the first part of SITES (./index): a site here is listed once, here.
//
// Deliberately has no dependency outside this folder's dependency-free files. This file is bundled
// into the extension through its own subpath export (@opportun/core/captureSites), so that the rest
// of @opportun/core (zod, uuidv7) never reaches the extension; packages/extension/test/bundle.test.ts
// checks the built bundle. An ATS site's identity carries a zod config schema, so one that gains
// capture cannot be listed here as it is: make the board config plain data (field names and
// patterns) first, and build the zod schema from it outside the identity.
import { indeed } from './indeed';
import { linkedin } from './linkedin';
import type { SiteIdentity } from './types';

export const CAPTURE_SITES = [linkedin, indeed] as const satisfies readonly SiteIdentity[];

export type CaptureSiteId = (typeof CAPTURE_SITES)[number]['id'];

export { INDEED_JOB_KEY, indeed } from './indeed';
export { linkedin } from './linkedin';
export { linkOnHost } from './types';
