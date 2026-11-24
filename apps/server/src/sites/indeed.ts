// Indeed's server half (https://github.com/bgoleno/opportun/issues/769): reading a page the user's own
// browser captured, and the user's own job-alert mail. Nothing here fetches anything (C-2). Its
// identity is packages/core/src/sites/indeed.ts.
import { indeed } from '@opportun/core';
import { INDEED_ALERT_SENDER, parseIndeedAlert } from '../lib/alertParsers/indeed';
import { indeedDescriptionOf, recognizeIndeedPage } from '../lib/indeedCapture';
import type { SiteModule } from './types';

export const indeedModule: SiteModule = {
  identity: indeed,
  capture: { recognize: recognizeIndeedPage, storedDescriptionOf: indeedDescriptionOf },
  alertEmail: { senders: [INDEED_ALERT_SENDER], parse: parseIndeedAlert },
};
