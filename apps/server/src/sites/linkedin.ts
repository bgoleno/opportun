// LinkedIn's server half (https://github.com/bgoleno/opportun/issues/769): reading a page the user's
// own browser captured, and the user's own job-alert mail. Nothing here fetches anything (C-1).
// Its identity is packages/core/src/sites/linkedin.ts.
import { linkedin } from '@opportun/core';
import { LINKEDIN_ALERT_SENDER, parseLinkedInAlert } from '../lib/alertParsers/linkedin';
import {
  cutTrailingNoise,
  descriptionOf,
  linesOf,
  recognizeLinkedInPage,
} from '../lib/linkedinCapture';
import type { SiteModule } from './types';

export const linkedinModule: SiteModule = {
  identity: linkedin,
  capture: {
    recognize: recognizeLinkedInPage,
    /**
     * LinkedIn's re-derive extraction, unchanged from before Indeed (issue #264). A capture made
     * before #246 shipped still carries the recommended rail in its raw stored text, so the text
     * is cut the way extractPage cuts it at capture time before descriptionOf reads it:
     * descriptionOf's own end markers exist to find where "About the job" ends, not to find the
     * rail, and a real capture was confirmed (read-only) to have nothing stop it between the
     * posting and the rail.
     */
    storedDescriptionOf: (text) => descriptionOf(linesOf(cutTrailingNoise(text))),
  },
  alertEmail: { senders: [LINKEDIN_ALERT_SENDER], parse: parseLinkedInAlert },
};
