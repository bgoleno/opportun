// Assisted apply prefill, the popup's half (M3, https://github.com/bgoleno/opportun/issues/183;
// tl's design on #120). On the user's click, on a Greenhouse posting tab: read the one
// handed-off attempt for this page from the user's own server (GET /connector/apply/current,
// #182), check the tab is that attempt's pinned posting, fetch its resume copy when it is
// ready, and build the plan the injected filler (greenhouseFill.ts) fills from. The page itself
// receives only the plan: the reviewed values and the file, never anything else of the popup's.
// Pure helpers and injected fetch; unit-tested.
import type { FetchResponse } from './api';
import type { FillPlan, FillReport, NotFilledReason } from './greenhouseFill';
import type { Rendered } from './render';
import type { Settings } from './settings';

const APPLY_PATH = '/api/v1/connector/apply';

/** The reads here are GETs with no body; a capture's POST keeps its own FetchLike (api.ts). */
export interface GetInit {
  method: 'GET';
  headers: Record<string, string>;
  credentials: 'omit';
  redirect: 'error';
}
export type GetLike = (url: string, init: GetInit) => Promise<FetchResponse>;

/**
 * How the popup confirms the resume after the fill (tl and sec on #187): it looks this many
 * times, this far apart (about 1.5 s in all), for the form to show the file's name. React 19
 * renders it after a macrotask, so the page side, which keeps no timer, cannot tell.
 */
export const RESUME_CHECKS = 6;
export const RESUME_GAP_MS = 300;

/** The server's snapshot ceiling (10 MB, #115); anything larger is not attached. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/**
 * The Greenhouse posting an https tab URL is on: `/<board>/jobs/<id>` on either Greenhouse
 * board host, which the server treats as one (destinationAllowed). Null for anything else,
 * including an embedded board on another site, which M3 does not fill. The injected filler keeps
 * its own copy of this rule for its last check in the page (it cannot import), and
 * test/greenhouseFill.test.ts pins the two equal.
 */
export function greenhouseJobOf(href: string): { board: string; jobId: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // https on the default port only (tl on #187).
  if (url.protocol !== 'https:' || url.port !== '') return null;
  if (url.hostname !== 'job-boards.greenhouse.io' && url.hostname !== 'boards.greenhouse.io') {
    return null;
  }
  const parts = url.pathname.split('/').filter((p) => p !== '');
  if (parts.length !== 3 || parts[1] !== 'jobs') return null;
  const [board, , jobId] = parts as [string, string, string];
  return { board: board.toLowerCase(), jobId };
}

/** Same board (case-insensitive, as the server compares slugs) and the same job id. */
export const samePosting = (
  a: { board: string; jobId: string },
  b: { board: string; jobId: string },
): boolean => a.board.toLowerCase() === b.board.toLowerCase() && a.jobId === b.jobId;

/** The attempt as GET /connector/apply/current returns it (routes/connectorApply.ts, #182). */
export interface PrefillAttempt {
  id: string;
  destinationUrl: string;
  fields: Record<string, string>;
  answers: { label: string; value: string }[];
  resume: { snapshotState: string | null; filename: string | null; bytes: number | null };
  /**
   * Detail fields the server left out because their stored value fails today's checks (#196):
   * keys only. Each is listed for the user to fill, never filled.
   */
  withheld: string[];
}

export type PrefillMiss = 'no_matching_attempt' | 'several_handed_off' | 'review_stale';

export type CurrentResult =
  | { kind: 'attempt'; attempt: PrefillAttempt }
  | { kind: 'none'; reason: PrefillMiss }
  | { kind: 'unauthorized' }
  | { kind: 'no_scope' }
  | { kind: 'unavailable' }
  | { kind: 'rate_limited'; retryAfterSec: number | null }
  | { kind: 'server_error'; status: number }
  | { kind: 'network' };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const MISSES: readonly string[] = ['no_matching_attempt', 'several_handed_off', 'review_stale'];

function stringRecord(v: unknown): Record<string, string> | null {
  if (!isRecord(v)) return null;
  const entries = Object.entries(v);
  if (!entries.every(([, value]) => typeof value === 'string')) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

/** The response body, checked field by field: anything off is a server error, never a guess. */
function parseCurrent(body: unknown): CurrentResult | null {
  if (!isRecord(body)) return null;
  if (body.attempt === null) {
    return typeof body.reason === 'string' && MISSES.includes(body.reason)
      ? { kind: 'none', reason: body.reason as PrefillMiss }
      : null;
  }
  const a = body.attempt;
  if (!isRecord(a) || typeof a.id !== 'string' || typeof a.destinationUrl !== 'string') {
    return null;
  }
  const fields = stringRecord(a.fields);
  if (fields === null || !Array.isArray(a.answers) || !isRecord(a.resume)) return null;
  const answers: { label: string; value: string }[] = [];
  for (const x of a.answers as unknown[]) {
    if (!isRecord(x) || typeof x.label !== 'string' || typeof x.value !== 'string') return null;
    answers.push({ label: x.label, value: x.value });
  }
  // Absent when nothing is withheld; when present, a list of field names, or the answer is wrong.
  let withheld: string[] = [];
  if (a.withheld !== undefined) {
    if (!Array.isArray(a.withheld) || !a.withheld.every((k) => typeof k === 'string')) return null;
    withheld = a.withheld as string[];
  }
  const r = a.resume;
  return {
    kind: 'attempt',
    attempt: {
      id: a.id,
      destinationUrl: a.destinationUrl,
      fields,
      answers,
      resume: {
        snapshotState: typeof r.snapshotState === 'string' ? r.snapshotState : null,
        filename: typeof r.filename === 'string' ? r.filename : null,
        bytes: typeof r.bytes === 'number' ? r.bytes : null,
      },
      withheld,
    },
  };
}

async function get(fetch: GetLike, settings: Settings, url: string, accept: string) {
  try {
    return await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${settings.token}`, accept },
      // As for a capture: bearer only, no cookies, and no redirect may carry the request away.
      credentials: 'omit',
      redirect: 'error',
    });
  } catch {
    return null;
  }
}

function retryAfter(res: FetchResponse): number | null {
  const after = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  return Number.isFinite(after) ? after : null;
}

/** The handed-off attempt for this tab, or why there is none. The tab's full URL is sent. */
export async function fetchCurrent(
  fetch: GetLike,
  settings: Settings,
  tabUrl: string,
): Promise<CurrentResult> {
  const res = await get(
    fetch,
    settings,
    `${settings.serverUrl}${APPLY_PATH}/current?url=${encodeURIComponent(tabUrl)}`,
    'application/json',
  );
  if (res === null) return { kind: 'network' };
  if (res.status === 401) return { kind: 'unauthorized' };
  if (res.status === 403) return { kind: 'no_scope' };
  if (res.status === 404) return { kind: 'unavailable' };
  if (res.status === 429) return { kind: 'rate_limited', retryAfterSec: retryAfter(res) };
  if (res.status !== 200) return { kind: 'server_error', status: res.status };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return parseCurrent(body) ?? { kind: 'server_error', status: res.status };
}

/** base64 of the bytes, in chunks so a large file does not overflow the argument list. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

/** The resume copy, none to attach, or a refusal that stops the whole fill. */
export type ResumeResult =
  { kind: 'file'; base64: string } | { kind: 'none' } | { kind: 'review_stale' };

/**
 * The attempt's resume copy as base64, or none whenever it cannot be attached as exactly that
 * file: not `ready` (pending, unsupported, failed, or `deleted`, #185), refused (409
 * snapshot_not_ready, or 404 when the attempt is no longer handed off), not a PDF, empty,
 * larger than the server's ceiling, or not the size /current announced. A 409 review_stale is
 * different: what was reviewed changed, so nothing at all may be filled (#185, tl).
 */
export async function fetchResume(
  fetch: GetLike,
  settings: Settings,
  attempt: PrefillAttempt,
): Promise<ResumeResult> {
  const none = { kind: 'none' } as const;
  const { snapshotState, filename, bytes } = attempt.resume;
  if (snapshotState !== 'ready' || filename === null || filename === '' || bytes === null) {
    return none;
  }
  if (bytes <= 0 || bytes > MAX_RESUME_BYTES) return none;
  const res = await get(
    fetch,
    settings,
    `${settings.serverUrl}${APPLY_PATH}/${encodeURIComponent(attempt.id)}/snapshot`,
    'application/pdf',
  );
  if (res === null) return none;
  if (res.status === 409) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const error = isRecord(body) && isRecord(body.error) ? body.error : {};
    return error.code === 'review_stale' ? { kind: 'review_stale' } : none;
  }
  if (res.status !== 200 || res.arrayBuffer === undefined) return none;
  if (!(res.headers.get('content-type') ?? '').toLowerCase().startsWith('application/pdf')) {
    return none;
  }
  let data: Uint8Array;
  try {
    data = new Uint8Array(await res.arrayBuffer());
  } catch {
    return none;
  }
  if (data.length !== bytes) return none;
  // "%PDF-": the file is what the form is told it is.
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d];
  if (!magic.every((b, i) => data.at(i) === b)) return none;
  return { kind: 'file', base64: toBase64(data) };
}

/**
 * Each detail field prefill fills by name (tl's mapping, #183): its key in the attempt, the form's
 * standard id for it or the question labels it matches, and the name the popup gives it. One
 * table for the fields to fill and for those the server withholds (#196; tl and qa on #201, #204).
 */
const PREFILL_FIELDS: readonly {
  key: string;
  id: string | null;
  labels: readonly string[];
  name: string;
}[] = [
  { key: 'firstName', id: 'first_name', labels: [], name: 'First name' },
  { key: 'lastName', id: 'last_name', labels: [], name: 'Last name' },
  { key: 'email', id: 'email', labels: [], name: 'Email' },
  { key: 'phone', id: 'phone', labels: [], name: 'Phone' },
  {
    key: 'linkedinUrl',
    id: null,
    labels: ['LinkedIn Profile', 'LinkedIn'],
    name: 'LinkedIn profile',
  },
  { key: 'websiteUrl', id: null, labels: ['Website'], name: 'Website' },
  // #435 (slice 1 of #402; tl's ruling on #437): the city and how you heard fill a text question
  // with exactly one of these labels, compared whole like every other. Country, School and Degree
  // are not planned yet: on Greenhouse they are lists, which the filler leaves alone and reports
  // as choose it on the form whatever the plan holds, and slice 2 adds them when it can choose.
  { key: 'location', id: null, labels: ['Location (City)'], name: 'Location (city)' },
  {
    key: 'heardFrom',
    id: null,
    labels: [
      'How did you hear about this role?',
      'How did you hear about this job?',
      'How did you hear about this position?',
      'How did you hear about this opportunity?',
      'How did you hear about us?',
    ],
    name: 'How did you hear about this role?',
  },
];

/**
 * What the filler fills, from the reviewed attempt only (tl's mapping): the four standard
 * fields by the form's ids, the other details (LinkedIn, website, and #435's city and how you
 * heard) by the question's exact label, and each reviewed answer by
 * its exact label. Empty values are left out: nothing is invented.
 */
export function buildPlan(
  attempt: PrefillAttempt,
  posting: { board: string; jobId: string },
  resumeBase64: string | null,
): FillPlan {
  const fields = new Map(Object.entries(attempt.fields));
  const value = (key: string): string => fields.get(key) ?? '';
  const standard = PREFILL_FIELDS.flatMap((f) =>
    f.id === null ? [] : [{ id: f.id, name: f.name, value: value(f.key) }],
  ).filter((x) => x.value !== '');
  const questions = [
    ...PREFILL_FIELDS.flatMap((f) =>
      f.id !== null ? [] : [{ labels: [...f.labels], name: f.name, value: value(f.key) }],
    ),
    ...attempt.answers.map((a) => ({ labels: [a.label], name: a.label, value: a.value })),
  ].filter((q) => q.value !== '');
  const filename = attempt.resume.filename;
  return {
    board: posting.board,
    jobId: posting.jobId,
    standard,
    questions,
    resume: resumeBase64 === null || filename === null ? null : { filename, base64: resumeBase64 },
    // Which field each withheld key is, so the filler reports it once (#196, tl on #201): its
    // standard id or question labels and its name, never a value.
    withheld: attempt.withheld.map(withheldField),
  };
}

/** A withheld key as the filler finds it on the form: the same table as the fields to fill. */
function withheldField(key: string): { id: string | null; labels: string[]; name: string } {
  const f = PREFILL_FIELDS.find((x) => x.key === key);
  return f === undefined
    ? { id: null, labels: [], name: withheldLabel(key) }
    : { id: f.id, labels: [...f.labels], name: f.name };
}

/** Why a field was not filled, in words (the popup's list). */
export const NOT_FILLED_WORDS = new Map<NotFilledReason, string>([
  ['choose_on_form', 'choose it on the form'],
  ['not_in_review', 'not in what you reviewed: answer it on the form'],
  ['no_matching_question', 'no question on this form has exactly this label'],
  ['has_value', 'it already had something in it, so it was left as it was'],
  ['not_shown', 'the form does not show this field, so it was left alone'],
  [
    'ambiguous',
    'more than one question or answer has this label, so it was not filled: answer it on the form',
  ],
  ['attach_yourself', 'attach your resume yourself'],
  ['attach_file_yourself', 'attach this file yourself'],
  [
    'withheld',
    "it no longer passes Opportun's checks: correct it in Opportun, or fill it in yourself",
  ],
  [
    'resume_unchecked',
    'it could not be checked: look at the resume on the form, and attach it yourself if it is missing or wrong',
  ],
]);

/** Always said after a fill: Opportun never submits. */
export const SUBMIT_REMINDER =
  "Opportun has not submitted anything. Check every field on the form, then press the site's own Submit button.";

/** One status line for a stop before anything was filled. */
export function renderPrefillStop(
  stop:
    | Exclude<CurrentResult, { kind: 'attempt' }>
    | { kind: 'not_greenhouse' }
    | { kind: 'other_posting'; destinationUrl: string }
    | { kind: 'inject_failed' }
    | { kind: 'wrong_page' }
    | { kind: 'no_form' },
): Rendered {
  const nothing = 'Nothing was filled.';
  switch (stop.kind) {
    case 'not_greenhouse':
      return {
        tone: 'error',
        text: `Open the application's page on Greenhouse (the address Opportun opened for you), then click Fill in again. ${nothing}`,
      };
    case 'none':
      return {
        tone: 'error',
        text:
          stop.reason === 'several_handed_off'
            ? // A re-application from a second opportunity can be handed off while the first still
              // is (qa, tl on #183): which one is meant cannot be known here, so nothing is filled.
              `You have two applications open for this job. In Opportun, record the earlier one (I submitted it, or I did not submit it), then try again. ${nothing}`
            : stop.reason === 'review_stale'
              ? `This application changed after you reviewed it. Review it again in Opportun. ${nothing}`
              : `None of your applications was handed off to this posting. Start it from Opportun's Apply step, then try again. ${nothing}`,
      };
    case 'other_posting':
      return {
        tone: 'error',
        text: `This tab is not the posting this application was handed off to (${stop.destinationUrl.slice(0, 200)}). ${nothing}`,
      };
    case 'unauthorized':
      return {
        tone: 'error',
        text: `The server rejected the token: it may be revoked or mistyped. Create a new one in Opportun under Settings > Integrations > Extensions and Connectors. ${nothing}`,
      };
    case 'no_scope':
      return {
        tone: 'error',
        text: "This extension's token can't fill in applications. In Opportun, open Settings > Integrations > Extensions and Connectors, set the extension up again and tick 'Also let it fill in applications you hand off', then revoke the old token.",
      };
    case 'unavailable':
      return {
        tone: 'error',
        text: `Assisted apply is not turned on on your Opportun server. ${nothing}`,
      };
    case 'rate_limited':
      return {
        tone: 'error',
        text: `Too many requests to your server for now. Try again in ${
          stop.retryAfterSec === null
            ? 'a few minutes'
            : `about ${Math.max(1, Math.ceil(stop.retryAfterSec / 60))} minute(s)`
        }. ${nothing}`,
      };
    case 'server_error':
      return {
        tone: 'error',
        text: `The server returned an unexpected response (${stop.status}). ${nothing}`,
      };
    case 'network':
      return {
        tone: 'error',
        text: `Could not reach the server. Check the address and that the server is running. ${nothing}`,
      };
    case 'inject_failed':
      return {
        tone: 'error',
        text: `The extension could not run in this tab. Reload the page and try again. ${nothing}`,
      };
    case 'wrong_page':
      return {
        tone: 'error',
        text: `The tab moved off this application's posting before filling. ${nothing}`,
      };
    case 'no_form':
      return {
        tone: 'error',
        text: `No Greenhouse application form was found on this page. Wait for it to load and try again. ${nothing}`,
      };
  }
}

/** The report the popup lists: what was filled, what was not and why, then the reminder. */
export function reportLines(report: Extract<FillReport, { ok: true }>): {
  filled: string[];
  notFilled: string[];
  reminder: string;
} {
  return {
    filled: report.filled.map((l) => l.slice(0, 200)),
    notFilled: report.notFilled.map(
      (n) => `${n.label.slice(0, 200)}: ${NOT_FILLED_WORDS.get(n.reason) ?? 'fill it in yourself'}`,
    ),
    reminder: SUBMIT_REMINDER,
  };
}

/** A withheld field's label, or its key when the popup has no name for it. */
export const withheldLabel = (key: string): string =>
  PREFILL_FIELDS.find((f) => f.key === key)?.name ?? key.slice(0, 200);
