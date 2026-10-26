// Inbound text the database can store on every engine (ADR-4, iteration 4 review). Postgres
// rejects a NUL character in text and jsonb values, and a lone UTF-16 surrogate (half an
// emoji, typically left by a length limit cutting a surrogate pair) cannot be encoded as
// UTF-8 at all. SQLite stores both, so the same mail would ingest on one engine and abort a
// sync batch on the other. Text is cleaned where it enters the app (mail ingest, the import
// pack, the LinkedIn export), on both engines; clean text is returned unchanged.

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `text` without NUL characters and lone surrogates (the same string when it has none). */
export function cleanText(text: string): string {
  return text.replaceAll('\u0000', '').replace(LONE_SURROGATE, '');
}

/** cleanText, then at most `max` UTF-16 units, never ending in half a surrogate pair. */
export function truncateText(text: string, max: number): string {
  const cut = cleanText(text).slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
