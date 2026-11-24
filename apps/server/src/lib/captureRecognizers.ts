// Reading a captured tab with the recognizer of the site that claims its host (design D18). The
// recognizers are the site modules' (apps/server/src/sites, https://github.com/bgoleno/opportun/issues/769).
// The capture route asks this module what a captured tab is; it asks the recognizer whose site
// claims the host, and refuses everything else. Adding a site is adding its module and its tests,
// not touching the route (routes/connectorCapture.ts), the resolve path (lib/captureResolve.ts)
// or the merge (lib/postingMerge.ts).
//
// The extension reads the same sites (packages/core/src/sites/capture.ts) and keeps its own gates:
// the manifest's host permissions, its rules for a tab that shows one posting in a split view
// (packages/extension/src/canonical.ts), and a reader for each site's page.
//
// Each recognizer also says how to read a description back out of a capture already stored on
// an opportunity's timeline, so re-derive (lib/postingRederive.ts) uses the extraction of the
// site the capture came from (https://github.com/bgoleno/opportun/issues/93).
//
// C-1 is unchanged: a recognizer reads the text the user's own browser already rendered and
// nothing here ever fetches a URL.
import { SITE_MODULES, type CaptureInputPage } from '../sites';
import { siteOfUrl } from './captureSites';
import type { Recognition } from './linkedinCapture';

/** What a recognizer returns, tagged with the site it came from. */
export type CapturedPage =
  | (Extract<Recognition, { kind: 'profile' }> & { siteId: string })
  | (Extract<Recognition, { kind: 'job' }> & { siteId: string })
  | Extract<Recognition, { kind: 'unrecognized' }>;

/** A page a recognizer read, with the unrecognized case excluded. */
export type RecognizedPage = Exclude<CapturedPage, { kind: 'unrecognized' }>;

const bySite = new Map(
  SITE_MODULES.flatMap((m) =>
    m.capture === undefined ? [] : [[m.identity.id, m.capture] as const],
  ),
);

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
