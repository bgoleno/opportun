// One line of feedback for the popup per Outcome. Pure, unit-tested. Takes no settings, so
// it can never echo the token.
import type { Outcome } from './api';
import type { CaptureSiteId } from './canonical';

export interface Rendered {
  tone: 'success' | 'info' | 'error';
  text: string;
}

const NOT_LOADED =
  'the page had not finished loading. Wait for it (scroll the profile or job description into view) and try again.';

const siteLabel = (site: CaptureSiteId): string => (site === 'indeed' ? 'Indeed' : 'LinkedIn');

/**
 * A job whose title is longer than the server can store as a posting (300 characters, its
 * `title_too_long` reason, https://github.com/bgoleno/opportun/issues/92). Waiting and retrying
 * cannot help, so this says what can.
 */
const TITLE_TOO_LONG =
  'the job title is longer than 300 characters, which is more than Opportun stores, so nothing was saved. You can add this job in Opportun by hand with a shorter title.';

/** An unclaimed host: `unsupported_site`, or `not_linkedin` from a server older than Indeed. */
const NOT_A_SITE = 'this is not a site Opportun captures from.';

/**
 * The server's refusal reasons (apps/server/src/lib/linkedinCapture.ts UnrecognizedReason), worded
 * for the site of the tab. A reason missing from a site's map falls back to the common one, then
 * to the server's own code.
 */
const LINKEDIN_REASONS = new Map<string, string>([
  ['not_linkedin', 'this is not a LinkedIn page.'],
  [
    'unsupported_path',
    'open a single profile (linkedin.com/in/…) or a job (linkedin.com/jobs/view/…). Feeds, search results and company pages are not captured.',
  ],
  [
    'login_wall',
    'LinkedIn is showing its sign-in page. Make sure you are signed in, then try again.',
  ],
  ['no_name', NOT_LOADED],
  ['no_headline', NOT_LOADED],
  ['not_a_profile', 'this does not look like a single person’s profile.'],
  ['no_title_company', NOT_LOADED],
  ['no_description', NOT_LOADED],
]);

/** https://github.com/bgoleno/opportun/issues/74. Indeed captures jobs only. */
const INDEED_REASONS = new Map<string, string>([
  ['not_linkedin', NOT_A_SITE],
  [
    'unsupported_path',
    'open a single Indeed job: a job page, or a search with a job open on the right. Search results and company pages are not captured.',
  ],
  ['no_title_company', NOT_LOADED],
  ['no_description', NOT_LOADED],
]);

function refusalText(reason: string, site: CaptureSiteId): string | undefined {
  const own = (site === 'indeed' ? INDEED_REASONS : LINKEDIN_REASONS).get(reason);
  if (own !== undefined) return own;
  if (reason === 'unsupported_site') return NOT_A_SITE;
  if (reason === 'title_too_long') return TITLE_TOO_LONG;
  if (reason === 'verification_wall') {
    return `${siteLabel(site)} is showing a sign-in or verification page. Complete it in this tab, then try again.`;
  }
  return undefined;
}

/** Longest server-supplied string (error code, refusal reason) shown in the popup. */
export const MAX_SERVER_STRING = 200;
const bounded = (s: string): string => s.slice(0, MAX_SERVER_STRING);

function minutes(sec: number): string {
  const m = Math.max(1, Math.ceil(sec / 60));
  return m === 1 ? 'about 1 minute' : `about ${m} minutes`;
}

/** A stage id as the app writes it, e.g. `in_process` becomes "In process". */
function stageLabel(stage: string): string {
  const words = stage.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `site` is the site of the tab captured (LinkedIn when the outcome is not about a tab). */
export function renderOutcome(outcome: Outcome, site: CaptureSiteId = 'linkedin'): Rendered {
  switch (outcome.kind) {
    case 'profile':
      return {
        tone: 'success',
        text: `${outcome.created ? 'Contact added to Opportun' : 'Contact updated in Opportun'}${
          outcome.refined ? ' (details refined by AI)' : ''
        }.`,
      };
    case 'job':
      // A job capture is an act of interest: the server resolves it to an opportunity at
      // Interested, completing any lead already waiting for it, and never to a review-queue
      // card. `duplicate` stays in the contract for older servers but is always false now.
      if (outcome.opportunityId === undefined) {
        return { tone: 'success', text: 'Captured to Opportun.' };
      }
      return outcome.stage == null
        ? { tone: 'success', text: 'Added to an opportunity you already track.' }
        : { tone: 'success', text: `Added to your pipeline as ${stageLabel(outcome.stage)}.` };
    case 'connected':
      return { tone: 'success', text: 'Connected: the server accepted the token.' };
    case 'refused':
      return {
        tone: 'error',
        text: `Not captured: ${
          refusalText(outcome.reason, site) ??
          `the server did not recognize this page (${bounded(outcome.reason)}).`
        }`,
      };
    case 'unauthorized':
      return {
        tone: 'error',
        text: 'The server rejected the token: it may be revoked or mistyped. Create a new one in Opportun under Settings > Integrations > Extensions and Connectors.',
      };
    case 'forbidden':
      return {
        tone: 'error',
        text: 'This token does not have the browser capture permission. Create one that does under Settings > Integrations > Extensions and Connectors.',
      };
    case 'rate_limited':
      return {
        tone: 'error',
        text: `Capture limit reached (30 captures per 15 minutes). Try again in ${
          outcome.retryAfterSec === null ? 'a few minutes' : minutes(outcome.retryAfterSec)
        }.`,
      };
    case 'too_large':
      return { tone: 'error', text: 'This page is too large to capture.' };
    case 'invalid':
      return {
        tone: 'error',
        text: `The server refused the request (${outcome.status} ${bounded(outcome.code)}). Check the server address.`,
      };
    case 'server_error':
      return {
        tone: 'error',
        text: `The server returned an unexpected response or a server error (${outcome.status}).`,
      };
    case 'network':
      return {
        tone: 'error',
        text: 'Could not reach the server. Check the address and that the server is running.',
      };
    case 'no_settings':
      return { tone: 'error', text: 'Save your server address and token first.' };
    case 'unsupported_tab':
      return {
        tone: 'error',
        text: 'Open a LinkedIn profile or job page, or an Indeed job, then click Capture.',
      };
    case 'not_a_posting':
      return {
        tone: 'error',
        text: 'Open a single Indeed job (a job page, or a search with a job open on the right), then click Capture.',
      };
    case 'layout_unrecognized':
      return {
        tone: 'error',
        text: `Not captured: ${siteLabel(site)}’s layout was not recognized, so nothing was sent. Reload the job and try again; if it keeps happening, the extension needs an update.`,
      };
    case 'empty_page':
      return {
        tone: 'error',
        text: 'This page has no text yet. Wait for it to load and try again.',
      };
    case 'permission_denied':
      return {
        tone: 'error',
        text: 'The extension needs your permission to contact your server. Save the settings again and allow it.',
      };
    case 'inject_failed':
      return {
        tone: 'error',
        text: 'The extension could not read this tab. Reload the page and try again.',
      };
  }
}
