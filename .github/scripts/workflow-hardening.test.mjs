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

// https://github.com/bgoleno/opportun/issues/663 (sec and tl on #642): on `pull_request` a workflow
// runs as the PR has it, so a PR could edit the label job out of its own run. The label job is in
// its own workflow on `pull_request_target`, which runs as the base branch has it: a PR that edits
// it, security.yml or the matcher still gets the label, decided by the base copy of both.
test('the security label is decided on pull_request_target, by base code only, with no PR code run', () => {
  const text = read('security-label.yml');
  // Its only trigger.
  assert.match(text, /^on:\s*\n\s+pull_request_target:/m);
  assert.doesNotMatch(text, /^\s+pull_request:/m);
  assert.doesNotMatch(text, /^\s+push:/m);
  // Nothing at the workflow level, and the job holds only what it needs.
  assert.match(text, /^permissions:\s*\{\}\s*$/m);
  const perms = [...text.matchAll(/^ {6}([\w-]+):\s*(read|write|none)\s*$/gm)].map(
    (m) => `${m[1]}:${m[2]}`,
  );
  assert.deepEqual(perms.sort(), ['contents:read', 'pull-requests:write']);
  // Every checkout is the base commit: never the PR's head or its merge ref.
  const checkouts = stepsOf(text).filter(isCheckout);
  assert.ok(checkouts.length > 0, 'no checkout of the base');
  for (const c of checkouts) {
    assert.match(c.text, /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/);
    assert.match(c.text, /^\s*persist-credentials:\s*false\s*$/m);
  }
  assert.doesNotMatch(text, /pull_request\.head|refs\/pull|github\.head_ref/);
  // No PR-controlled text is expanded into a script: the number goes through the environment.
  assert.doesNotMatch(text, /\$\{\{\s*github\.event\.pull_request\.(title|body|head)/);
  const runs = stepsOf(text).filter((s) => /^\s*run:/m.test(s.text));
  // The script itself, from `run:` on: the `env:` above it is where an expression belongs.
  const script = (r) => r.text.slice(r.text.search(/^\s*run:/m));
  for (const r of runs)
    assert.doesNotMatch(script(r), /\$\{\{/, `expression in a script: ${script(r)}`);
  // The PR's changed paths come from the API, through the base copy of the matcher.
  const check = runs.find((r) => r.text.includes('check-security-paths.mjs'));
  assert.ok(check !== undefined, 'no step runs the matcher');
  assert.match(check.text, /gh pr diff "\$PR_NUMBER" --name-only/);
  assert.match(check.text, /node \.github\/scripts\/check-security-paths\.mjs/);
  assert.ok(
    runs.some((r) => r.text.includes('--add-label security')),
    'no step applies the label',
  );
});

test('the pull_request workflows no longer label: a PR cannot edit away a label they never apply', () => {
  for (const file of WORKFLOWS.filter((f) => f !== 'security-label.yml')) {
    assert.doesNotMatch(read(file), /--add-label/, `${file} applies a label`);
  }
});

test('a PR that edits the label workflow, security.yml or the matcher is itself labelled', async () => {
  const { matchingSecurityPaths } = await import('./security-paths.mjs');
  const files = [
    '.github/workflows/security-label.yml',
    '.github/workflows/security.yml',
    '.github/scripts/security-paths.mjs',
    '.github/scripts/check-security-paths.mjs',
  ];
  assert.deepEqual(matchingSecurityPaths(files), files);
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
