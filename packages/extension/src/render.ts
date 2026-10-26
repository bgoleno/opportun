// One line of feedback for the popup per Outcome. Pure, unit-tested. Takes no settings, so
// it can never echo the token.
import type { Outcome } from './api';

export interface Rendered {
  tone: 'success' | 'info' | 'error';
  text: string;
}

const NOT_LOADED =
  'the page had not finished loading. Wait for it (scroll the profile or job description into view) and try again.';

/** The server's refusal reasons (apps/server/src/lib/linkedinCapture.ts UnrecognizedReason). */
const REASONS = new Map<string, string>([
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

export function renderOutcome(outcome: Outcome): Rendered {
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
          REASONS.get(outcome.reason) ??
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
    case 'not_linkedin':
      return { tone: 'error', text: 'Open a LinkedIn profile or job page, then click Capture.' };
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
