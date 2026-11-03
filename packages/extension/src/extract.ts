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

/**
 * What an injected reader returns: the page, or why it was not read. A refusal carries no page
 * text at all, so nothing can be sent from it.
 */
export type ExtractResult =
  { ok: true; page: RawPage } | { ok: false; reason: 'layout_unrecognized' };

/**
 * The function that runs inside an Indeed tab, only when the user clicks Capture
 * (https://github.com/bgoleno/opportun/issues/74). Self-contained like extractPage: serialized
 * with toString() and injected, so no imports and no module-level names (types are erased).
 *
 * It composes the text from named parts of the job, exactly as the Indeed capture text contract
 * defines it (https://github.com/bgoleno/opportun/issues/73#issuecomment-6568000179), rather than
 * one innerText. The job is `[data-testid="viewjob-main-content"]` on both layouts. On /viewjob
 * there is no <main> and <body> holds the site nav and account menu; in the split view <main>
 * holds the results list too; and the job pane ends with a block of other recommended jobs. So:
 *   1 the title: textContent of vj-job-title (the full header can be visibility: hidden while a
 *     sticky compact copy shows, so innerText could be empty);
 *   2 the company: textContent of the first link in company-info-metadata;
 *   3 the later metadata children (rating, location, work setting), separators left out;
 *   4 the structured job summary, if any (innerText);
 *   5 the literal line "Full job description";
 *   6 innerText of each element after the description heading in its container, except the
 *     page's visibility sentinels and style, script, noscript and template elements. The
 *     recommended jobs are a sibling of that container, so they are never reached.
 * Each part is trimmed and empty parts are left out. When the root or a required part (title,
 * company link, description heading, a non-empty description) is missing, Indeed's layout has
 * changed: the capture is refused, never guessed at, and never taken from <main>, <body> or the
 * tab title.
 *
 * The title it reports is the job title (part 1), not document.title: in the split view the tab
 * title names the search, which has no business leaving the browser. With a job open in a pane
 * (the split view, the home page) it also refuses when no highlighted results card names the
 * URL's vjk.
 */
export function extractIndeedJob(doc: Document = document): ExtractResult {
  const refuse: ExtractResult = { ok: false, reason: 'layout_unrecognized' };
  const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
  // A part's own lines keep their order and breaks; only whitespace at the end of each is cut.
  const visible = (el: Element): string =>
    ((el as HTMLElement).innerText ?? el.textContent ?? '')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();

  const root = doc.querySelector('[data-testid="viewjob-main-content"]');
  if (root === null) return refuse;

  // With a job open in a pane, the URL's vjk names the job, and the pane should be showing it.
  // If highlighted results cards name jobs but none of them is the URL's, the pane and the URL
  // disagree (a click still loading): refuse rather than send one job's text under another job's
  // key. Any highlighted card will do, not only the first: the home page has several lists, each
  // keeping a highlighted card of its own, and only the list clicked in names the vjk (#156).
  // Only class names are read from the lists here; nothing from them is sent.
  const vjk = new URL(doc.location.href).searchParams.get('vjk');
  if (vjk !== null) {
    const cards = Array.from(doc.querySelectorAll('.vjs-highlight')).flatMap((card) =>
      Array.from(card.classList).flatMap((c) => {
        const key = /^job_([0-9a-f]+)$/i.exec(c)?.[1];
        return key === undefined ? [] : [key.toLowerCase()];
      }),
    );
    if (cards.length > 0 && !cards.includes(vjk.toLowerCase())) return refuse;
  }

  const titleEl = root.querySelector('[data-testid="vj-job-title"]');
  const title = collapse(titleEl?.textContent);
  const meta = root.querySelector('[data-testid="company-info-metadata"]');
  const companyLink = meta?.querySelector('a') ?? null;
  const company = collapse(companyLink?.textContent);
  if (title === '' || meta === null || companyLink === null || company === '') return refuse;

  const parts: string[] = [title, company];
  let afterCompany = false;
  for (const child of Array.from(meta.children)) {
    if (!afterCompany) {
      afterCompany = child === companyLink || child.contains(companyLink);
      continue;
    }
    const line = collapse(child.textContent);
    if (line !== '' && line !== '·' && line !== '•') parts.push(line);
  }

  const summary = root.querySelector('[data-testid="structured-job-summary"]');
  if (summary !== null) parts.push(visible(summary));

  const heading = root.querySelector('[data-testid="vj-job-description-heading"]');
  const container = heading?.parentElement ?? null;
  if (heading === null || container === null) return refuse;
  const description: string[] = [];
  let afterHeading = false;
  for (const child of Array.from(container.children)) {
    if (!afterHeading) {
      afterHeading = child === heading;
      continue;
    }
    if ((child.getAttribute('data-testid') ?? '').startsWith('vj-rcv-flag-sentinel')) continue;
    // Never text in a browser, whatever an innerText implementation returns for them.
    if (['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE'].includes(child.tagName.toUpperCase())) continue;
    const text = visible(child);
    if (text !== '') description.push(text);
  }
  if (description.length === 0) return refuse;

  const text = [...parts, 'Full job description', ...description]
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .join('\n');
  return {
    ok: true,
    page: { url: doc.location.href, title, text: text.slice(0, 1_000_000) },
  };
}
