// The one source of truth for the "cut at the first trailing-noise marker, respecting a
// floor" data (issue #275) shared by two independent implementations of that algorithm:
// packages/extension/src/extract.ts's extractPage (a browser-injected function that must stay
// self-contained, so it receives this data as a parameter rather than importing it) and
// apps/server/src/lib/linkedinCapture.ts's cutTrailingNoise (ordinary server code, imports this
// module directly). Patterns are plain strings, not compiled RegExp: extractPage's data crosses
// chrome.scripting.executeScript's `args`, which is JSON-serializable only (narrower than
// structured clone), and a RegExp JSON-serializes to `{}`, silently matching nothing. Both
// consumers reconstruct with `new RegExp(pattern, 'i')`.
//
// Deliberately has no imports of its own. This file gets bundled into the extension through
// its own dedicated subpath export (not the package's main entry point), specifically so that
// pulling it in never also pulls in the rest of @opportun/core (zod, uuidv7) into a browser
// extension bundle. Keep it that way: the next addition here should be more marker data, not a
// helper that imports something else.

/**
 * Matched as a whole trimmed line, never a substring (with one deliberate exception below), so
 * a posting that happens to use one of these words in a sentence (a bullet about being
 * "promoted", a benefit that mentions "LinkedIn Learning") is untouched; only a line that IS
 * one of them, or ends with one of them, cuts.
 *
 * Confirmed against the owner's own real captured pages (8 samples, read-only, never
 * committed): `promoted` fires in all 8, always 77-87% of the way through, which is where the
 * rail genuinely starts. `select language` and the copyright line are unexercised in those 8
 * (no language picker or footer happened to be present) but are regex-verified against the
 * real lines they are meant to catch (`Select language`, `LinkedIn Corporation © 2026`:
 * case-insensitivity and the anchored copyright pattern already handle them, no change
 * needed). `linkedin learning` is anchored at the end only, never the start, because the real
 * line is "Show more on LinkedIn Learning" (confirmed in 6 of 8 samples), not a bare heading.
 * `people also viewed`, `jobs you may be interested in` and `more jobs for you` are unconfirmed
 * against this sample: kept as plausible, low-risk fallbacks for a page shape not yet seen,
 * not as proven coverage.
 *
 * Do not loosen `similar jobs` into a substring match the way `linkedin learning` is loosened:
 * real pages carry "Set alert for similar jobs" near the job's OWN header actions (its own
 * "Set alert" toggle), 10-16% of the way through, nowhere near the rail. A substring match
 * there would cut away almost the entire real posting. The exact, fully-anchored form never
 * matches that line and must stay that way. (Confirmed the hard way, issue #264:
 * linkedinCapture.ts's `descriptionOf`, a different and separately-motivated extraction, used
 * to end its own scan at the exact phrase "Set alert for similar jobs" rather than a bare
 * heading, and on the owner's own stored GitHub capture that phrase sits mid-posting -- the
 * same landmine, hit by different code. Fixed there by dropping that one marker.)
 */
export const TRAILING_NOISE_MARKER_PATTERNS: readonly string[] = [
  '^promoted$', // LinkedIn's own sponsored-content disclosure label, on each rail card
  '^people also viewed$',
  '^similar jobs$', // see the warning above: never loosen this one to a substring match
  '^jobs you may be interested in$',
  '^more jobs for you$',
  'linkedin learning$', // real line: "Show more on LinkedIn Learning"
  '^select language$',
  '^linkedin corporation\\s*©\\s*\\d{4}$',
];

/**
 * A cut is honored only once it leaves at least this much of the page behind, whichever is
 * larger: an absolute floor (guards a very short page) and a fraction of the whole page
 * (guards a long one). A "Promoted" badge on the primary posting itself, if it is a sponsored
 * listing, would land well under half the page; the real rail boundary, confirmed above, never
 * does. A match that fails this isn't given up on outright: scanning continues for a later
 * match (often another rail card) that does clear it, since one early false hit should not cost
 * the fallback its only other chances.
 */
export const MIN_KEPT_CHARS = 200;
export const MIN_KEPT_FRACTION = 0.5;
