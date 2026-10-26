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
 * full dedupeKey differs. Used wherever several discovery results for one role need to be
 * recognized as the same group -- the review queue's display grouping and bulk-accept's
 * chain-to-one-opportunity handling (issue #209) both call this rather than each re-deriving
 * the split, so the two can never quietly disagree about what counts as a group.
 *
 * `normalize()` only narrows to `[a-z0-9 ]`, so `|` never appears in the company or title
 * segments: splitting on `|` and keeping the first two segments is a safe way to drop only
 * the location segment, not a heuristic over the posting's own text.
 */
export function dedupeGroupKey(key: string): string {
  return key.split('|').slice(0, 2).join('|');
}
