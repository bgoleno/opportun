// The judging half of desktop.spec.ts (issue https://github.com/bgoleno/opportun/issues/33): what
// the spec measured on a view, against what its KNOWN entry excuses. Kept apart from the browser
// code so the rules can be read, and checked, on their own.

/** The window widths the desktop spec measures at. */
export const WIDTHS = [1280, 1536, 1920, 2560] as const;

/** A wrapped line wider than the limit, or a layout problem (page cap, centring, no content box). */
export type Finding =
  | { kind: 'line'; tag: string; element: string; ch: number; lines: number; text: string }
  | { kind: 'layout'; message: string };

/** One finding a KNOWN entry excuses: a wrapped line in a `tag` element whose text starts so. */
export interface Excuse {
  tag: string;
  text: string;
  widths: readonly number[];
}

export const line = (tag: string, text: string, widths: readonly number[]): Excuse => ({
  tag,
  text,
  widths,
});

export const describeFinding = (f: Finding): string =>
  f.kind === 'layout'
    ? f.message
    : `${f.element} has a ${f.ch.toFixed(1)}ch line (${f.lines} lines): "${f.text}"`;

/**
 * Splits a view's findings at one width: `unexcused` is every finding no excuse for this width
 * covers (a layout finding is never covered), and `stale` is every excuse for this width that no
 * longer matches a finding, so a fix has to remove it. A test passes only when both are empty.
 */
export function judge(
  excuses: readonly Excuse[],
  width: number,
  found: readonly Finding[],
): { unexcused: string[]; stale: string[] } {
  const atWidth = excuses.filter((e) => e.widths.includes(width));
  const matches = (e: Excuse, f: Finding) =>
    f.kind === 'line' && f.tag === e.tag && f.text.startsWith(e.text);
  return {
    unexcused: found.filter((f) => !atWidth.some((e) => matches(e, f))).map(describeFinding),
    stale: atWidth
      .filter((e) => !found.some((f) => matches(e, f)))
      .map((e) => `<${e.tag}> "${e.text}"`),
  };
}
