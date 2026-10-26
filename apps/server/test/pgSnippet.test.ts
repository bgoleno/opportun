// The pgSnippet builder and the query/token helpers it shares a module with, split out of
// searchParity.test.ts by issue #322: none of this touches the database or either dialect, so a
// failure here is a pure-CPU/string bug, never a sign the SQLite/Postgres parity table broke.
// That distinction is exactly what #322 exists to make legible from the test file name alone --
// see #308, where a failure here was misread as a dialect-parity regression because both lived
// in one file.
import { describe, expect, it } from 'vitest';
import {
  pgSnippet,
  queryPhrases,
  searchTokens,
  SNIPPET_END,
  SNIPPET_START,
  toMatchQuery,
  toTsQuery,
} from '../src/repos/search';
import { expectLinear } from './scaling';
import { CORPUS, QUERIES } from './searchCorpus';

const S = SNIPPET_START;
const E = SNIPPET_END;

describe('search query and snippet builders', () => {
  it('builds the same words for FTS5 and tsquery, operators quoted as plain words', () => {
    expect(toMatchQuery(`state-of-the-art o'brien NEAR( "x"`)).toBe(
      `"state-of-the-art" "o'brien" "NEAR(" """x"""*`,
    );
    expect(toTsQuery(`state-of-the-art o'brien NEAR( "x"`)).toBe(
      `('state' <-> 'of' <-> 'the' <-> 'art') & ('o' <-> 'brien') & 'near' & 'x':*`,
    );
    expect(toTsQuery('Café')).toBe(`'cafe':*`);
    expect(toTsQuery('* ! |')).toBeNull();
    expect(toTsQuery(`a'b\\c`)).toBe(`('a' <-> 'b' <-> 'c':*)`);
  });

  it('tokenizes as unicode61 with remove_diacritics 2 does', () => {
    expect(searchTokens('Ünïcode C++ jane.doe@example.com 東京 éte').map((t) => t.token)).toEqual([
      'unicode',
      'c',
      'jane',
      'doe',
      'example',
      'com',
      '東京',
      'ete',
    ]);
  });

  it('cuts snippets like FTS5: whole short texts, ellipses on cut long ones', () => {
    expect(pgSnippet('Own the observability roadmap.', 'observability')).toBe(
      `Own the ${S}observability${E} roadmap.`,
    );
    expect(pgSnippet(`He said "ship it" and O'Brien agreed`, `o'brien`)).toBe(
      `He said "ship it" and ${S}O'Brien${E} agreed`,
    );
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const cut = pgSnippet(words, 'w20');
    expect(cut).toBe(
      `...w13 w14 w15 w16 w17 w18 w19 ${S}w20${E} w21 w22 w23 w24 w25 w26 w27 w28...`,
    );
  });
});

/**
 * The first pgSnippet (Task 11), kept as the reference for its output: quadratic in the
 * number of matches (a planted 'a a a ...' body froze the server), so it is only run here on
 * small inputs. The linear rewrite must produce the same snippet whenever there are at most
 * SNIPPET_MAX_HITS matches.
 */
function referenceSnippet(text: string, q: string): string {
  const tokens = searchTokens(text);
  const phrases = queryPhrases(q);
  const hits: { from: number; to: number; phrase: number }[] = [];
  phrases.forEach((p, phrase) => {
    const n = p.tokens.length;
    for (let i = 0; i + n <= tokens.length; i++) {
      const ok = p.tokens.every((t, k) => {
        const have = tokens[i + k]?.token ?? '';
        return p.prefix && k === n - 1 ? have.startsWith(t) : have === t;
      });
      if (ok) hits.push({ from: i, to: i + n - 1, phrase });
    }
  });
  hits.sort((a, b) => a.from - b.from || a.to - b.to);
  const n = 16;
  let start = 0;
  if (tokens.length > n && hits.length > 0) {
    let best = { score: -1, first: 0, last: 0 };
    for (const h of hits) {
      const inside = hits.filter((x) => x.from >= h.from && x.to < h.from + n);
      const score = new Set(inside.map((x) => x.phrase)).size * 1000 + inside.length;
      if (score > best.score) {
        best = { score, first: h.from, last: Math.max(...inside.map((x) => x.to)) };
      }
    }
    const slack = n - (best.last - best.first + 1);
    start = Math.max(0, Math.min(best.first - Math.floor(slack / 2), tokens.length - n));
  }
  const end = Math.min(tokens.length, start + n) - 1;
  if (tokens.length === 0) return text;
  const from = start === 0 ? 0 : (tokens[start]?.start ?? 0);
  const to = end === tokens.length - 1 ? text.length : (tokens[end]?.end ?? text.length);
  let out = start === 0 ? '' : '...';
  let at = from;
  for (const h of hits) {
    if (h.from < start || h.to > end) continue;
    const hs = tokens[h.from]?.start ?? 0;
    const he = tokens[h.to]?.end ?? 0;
    if (hs < at) continue;
    out += text.slice(at, hs) + S + text.slice(hs, he) + E;
    at = he;
  }
  out += text.slice(at, to);
  if (end < tokens.length - 1) out += '...';
  return out;
}

describe('pgSnippet does not blow up on a large body (review fix 1)', () => {
  it('grows with the body, not faster, when snippeting a body full of matches', () => {
    const body = (kb: number) => 'a '.repeat(kb * 512);
    const quarter = body(256);
    const full = body(1024);
    let out = '';
    expectLinear({
      label: 'pgSnippet with a match',
      factor: 4,
      ceilingMs: 1_000,
      small: () => void pgSnippet(quarter, 'a'),
      large: () => (out = pgSnippet(full, 'a')),
    });
    expect(out.startsWith(`${S}a${E} ${S}a${E}`)).toBe(true);
    expect(out.endsWith('...')).toBe(true);
  });

  // The case that flaked: a full read with no match, which cannot stop early. It failed at
  // 385-478 ms against a 250 ms bound whenever the suite ran in parallel, and passed alone
  // every time. The ratio below measures both sizes on the same loaded machine, so the load
  // cancels; the ceiling is a backstop, not the assertion.
  it('grows with the body, not faster, when reading one with no match at all', () => {
    const body = (kb: number) => 'b '.repeat(kb * 512);
    const quarter = body(256);
    const full = body(1024);
    let out = '';
    expectLinear({
      label: 'pgSnippet full scan',
      factor: 4,
      ceilingMs: 2_000,
      small: () => void pgSnippet(quarter, 'a'),
      large: () => (out = pgSnippet(full, 'a')),
    });
    expect(out.startsWith('b b')).toBe(true);
  });

  it('matches the reference snippet on every parity case and on generated texts', () => {
    const texts = (Object.values(CORPUS) as { title?: string; text: string }[]).map((d) =>
      [d.title, d.text].filter((p) => p !== undefined && p !== '').join('\n'),
    );
    const diffs: string[] = [];
    const check = (text: string, q: string) => {
      const want = referenceSnippet(text, q);
      const got = pgSnippet(text, q);
      if (got !== want)
        diffs.push(
          `${JSON.stringify(q)} on ${JSON.stringify(text.slice(0, 60))}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`,
        );
    };
    for (const text of texts) for (const { q } of QUERIES) check(text, q);
    // Seeded generated texts: windows at the start, middle and end, overlapping phrases.
    let seed = 7;
    const rand = (k: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % k;
    };
    const vocab = ['red', 'reef', 'blue', 'b', 'green', 'red-blue', 'x', 'Réd'];
    for (let i = 0; i < 400; i++) {
      const words = Array.from({ length: rand(60) }, () => vocab[rand(vocab.length)]).join(' ');
      const q = Array.from({ length: 1 + rand(3) }, () => vocab[rand(vocab.length)]).join(' ');
      check(words, q);
    }
    expect(diffs, diffs.join('\n')).toEqual([]);
  });
});
