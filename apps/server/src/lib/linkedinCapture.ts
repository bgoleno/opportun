// LinkedIn capture shape check (FR-C5, plan Task 13, Review Focus 5). The browser extension
// posts a tab the user is looking at as { url, title, text } (text = the tab's innerText). This
// module decides, deterministically and before any AI or database work, whether that tab is
// one person's profile or one job posting, and refuses everything else (the feed, search
// results, company pages, the sign-in wall, half-rendered pages, other hosts): a refusal is
// better than a garbage contact or lead.
//
// C-1: the URL is provenance metadata only. Nothing here or downstream ever fetches it.
//
// Pure functions only (no IO), exported for tests.

import {
  MIN_KEPT_CHARS,
  MIN_KEPT_FRACTION,
  TRAILING_NOISE_MARKER_PATTERNS,
} from '@opportun/core/linkedinMarkers';

/** Lines of page text examined; a real profile or job page states its markers near the top. */
const MAX_LINES = 5_000;
const MAX_HEADLINE = 300;
const MAX_NAME = 200;
const MAX_JOB_FIELD = 300;
/** Description characters kept from the page (NormalizedPosting.descriptionMd allows 50k). */
export const MAX_DESCRIPTION = 50_000;

export type LinkedInPage =
  | { kind: 'profile'; profileUrl: string; name: string; headline: string }
  | {
      kind: 'job';
      jobId: string;
      jobUrl: string;
      title: string;
      company: string;
      descriptionMd: string;
    };

export type UnrecognizedReason =
  | 'not_linkedin'
  | 'unsupported_path'
  | 'login_wall'
  | 'no_name'
  | 'no_headline'
  | 'not_a_profile'
  | 'no_title_company'
  | 'no_description';

export type Recognition = LinkedInPage | { kind: 'unrecognized'; reason: UnrecognizedReason };

export type LinkedInPath = { kind: 'profile'; slug: string } | { kind: 'job'; id: string };

/** The LinkedIn apex host, its www host, or a two-letter country subdomain (uk., de.). */
const LINKEDIN_HOST = /^(?:www\.|[a-z][a-z]\.)?linkedin\.com$/;
const PROFILE_PATH = /^\/in\/([^/]{1,200})\/?$/;
const JOB_PATH = /^\/jobs\/view\/(\d{1,20})\/?$/;

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function slugOf(encoded: string): string {
  let slug = encoded;
  try {
    slug = decodeURIComponent(encoded);
  } catch {
    // Keep the raw segment: it is still a stable key.
  }
  return slug.toLowerCase();
}

/**
 * The page a captured URL names: a profile (/in/<slug>) or a job view (/jobs/view/<id>) on an
 * https LinkedIn host, or null. Sub-pages (/in/x/details/...) and search views are not pages
 * this capture understands.
 */
export function linkedInPathOf(raw: string): LinkedInPath | null {
  const url = parseUrl(raw);
  if (url === null || url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (!LINKEDIN_HOST.test(url.hostname.toLowerCase())) return null;
  const profile = PROFILE_PATH.exec(url.pathname);
  if (profile !== null) return { kind: 'profile', slug: slugOf(profile[1]!) };
  const job = JOB_PATH.exec(url.pathname);
  if (job !== null) return { kind: 'job', id: job[1]! };
  return null;
}

/**
 * The profile key of a stored contact URL (any http(s) LinkedIn host spelling, any query), so
 * a capture matches a contact the data export created. Null for anything else.
 */
export function profileSlugOf(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const url = parseUrl(raw.trim());
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  if (!LINKEDIN_HOST.test(url.hostname.toLowerCase())) return null;
  const m = PROFILE_PATH.exec(url.pathname);
  return m === null ? null : slugOf(m[1]!);
}

/** The captured URL without query, fragment or trailing slash (tracking parameters dropped). */
const profileUrlOf = (host: string, slug: string): string =>
  `https://${host}/in/${encodeURIComponent(slug)}`;
const jobUrlOf = (host: string, id: string): string => `https://${host}/jobs/view/${id}`;

/** Trimmed, non-empty lines of the page text, control characters flattened to spaces. Exported
 *  for issue #264: re-deriving a description from a stored capture needs the same line split,
 *  not a second one that could drift from this one. */
export function linesOf(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // eslint-disable-next-line no-control-regex -- flattening control characters is the point
    const line = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (line !== '') out.push(line);
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

/** The tab title's parts: "(3) Dana Testworth | LinkedIn" -> ["Dana Testworth"]. */
function titleParts(title: string): string[] {
  const parts = title
    .replace(/^\(\d+\+?\)\s*/, '')
    .split(' | ')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.at(-1)?.toLowerCase() === 'linkedin') parts.pop();
  return parts;
}

const LOGIN_TITLE = /^(?:sign ?up|sign ?in|log ?in|linkedin login|join linkedin)\b/i;
const LOGIN_TEXT = [
  'sign in to view',
  'join to view',
  'forgot password?',
  'agree & join',
  'sign in with email',
  'new to linkedin? join now',
];

/** LinkedIn's sign-in wall, in any of the shapes it serves on a profile or job URL. */
export function isLoginWall(title: string, text: string): boolean {
  if (LOGIN_TITLE.test(titleParts(title).join(' | '))) return true;
  const lower = text.toLowerCase();
  return LOGIN_TEXT.some((marker) => lower.includes(marker));
}

/** Lines between a profile's name and its headline that are not the headline. */
const PROFILE_NOISE = [
  /^(?:he|she|they|ze|xe)\/\w+$/i,
  /^·?\s*(?:1st|2nd|3rd\+?)(?: degree connection)?$/i,
  /^·$/,
  /^verified$/i,
];
/** Site chrome that can follow a name but is never a headline. */
const NOT_HEADLINE = new Set(
  [
    'message',
    'connect',
    'follow',
    'following',
    'more',
    'pending',
    'contact info',
    'open to',
    'add profile section',
    'about',
    'experience',
  ].map((s) => s.toLowerCase()),
);
const COUNTS = /^[\d,.]+\+?\s+(?:connections|followers)$/i;

function headlineAfter(lines: string[], nameIndex: number, name: string): string | null {
  for (const line of lines.slice(nameIndex + 1, nameIndex + 5)) {
    if (PROFILE_NOISE.some((re) => re.test(line))) continue;
    if (line === name || NOT_HEADLINE.has(line.toLowerCase()) || COUNTS.test(line)) return null;
    if (line.length < 2 || line.length > MAX_HEADLINE) return null;
    return line;
  }
  return null;
}

/** A profile shows at least one of these; the feed and search results show none of them. */
function hasProfileSections(lines: string[]): boolean {
  return lines.some((l) => {
    const lower = l.toLowerCase();
    return lower === 'contact info' || lower === 'experience' || COUNTS.test(l);
  });
}

function recognizeProfile(host: string, slug: string, title: string, lines: string[]): Recognition {
  const [name] = titleParts(title);
  if (name === undefined || name.length > MAX_NAME) {
    return { kind: 'unrecognized', reason: 'no_name' };
  }
  if (!hasProfileSections(lines)) return { kind: 'unrecognized', reason: 'not_a_profile' };
  let sawName = false;
  for (const [i, line] of lines.entries()) {
    if (line !== name) continue;
    sawName = true;
    const headline = headlineAfter(lines, i, name);
    if (headline !== null) {
      return { kind: 'profile', profileUrl: profileUrlOf(host, slug), name, headline };
    }
  }
  return { kind: 'unrecognized', reason: sawName ? 'no_headline' : 'no_name' };
}

const DESCRIPTION_START = 'about the job';
// 'set alert for similar jobs' was removed here (issue #264, confirmed against the owner's own
// real stored GitHub capture, read-only, never committed): that exact line sits inside the
// job's own header actions, not at a section boundary -- on that real page it appeared 101
// lines into the posting, well before 'About the company', and stopping there cut the
// description down to a third of the real content. This is the same landmine
// @opportun/core/linkedinMarkers' own comment already warns against for a different reason
// (there, a substring match on 'similar jobs' would cut away the posting instead of the
// rail); here the exact phrase itself was the problem. 'similar jobs' alone (a real section
// heading, confirmed elsewhere) is kept.
const DESCRIPTION_END = new Set(
  ['about the company', 'more jobs', 'similar jobs'].map((s) => s.toLowerCase()),
);

/**
 * The same trailing-noise cut `extractPage` (packages/extension/src/extract.ts) applies at
 * capture time (issue #246). Both read `@opportun/core/linkedinMarkers` as their one shared
 * source of truth (issue #275); this function has no serialization constraint of its own, so
 * it just imports it directly, unlike `extractPage`, which must receive the same data as a
 * parameter. Issue #264's re-derive needs this exact cut too: a capture made before #246
 * shipped still carries the rail in its raw stored text, and `descriptionOf` below cannot be
 * trusted alone to stop before it reaches one (its own marker set is deliberately narrower and
 * exists for a different reason -- finding where "About the job" ends, not where the page's
 * site chrome begins).
 */
const trailingNoiseMarkers = TRAILING_NOISE_MARKER_PATTERNS.map((p) => new RegExp(p, 'i'));

export function cutTrailingNoise(text: string): string {
  const lines = text.split('\n');
  const floor = Math.max(MIN_KEPT_CHARS, text.length * MIN_KEPT_FRACTION);
  let cutAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- i is a bounded loop index
    const line = lines[i]!.trim();
    if (line === '' || !trailingNoiseMarkers.some((marker) => marker.test(line))) continue;
    if (lines.slice(0, i).join('\n').length >= floor) {
      cutAt = i;
      break;
    }
  }
  return cutAt === -1 ? text : lines.slice(0, cutAt).join('\n');
}

/** Exported for issue #264: the same "About the job" to "About the company"/similar-jobs
 *  extraction a fresh capture falls back to when AI is unavailable, reused as-is to re-derive a
 *  description from a capture's raw text already stored on an opportunity's timeline. */
export function descriptionOf(lines: string[]): string | null {
  const start = lines.findIndex((l) => l.toLowerCase() === DESCRIPTION_START);
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (DESCRIPTION_END.has(line.toLowerCase())) break;
    body.push(line);
  }
  const text = body.join('\n').slice(0, MAX_DESCRIPTION).trim();
  return text === '' ? null : text;
}

function recognizeJob(host: string, id: string, title: string, lines: string[]): Recognition {
  // A job view's tab title is "<job title> | <company> | LinkedIn"; both must be on the page.
  const parts = titleParts(title);
  const [jobTitle, company] = parts;
  const onPage = new Set(lines);
  if (
    parts.length !== 2 ||
    jobTitle === undefined ||
    company === undefined ||
    jobTitle.length > MAX_JOB_FIELD ||
    company.length > MAX_JOB_FIELD ||
    !onPage.has(jobTitle) ||
    !onPage.has(company)
  ) {
    return { kind: 'unrecognized', reason: 'no_title_company' };
  }
  const descriptionMd = descriptionOf(lines);
  if (descriptionMd === null) return { kind: 'unrecognized', reason: 'no_description' };
  return {
    kind: 'job',
    jobId: id,
    jobUrl: jobUrlOf(host, id),
    title: jobTitle,
    company,
    descriptionMd,
  };
}

/** Decides what a captured tab is. Never throws; never touches the network. */
export function recognizeLinkedInPage(input: {
  url: string;
  title: string;
  text: string;
}): Recognition {
  const url = parseUrl(input.url);
  if (url === null || !LINKEDIN_HOST.test(url.hostname.toLowerCase())) {
    return { kind: 'unrecognized', reason: 'not_linkedin' };
  }
  const path = linkedInPathOf(input.url);
  if (path === null) return { kind: 'unrecognized', reason: 'unsupported_path' };
  if (isLoginWall(input.title, input.text)) return { kind: 'unrecognized', reason: 'login_wall' };
  const lines = linesOf(input.text);
  const host = url.hostname.toLowerCase();
  return path.kind === 'profile'
    ? recognizeProfile(host, path.slug, input.title, lines)
    : recognizeJob(host, path.id, input.title, lines);
}

const normalizeForGrounding = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * True when `value` occurs in `pageText` as whole words, ignoring case and whitespace runs.
 * Model output about a profile is kept only when it is grounded this way, so an injected
 * instruction cannot make the model invent an employer the page never shows.
 */
export function isGroundedIn(value: string, pageText: string): boolean {
  const needle = normalizeForGrounding(value);
  if (needle === '') return false;
  const hay = normalizeForGrounding(pageText);
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    const before = at === 0 ? '' : hay.charAt(at - 1);
    const after = hay.charAt(at + needle.length);
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
  }
  return false;
}
