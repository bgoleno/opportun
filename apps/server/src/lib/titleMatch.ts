// How alike two job titles are (https://github.com/bgoleno/opportun/issues/763): the overlap of
// their words, and the overlap a confident match needs. Pure, so repos and lib use it without
// importing the lead-resolve job (jobs/leadResolve.ts), which imports the repos back.

/** Minimum normalized title token overlap for a confident match. */
export const TITLE_MATCH_THRESHOLD = 0.6;

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .normalize('NFKD')
      .toLowerCase()
      .replace(/\p{M}/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0),
  );
}

/** Shared tokens over the larger token set: 1 for the same words, 0 for none in common. */
export function titleOverlap(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  const larger = Math.max(ta.size, tb.size);
  if (larger === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / larger;
}
