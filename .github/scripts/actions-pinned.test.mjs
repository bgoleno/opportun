// Run with `node --test .github/scripts` (zero dependencies). Every action a workflow uses is
// pinned to a full commit SHA, not a tag a publisher can move (#524, sec's audit:
// google/osv-scanner-action was the one left on a version tag). A local action (./...) is ours.
// The comment beside a pin names the exact release its commit is tagged as (#875, sec on #874): a
// major tag such as v4 moves past the commit, so it no longer says which release that is. The form
// is checked here; that the commit IS that release needs the network, so a review checks it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const DIR = new URL('../workflows/', import.meta.url);
const WORKFLOWS = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

/** Every `uses:` reference in a workflow, with its line number and what follows it on the line. */
export function usesOf(text) {
  return text
    .split('\n')
    .map((line, i) => ({ line: i + 1, m: /^\s*(?:-\s+)?uses:\s*([^\s#]+)(.*)$/.exec(line) }))
    .filter((u) => u.m !== null)
    .map((u) => ({
      line: u.line,
      ref: u.m[1].replace(/^['"]|['"]$/g, ''),
      rest: u.m[2].trim(),
    }));
}

/** True when `ref` is pinned: owner/repo[/path]@<40 hex>, or a local ./ action. */
export function isPinned(ref) {
  if (ref.startsWith('./')) return true;
  return /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/.test(ref);
}

/**
 * True when what follows a pin is its exact release and nothing else. Nothing after the version:
 * Dependabot rewrites a comment only when the comment ends with the old commit's version.
 */
export function namesRelease({ ref, rest }) {
  if (ref.startsWith('./')) return true;
  return /^# v\d+\.\d+\.\d+$/.test(rest);
}

test('the pin check reads a sub-action and refuses a tag', () => {
  assert.ok(isPinned('google/osv-scanner-action/osv-scanner-action@' + 'b'.repeat(40)));
  assert.ok(isPinned('actions/checkout@' + '3'.repeat(40)));
  assert.ok(isPinned('./.github/actions/setup'));
  assert.ok(!isPinned('google/osv-scanner-action/osv-scanner-action@v2.7.0'));
  assert.ok(!isPinned('actions/checkout@v4'));
  assert.ok(!isPinned('actions/checkout@' + 'b'.repeat(39)));
  assert.deepEqual(usesOf('  - uses: actions/checkout@v4 # v4\n      uses: "a/b@c"'), [
    { line: 1, ref: 'actions/checkout@v4', rest: '# v4' },
    { line: 2, ref: 'a/b@c', rest: '' },
  ]);
});

test('the comment check accepts an exact release and refuses anything else', () => {
  const named = (line) => namesRelease(usesOf(line)[0]);
  const pin = `      - uses: actions/checkout@${'3'.repeat(40)}`;
  assert.ok(named(`${pin} # v7.0.1`));
  assert.ok(named('      - uses: ./.github/actions/setup'));
  for (const comment of ['', ' # v7', ' # v7.0', ' # 7.0.1', ' # v7.0.1 (signed)', ' # main'])
    assert.ok(!named(`${pin}${comment}`), `accepted${comment}`);
});

for (const file of WORKFLOWS) {
  test(`every action in ${file} is pinned to a commit SHA`, () => {
    const text = readFileSync(new URL(file, DIR), 'utf8');
    const loose = usesOf(text).filter((u) => !isPinned(u.ref));
    assert.deepEqual(
      loose,
      [],
      `${file}: ${loose.map((u) => `line ${u.line} ${u.ref}`).join(', ')}`,
    );
  });

  test(`every pin in ${file} names its exact release`, () => {
    const text = readFileSync(new URL(file, DIR), 'utf8');
    const vague = usesOf(text).filter((u) => !namesRelease(u));
    assert.deepEqual(
      vague,
      [],
      `${file}: ${vague.map((u) => `line ${u.line} ${u.ref} ${u.rest}`).join(', ')}`,
    );
  });
}
