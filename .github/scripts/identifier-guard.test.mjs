// Run with `node --test .github/scripts` (zero dependencies). The identifier guard
// (.github/workflows/identifier-guard.yml) fails a pull request that holds a withheld real-world
// identifier (https://github.com/bgoleno/opportun/issues/619, from sec's audit of da17a6a). The terms
// here are made up: the real list is a repository secret and never appears in the tree.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locationOf, parseTerms, withheldCount } from './identifier-guard.mjs';

test('a line holding both an allowed word and a withheld term is still flagged', () => {
  // The allow list used to drop the whole line, so the term beside an allowed word went through.
  assert.equal(withheldCount('Moving from RHEL to the Zorblax cluster', 'zorblax'), 1);
});

test('an allowed word that is itself the term is not flagged', () => {
  assert.equal(withheldCount('FROM rhel:9', 'rhel'), 0);
});

test('a letters-only term matches as a word, not inside a longer word', () => {
  assert.equal(withheldCount('the zorblaxian empire', 'zorblax'), 0);
  assert.equal(withheldCount('const ZorblaxClient = 1', 'zorblax'), 0);
  assert.equal(withheldCount('see zorblax.example and ZORBLAX-2', 'zorblax'), 2);
});

test('a term with punctuation or digits matches as a literal, in any case', () => {
  assert.equal(withheldCount('host: Zorb-42.example', 'zorb-42'), 1);
  // Not a pattern: a term holding regex or glob characters means only itself.
  assert.equal(withheldCount('a.b and axb', 'a.b'), 1);
  assert.equal(withheldCount('* and **', '*'), 3);
});

test('the terms are read from the secret as words, with no shell expansion', () => {
  assert.deepEqual(parseTerms(' zorblax\n  zorb-42  *\t'), ['zorblax', 'zorb-42', '*']);
  assert.deepEqual(parseTerms(''), []);
  assert.deepEqual(parseTerms('   \n'), []);
});

test('a hit is reported as file:line, and a path holding a term is not printed', () => {
  assert.equal(locationOf({ path: 'docs/notes.md', line: 7 }, ['zorblax']), 'docs/notes.md:7');
  assert.equal(
    locationOf({ path: 'docs/Zorblax-notes.md', line: 7 }, ['zorblax']),
    '(a file whose name holds a withheld term):7',
  );
});

// The workflow step itself, run against a throwaway repository, is tested in
// apps/server/test/identifierGuard.test.ts (#520, #619).
