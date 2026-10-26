// Posting sanitization (NFR-SEC, Review Focus 1). Posting text comes from third parties (ATS
// boards, MCP tools, alert mail) and is hostile data: before anything is stored, ranked or
// shown, markup is stripped (scripts and styles with their content), entities are decoded,
// control and bidi-override characters are removed, the NormalizedPosting caps are enforced by
// truncation, and links other than http(s) are dropped. The output is plain text; the UI
// renders it as text only, and prompts fence it as *_untrusted.
import type { NormalizedPosting } from '@opportun/core';

export const POSTING_CAPS = {
  company: 300,
  title: 300,
  descriptionMd: 50_000,
  postingUrl: 2000,
  location: 300,
  compNote: 500,
  externalId: 500,
} as const;

/** Elements removed together with their content. */
const DROP_ELEMENTS = ['script', 'style', 'noscript', 'template', 'iframe', 'object', 'svg'];

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201d',
  ldquo: '\u201c',
  bull: '\u2022',
  middot: '\u00b7',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  euro: '\u20ac',
  pound: '\u00a3',
};

/** ASCII-only lowercase: unlike toLowerCase it never changes the length, so indexes line up. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Removes <name ...>...</name> blocks, case-insensitively, in one pass with indexOf (no lazy
 * regex), so input full of unclosed or repeated tags stays linear. An unclosed element drops
 * the rest of the input.
 */
function dropElement(html: string, name: string): string {
  const low = asciiLower(html);
  const open = `<${name}`;
  const parts: string[] = [];
  let pos = 0;
  let start = low.indexOf(open);
  while (start !== -1) {
    const after = low.charAt(start + open.length);
    if (after !== '' && /[a-z0-9-]/.test(after)) {
      // A longer tag name (e.g. <scripts>): not this element.
      start = low.indexOf(open, start + 1);
      continue;
    }
    parts.push(html.slice(pos, start), ' ');
    const close = low.indexOf(`</${name}`, start);
    const end = close === -1 ? -1 : low.indexOf('>', close);
    pos = end === -1 ? html.length : end + 1;
    start = low.indexOf(open, pos);
  }
  parts.push(html.slice(pos));
  return parts.join('');
}

function dropElements(html: string): string {
  return DROP_ELEMENTS.reduce(dropElement, html);
}

const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
// Tags start right after '<' (browsers read "< b" as text). No optional whitespace runs next to
// each other, so matching stays linear on hostile input.
const BLOCK_BREAK = /<(?:br|\/p|\/div|\/h[1-6]|\/tr|\/ul|\/ol|\/section|\/article)\b[^<>]*>/gi;
const LIST_ITEM = /<li\b[^<>]*>/gi;
const BLOCK_OPEN = /<(?:p|div|h[1-6]|tr|ul|ol|section|article)\b[^<>]*>/gi;
const ANY_TAG = /<\/?[a-z!?][^<>]*>/gi;
/** A tag cut off by the end of the input. */
const TRAILING_TAG = /<\/?[a-z!?][^<>]*$/i;

function stripTags(html: string, multiline: boolean): string {
  let s = dropElements(html).replace(COMMENT, ' ');
  if (multiline) {
    s = s.replace(LIST_ITEM, '\n- ').replace(BLOCK_BREAK, '\n').replace(BLOCK_OPEN, '\n');
  }
  return s.replace(ANY_TAG, multiline ? '' : ' ').replace(TRAILING_TAG, '');
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      const valid =
        Number.isInteger(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : '';
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** C0/C1 controls and invisible direction overrides (which can disguise text). */
const CONTROL = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const CONTROL_EXCEPT_NEWLINE_TAB = /[^\P{Cc}\n\t]|[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** Cuts to `max` UTF-16 units without leaving half a surrogate pair. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** Markup removed, entities decoded, markup that decoding revealed removed again. */
function plain(value: string, multiline: boolean): string {
  return stripTags(decodeEntities(stripTags(value, multiline)), multiline);
}

function line(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const s = plain(value.replace(/[\t\n\v\f\r]/g, ' '), false)
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(s, max).trim();
}

function optionalLine(value: unknown, max: number): string | null {
  const s = line(value, max);
  return s === '' ? null : s;
}

/**
 * Markup stripped (elements dropped whole by `dropElements`, so a `<script>`'s content can
 * never smuggle text past the cleaner no matter what it contains), entities decoded, paragraph
 * breaks kept as newlines, bounded to POSTING_CAPS.descriptionMd. Exported so a posting path that
 * only has a raw page body (not yet a NormalizedPosting) can reach the same cleaning
 * `sanitizePosting` applies to a description field, instead of reaching for a different
 * HTML-to-text function (issue #238: `opportunityEnrich` used the Gmail adapter's `htmlToText`,
 * whose regex-based element matching searches the whole remaining document for the first literal
 * closing tag rather than stopping at the matching one, and a careers page's `<head>` script held
 * JSON values that were themselves complete HTML documents containing several `</head>` strings).
 */
export function sanitizeDescriptionText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = plain(value.replace(/\r\n?/g, '\n'), true)
    .replace(CONTROL_EXCEPT_NEWLINE_TAB, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const out = truncate(s, POSTING_CAPS.descriptionMd).trim();
  return out === '' ? null : out;
}

/** http(s) links only; anything else (javascript:, data:, relative, oversized) is dropped. */
function link(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.replace(CONTROL, '').trim();
  if (raw === '' || raw.length > POSTING_CAPS.postingUrl) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.href.length > POSTING_CAPS.postingUrl ? null : url.href;
}

/** The largest |epoch ms| a JavaScript Date can hold (toISOString throws beyond it). */
const MAX_DATE_MS = 8.64e15;

/** An integer epoch-ms time inside the Date range; anything else is dropped to null (not clamped). */
function postedAt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= MAX_DATE_MS
    ? value
    : null;
}

/**
 * The posting as plain, bounded text. Every adapter's output passes through here before it is
 * stored or used. Robust to raw values of the wrong type (an adapter maps untrusted JSON).
 */
export function sanitizePosting(p: NormalizedPosting): NormalizedPosting {
  const raw = p as Record<string, unknown>;
  return {
    company: line(raw.company, POSTING_CAPS.company),
    title: line(raw.title, POSTING_CAPS.title),
    descriptionMd: sanitizeDescriptionText(raw.descriptionMd),
    postingUrl: link(raw.postingUrl),
    location: optionalLine(raw.location, POSTING_CAPS.location),
    remote: typeof raw.remote === 'boolean' ? raw.remote : null,
    compNote: optionalLine(raw.compNote, POSTING_CAPS.compNote),
    externalId: optionalLine(raw.externalId, POSTING_CAPS.externalId),
    postedAt: postedAt(raw.postedAt),
  };
}
