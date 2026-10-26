// The one function that runs inside the LinkedIn tab, and only when the user clicks Capture
// in the popup (C-1): chrome.scripting.executeScript serializes it with toString() and runs it
// once in the active tab. It must therefore stay self-contained: no imports, no references to
// module-level names, only its own body, its parameters, and the page's globals. (Type-only
// names like `ExtractMarkers` below are erased before this is ever serialized, so declaring an
// interface here is fine; a runtime import is not.)

export interface RawPage {
  url: string;
  title: string;
  text: string;
}

/**
 * The trailing-noise cut's tunable data (issue #275), the one thing besides the page's own
 * document that `extractPage` needs from outside. Supplied by the caller (`popup.ts`) via
 * `chrome.scripting.executeScript`'s `args`, which is JSON-serializable only -- narrower than
 * full structured clone, which is why `trailingNoisePatterns` is plain strings rather than
 * compiled `RegExp` (a `RegExp` JSON-serializes to `{}`, so it would arrive empty and silently
 * match nothing). The single source of truth for this data is
 * `@opportun/core/linkedinMarkers`, read by `popup.ts` and by
 * `apps/server/src/lib/linkedinCapture.ts`'s `cutTrailingNoise` (which has no serialization
 * constraint and just imports it directly).
 */
export interface ExtractMarkers {
  trailingNoisePatterns: readonly string[];
  minKeptChars: number;
  minKeptFraction: number;
}

/**
 * The page as the user sees it: its URL, its title, and the visible text of its <main>
 * landmark (the body when there is none). innerText, not textContent: scripts, styles and
 * hidden elements are left out and block boundaries become line breaks. The raw text is
 * capped generously here; the popup normalizes and trims it to the server's limit.
 *
 * On a LinkedIn job view, <main> is the posting plus whatever else LinkedIn decided to append
 * that day: a rail of unrelated "Promoted" jobs, LinkedIn Learning course promos, the global
 * footer, a multi-language picker (#246). All of that reliably comes AFTER the posting in
 * reading order, so this cuts the text at the first line that unambiguously belongs to one of
 * those trailing sections, rather than trying to select the posting out by its markup (which
 * changes without notice and is not available to reason about here). `markers` is required
 * (no default is reachable from inside this serialized body), and `doc` comes last so a real
 * call site can pass one argument -- `markers` -- and let `doc` default, rather than ever
 * needing to pass `undefined` positionally to skip it.
 *
 * Two deliberate failure-mode guards, per #246: a marker that stops matching (a rename, a
 * missing section) means nothing cuts, so the whole <main> is kept exactly as before this fix,
 * never narrowed to empty. And a marker that matches too early (near the very top, which would
 * usually mean a false match rather than a real trailing section) is ignored rather than
 * honored, for the same reason: capturing noise is merely annoying; capturing nothing on a
 * button the user pressed on purpose is a silent loss of their data.
 *
 * See `@opportun/core/linkedinMarkers` for the marker patterns themselves, their rationale
 * (confirmed against real captured pages) and the floor constants' reasoning -- this function
 * only consumes that data, it no longer owns it.
 */
export function extractPage(markers: ExtractMarkers, doc: Document = document): RawPage {
  const root = (doc.querySelector('main') ?? doc.body) as HTMLElement | null;
  const raw = root === null ? '' : (root.innerText ?? '');

  // Matched as a whole trimmed line, never a substring, so a posting that happens to use one of
  // these words in a sentence (a bullet about being "promoted", a benefit that mentions
  // "LinkedIn Learning") is untouched; only a line that IS one of them, or ends with one of
  // them, cuts. See @opportun/core/linkedinMarkers for which patterns rely on that exactness
  // and why (in particular: never loosen `similar jobs` into a substring match).
  const trailingNoiseMarkers = markers.trailingNoisePatterns.map((p) => new RegExp(p, 'i'));

  const lines = raw.split('\n');
  const floor = Math.max(markers.minKeptChars, raw.length * markers.minKeptFraction);
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
  const text = cutAt === -1 ? raw : lines.slice(0, cutAt).join('\n');

  return {
    url: doc.location.href,
    title: doc.title ?? '',
    text: text.slice(0, 1_000_000),
  };
}
