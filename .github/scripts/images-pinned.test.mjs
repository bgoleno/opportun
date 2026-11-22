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

/** docker options that take a value as the next word (the image is the first word that is not). */
const DOCKER_VALUE_OPTIONS = new Set([
  '-v',
  '--volume',
  '-w',
  '--workdir',
  '-e',
  '--env',
  '--env-file',
  '--name',
  '--network',
  '-p',
  '--publish',
  '-u',
  '--user',
  '--entrypoint',
  '--mount',
  '--platform',
  '-l',
  '--label',
  '--add-host',
  '--cidfile',
  '--hostname',
  '-h',
  '--memory',
  '-m',
  '--cpus',
  '--pull',
]);

/**
 * The image of each `docker run`, `docker create` or `docker pull` in a workflow's scripts (#800),
 * with its line: a bare Docker Hub name (`node:22`) as well as a registry one. Only a command
 * counts, at the start of a line, after a one-line step's `run:` (with or without its `- `), or
 * after `;`, `&&`, `||`, `|` or `$(`, not the words inside a string (an echo that mentions
 * `docker pull`). A continued line (ending in a backslash) is read with the lines it continues to.
 * Not read, as no workflow uses them: `docker` called through a variable (`$DOCKER run`) or
 * `sudo`, and an image named by a variable (that word is read as the image, so it fails, not
 * passes). An option that takes a value but is not in DOCKER_VALUE_OPTIONS has its value read as
 * the image, which also fails rather than passes.
 */
export function dockerImagesOf(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const start = i;
    let logical = lines[i].replace(/(^|\s)#.*$/, '');
    while (/\\\s*$/.test(logical) && i + 1 < lines.length) {
      i += 1;
      logical = `${logical.replace(/\\\s*$/, ' ')}${lines[i].replace(/(^|\s)#.*$/, '')}`;
    }
    for (const m of logical.matchAll(
      /(?:^\s*(?:-\s+)?run:\s*['"]?|^\s*|[;&|(]\s*|\$\(\s*)docker\s+(run|create|pull)\b(.*)$/g,
    )) {
      const words = m[2]
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/^['"]|['"]$/g, ''));
      let image = null;
      for (let k = 0; k < words.length; k += 1) {
        const w = words[k];
        if (w === '') continue;
        if (w.startsWith('-')) {
          if (!w.includes('=') && DOCKER_VALUE_OPTIONS.has(w)) k += 1;
          continue;
        }
        image = w;
        break;
      }
      if (image !== null) out.push({ line: start + 1, ref: image });
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

test('docker run, create and pull are read for their image, a bare Docker Hub name included (#800)', () => {
  const pinned = 'ghcr.io/google/osv-scanner@sha256:' + 'a'.repeat(64);
  const text = [
    'docker run node:22',
    'set -e; docker pull alpine',
    '  docker run --rm -v "$RUNNER_TEMP:/work" -w /work \\',
    `    ${pinned} \\`,
    '    scan image',
    'docker create --name x -e A=1 --platform=linux/amd64 postgres:16@sha256:' + 'b'.repeat(64),
    'out=$(docker run redis:7 echo hi)',
    'echo "anyone can `docker pull` these with no login"',
    '# docker run commented:1',
    '      - run: docker pull node:20',
    '        run: docker run --rm alpine:3 true',
  ].join('\n');
  assert.deepEqual(dockerImagesOf(text), [
    { line: 1, ref: 'node:22' },
    { line: 2, ref: 'alpine' },
    { line: 3, ref: pinned },
    { line: 6, ref: 'postgres:16@sha256:' + 'b'.repeat(64) },
    { line: 7, ref: 'redis:7' },
    { line: 10, ref: 'node:20' },
    { line: 11, ref: 'alpine:3' },
  ]);
  const loose = dockerImagesOf(text)
    .filter((r) => !DIGEST.test(r.ref))
    .map((r) => r.ref);
  assert.deepEqual(loose, ['node:22', 'alpine', 'redis:7', 'node:20', 'alpine:3']);
});

for (const file of WORKFLOWS) {
  test(`every image in ${file} is pinned by digest`, () => {
    const text = read(file);
    const loose = [...imagesOf(text), ...dockerImagesOf(text)].filter((r) => !DIGEST.test(r.ref));
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
