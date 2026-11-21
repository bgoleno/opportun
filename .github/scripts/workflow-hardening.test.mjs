// Run with `node --test .github/scripts` (zero dependencies). Workflow hardening from sec's audit
// of da17a6a (https://github.com/bgoleno/opportun/issues/619): no checkout leaves the job's token in
// .git/config, and the security label is decided by the base branch's matcher, never by the PR's.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const DIR = new URL('../workflows/', import.meta.url);
const WORKFLOWS = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
const read = (file) => readFileSync(new URL(file, DIR), 'utf8');

/**
 * Every step of a workflow, as its own lines: a step starts at a `- ` list item under `steps:`
 * and runs until the next one at the same indentation, or a line indented less.
 */
export function stepsOf(text) {
  const lines = text.split('\n');
  const steps = [];
  let indent = null;
  let current = null;
  for (const [i, line] of lines.entries()) {
    const item = /^(\s*)- /.exec(line);
    if (/^\s*steps:\s*$/.test(line)) {
      indent = null;
      if (current !== null) steps.push(current);
      current = null;
      continue;
    }
    if (item !== null && (indent === null || item[1].length === indent)) {
      if (current !== null) steps.push(current);
      indent = item[1].length;
      current = { line: i + 1, lines: [line] };
      continue;
    }
    if (current !== null) {
      const own = /^(\s*)\S/.exec(line);
      if (own !== null && own[1].length <= indent && !line.trimStart().startsWith('#')) {
        steps.push(current);
        current = null;
        indent = null;
        continue;
      }
      current.lines.push(line);
    }
  }
  if (current !== null) steps.push(current);
  return steps.map((s) => ({ line: s.line, text: s.lines.join('\n') }));
}

const isCheckout = (step) => /uses:\s*actions\/checkout@/.test(step.text);

test('the step reader finds a checkout and its with: block', () => {
  const steps = stepsOf(
    [
      'jobs:',
      '  a:',
      '    steps:',
      '      - uses: actions/checkout@abc # v7',
      '        with:',
      '          persist-credentials: false',
      '      - name: next',
      '        run: echo hi',
    ].join('\n'),
  );
  assert.equal(steps.length, 2);
  assert.ok(isCheckout(steps[0]));
  assert.match(steps[0].text, /persist-credentials: false/);
  assert.doesNotMatch(steps[1].text, /checkout/);
});

for (const file of WORKFLOWS) {
  test(`every checkout in ${file} leaves no token in .git/config`, () => {
    // None of these pushes with git (the label job edits the PR through gh, with GH_TOKEN): a
    // checkout that kept its credentials would leave a token any later step could read.
    const kept = stepsOf(read(file))
      .filter(isCheckout)
      .filter((s) => !/^\s*persist-credentials:\s*false\s*$/m.test(s.text));
    assert.deepEqual(
      kept.map((s) => `line ${s.line}`),
      [],
      `${file}: set persist-credentials: false`,
    );
  });
}

test("the security label job runs the base branch's matcher, not the PR's", () => {
  const text = read('security.yml');
  const start = text.indexOf('  label-security-sensitive:');
  assert.ok(start >= 0, 'the label job is gone');
  const next = /\n {2}[\w-]+:\s*\n/.exec(text.slice(start + 1));
  const job = text.slice(start, next === null ? undefined : start + 1 + next.index);
  const steps = stepsOf(job);
  // A checkout of the base commit into its own directory...
  const base = steps.find(
    (s) =>
      isCheckout(s) &&
      /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/.test(s.text) &&
      /path:\s*base\s*$/m.test(s.text),
  );
  assert.ok(base !== undefined, 'no checkout of the base commit into ./base');
  // ...and the step that decides the label runs the matcher from there, never from the PR's tree.
  const check = steps.find((s) => s.text.includes('check-security-paths.mjs'));
  assert.ok(check !== undefined, 'no step runs the matcher');
  assert.match(check.text, /node base\/\.github\/scripts\/check-security-paths\.mjs/);
  assert.doesNotMatch(check.text, /node \.github\/scripts\/check-security-paths\.mjs/);
});

test("the image's base digest is kept current by Dependabot, for the Dockerfile only (#619)", () => {
  // The owner's decision on #619: the docker ecosystem for deploy/, weekly, and nothing else, so
  // digest bumps arrive as pull requests that go through review like any other.
  const text = readFileSync(new URL('../dependabot.yml', import.meta.url), 'utf8');
  const ecosystems = [...text.matchAll(/^\s*-\s*package-ecosystem:\s*["']?([\w-]+)/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(ecosystems, ['docker']);
  assert.match(text, /^\s*directory:\s*["']?\/deploy["']?\s*$/m);
  assert.match(text, /^\s*interval:\s*["']?weekly["']?\s*$/m);
});
