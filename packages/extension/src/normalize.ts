// Turns what extractPage read in the tab into the body POST /api/v1/connector/capture
// accepts ({ url ≤2048, title ≤500, text 1..200k }). Pure, unit-tested.
import { canonicalCaptureUrl } from './canonical';
import type { RawPage } from './extract';

/** The server's text cap (apps/server/src/routes/connectorCapture.ts CAPTURE_TEXT_MAX). */
export const MAX_TEXT = 200_000;
export const MAX_TITLE = 500;

export interface CapturePayload {
  url: string;
  title: string;
  text: string;
}

export type NormalizeResult =
  { ok: true; payload: CapturePayload } | { ok: false; error: 'empty_page' };

/** Cut to `max` UTF-16 units without leaving half a surrogate pair at the end. */
function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeCapture(raw: RawPage): NormalizeResult {
  const text = cap(normalizeText(raw.text), MAX_TEXT);
  if (text === '') return { ok: false, error: 'empty_page' };
  const title = cap(raw.title.replace(/\s+/g, ' ').trim(), MAX_TITLE);
  return { ok: true, payload: { url: canonicalCaptureUrl(raw.url), title, text } };
}
