// Mail text helpers shared by the server's Gmail adapter and the Apple Mail connector CLI
// (FR-M1, FR-M5): one implementation of the HTML-to-text contract and address splitting, so
// pushed mail and synced mail normalize identically. Pure functions, no I/O.

// core compiles without DOM or node types; WHATWG URL is a global in every runtime it serves.
interface ParsedUrl {
  readonly protocol: string;
  readonly href: string;
}
declare const URL: new (input: string) => ParsedUrl;

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (whole, ent: string) => {
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const cp = Number.parseInt(ent.slice(2), 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (ent.startsWith('#')) {
      const cp = Number.parseInt(ent.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES.get(ent.toLowerCase()) ?? whole;
  });
}

/** Longest link kept inline: the NormalizedPosting posting-url cap. */
const MAX_LINK = 2000;
/** Text kept for conversion once scripts, styles and comments are gone (review F2). */
export const MAX_HTML_TEXT_CHARS = 200_000;
export const HTML_TRUNCATED_MARK = '\n[truncated]';
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

// Every pass below scans forward only, so the conversion is linear in the input. The regex
// form it replaces (`<a\b[^>]*>[^]*?<\/a\s*>` and friends) retried from every unclosed
// opening tag, which made 500k characters of `<a href=` take seconds: a hostile message
// could stall every sync that re-read it. Output is unchanged (see mailText.test.ts).

/**
 * Replaces each `<...>` tag (from a '<' to the first '>' after it, as `<[^>]*>` matched) for
 * which `replace` returns a string. Once no '>' is left, no later '<' can close either.
 */
function replaceTags(html: string, open: RegExp, replace: (tag: string) => string | null) {
  // `open` is a global regex literal, fresh per call.
  open.lastIndex = 0;
  let out = '';
  let last = 0;
  for (let m = open.exec(html); m !== null; m = open.exec(html)) {
    const gt = html.indexOf('>', m.index + 1);
    if (gt < 0) break;
    const replacement = replace(html.slice(m.index, gt + 1));
    if (replacement === null) continue;
    out += html.slice(last, m.index) + replacement;
    last = gt + 1;
    open.lastIndex = last;
  }
  return out + html.slice(last);
}

/** `<x ...>` to the first '>' removed (or replaced): the old `/<[^>]*>/g`. */
const stripTags = (html: string, by: string) => replaceTags(html, /</g, () => by);

/**
 * Each `<open ...>` up to the first `closeRe` after it, rewritten by `render`. A name with no
 * closing tag ahead has none for any later opening either, so it is not searched again.
 */
function replaceElements(
  html: string,
  openRe: RegExp,
  closeFor: (m: RegExpExecArray) => RegExp,
  render: (tag: string, inner: string) => string,
): string {
  const unclosed = new Set<string>();
  let out = '';
  let last = 0;
  for (let m = openRe.exec(html); m !== null; m = openRe.exec(html)) {
    const gt = html.indexOf('>', m.index + 1);
    if (gt < 0) break;
    const close = closeFor(m);
    if (unclosed.has(close.source)) continue;
    close.lastIndex = gt + 1;
    const c = close.exec(html);
    if (c === null) {
      unclosed.add(close.source);
      continue;
    }
    out +=
      html.slice(last, m.index) + render(html.slice(m.index, gt + 1), html.slice(gt + 1, c.index));
    last = close.lastIndex;
    openRe.lastIndex = last;
  }
  return out + html.slice(last);
}

/** The http(s) link an anchor points at, entity-decoded; null when it cannot be followed. */
function anchorLink(attrs: string): string | null {
  const m = HREF.exec(attrs);
  const raw = decodeEntities((m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim());
  if (raw === '' || raw.length > MAX_LINK) return null;
  let url: ParsedUrl;
  try {
    // No base: a relative href in mail cannot be resolved, so it is dropped.
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
}

/**
 * Rewrites every anchor as `text (url)` before the tags come off, so the link survives. A
 * posting or careers link is often the most useful thing in a message (FR-D7 resolves an
 * opportunity's posting from one), and stripping tags alone threw all of them away.
 */
function inlineLinks(html: string): string {
  return replaceElements(
    html,
    /<a\b/gi,
    () => /<\/a\s*>/gi,
    (tag, inner) => {
      const url = anchorLink(tag.slice(2, -1));
      if (url === null) return inner;
      const text = stripTags(inner, ' ').replace(/\s+/g, ' ').trim();
      if (text === '') return ` (${url}) `;
      return text.includes(url) ? ` ${text} ` : ` ${text} (${url}) `;
    },
  );
}

/** Drops `<!-- ... -->`; an unclosed comment and everything after it stay (as before). */
function dropComments(html: string): string {
  let out = '';
  let last = 0;
  for (let open = html.indexOf('<!--'); open >= 0; open = html.indexOf('<!--', last)) {
    const close = html.indexOf('-->', open + 4);
    if (close < 0) break;
    out += `${html.slice(last, open)} `;
    last = close + 3;
  }
  return out + html.slice(last);
}

/** Linear as a regex: every attempt starts at a literal `</name`. */
const BLOCK_CLOSERS = /<\/(p|div|li|tr|h[1-6]|blockquote|table)\s*>/gi;

/**
 * Plain text from an HTML body: scripts and styles dropped, block ends become newlines.
 * `keepLinks` rewrites anchors as `text (url)` instead of dropping their hrefs. What is left
 * after scripts, styles and comments go is cut at MAX_HTML_TEXT_CHARS (marked), so a page
 * heavy with scripts keeps its text while a hostile body cannot grow the work without bound.
 */
export function htmlToText(html: string, opts: { keepLinks?: boolean } = {}): string {
  const linked = opts.keepLinks === true ? inlineLinks(html) : html;
  let source = dropComments(
    replaceElements(
      linked,
      /<(script|style|head)\b/gi,
      (m) => {
        const name = (m[1] ?? '').toLowerCase();
        return name === 'script'
          ? /<\/script\s*>/gi
          : name === 'style'
            ? /<\/style\s*>/gi
            : /<\/head\s*>/gi;
      },
      () => ' ',
    ),
  );
  let truncated = false;
  if (source.length > MAX_HTML_TEXT_CHARS) {
    const code = source.charCodeAt(MAX_HTML_TEXT_CHARS - 1);
    const end = code >= 0xd800 && code <= 0xdbff ? MAX_HTML_TEXT_CHARS - 1 : MAX_HTML_TEXT_CHARS;
    source = source.slice(0, end);
    truncated = true;
  }
  // Three passes, in the order the regex version ran them, so odd markup ends up the same.
  const text = stripTags(
    replaceTags(source, /<br\b/gi, () => '\n').replace(BLOCK_CLOSERS, '\n'),
    '',
  );
  const out = decodeEntities(text)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncated ? out + HTML_TRUNCATED_MARK : out;
}

/** Splits an address list on commas outside quotes and angle brackets. */
export function splitAddresses(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if (ch === ',' && !quoted && !angle) {
      if (cur.trim().length > 0) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) out.push(cur.trim());
  return out;
}
