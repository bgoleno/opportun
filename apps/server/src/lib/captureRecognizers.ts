// The per-site recognizer registry (design D18). The capture route asks this module what a
// captured tab is; it asks the recognizer whose site claims the host, and refuses everything
// else. Adding Wellfound is adding a recognizer and its tests here, not touching the route
// (routes/connectorCapture.ts), the resolve path (lib/captureResolve.ts) or the merge
// (lib/postingMerge.ts).
//
// The seam is server-side only in this build. The extension has its own LinkedIn-specific
// gates (manifest host permissions, canonical.ts's isLinkedInUrl and currentJobId rewrite, the
// popup's tab check, the connection-test payload), and a shared site table driving those is
// its own piece of work: adding a site needs an extension rebuild and redistribution anyway.
//
// C-1 is unchanged: a recognizer reads the text the user's own browser already rendered and
// nothing here ever fetches a URL.
import { siteOfUrl } from './captureSites';
import { recognizeLinkedInPage, type Recognition } from './linkedinCapture';

export interface CaptureInputPage {
  url: string;
  title: string;
  text: string;
}

/** What a recognizer returns, tagged with the site it came from. */
export type CapturedPage =
  | (Extract<Recognition, { kind: 'profile' }> & { siteId: string })
  | (Extract<Recognition, { kind: 'job' }> & { siteId: string })
  | Extract<Recognition, { kind: 'unrecognized' }>;

/** A page a recognizer read, with the unrecognized case excluded. */
export type RecognizedPage = Exclude<CapturedPage, { kind: 'unrecognized' }>;

export interface CaptureRecognizer {
  /** The CAPTURE_SITES id this recognizer serves. */
  siteId: string;
  recognize(input: CaptureInputPage): Recognition;
}

export const CAPTURE_RECOGNIZERS: readonly CaptureRecognizer[] = [
  { siteId: 'linkedin', recognize: recognizeLinkedInPage },
];

const bySite = new Map(CAPTURE_RECOGNIZERS.map((r) => [r.siteId, r]));

/**
 * Reads a captured tab, or refuses it. The host decides which recognizer runs, so a page on a
 * site nothing claims is refused before any recognizer sees its text.
 */
export function recognizeCapturedPage(input: CaptureInputPage): CapturedPage {
  const site = siteOfUrl(input.url);
  const recognizer = site === null ? undefined : bySite.get(site.id);
  if (site === null || recognizer === undefined) {
    return { kind: 'unrecognized', reason: 'not_linkedin' };
  }
  const page = recognizer.recognize(input);
  return page.kind === 'unrecognized' ? page : { ...page, siteId: site.id };
}
