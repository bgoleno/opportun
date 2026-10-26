// The shared corpus and query table behind search's dialect-parity check (searchParity.test.ts)
// and its reuse as extra coverage for pgSnippet (pgSnippet.test.ts), split out of
// searchParity.test.ts by issue #322. Not a *.test.ts file on purpose: it is data, not a suite,
// and vitest's include glob only picks up *.test.ts, so this never runs as its own (empty) file.
//
// This is the one genuine sharing issue #322 asked to be reported rather than silently worked
// around: pgSnippet.test.ts's "matches the reference snippet on every parity case" test walks
// this same table to get free additional snippet-correctness cases, not because the two
// concerns are actually one thing. Duplicating ~90 lines of corpus/query data into both files
// would have let the two copies drift silently, which is worse than one admitted shared import.

/** A 50 KB body: filler words, one rare term near the end. */
export const BIG = `${'lorem ipsum dolor sit amet '.repeat(2000)}the haystack hides a needle here ${'tail words '.repeat(50)}`;

/** The corpus, by label. Kinds: o = opportunity (title, description), a = activity body,
 * p = contact (name, notes), c = communication (subject, snippet). */
export const CORPUS = {
  accents: { kind: 'o', title: 'Café Résumé review', text: 'Naïve façade at São Paulo office' },
  hyphen: { kind: 'o', title: 'Platform lead', text: 'Our state-of-the-art e-mail pipeline' },
  email: { kind: 'a', text: 'Write to jane.doe@example.com about the offer letter' },
  cpp: { kind: 'o', title: 'Senior C++ engineer', text: 'Modern C# welcome too' },
  cjk: { kind: 'p', title: '佐藤 Sato', text: '東京 オフィス 採用 担当' },
  quotes: { kind: 'a', text: `He said "ship it" and O'Brien agreed` },
  operators: { kind: 'c', title: 'Syntax AND OR NOT', text: 'NEAR(x) a:b column^2 -minus +plus' },
  big: { kind: 'a', text: BIG },
  caps: { kind: 'p', title: 'KUBERNETES Migration', text: 'Cluster upgrade notes' },
  digits: { kind: 'c', title: 'Q3 2024 targets', text: 'Ship v2.1 by week 37' },
  dense: { kind: 'a', text: 'observability observability observability' },
  sparse: {
    kind: 'a',
    text: `A long memo about many things: hiring, budgets, travel, offsites, ${'planning '.repeat(40)}and observability once.`,
  },
} as const;
export type Label = keyof typeof CORPUS;

/**
 * The query table: the exact hit set (by corpus label) for user a, and the expected best hit
 * where one document clearly ranks first on both engines.
 */
export const QUERIES: { q: string; hits: Label[]; top?: Label }[] = [
  // Accents fold on both sides of the match, in any case.
  { q: 'cafe', hits: ['accents'] },
  { q: 'Café', hits: ['accents'] },
  { q: 'CAFÉ RESUME', hits: ['accents'] },
  { q: 'naive facade sao', hits: ['accents'] },
  { q: 'São', hits: ['accents'] },
  // Hyphenated words are their parts; a hyphenated query word is a phrase of them.
  { q: 'state', hits: ['hyphen'] },
  { q: 'state-of-the-art', hits: ['hyphen'] },
  { q: 'art state', hits: ['hyphen'] },
  { q: 'the-state', hits: [] },
  { q: 'e-mail', hits: ['hyphen'] },
  { q: 'email', hits: [] },
  // Emails are split into words (Postgres's own parser would keep the address whole).
  { q: 'jane', hits: ['email'] },
  { q: 'example', hits: ['email'] },
  { q: 'jane.doe@example.com', hits: ['email'] },
  { q: 'doe@example', hits: ['email'] },
  { q: 'example.com/jane', hits: [] },
  // C++ and C# are the letter c; with the prefix on the last word, "c++ engineer" is exact.
  { q: 'C++ engineer', hits: ['cpp'] },
  { q: 'senior c#', hits: ['cpp'] },
  // CJK runs between spaces are words; the last word is a prefix.
  { q: '東京', hits: ['cjk'] },
  { q: '東', hits: ['cjk'] },
  { q: 'オフィス 採用', hits: ['cjk'] },
  { q: '京', hits: [] },
  // User-typed quotes and FTS operators are literal words, never syntax.
  { q: '"ship it"', hits: ['quotes'] },
  { q: "o'brien", hits: ['quotes'] },
  { q: 'obrien', hits: [] },
  { q: 'brien', hits: ['quotes'] },
  { q: 'AND', hits: ['operators', 'quotes', 'sparse'] },
  { q: 'syntax AND', hits: ['operators'] },
  { q: 'syntax AND missingword', hits: [] },
  { q: 'NEAR(x)', hits: ['operators'] },
  { q: 'a:b', hits: ['operators'] },
  { q: 'column^2', hits: ['operators'] },
  { q: '-minus', hits: ['operators'] },
  { q: 'plus:*', hits: ['operators'] },
  { q: 'syntax & missingword', hits: [] },
  { q: 'syntax &', hits: ['operators'] },
  { q: 'syntax | missingword', hits: [] },
  { q: 'syntax !missingword', hits: [] },
  // Case, digits, prefixes.
  { q: 'kubernetes', hits: ['caps'] },
  { q: 'KUBE', hits: ['caps'] },
  { q: 'q3 2024', hits: ['digits'] },
  { q: 'v2', hits: ['digits'] },
  { q: 'v2.1', hits: ['digits'] },
  { q: 'v2.2', hits: [] },
  // A 50 KB body is indexed in full.
  { q: 'needle', hits: ['big'] },
  { q: 'haystack needle', hits: ['big'] },
  // Ranking: a short body made of the term beats a long memo that mentions it once.
  { q: 'observability', hits: ['dense', 'sparse'], top: 'dense' },
  // Nothing searchable: no letters or digits.
  { q: '"', hits: [] },
  { q: '* ^ & | ! :', hits: [] },
];

/**
 * Deliberate differences between the engines, asserted rather than skipped. None remain for
 * the hit sets above: every query in QUERIES has one expectation on both engines. Ranking
 * among close hits and snippet window placement may differ (bm25 vs ts_rank_cd; FTS5's
 * snippet() vs pgSnippet) and are therefore only asserted where unambiguous.
 */
export const KNOWN_DIFFERENCES: string[] = [];
