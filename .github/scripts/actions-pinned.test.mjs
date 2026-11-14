// Run with `node --test .github/scripts` (zero dependencies). Every action a workflow uses is
// pinned to a full commit SHA, not a tag a publisher can move (#524, sec's audit:
// google/osv-scanner-action was the one left on a version tag). A local action (./...) is ours.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const DIR = new URL('../workflows/', import.meta.url);
const WORKFLOWS = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

/** Every `uses:` reference in a workflow, with its line number. */
export function usesOf(text) {
  return text
    .split('\n')
    .map((line, i) => ({ line: i + 1, m: /^\s*(?:-\s+)?uses:\s*([^\s#]+)/.exec(line) }))
    .filter((u) => u.m !== null)
    .map((u) => ({ line: u.line, ref: u.m[1].replace(/^['"]|['"]$/g, '') }));
}

/** True when `ref` is pinned: owner/repo[/path]@<40 hex>, or a local ./ action. */
export function isPinned(ref) {
  if (ref.startsWith('./')) return true;
  return /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/.test(ref);
}

test('the pin check reads a sub-action and refuses a tag', () => {
  assert.ok(isPinned('google/osv-scanner-action/osv-scanner-action@' + 'b'.repeat(40)));
  assert.ok(isPinned('actions/checkout@' + '3'.repeat(40)));
  assert.ok(isPinned('./.github/actions/setup'));
  assert.ok(!isPinned('google/osv-scanner-action/osv-scanner-action@v2.7.0'));
  assert.ok(!isPinned('actions/checkout@v4'));
  assert.ok(!isPinned('actions/checkout@' + 'b'.repeat(39)));
  assert.deepEqual(usesOf('  - uses: actions/checkout@v4 # v4\n      uses: "a/b@c"'), [
    { line: 1, ref: 'actions/checkout@v4' },
    { line: 2, ref: 'a/b@c' },
  ]);
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
}
