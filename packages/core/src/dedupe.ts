import { sha256Hex } from './sha256';

const SENIORITY_TOKENS: ReadonlySet<string> = new Set([
  'sr',
  'senior',
  'jr',
  'junior',
  'staff',
  'principal',
  'lead',
]);

/** Lowercase, NFKD, strip diacritics, keep only [a-z0-9 ], collapse whitespace. */
function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/\s/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/ +/g, ' ')
    .trim();
}

/**
 * Strip leading and trailing seniority tokens (repeatedly) from a normalized title.
 *
 * Tradeoff: this makes "Staff PM" and "PM" at the same company and location collide,
 * so two genuinely separate reqs at different levels look like one posting. We accept
 * that because the common case is the same posting re-listed or re-captured with a
 * different level prefix, and the API lets the user force-create past a duplicate.
 * Tokens in the middle of a title ("PM, Staff Programs") are kept, and a title made
 * only of seniority tokens ("Lead") is left intact rather than emptied.
 */
function stripSeniority(title: string): string {
  const tokens = title.split(' ').filter((t) => t.length > 0);
  let start = 0;
  let end = tokens.length;
  while (start < end && SENIORITY_TOKENS.has(tokens.at(start) ?? '')) start++;
  while (end > start && SENIORITY_TOKENS.has(tokens.at(end - 1) ?? '')) end--;
  return start < end ? tokens.slice(start, end).join(' ') : tokens.join(' ');
}

const CORPORATE_SUFFIX_TOKENS: ReadonlySet<string> = new Set([
  'inc',
  'incorporated',
  'llc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'plc',
  'pbc',
]);

/**
 * Strip trailing corporate-suffix tokens (repeatedly) from a normalized company name. Only
 * trailing, unlike stripSeniority's leading-and-trailing: a suffix like "Inc." only ever
 * closes a legal name, never opens one, so "Inc Robotics" keeps its leading token.
 */
function stripCorporateSuffix(name: string): string {
  const tokens = name.split(' ').filter((t) => t.length > 0);
  let end = tokens.length;
  while (end > 0 && CORPORATE_SUFFIX_TOKENS.has(tokens.at(end - 1) ?? '')) end--;
  return end > 0 ? tokens.slice(0, end).join(' ') : tokens.join(' ');
}

/**
 * A fuzzy-match key for company names (issue #94): collides "Acme Robotics" with "Acme
 * Robotics, Inc." the way dedupeKey's own normalize() does not. Deliberately not folded into
 * dedupeKey itself: dedupeKey's exact-match behavior is a stored, indexed value other code
 * already depends on (the per-user unique index, the force-create override flow), and widening
 * it would risk two previously-distinct stored keys suddenly colliding. This is a separate,
 * read-only comparison used only by the near-miss heuristic.
 */
export function companyMatchKey(company: string): string {
  return orFallback(stripCorporateSuffix(normalize(company)), company);
}

/**
 * A company, title, or location segment that normalizes to empty (non-Latin input such as
 * Japanese or Cyrillic has no [a-z0-9] left) would make every such value collide — issue #13
 * was location's turn, after company and title. Fall back to `#` and the first 12 hex chars of
 * sha256 of the NFKD-normalized original, with whitespace collapsed and trimmed so spacing
 * differences still match. A blank original (missing or empty location) stays empty: there is
 * nothing non-Latin about having said nothing.
 */
function orFallback(normalized: string, original: string): string {
  if (normalized !== '') return normalized;
  const source = original.normalize('NFKD').replace(/\s+/g, ' ').trim();
  return source === '' ? '' : `#${sha256Hex(source).slice(0, 12)}`;
}

/** Stable key for detecting the same opportunity: `company|title|location`. */
export function dedupeKey(company: string, title: string, location?: string | null): string {
  const c = orFallback(normalize(company), company);
  const t = orFallback(stripSeniority(normalize(title)), title);
  const l = orFallback(normalize(location ?? ''), location ?? '');
  return `${c}|${t}|${l}`;
}

/**
 * `dedupeKey`'s company+title segments, with the location segment dropped: the same role
 * advertised in several locations (issue #191) shares this key even though each location's
 * full dedupeKey differs. It strips level words, so it is wider than one card of the review
 * queue: what counts as a card is `cardKey`.
 *
 * `normalize()` only narrows to `[a-z0-9 ]`, so `|` never appears in the company or title
 * segments: splitting on `|` and keeping the first two segments is a safe way to drop only
 * the location segment, not a heuristic over the posting's own text.
 */
export function dedupeGroupKey(key: string): string {
  return key.split('|').slice(0, 2).join('|');
}

/** Levels written short, as the word the other postings of a role use. */
const SPELLED_OUT: ReadonlyMap<string, string> = new Map([
  ['sr', 'senior'],
  ['jr', 'junior'],
]);

/**
 * What one card of the review queue is: the postings of one role at one company, whatever their
 * location (https://github.com/bgoleno/opportun/issues/968). The stored key's company and title, as
 * dedupeGroupKey reads them, and the posting's own whole title. Only with the second: dedupeKey
 * strips the level at either end, which made one card, and one opportunity, of "Senior X" and
 * "Principal X", two different jobs. Used wherever a card is recognized (the page's grouping, bulk
 * accept, and the chain to an earlier accept), so they cannot disagree about what one is. Compared
 * only, never stored.
 */
export function cardKey(storedKey: string, company: string, title: string): string {
  const whole = normalize(title)
    .split(' ')
    .map((word) => SPELLED_OUT.get(word) ?? word)
    .join(' ');
  return [
    dedupeGroupKey(storedKey),
    orFallback(normalize(company), company),
    orFallback(whole, title),
  ].join('|');
}

/**
 * A role title as dedupeKey reads it (normalised, seniority stripped at either end), for finding
 * the title in free text normalised by matchText (https://github.com/bgoleno/opportun/issues/126).
 * Like dedupeKey, a title with no Latin letters falls back to a hash, which free text never
 * contains: such a title is simply never found.
 */
export function titleMatchKey(title: string): string {
  return orFallback(stripSeniority(normalize(title)), title);
}

/**
 * Free text (an email's subject or body) normalised exactly as titles and company names are
 * here: lowercase, accents and punctuation removed, whitespace collapsed. Search it for
 * titleMatchKey and companyMatchKey values (https://github.com/bgoleno/opportun/issues/126).
 */
export function matchText(text: string): string {
  return normalize(text);
}
