// Run with `node --test .github/scripts` (zero dependencies). Every container image a workflow
// runs is pinned by digest, and no workflow uses a container action whose image is named by tag
// (#733, sec's supply-chain review): pinning such an action's commit does not pin the code it
// runs, which was the case for google/osv-scanner-action. actions-pinned.test.mjs pins the
// actions' commits; this pins the images.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { usesOf } from './actions-pinned.test.mjs';

const DIR = new URL('../workflows/', import.meta.url);
const WORKFLOWS = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
const read = (file) => readFileSync(new URL(file, DIR), 'utf8');

const DIGEST = /@sha256:[0-9a-f]{64}$/;

/**
 * The actions the workflows may use, each checked to run as JavaScript (its action.yml's
 * `runs.using`, read at the pinned commit on 2026-11-21). A container action would run an image
 * its commit pin does not fix, so a new action is added here only after reading its action.yml:
 * `using: docker` with an `image: docker://...` by tag is refused.
 */
export const CHECKED_ACTIONS = new Map([
  ['actions/checkout', 'node24'],
  ['actions/setup-node', 'node24'],
  ['actions/upload-artifact', 'node24'],
  ['actions/dependency-review-action', 'node24'],
  ['github/codeql-action', 'node24'],
]);

/** owner/repo of a `uses:` reference (a sub-action's path dropped), or null for a local one. */
export function actionRepo(ref) {
  if (ref.startsWith('./')) return null;
  const [path] = ref.split('@');
  return path.split('/').slice(0, 2).join('/');
}

/** Image references in a workflow, with line numbers: `image:` values and registry names. */
export function imagesOf(text) {
  const out = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/(^|\s)#.*$/, '');
    if (line.trim() === '') continue;
    // A docker:// action reference.
    for (const m of line.matchAll(/docker:\/\/([^\s'"]+)/g)) out.push({ line: i + 1, ref: m[1] });
    // A registry-qualified name anywhere (a docker run, a service, an expression's literal).
    for (const m of line.matchAll(
      /\b((?:ghcr\.io|docker\.io|mcr\.microsoft\.com|quay\.io|gcr\.io|public\.ecr\.aws)\/[\w./-]+(?::[\w.-]+)?(?:@sha256:[0-9a-f]+)?)/g,
    )) {
      out.push({ line: i + 1, ref: m[1] });
    }
    // An `image:` value: a plain name, or the string literals of an expression.
    const image = /^\s*image:\s*(.+)$/.exec(line);
    if (image !== null) {
      const value = image[1].trim();
      // In an expression, only the literals that name an image (a tag, digest or path), not the
      // ones it compares against, such as matrix.db == 'postgres'.
      const literals = value.startsWith('${{')
        ? [...value.matchAll(/'([^']*)'/g)].map((m) => m[1]).filter((v) => /[:/@]/.test(v))
        : [value.replace(/^['"]|['"]$/g, '')];
      for (const ref of literals) if (ref !== '') out.push({ line: i + 1, ref });
    }
  }
  return out;
}

test('the image reader finds image: values, expression literals, docker:// and registry names', () => {
  const text = [
    "  image: ${{ matrix.db == 'postgres' && 'postgres:16' || '' }}",
    '  image: mcr.microsoft.com/playwright:v1.64.0-noble',
    '  - uses: docker://ghcr.io/a/b:v1',
    '  docker run ghcr.io/google/osv-scanner@sha256:' + 'a'.repeat(64) + ' \\',
    '  # image: ghcr.io/in/a-comment:v1',
  ].join('\n');
  const refs = imagesOf(text).map((r) => r.ref);
  assert.ok(refs.includes('postgres:16'));
  assert.ok(!refs.includes('postgres'));
  assert.ok(refs.includes('mcr.microsoft.com/playwright:v1.64.0-noble'));
  assert.ok(refs.includes('ghcr.io/a/b:v1'));
  assert.ok(refs.includes('ghcr.io/google/osv-scanner@sha256:' + 'a'.repeat(64)));
  assert.ok(!refs.some((r) => r.includes('in/a-comment')));
  assert.ok(!DIGEST.test('postgres:16'));
  assert.ok(DIGEST.test('postgres:16@sha256:' + 'b'.repeat(64)));
});

for (const file of WORKFLOWS) {
  test(`every image in ${file} is pinned by digest`, () => {
    const loose = imagesOf(read(file)).filter((r) => !DIGEST.test(r.ref));
    assert.deepEqual(
      loose.map((r) => `${file}:${r.line} ${r.ref}`),
      [],
      'pin each image by digest (name:tag@sha256:...), updating the tag and digest together',
    );
  });

  test(`${file} uses only actions checked to run as JavaScript`, () => {
    const unchecked = usesOf(read(file))
      .map((u) => ({ ...u, repo: actionRepo(u.ref) }))
      .filter((u) => u.repo !== null && !CHECKED_ACTIONS.has(u.repo));
    assert.deepEqual(
      unchecked.map((u) => `${file}:${u.line} ${u.ref}`),
      [],
      "read the action's action.yml at its pin: a container action whose image is named by tag " +
        'is not used (#733); a JavaScript or composite one is added to CHECKED_ACTIONS',
    );
  });
}
