// The per-site recognizer registry (design D18). The capture route asks this module what a
// captured tab is; it asks the recognizer whose site claims the host, and refuses everything
// else. Adding Wellfound is adding a recognizer and its tests here, not touching the route
// (routes/connectorCapture.ts), the resolve path (lib/captureResolve.ts) or the merge
// (lib/postingMerge.ts).
//
// The seam is server-side only. The extension keeps its own site gates (manifest host
// permissions, canonical.ts's per-site URL checks, the popup's tab check), which since
// https://github.com/bgoleno/opportun/pull/81 let through LinkedIn jobs and profiles and Indeed
// jobs; packages/extension/src/canonical.ts is where they are defined. A shared site table
// driving both is its own piece of work: adding a site needs an extension rebuild and
// redistribution anyway.
//
// Each recognizer also says how to read a description back out of a capture already stored on
// an opportunity's timeline, so re-derive (lib/postingRederive.ts) uses the extraction of the
// site the capture came from (https://github.com/bgoleno/opportun/issues/93).
//
// C-1 is unchanged: a recognizer reads the text the user's own browser already rendered and
// nothing here ever fetches a URL.
import { siteOfUrl } from './captureSites';
import { indeedDescriptionOf, recognizeIndeedPage } from './indeedCapture';
import {
  cutTrailingNoise,
  descriptionOf,
  linesOf,
  recognizeLinkedInPage,
  type Recognition,
} from './linkedinCapture';

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
  /**
   * The job description in a capture's stored text, or null when there is none to find. It is
   * deterministic and never calls AI: re-derive holds itself to the bar of a live capture with
   * no AI key (see lib/postingRederive.ts).
   */
  storedDescriptionOf(text: string): string | null;
}

/**
 * LinkedIn's re-derive extraction, unchanged from before Indeed (issue #264). A capture made
 * before #246 shipped still carries the recommended rail in its raw stored text, so the text is
 * cut the way extractPage cuts it at capture time before descriptionOf reads it: descriptionOf's
 * own end markers exist to find where "About the job" ends, not to find the rail, and a real
 * capture was confirmed (read-only) to have nothing stop it between the posting and the rail.
 */
const linkedInStoredDescriptionOf = (text: string): string | null =>
  descriptionOf(linesOf(cutTrailingNoise(text)));

export const CAPTURE_RECOGNIZERS: readonly CaptureRecognizer[] = [
  {
    siteId: 'linkedin',
    recognize: recognizeLinkedInPage,
    storedDescriptionOf: linkedInStoredDescriptionOf,
  },
  { siteId: 'indeed', recognize: recognizeIndeedPage, storedDescriptionOf: indeedDescriptionOf },
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
    // Site-neutral since Indeed (https://github.com/bgoleno/opportun/issues/73); this was
    // `not_linkedin`. The extension only posts tabs on its own capture sites, so it rarely meets
    // this reason; since https://github.com/bgoleno/opportun/pull/81 its render.ts knows both
    // names. recognizeLinkedInPage itself still returns `not_linkedin`.
    return { kind: 'unrecognized', reason: 'unsupported_site' };
  }
  const page = recognizer.recognize(input);
  return page.kind === 'unrecognized' ? page : { ...page, siteId: site.id };
}

/**
 * The description in a stored capture, read with the extraction of the site it came from, or
 * null when that site has no recognizer or the text has no description it can find
 * (https://github.com/bgoleno/opportun/issues/93).
 */
export function storedDescriptionOf(siteId: string | null, text: string): string | null {
  const recognizer = siteId === null ? undefined : bySite.get(siteId);
  return recognizer === undefined ? null : recognizer.storedDescriptionOf(text);
}
