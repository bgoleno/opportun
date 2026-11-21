#!/usr/bin/env node
// The identifier guard's scan (.github/workflows/identifier-guard.yml): fails when a withheld
// real-world identifier appears in a tracked file. The terms come from the repository secret
// BLOCKED_IDENTIFIERS, in the TERMS environment variable, space- or newline-separated; they are
// never in the tree, which would re-publish the very names withheld.
//
// In a script rather than the workflow's shell (https://github.com/bgoleno/opportun/issues/619, from
// sec's audit): the shell split TERMS unquoted, so a term holding a glob character expanded against
// the working directory, and its allow list dropped every line that held an allowed word, so a
// withheld term on the same line went through. Here the terms are words of the variable, never
// expanded, and an allowed word excuses only a match that lies inside it.
//
// The job log is public, and Actions masks the secret's whole value, not each term in it. So every
// term is masked before anything else is printed, and a hit is reported as file:line only, never
// the term or the matching line (#520). A path holding any term, in any case, is not printed either:
// only its line number is.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Innocuous words that legitimately contain or equal a blocked term (a city name, a camelCase
 * identifier, a distribution name). Expand as real false positives appear.
 */
export const ALLOWED_WORDS = ['francisco', 'withpepper', 'withpeople', 'rhel'];

/** The terms in the secret's value: its whitespace-separated words, as they are. */
export function parseTerms(value) {
  return value.split(/\s+/).filter((t) => t !== '');
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Letters-only terms match on word boundaries, so a short term does not fire inside a longer word;
 * anything with punctuation or digits is matched as a literal. Both ignore case.
 */
function termPattern(term) {
  return /^[A-Za-z]+$/.test(term)
    ? new RegExp(`(?<![A-Za-z])${term}(?![A-Za-z])`, 'gi')
    : new RegExp(escape(term), 'gi');
}

/** The spans of `text` an allowed word covers, as [start, end) pairs. */
function allowedSpans(text, allowed) {
  const spans = [];
  for (const word of allowed) {
    for (const m of text.matchAll(new RegExp(escape(word), 'gi'))) {
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  return spans;
}

/** How many matches of `term` in `text` are not inside an allowed word. */
export function withheldCount(text, term, allowed = ALLOWED_WORDS) {
  const spans = allowedSpans(text, allowed);
  let n = 0;
  for (const m of text.matchAll(termPattern(term))) {
    const start = m.index;
    const end = start + m[0].length;
    if (!spans.some(([a, b]) => a <= start && end <= b)) n += 1;
  }
  return n;
}

/** Where a hit is, as the log may show it: file:line, with a path that holds a term withheld. */
export function locationOf(hit, terms) {
  const lower = hit.path.toLowerCase();
  const path = terms.some((t) => lower.includes(t.toLowerCase()))
    ? '(a file whose name holds a withheld term)'
    : hit.path;
  return `${path}:${hit.line}`;
}

/**
 * Every line of a tracked file (lockfile aside) that holds `term`, any case, from git grep: a
 * superset that withheldCount then narrows. NUL-separated, so a path holding a colon is read whole.
 */
function candidates(term) {
  let out;
  try {
    out = execFileSync(
      'git',
      ['grep', '-z', '-n', '-I', '-i', '-F', '-e', term, '--', '.', ':!pnpm-lock.yaml'],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch (err) {
    if (err.status === 1) return []; // git grep: no match
    throw err;
  }
  return out
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [path, line, ...rest] = l.split('\0');
      return { path, line: Number(line), text: rest.join('\0') };
    });
}

/** Runs the scan. Resolves with the exit code; prints only masks, notices and file:line. */
export function main(env = process.env, print = (s) => console.log(s)) {
  const terms = parseTerms(env.TERMS ?? '');
  if (terms.length === 0) {
    print('::warning::BLOCKED_IDENTIFIERS secret is not set; identifier guard skipped.');
    return 0;
  }
  for (const t of terms) print(`::add-mask::${t}`);
  let bad = false;
  for (const term of terms) {
    const hits = candidates(term).filter((c) => withheldCount(c.text, term) > 0);
    if (hits.length === 0) continue;
    bad = true;
    print('::error::withheld identifier present; remove it from these places:');
    for (const hit of hits.slice(0, 5)) print(locationOf(hit, terms));
  }
  if (bad) return 1;
  print('Identifier guard: clean.');
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
