// Full-text search (FR-O9). SQLite: the FTS5 search_index table (drizzle/0001_fts.sql).
// Postgres: a search_index table with a tsvector column and a GIN index
// (drizzle-pg/0001_search.sql). Repository write paths call the index* / removeFromIndex
// helpers inside the same transaction as the row change, so the index never drifts from
// committed data.
//
// Postgres parity with FTS5 (iteration 4 Task 11; test/searchParity.test.ts): text is split
// and folded here, in application code, the way FTS5's unicode61 tokenizer
// (remove_diacritics 2) does (searchTokens), and Postgres only sees the folded tokens, through
// the 'simple' configuration (no stemming, no stop words). Its own parser would otherwise keep
// emails, hosts and URLs whole, treat non-ASCII punctuation as letters under the C collation,
// and leave accents unfolded. Queries are built the same way (toTsQuery mirrors toMatchQuery),
// snippets are cut and highlighted here with the same tokens (pgSnippet) rather than by
// ts_headline, which would re-parse with Postgres's parser and miss accent-folded matches.
// Ranking is ts_rank_cd rather than FTS5's bm25: hit sets are identical, order agrees on a
// clear best match, and may differ among close ones.
//
// Accepted tokenizer differences (test/searchTokenizer.test.ts compares searchTokens with
// FTS5's own vocabulary over a multi-script corpus): Unicode-version skew only. SQLite's
// case table predates later Unicode case pairs (Cherokee, Adlam, Georgian Mtavruli, Latin
// Extended-D), which Node lowercases, so a query in the other case of such a letter matches
// on Postgres and not on SQLite.
import { sql } from 'drizzle-orm';
import { rawAll, rawGet, rawRun } from '../db/client';
import { SCHEMA_DIALECT } from '../db/schema';
import type { Db, Exec, UserCtx } from './base';
import type { Page } from './list';

export const SEARCH_KINDS = ['opportunity', 'activity', 'communication', 'contact'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** Snippet highlight delimiters: STX/ETX never occur in normal text and are not markup. */
export const SNIPPET_START = '\u0002';
export const SNIPPET_END = '\u0003';
const SNIPPET_ELLIPSIS = '...';
const SNIPPET_TOKENS = 16;
/** Column index of `text` in search_index(entity_kind, entity_id, user_id, text). */
const TEXT_COLUMN = 3;

export interface SearchHit {
  entityKind: SearchKind;
  entityId: string;
  snippet: string;
  /** Null for a contact, and for a communication not linked to an opportunity. */
  opportunityId: string | null;
}

function joinText(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => p != null && p.length > 0).join('\n');
}

/** A token of indexed text: its folded form and where it sits in the original. */
export interface SearchToken {
  token: string;
  start: number;
  end: number;
}

/**
 * Token characters as unicode61 sees them: letters, numbers, private-use characters, and the
 * combining diacritical marks block (U+0300-U+036F, folded away below, so "e" + U+0301 stays
 * one token). Every other mark separates tokens, as in unicode61: Devanagari vowel signs,
 * Hebrew points and Arabic harakat split a word there on both engines.
 */
const TOKEN = /[\p{L}\p{N}\p{Co}\u0300-\u036f]+/gu;

// Tokens hold only letters, digits and marks: printable ASCII is the plain-ASCII case.
const ASCII = /^[ -~]*$/;
const LATIN = /\p{Script=Latin}/u;
const DIACRITIC = /[\u0300-\u036f]/g;

/**
 * Lowercase and diacritic folding as unicode61 with remove_diacritics 2 does it: diacritics
 * are removed from Latin letters only (so Greek tonos, Cyrillic й and ё and Japanese voicing
 * marks stay, as in FTS5), a standalone combining diacritic is dropped, and the Greek final
 * sigma folds to sigma. Remaining differences (newer Unicode case pairs) are asserted in
 * test/searchTokenizer.test.ts.
 */
function fold(token: string): string {
  // ASCII has no diacritics: the common case skips normalization.
  if (ASCII.test(token)) return token.toLowerCase();
  let out = '';
  for (const ch of token.toLowerCase()) {
    if (ch >= '\u0300' && ch <= '\u036f') continue;
    out += LATIN.test(ch) ? ch.normalize('NFD').replace(DIACRITIC, '') : ch;
  }
  return out.replaceAll('ς', 'σ');
}

/** The tokens of `text`, lazily (pgSnippet stops reading a huge body early). */
function* tokenStream(text: string): Generator<SearchToken> {
  for (const m of text.matchAll(TOKEN)) {
    const token = fold(m[0]);
    if (token !== '') yield { token, start: m.index, end: m.index + m[0].length };
  }
}

/** `text` split and folded as FTS5's unicode61 tokenizer would (Postgres index and query). */
export function searchTokens(text: string): SearchToken[] {
  return [...tokenStream(text)];
}

/**
 * At most this many UTF-8 bytes of folded tokens are indexed per entity on Postgres. A
 * tsvector's lexemes may total at most 1 MB ("string is too long for tsvector"), and the
 * lexemes are a subset of the document, so a 512 KiB document can never hit that limit,
 * which a body of distinct words over roughly 700 KB otherwise turns into a failed write.
 * The stored text is not cut (snippets read it); its words past the cap are not searchable.
 * Other Postgres limits, documented rather than worked around: positions stop at 16383 (a
 * phrase match beyond that position can be missed), and a single word over 2047 bytes is
 * not indexed (FTS5 indexes it).
 */
export const SEARCH_DOCUMENT_MAX_BYTES = 512 * 1024;

/** The folded token stream Postgres indexes (to_tsvector('simple', ...)), capped. */
export function searchDocument(text: string): string {
  const parts: string[] = [];
  let bytes = 0;
  for (const { token } of tokenStream(text)) {
    const size = (ASCII.test(token) ? token.length : Buffer.byteLength(token)) + 1;
    if (bytes + size - 1 > SEARCH_DOCUMENT_MAX_BYTES) break;
    parts.push(token);
    bytes += size;
  }
  return parts.join(' ');
}

/** Replaces the index row for one entity. */
async function upsert(
  exec: Exec,
  ctx: UserCtx,
  kind: SearchKind,
  id: string,
  text: string,
): Promise<void> {
  if (SCHEMA_DIALECT === 'postgres') {
    await rawRun(
      exec,
      sql`INSERT INTO search_index (entity_kind, entity_id, user_id, text, tsv)
          VALUES (${kind}, ${id}, ${ctx.userId}, ${text},
                  to_tsvector('simple', ${searchDocument(text)}))
          ON CONFLICT (user_id, entity_kind, entity_id)
          DO UPDATE SET text = excluded.text, tsv = excluded.tsv`,
    );
    return;
  }
  await removeFromIndex(exec, ctx, kind, id);
  await rawRun(
    exec,
    sql`INSERT INTO search_index (entity_kind, entity_id, user_id, text)
        VALUES (${kind}, ${id}, ${ctx.userId}, ${text})`,
  );
}

export async function removeFromIndex(
  exec: Exec,
  ctx: UserCtx,
  kind: SearchKind,
  id: string,
): Promise<void> {
  await rawRun(
    exec,
    sql`DELETE FROM search_index
        WHERE entity_kind = ${kind} AND entity_id = ${id} AND user_id = ${ctx.userId}`,
  );
}

export async function indexOpportunity(
  exec: Exec,
  ctx: UserCtx,
  opp: { id: string; title: string; descriptionMd: string | null },
): Promise<void> {
  await upsert(exec, ctx, 'opportunity', opp.id, joinText(opp.title, opp.descriptionMd));
}

export async function indexActivity(
  exec: Exec,
  ctx: UserCtx,
  activity: { id: string; title: string; bodyMd: string | null },
): Promise<void> {
  await upsert(exec, ctx, 'activity', activity.id, joinText(activity.title, activity.bodyMd));
}

/** For the communications write paths (ingest and sync land in later tasks). */
export async function indexCommunication(
  exec: Exec,
  ctx: UserCtx,
  comm: { id: string; subject: string | null; snippet: string | null },
): Promise<void> {
  await upsert(exec, ctx, 'communication', comm.id, joinText(comm.subject, comm.snippet));
}

export async function indexContact(
  exec: Exec,
  ctx: UserCtx,
  contact: { id: string; name: string; notes: string | null },
): Promise<void> {
  await upsert(exec, ctx, 'contact', contact.id, joinText(contact.name, contact.notes));
}

/** Removes an opportunity's row and those of the activities that cascade with it. */
export async function removeOpportunityFromIndex(
  exec: Exec,
  ctx: UserCtx,
  opportunityId: string,
): Promise<void> {
  await rawRun(
    exec,
    sql`DELETE FROM search_index
        WHERE user_id = ${ctx.userId} AND entity_kind = 'activity'
          AND entity_id IN (SELECT id FROM activities
                            WHERE user_id = ${ctx.userId} AND opportunity_id = ${opportunityId})`,
  );
  await removeFromIndex(exec, ctx, 'opportunity', opportunityId);
}

/**
 * Turns free text into an FTS5 query of plain terms: every whitespace-separated word is
 * a quoted string (so AND, NEAR(, column filters and stray quotes are literal), all must
 * match, and the last one matches as a prefix for type-ahead. Null when nothing is left.
 */
export function toMatchQuery(q: string): string | null {
  const words = queryWords(q);
  if (words.length === 0) return null;
  return words
    .map((w, i) => `"${w.replaceAll('"', '""')}"${i === words.length - 1 ? '*' : ''}`)
    .join(' ');
}

/** The user's words: whitespace-separated, control characters dropped, needing a letter or digit. */
function queryWords(q: string): string[] {
  return q
    .split(/\s+/)
    .map((w) => w.replace(/[\p{C}]/gu, ''))
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/** One query word as Postgres matches it: its folded tokens in order, the last maybe a prefix. */
export interface QueryPhrase {
  tokens: string[];
  prefix: boolean;
}

/** The query as phrases (one per word); FTS5's quoted "word" is a phrase of its tokens. */
export function queryPhrases(q: string): QueryPhrase[] {
  const words = queryWords(q);
  return words
    .map((w, i) => ({
      tokens: searchTokens(w).map((t) => t.token),
      prefix: i === words.length - 1,
    }))
    .filter((p) => p.tokens.length > 0);
}

/**
 * toMatchQuery for Postgres: a to_tsquery('simple', ...) string where each word is a phrase
 * of its folded tokens (<->), all words must match (&), and the last token of the last word
 * matches as a prefix (:*). Tokens hold only letters and digits; each is quoted anyway, and the
 * string is always passed as a bound parameter. Null when nothing is left.
 */
export function toTsQuery(q: string): string | null {
  const phrases = queryPhrases(q);
  if (phrases.length === 0) return null;
  const lexeme = (t: string) => `'${t.replace(/['\\]/g, (c) => `\\${c}`)}'`;
  return phrases
    .map((p) => {
      const parts = p.tokens.map(lexeme);
      if (p.prefix) parts[parts.length - 1] = `${parts.at(-1) ?? ''}:*`;
      return parts.length === 1 ? (parts[0] ?? '') : `(${parts.join(' <-> ')})`;
    })
    .join(' & ');
}

/** At most this many matches are considered for a snippet (the first ones in the text). */
export const SNIPPET_MAX_HITS = 2000;

interface Hit {
  from: number;
  to: number;
  phrase: number;
}

/**
 * pgSnippet's view of a text: its tokens up to where the snippet can no longer change, and
 * the phrase matches among them (sorted by start, then end). Tokenizing stops once
 * SNIPPET_MAX_HITS matches are found and SNIPPET_TOKENS + 1 more tokens are known, so a
 * huge body costs no more than its first matches (review fix 1); `complete` says whether
 * every token of the text was read.
 */
function snippetScan(
  text: string,
  phrases: QueryPhrase[],
): { tokens: SearchToken[]; hits: Hit[]; complete: boolean } {
  const tokens: SearchToken[] = [];
  const hits: Hit[] = [];
  const maxLen = Math.max(1, ...phrases.map((p) => p.tokens.length));
  let stopAt = Infinity;
  const matchesAt = (p: QueryPhrase, i: number): boolean =>
    p.tokens.every((t, k) => {
      const have = tokens[i + k]?.token ?? '';
      return p.prefix && k === p.tokens.length - 1 ? have.startsWith(t) : have === t;
    });
  for (const token of tokenStream(text)) {
    tokens.push(token);
    // Every phrase that can end at this token has all its tokens now: test the ones that
    // start maxLen - 1 tokens back, in start order, once each.
    const i = tokens.length - maxLen;
    if (i >= 0 && hits.length < SNIPPET_MAX_HITS) {
      phrases.forEach((p, phrase) => {
        if (matchesAt(p, i)) hits.push({ from: i, to: i + p.tokens.length - 1, phrase });
      });
      if (hits.length >= SNIPPET_MAX_HITS) stopAt = tokens.length + SNIPPET_TOKENS + 1;
    }
    if (tokens.length >= stopAt) return { tokens, hits: sortHits(hits), complete: false };
  }
  // The tail: starts shorter than maxLen tokens from the end.
  for (let i = Math.max(0, tokens.length - maxLen + 1); i < tokens.length; i++) {
    if (hits.length >= SNIPPET_MAX_HITS) break;
    phrases.forEach((p, phrase) => {
      if (i + p.tokens.length <= tokens.length && matchesAt(p, i)) {
        hits.push({ from: i, to: i + p.tokens.length - 1, phrase });
      }
    });
  }
  return { tokens, hits: sortHits(hits), complete: true };
}

const sortHits = (hits: Hit[]): Hit[] => hits.sort((a, b) => a.from - b.from || a.to - b.to);

/**
 * The window start FTS5 would pick: among candidate starts (each match's start), the first
 * one whose SNIPPET_TOKENS-token window holds the most distinct query words, then the most
 * matches; returns that start and the end of the last match inside. Two pointers over the
 * sorted matches: a window holds at most SNIPPET_TOKENS starts of a few phrases each, so
 * scoring one is bounded, and the whole pass is linear in the number of matches.
 */
function bestWindow(hits: Hit[]): { first: number; last: number } {
  const n = SNIPPET_TOKENS;
  let lo = 0;
  let hi = 0;
  let best = { score: -1, first: 0, last: 0 };
  for (let k = 0; k < hits.length; k++) {
    const s = hits[k]!.from;
    if (k > 0 && hits[k - 1]!.from === s) continue; // same start, same window
    while (hits[lo]!.from < s) lo += 1;
    while (hi < hits.length && hits[hi]!.from < s + n) hi += 1;
    const phrases = new Set<number>();
    let inside = 0;
    let last = s;
    for (let j = lo; j < hi; j++) {
      const h = hits[j]!;
      if (h.to >= s + n) continue; // starts inside, ends past the window
      inside += 1;
      phrases.add(h.phrase);
      if (h.to > last) last = h.to;
    }
    const score = phrases.size * 1000 + inside;
    if (score > best.score) best = { score, first: s, last };
  }
  return best;
}

/**
 * FTS5's snippet() for Postgres hits: a window of at most SNIPPET_TOKENS tokens of the
 * original text around the matches, each phrase match wrapped in SNIPPET_START/SNIPPET_END,
 * with SNIPPET_ELLIPSIS where the window cuts the text. The window covers the most distinct
 * query words (then the most matches) and is centered on them, as FTS5 does. Linear in the
 * text up to its first SNIPPET_MAX_HITS matches (a planted body of one-letter words must not
 * stall the event loop).
 */
export function pgSnippet(text: string, q: string): string {
  const phrases = queryPhrases(q);
  const { tokens, hits, complete } = snippetScan(text, phrases);
  const n = SNIPPET_TOKENS;
  if (tokens.length === 0) return text;
  let start = 0;
  if ((tokens.length > n || !complete) && hits.length > 0) {
    const best = bestWindow(hits);
    const slack = n - (best.last - best.first + 1);
    // When the scan stopped early, more than n tokens follow the window: no end clamp.
    const maxStart = complete ? tokens.length - n : Infinity;
    start = Math.max(0, Math.min(best.first - Math.floor(slack / 2), maxStart));
  }
  const end = Math.min(tokens.length, start + n) - 1;
  const atEnd = complete && end === tokens.length - 1;
  const from = start === 0 ? 0 : (tokens[start]?.start ?? 0);
  const to = atEnd ? text.length : (tokens[end]?.end ?? text.length);
  let out = start === 0 ? '' : SNIPPET_ELLIPSIS;
  let at = from;
  for (const h of hits) {
    if (h.from < start || h.to > end) continue;
    const hs = tokens[h.from]?.start ?? 0;
    const he = tokens[h.to]?.end ?? 0;
    if (hs < at) continue; // overlaps a span already wrapped
    out += text.slice(at, hs) + SNIPPET_START + text.slice(hs, he) + SNIPPET_END;
    at = he;
  }
  out += text.slice(at, to);
  if (!atEnd) out += SNIPPET_ELLIPSIS;
  return out;
}

interface HitRow {
  entity_kind: SearchKind;
  entity_id: string;
  snippet: string;
  opportunity_id: string | null;
}

/**
 * The caller's hits, best first. Filtered by user_id, and each hit must join back to a
 * row the caller owns, so a stale index row can never surface.
 */
export async function search(
  db: Db,
  ctx: UserCtx,
  q: string,
  page: { limit: number; offset: number },
): Promise<Page<SearchHit>> {
  if (SCHEMA_DIALECT === 'postgres') return searchPg(db, ctx, q, page);
  const match = toMatchQuery(q);
  if (match === null) return { items: [], total: 0 };
  const from = sql`
    FROM search_index
    LEFT JOIN opportunities o
      ON search_index.entity_kind = 'opportunity' AND o.id = search_index.entity_id
     AND o.user_id = ${ctx.userId}
    LEFT JOIN activities a
      ON search_index.entity_kind = 'activity' AND a.id = search_index.entity_id
     AND a.user_id = ${ctx.userId}
    LEFT JOIN communications c
      ON search_index.entity_kind = 'communication' AND c.id = search_index.entity_id
     AND c.user_id = ${ctx.userId}
    LEFT JOIN contacts p
      ON search_index.entity_kind = 'contact' AND p.id = search_index.entity_id
     AND p.user_id = ${ctx.userId}
    WHERE search_index MATCH ${match}
      AND search_index.user_id = ${ctx.userId}
      AND coalesce(o.id, a.id, c.id, p.id) IS NOT NULL`;
  const rows = await rawAll<HitRow>(
    db,
    sql`
    SELECT search_index.entity_kind AS entity_kind,
           search_index.entity_id AS entity_id,
           snippet(search_index, ${TEXT_COLUMN}, ${SNIPPET_START}, ${SNIPPET_END},
                   ${SNIPPET_ELLIPSIS}, ${SNIPPET_TOKENS}) AS snippet,
           coalesce(o.id, a.opportunity_id, c.opportunity_id) AS opportunity_id
    ${from}
    ORDER BY rank, search_index.entity_id
    LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const total = (await rawGet<{ n: number }>(db, sql`SELECT count(*) AS n ${from}`))?.n ?? 0;
  return {
    items: rows.map((r) => ({
      entityKind: r.entity_kind,
      entityId: r.entity_id,
      snippet: r.snippet,
      opportunityId: r.opportunity_id,
    })),
    total,
  };
}

/** search() on Postgres: the same joins, filters and paging over the tsvector index. */
async function searchPg(
  db: Db,
  ctx: UserCtx,
  q: string,
  page: { limit: number; offset: number },
): Promise<Page<SearchHit>> {
  const query = toTsQuery(q);
  if (query === null) return { items: [], total: 0 };
  const from = sql`
    FROM search_index
    LEFT JOIN opportunities o
      ON search_index.entity_kind = 'opportunity' AND o.id = search_index.entity_id
     AND o.user_id = ${ctx.userId}
    LEFT JOIN activities a
      ON search_index.entity_kind = 'activity' AND a.id = search_index.entity_id
     AND a.user_id = ${ctx.userId}
    LEFT JOIN communications c
      ON search_index.entity_kind = 'communication' AND c.id = search_index.entity_id
     AND c.user_id = ${ctx.userId}
    LEFT JOIN contacts p
      ON search_index.entity_kind = 'contact' AND p.id = search_index.entity_id
     AND p.user_id = ${ctx.userId}
    WHERE search_index.tsv @@ to_tsquery('simple', ${query})
      AND search_index.user_id = ${ctx.userId}
      AND coalesce(o.id, a.id, c.id, p.id) IS NOT NULL`;
  const rows = await rawAll<Omit<HitRow, 'snippet'> & { text: string }>(
    db,
    sql`
    SELECT search_index.entity_kind AS entity_kind,
           search_index.entity_id AS entity_id,
           search_index.text AS text,
           coalesce(o.id, a.opportunity_id, c.opportunity_id) AS opportunity_id
    ${from}
    ORDER BY ts_rank_cd(search_index.tsv, to_tsquery('simple', ${query}), 1) DESC,
             search_index.entity_id
    LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const total = (await rawGet<{ n: number }>(db, sql`SELECT count(*)::int AS n ${from}`))?.n ?? 0;
  return {
    items: rows.map((r) => ({
      entityKind: r.entity_kind,
      entityId: r.entity_id,
      snippet: pgSnippet(r.text, q),
      opportunityId: r.opportunity_id,
    })),
    total,
  };
}
