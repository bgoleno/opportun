// What the popup accepts back from the filler's executeScript. A separate module, so a test can
// hand it what the real filler returns: popup.ts mounts the popup when it is imported.
import type { FillReport } from './greenhouseFill';

export const NOT_FILLED_REASONS: readonly unknown[] = [
  'choose_on_form',
  'not_in_review',
  'no_matching_question',
  'has_value',
  'not_shown',
  'ambiguous',
  'attach_yourself',
  'attach_file_yourself',
  'resume_unchecked',
  'withheld',
  'no_option',
  'several_options',
  'list_not_shown',
  'not_confirmed',
  'page_changed',
];

/** What fillGreenhouseForm may return; anything else from the tab is treated as a failure. */
export const isFillReport = (v: unknown): v is FillReport => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as {
    ok?: unknown;
    reason?: unknown;
    chosen?: unknown;
    filled?: unknown;
    notFilled?: unknown;
  };
  // Every stop the filler returns, fill_running included (#531): one this check does not know would
  // be taken for a tab the extension could not run in (qa's live run at 66dab73).
  if (r.ok === false) {
    return r.reason === 'wrong_page' || r.reason === 'no_form' || r.reason === 'fill_running';
  }
  const resume = (v as { resume?: unknown }).resume;
  const resumeOk =
    resume === null ||
    (typeof resume === 'object' &&
      resume !== null &&
      typeof (resume as { filename?: unknown }).filename === 'string' &&
      typeof (resume as { size?: unknown }).size === 'number' &&
      typeof (resume as { before?: unknown }).before === 'number');
  return (
    r.ok === true &&
    resumeOk &&
    Array.isArray(r.chosen) &&
    r.chosen.every(
      (c: unknown) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as { label?: unknown }).label === 'string' &&
        typeof (c as { text?: unknown }).text === 'string',
    ) &&
    Array.isArray(r.filled) &&
    r.filled.every((l) => typeof l === 'string') &&
    Array.isArray(r.notFilled) &&
    r.notFilled.every(
      (n: unknown) =>
        typeof n === 'object' &&
        n !== null &&
        typeof (n as { label?: unknown }).label === 'string' &&
        NOT_FILLED_REASONS.includes((n as { reason?: unknown }).reason) &&
        ['string', 'undefined'].includes(typeof (n as { detail?: unknown }).detail),
    )
  );
};
