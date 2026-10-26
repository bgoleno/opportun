// Turns a message as the JXA bridge prints it into the server's InboundMessage. Mail content
// is hostile input; here it is only reshaped and capped, never interpreted (the server fences
// it for the classifier exactly like Gmail mail).
import { createHash } from 'node:crypto';
import { htmlToText, splitAddresses } from '@opportun/core/mailText';
import type { InboundMessage } from './types';

/** The body cap, in characters, agreed with the server (it cuts at 1MB of UTF-8 itself). */
export const MAX_BODY_CHARS = 500_000;
const SNIPPET_CHARS = 200;
/**
 * The server's schema caps (routes/connectorMail.ts): a field over them fails the whole batch
 * with a 400, so they are cut here instead.
 */
const MAX_KEY = 1024;
const MAX_ADDRESS = 4096;
const MAX_RECIPIENTS = 500;
const MAX_SUBJECT = 16_384;
const EXTERNAL_PREFIX = 'apple-mail:';

/** One line of the JXA script's output. Everything but the id and date is optional. */
export interface RawMail {
  id: string;
  subject?: string;
  sender?: string;
  /** {name, address} pairs, address strings, or one address-list string. */
  recipients?: unknown;
  dateReceived: string;
  dateSent?: string;
  body?: string;
}

export interface Address {
  name: string;
  address: string;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return t;
}

/** "Name <addr>", "\"Last, First\" <addr>", "<addr>", "addr" or a bare display name. */
export function parseAddress(input: string): Address {
  const s = input.trim();
  const angled = /^(.*?)\s*<([^<>]*)>\s*$/s.exec(s);
  if (angled !== null) {
    return { name: unquote(angled[1] ?? ''), address: (angled[2] ?? '').trim() };
  }
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return { name: '', address: s };
  return { name: unquote(s), address: '' };
}

/** RFC 5322-ish display form: the name is quoted when it carries specials. */
export function formatAddress({ name, address }: Address): string {
  const n = name.trim();
  const a = address.trim();
  if (a === '') return n;
  if (n === '' || n.toLowerCase() === a.toLowerCase()) return a;
  const shown = /[",;:<>@()[\]\\]/.test(n) ? `"${n.replace(/(["\\])/g, '\\$1')}"` : n;
  return `${shown} <${a}>`;
}

function recipientList(value: unknown): string[] {
  const parts: Address[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string') {
      for (const one of splitAddresses(v)) parts.push(parseAddress(one));
    } else if (typeof v === 'object' && v !== null) {
      const o = v as { name?: unknown; address?: unknown };
      parts.push({
        name: typeof o.name === 'string' ? o.name : '',
        address: typeof o.address === 'string' ? o.address : '',
      });
    }
  };
  if (Array.isArray(value)) value.forEach(add);
  else add(value);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const shown = formatAddress(p);
    const key = (p.address.trim() || shown).toLowerCase();
    if (shown === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(truncateChars(shown, MAX_ADDRESS));
  }
  return out.slice(0, MAX_RECIPIENTS);
}

// "Re:", "Fwd :", "AW:", and the counted "Re[2]:" form (two patterns keep each one simple).
const REPLY_PREFIXES = [
  /^(?:re|fwd?|aw|sv|wg|antw) ?:/i,
  /^(?:re|fwd?|aw|sv|wg|antw)\[\d{1,4}\] ?:/i,
];
const replyPrefix = (s: string) => REPLY_PREFIXES.map((r) => r.exec(s)).find((m) => m !== null);

/** The subject without reply/forward prefixes, whitespace-collapsed and lowercased. */
export function normalizeSubject(subject: string): string {
  let s = subject.trimStart();
  for (let m = replyPrefix(s); m !== undefined && m !== null; m = replyPrefix(s)) {
    s = s.slice(m[0].length).trimStart();
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** At most `max` UTF-16 units, never ending on half a surrogate pair. */
export function truncateChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return s.slice(0, end);
}

/**
 * A known tag name followed by whitespace, '>' or '/': `\b` also matched before '.' and '@',
 * which took a quoted `<a.smith@acme.com>` for an anchor and stripped it (review F1). No
 * scan to the closing '>', so a hostile body cannot make this slow either.
 */
const HTML_TAG =
  /<(?:!doctype|html|head|body|div|p|br|table|tr|td|span|a|style|meta|font|img)(?=[\s>/])/i;

export function looksLikeHtml(body: string): boolean {
  return HTML_TAG.test(body);
}

function externalIdFor(id: string): string {
  const full = EXTERNAL_PREFIX + id;
  if (full.length <= MAX_KEY) return full;
  return `${EXTERNAL_PREFIX}sha256:${createHash('sha256').update(id).digest('hex')}`;
}

const dateMs = (s: unknown): number => (typeof s === 'string' ? Date.parse(s) : Number.NaN);

/** The InboundMessage plus the date the cursor tracks. Throws on a message with no id or date. */
export function toInbound(raw: RawMail): { message: InboundMessage; receivedAt: number } {
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id === '') throw new Error('message without an id');
  const receivedAt = dateMs(raw.dateReceived);
  if (!Number.isFinite(receivedAt)) throw new Error(`message ${id} has no usable date`);
  const sent = dateMs(raw.dateSent);

  const externalId = externalIdFor(id);
  const subject = truncateChars(typeof raw.subject === 'string' ? raw.subject : '', MAX_SUBJECT);
  const normalized = normalizeSubject(subject);
  const threadKey =
    normalized === '' ? externalId : truncateChars(`apple-mail-subject:${normalized}`, MAX_KEY);

  let body = truncateChars(typeof raw.body === 'string' ? raw.body : '', MAX_BODY_CHARS);
  body = body.replace(/\r\n?/g, '\n');
  // Links are kept: a posting link is often the most useful thing a message carries.
  if (looksLikeHtml(body)) body = htmlToText(body, { keepLinks: true });

  const sender = typeof raw.sender === 'string' ? formatAddress(parseAddress(raw.sender)) : '';
  return {
    receivedAt,
    message: {
      externalId,
      threadKey,
      from: sender === '' ? '(unknown sender)' : truncateChars(sender, MAX_ADDRESS),
      to: recipientList(raw.recipients),
      subject,
      snippet: truncateChars(body.replace(/\s+/g, ' ').trim(), SNIPPET_CHARS),
      bodyText: body,
      sentAt: Math.max(0, Number.isFinite(sent) && sent > 0 ? sent : receivedAt),
    },
  };
}
