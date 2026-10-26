// The Postgres search tokenizer (repos/search.ts searchTokens) against the real thing: FTS5
// unicode61 with remove_diacritics 2, the tokenizer SQLite search uses (review fix 2). Both
// engines must index the same terms for a text, so every sample here is tokenized by both and
// compared token by token. The differences that remain are listed in KNOWN_DIFFERENCES with
// both outputs, so a change on either side (a Node or SQLite upgrade, a tokenizer edit) fails
// the test instead of drifting silently. In-memory SQLite: runs on both legs.
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { searchTokens } from '../src/repos/search';

/** Multi-script samples covering the divergence classes the Wave 3 review measured. */
const SAMPLES = [
  'ΟΔΟΣ οδός',
  'Σίσυφος λόγος',
  'ΆΈΉ',
  'йогурт Йошкар',
  'Ёлка ёж',
  'Щука ЪЫЬ',
  'がぎぐ パン',
  'ｶﾞｯｺｳ',
  'ガッコウ',
  'हिन्दी नमस्ते',
  'שָׁלוֹם עולם',
  'مَرْحَبًا عالم',
  'ภาษาไทย',
  'Tiếng Việt',
  'İstanbul ıi',
  'Straße',
  'Łódź Ćma',
  'Řeka',
  'Søren Æsir Åse',
  'ﬁnance',
  'ＡＢＣ１２３',
  'e\u0301te',
  '한국어',
  '中文字',
  'emoji😀ok',
  '٣٤ ²³',
  'ꭰꭱ',
  'Ა Ბ',
  '𞤀𞤢',
  'ǅungla',
  'Ⅻ',
  'ŉ',
  'a\u0308\u0304',
  'ð þ',
  'ภาษาไทยที่นี่',
  'α\u0301ρα',
  'a\u1dc4b',
  'ᎠᎡ',
  'Հայերեն',
  'ግዕዝ',
  'naïve CAFÉ',
  'Ǆemal',
  'ﬀ',
  'ʼapostrophe',
  'x\u20d7y',
  'ꞵꞴ',
  'ᲐᲑ',
];

/**
 * Accepted differences, all Unicode-version skew: SQLite's case folding table predates the
 * case pairs Unicode added later (Cherokee lowercase 8.0, Adlam 9.0, Georgian Mtavruli 11.0,
 * Latin Extended-D 12.0), which Node lowercases. A user typing the other case of such a letter
 * finds a match on Postgres that SQLite misses; same-case queries match on both.
 */
const KNOWN_DIFFERENCES: Record<string, { fts5: string[]; postgres: string[] }> = {
  'Ა Ბ': { fts5: ['Ა', 'Ბ'], postgres: ['ა', 'ბ'] },
  '𞤀𞤢': { fts5: ['𞤀𞤢'], postgres: ['𞤢𞤢'] },
  ᎠᎡ: { fts5: ['ᎠᎡ'], postgres: ['ꭰꭱ'] },
  ꞵꞴ: { fts5: ['ꞵꞴ'], postgres: ['ꞵꞵ'] },
  'ᲐᲑ': { fts5: ['ᲐᲑ'], postgres: ['აბ'] },
};

function fts5Tokens(samples: string[]): string[][] {
  const db = new Database(':memory:');
  try {
    db.exec(
      "CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'unicode61 remove_diacritics 2');" +
        "CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');",
    );
    const insert = db.prepare('INSERT INTO t (rowid, x) VALUES (?, ?)');
    samples.forEach((s, i) => insert.run(i + 1, s));
    const terms = db.prepare('SELECT term FROM v WHERE doc = ? ORDER BY offset');
    return samples.map((_, i) => (terms.all(i + 1) as { term: string }[]).map((r) => r.term));
  } finally {
    db.close();
  }
}

describe('searchTokens and FTS5 unicode61', () => {
  it('split and fold every sample alike, except the listed Unicode-version differences', () => {
    const fts5 = fts5Tokens(SAMPLES);
    const diffs: string[] = [];
    SAMPLES.forEach((sample, i) => {
      const want = fts5[i] ?? [];
      const got = searchTokens(sample).map((t) => t.token);
      const known = KNOWN_DIFFERENCES[sample];
      if (known !== undefined) {
        if (JSON.stringify(known) !== JSON.stringify({ fts5: want, postgres: got })) {
          diffs.push(
            `${JSON.stringify(sample)}: known difference changed: fts5 ${JSON.stringify(want)}, postgres ${JSON.stringify(got)}`,
          );
        }
      } else if (JSON.stringify(got) !== JSON.stringify(want)) {
        diffs.push(
          `${JSON.stringify(sample)}: fts5 ${JSON.stringify(want)}, postgres ${JSON.stringify(got)}`,
        );
      }
    });
    expect(diffs, diffs.join('\n')).toEqual([]);
    expect(Object.keys(KNOWN_DIFFERENCES).every((k) => SAMPLES.includes(k))).toBe(true);
  });
});
