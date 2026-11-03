// "Record confirmation page" (assisted apply M4, https://github.com/bgoleno/opportun/issues/121):
// on the user's click, over the application site's thank-you page, the popup asks the server
// which application this page may confirm (GET /connector/apply/confirmable), reads the page's
// text once, and sends it with the tab's own address (POST /connector/apply/:id/confirmation).
// The server decides everything again on the POST (tl on #121); nothing here records "I
// submitted it", and the address sent is always the browser's tab.url, never one the page
// reports (sec on https://github.com/bgoleno/opportun/pull/188).
import type { FetchLike, FetchResponse } from './api';
import type { GetLike } from './prefill';
import type { Rendered } from './render';
import type { Settings } from './settings';

/** The server keeps at most this much of the page (the route's schema); the rest is cut here. */
export const CONFIRMATION_TEXT_MAX = 20_000;
const TITLE_MAX = 500;
const APPLY_PATH = '/api/v1/connector/apply';

/** What the page reader returns: the page's own address only to compare with the tab's. */
export interface ReadPage {
  href: string;
  title: string;
  text: string;
}

/**
 * Injected once into the tab on the click (scripting.executeScript, top frame, no args): the
 * page's visible text and title, and its address so the popup can tell that the tab has not
 * moved since the lookup. Self-contained: it is serialized, so it may use nothing from here.
 */
export function readConfirmationPage(doc: Document = document): ReadPage {
  return {
    href: doc.location.href,
    title: doc.title,
    text: doc.body?.innerText ?? '',
  };
}

export type ConfirmableMiss =
  'no_matching_attempt' | 'several_matching' | 'needs_submitted_first' | 'already_recorded';

export type ConfirmableResult =
  | { kind: 'attempt'; id: string; opportunityTitle: string; companyName: string }
  | { kind: 'none'; reason: ConfirmableMiss }
  | { kind: 'unauthorized' }
  | { kind: 'no_scope' }
  | { kind: 'unavailable' }
  | { kind: 'rate_limited'; retryAfterSec: number | null }
  | { kind: 'server_error'; status: number }
  | { kind: 'network' };

const MISSES: readonly string[] = [
  'no_matching_attempt',
  'several_matching',
  'needs_submitted_first',
  'already_recorded',
];

function retryAfter(res: FetchResponse): number | null {
  const after = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  return Number.isFinite(after) ? after : null;
}

/** The answers every device route shares, or null for a 200 the caller reads itself. */
function common(
  res: FetchResponse,
): Extract<
  ConfirmableResult,
  { kind: 'unauthorized' | 'no_scope' | 'unavailable' | 'rate_limited' | 'server_error' }
> | null {
  if (res.status === 401) return { kind: 'unauthorized' };
  if (res.status === 403) return { kind: 'no_scope' };
  if (res.status === 404) return { kind: 'unavailable' };
  if (res.status === 429) return { kind: 'rate_limited', retryAfterSec: retryAfter(res) };
  return null;
}

async function body(res: FetchResponse): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function parseConfirmable(value: unknown): ConfirmableResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as { attempt?: unknown; reason?: unknown };
  if (v.attempt === null) {
    if (typeof v.reason !== 'string' || !MISSES.includes(v.reason)) return null;
    return { kind: 'none', reason: v.reason as ConfirmableMiss };
  }
  const a = v.attempt as { id?: unknown; opportunityTitle?: unknown; companyName?: unknown };
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof a.id !== 'string' ||
    typeof a.opportunityTitle !== 'string' ||
    typeof a.companyName !== 'string'
  ) {
    return null;
  }
  return {
    kind: 'attempt',
    id: a.id,
    opportunityTitle: a.opportunityTitle,
    companyName: a.companyName,
  };
}

/** Which application this tab's page may confirm, or why none. The tab's address is sent. */
export async function fetchConfirmable(
  get: GetLike,
  settings: Settings,
  tabUrl: string,
): Promise<ConfirmableResult> {
  let res: FetchResponse;
  try {
    res = await get(
      `${settings.serverUrl}${APPLY_PATH}/confirmable?url=${encodeURIComponent(tabUrl)}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${settings.token}`, accept: 'application/json' },
        // Bearer only: no cookies, and no redirect may carry the request (and its token) away.
        credentials: 'omit',
        redirect: 'error',
      },
    );
  } catch {
    return { kind: 'network' };
  }
  const shared = common(res);
  if (shared !== null) return shared;
  if (res.status !== 200) return { kind: 'server_error', status: res.status };
  return parseConfirmable(await body(res)) ?? { kind: 'server_error', status: res.status };
}

export type RecordResult =
  | { kind: 'recorded'; recorded: boolean }
  | { kind: 'refused'; code: string }
  | Exclude<ConfirmableResult, { kind: 'attempt' } | { kind: 'none' }>;

/** The page's text as sent: at most CONFIRMATION_TEXT_MAX characters, whole otherwise. */
export function confirmationText(text: string): string {
  const cut = text.slice(0, CONFIRMATION_TEXT_MAX);
  // Never end on half a surrogate pair (an emoji cut in two).
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Sends the page for that application. `url` is the tab's own address. */
export async function postConfirmation(
  fetch: FetchLike,
  settings: Settings,
  id: string,
  page: { url: string; title: string; text: string },
): Promise<RecordResult> {
  let res: FetchResponse;
  try {
    res = await fetch(`${settings.serverUrl}${APPLY_PATH}/${encodeURIComponent(id)}/confirmation`, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        url: page.url,
        title: page.title.slice(0, TITLE_MAX),
        text: confirmationText(page.text),
      }),
      credentials: 'omit',
      redirect: 'error',
    });
  } catch {
    return { kind: 'network' };
  }
  const shared = common(res);
  if (shared !== null) return shared;
  const value = (await body(res)) as { recorded?: unknown; error?: { code?: unknown } } | undefined;
  if (res.status === 200 && typeof value?.recorded === 'boolean') {
    return { kind: 'recorded', recorded: value.recorded };
  }
  if ((res.status === 409 || res.status === 422) && typeof value?.error?.code === 'string') {
    return { kind: 'refused', code: value.error.code };
  }
  return { kind: 'server_error', status: res.status };
}

const NOTHING = 'Nothing was recorded.';

/** What the popup says for a stop before or after sending. Sentence style of renderOutcome. */
export function renderConfirmation(
  result:
    | Exclude<ConfirmableResult, { kind: 'attempt' }>
    | RecordResult
    | { kind: 'not_a_page' }
    | { kind: 'capture_site' }
    | { kind: 'inject_failed' }
    | { kind: 'moved' }
    | { kind: 'empty' },
  title?: string,
): Rendered {
  switch (result.kind) {
    case 'recorded':
      return result.recorded
        ? {
            tone: 'success',
            text: `Confirmation page recorded for ${title ?? 'this application'}. You can see or delete it in Opportun.`,
          }
        : {
            tone: 'info',
            text: `This application is already confirmed. ${NOTHING}`,
          };
    case 'none':
      switch (result.reason) {
        case 'needs_submitted_first':
          return {
            tone: 'error',
            text: `In Opportun, say you submitted this application first (I submitted it), then record this page. ${NOTHING}`,
          };
        case 'already_recorded':
          return {
            tone: 'info',
            text: `A confirmation page is already recorded for the application this page belongs to. ${NOTHING}`,
          };
        case 'several_matching':
          return {
            tone: 'error',
            text: `More than one of your applications could match this page. Mark the right one confirmed in Opportun instead. ${NOTHING}`,
          };
        case 'no_matching_attempt':
          return {
            tone: 'error',
            text: `None of your submitted applications is on this site. Open the thank-you page the application site showed you. ${NOTHING}`,
          };
      }
      break;
    case 'refused':
      return {
        tone: 'error',
        text:
          result.code === 'wrong_site'
            ? `This page is not on the application's site. ${NOTHING}`
            : result.code === 'different_job'
              ? `This page is for another job. ${NOTHING}`
              : result.code === 'not_submitted'
                ? `In Opportun, say you submitted this application first (I submitted it), then record this page. ${NOTHING}`
                : `This application can no longer take a confirmation page. ${NOTHING}`,
      };
    case 'not_a_page':
      return {
        tone: 'error',
        text: `Open the application site's thank-you page in this tab, then click Record again. ${NOTHING}`,
      };
    case 'capture_site':
      return {
        tone: 'error',
        text: `A LinkedIn or Indeed page is never an application's confirmation page. ${NOTHING}`,
      };
    case 'inject_failed':
      return {
        tone: 'error',
        text: `The extension could not read this tab. Reload the page and try again. ${NOTHING}`,
      };
    case 'moved':
      return { tone: 'error', text: `The tab moved to another page. Try again. ${NOTHING}` };
    case 'empty':
      return { tone: 'error', text: `This page has no text to record. ${NOTHING}` };
    case 'unauthorized':
      return {
        tone: 'error',
        text: `The server rejected the token: it may be revoked or mistyped. Create a new one in Opportun under Settings > Integrations > Extensions and Connectors. ${NOTHING}`,
      };
    case 'no_scope':
      return {
        tone: 'error',
        text: "This extension's token can't record confirmation pages. In Opportun, open Settings > Integrations > Extensions and Connectors, set the extension up again and tick 'Also let it fill in applications you hand off', then revoke the old token.",
      };
    case 'unavailable':
      return {
        tone: 'error',
        text: `Assisted apply is not turned on on your Opportun server. ${NOTHING}`,
      };
    case 'rate_limited':
      return {
        tone: 'error',
        text: `Too many requests to your server for now. Try again in ${
          result.retryAfterSec === null
            ? 'a few minutes'
            : `about ${Math.max(1, Math.ceil(result.retryAfterSec / 60))} minute(s)`
        }. ${NOTHING}`,
      };
    case 'server_error':
      return {
        tone: 'error',
        text: `The server returned an unexpected response (${result.status}). ${NOTHING}`,
      };
    case 'network':
      return {
        tone: 'error',
        text: `Could not reach the server. Check the address and that the server is running. ${NOTHING}`,
      };
  }
  return { tone: 'error', text: `Something went wrong. ${NOTHING}` };
}
