// Run with `node --test .github/scripts` (zero dependencies). The Publish image workflow cannot be
// run to test it: a dispatch publishes a public image and a public Release. So the refusals, the
// notes and the workflow's shape are proven here (https://github.com/bgoleno/opportun/issues/478).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  changelogSection,
  check,
  gitTagOf,
  isVersion,
  liveLookup,
  releaseFree,
  releaseNotes,
  shaTagOf,
} from './publish.mjs';

const SHA = 'd4d97b6c0ffee0123456789abcdef0123456789a';
const IMAGE = 'ghcr.io/bgoleno/opportun';
const DIGEST = `${IMAGE}@sha256:${'a'.repeat(64)}`;
const CHANGELOG = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '## 0.3.2 (2026-11-14)',
  '',
  '### Fixes',
  '',
  '- A fix.',
  '',
  '## 0.3.1 (2026-11-13)',
  '',
  '- Older.',
  '',
].join('\n');

/** A lookup where nothing exists, recording every question in order. */
function nothingExists() {
  const asked = [];
  const lookup = async (q) => {
    asked.push(`${q.kind}:${q.name}`);
    return 'absent';
  };
  return { asked, lookup };
}

const base = { ref: 'refs/heads/main', sha: SHA, image: IMAGE, changelog: CHANGELOG };

test('the version pattern: no leading v, one spelling per version', () => {
  for (const ok of ['0.3.1', '1.0.0', '0.3.2-rc.1']) assert.equal(isVersion(ok), true, ok);
  for (const bad of ['v0.3.1', '0.3', '0.3.1-', '0.3.1 ', '0.3.1;rm', '']) {
    assert.equal(isVersion(bad), false, bad);
  }
  assert.equal(gitTagOf('0.3.1'), 'v0.3.1');
  assert.equal(shaTagOf(SHA), 'sha-d4d97b6');
});

test('a build with no version: only the sha tag is checked, and latest moves on main', async () => {
  const { asked, lookup } = nothingExists();
  const result = await check({ ...base, version: '', lookup });
  assert.deepEqual(result, {
    tag: 'sha-d4d97b6',
    version: '',
    latest: true,
    labelVersion: 'sha-d4d97b6',
  });
  assert.deepEqual(asked, ['image:sha-d4d97b6']);
});

test('a branch build with no version is allowed, and does not move latest', async () => {
  const { lookup } = nothingExists();
  const result = await check({ ...base, ref: 'refs/heads/try', version: '', lookup });
  assert.equal(result.latest, false);
  assert.equal(result.refused, undefined);
});

test('a version: every image, git tag and Release name is checked, and the label is the version', async () => {
  const { asked, lookup } = nothingExists();
  const result = await check({ ...base, version: '0.3.2', lookup });
  assert.deepEqual(result, {
    tag: 'sha-d4d97b6',
    version: '0.3.2',
    latest: true,
    labelVersion: '0.3.2',
  });
  assert.deepEqual(asked, ['image:sha-d4d97b6', 'image:0.3.2', 'gitTag:v0.3.2', 'release:v0.3.2']);
});

test('refused before any lookup: a bad version, a version off main, a version with no notes', async () => {
  for (const [input, pattern] of [
    [{ version: 'v0.3.2' }, /not MAJOR\.MINOR\.PATCH/],
    [{ version: '0.3.2', ref: 'refs/heads/try' }, /only from main/],
    [{ version: '0.3.3' }, /no '## 0\.3\.3 \(YYYY-MM-DD\)' section/],
  ]) {
    const { asked, lookup } = nothingExists();
    const result = await check({ ...base, ...input, lookup });
    assert.match(result.refused, pattern);
    assert.deepEqual(asked, [], 'nothing is looked up after a local refusal');
  }
});

test('refused when any one of them exists already: the sha tag, the image version, the git tag, the Release', async () => {
  for (const [exists, pattern] of [
    ['image:sha-d4d97b6', /one build per commit/],
    ['image:0.3.2', /opportun:0\.3\.2 already exists/],
    ['gitTag:v0.3.2', /git tag v0\.3\.2 already exists/],
    ['release:v0.3.2', /Release v0\.3\.2 already exists/],
  ]) {
    const lookup = async (q) => (`${q.kind}:${q.name}` === exists ? 'present' : 'absent');
    const result = await check({ ...base, version: '0.3.2', lookup });
    assert.match(result.refused, pattern, exists);
  }
});

test('a lookup that cannot answer refuses: it fails closed', async () => {
  const lookup = async () => {
    throw new Error('HTTP 503');
  };
  const result = await check({ ...base, version: '', lookup });
  assert.match(result.refused, /could not check whether .*sha-d4d97b6 exists: HTTP 503/);
});

test('release-free: refuses an existing tag or Release, and a lookup that cannot answer', async () => {
  const { asked, lookup } = nothingExists();
  assert.equal(await releaseFree('0.3.2', lookup), null);
  assert.deepEqual(asked, ['gitTag:v0.3.2', 'release:v0.3.2']);
  for (const exists of ['gitTag:v0.3.2', 'release:v0.3.2']) {
    const found = async (q) => (`${q.kind}:${q.name}` === exists ? 'present' : 'absent');
    assert.match(await releaseFree('0.3.2', found), /exists already/, exists);
  }
  const down = async () => {
    throw new Error('HTTP 500');
  };
  assert.match(await releaseFree('0.3.2', down), /could not check/);
});

test('the CHANGELOG section: from its heading to the next, and only that version', () => {
  assert.equal(changelogSection(CHANGELOG, '0.3.2'), '### Fixes\n\n- A fix.');
  assert.equal(changelogSection(CHANGELOG, '0.3.1'), '- Older.');
  assert.equal(changelogSection(CHANGELOG, '0.3'), null);
  assert.equal(changelogSection(CHANGELOG, 'Unreleased'), null);
  assert.equal(changelogSection('## 0.4.0 (2026-12-01)\n\n## 0.3.2 (2026-11-14)\n', '0.4.0'), null);
});

test('the real CHANGELOG.md parses: its Unreleased heading is never taken for a version', () => {
  const real = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
  assert.equal(changelogSection(real, 'Unreleased'), null);
});

test('the Release notes: the section, the image with its digest, and the commit', () => {
  const notes = releaseNotes({
    changelog: CHANGELOG,
    version: '0.3.2',
    image: IMAGE,
    digest: DIGEST,
    sha: SHA,
    repository: 'bgoleno/opportun',
  });
  assert.match(notes, /^### Fixes\n\n- A fix\.\n/);
  assert.match(notes, new RegExp(`Image: \`${IMAGE}:0\\.3\\.2\` \\(\`sha256:a{64}\`\\)`));
  assert.match(
    notes,
    /Commit: \[`d4d97b6`\]\(https:\/\/github\.com\/bgoleno\/opportun\/commit\/d4d97b6c0ffee/,
  );
  assert.throws(
    () =>
      releaseNotes({
        changelog: CHANGELOG,
        version: '0.3.2',
        image: IMAGE,
        digest: 'nope',
        sha: SHA,
        repository: 'r',
      }),
    /not an image digest/,
  );
});

test('the live lookup: 200 is present, 404 absent, anything else an error', async () => {
  const seen = [];
  const answers = new Map([
    ['https://ghcr.io/v2/bgoleno/opportun/manifests/sha-d4d97b6', 404],
    ['https://ghcr.io/v2/bgoleno/opportun/manifests/0.3.1', 200],
    ['https://api.github.com/repos/bgoleno/opportun/git/ref/tags/v0.3.1', 200],
    ['https://api.github.com/repos/bgoleno/opportun/releases/tags/v0.3.2', 404],
    ['https://api.github.com/repos/bgoleno/opportun/git/ref/tags/v9.9.9', 502],
  ]);
  const fetchImpl = async (url, opts = {}) => {
    seen.push([url, opts.method ?? 'GET']);
    if (url.startsWith('https://ghcr.io/token')) {
      return { status: 200, json: async () => ({ token: 'pull-token' }) };
    }
    return { status: answers.get(url) ?? 500 };
  };
  const lookup = liveLookup({
    image: IMAGE,
    repository: 'bgoleno/opportun',
    token: 't',
    fetchImpl,
  });
  assert.equal(await lookup({ kind: 'image', name: 'sha-d4d97b6' }), 'absent');
  assert.equal(await lookup({ kind: 'image', name: '0.3.1' }), 'present');
  assert.equal(await lookup({ kind: 'gitTag', name: 'v0.3.1' }), 'present');
  assert.equal(await lookup({ kind: 'release', name: 'v0.3.2' }), 'absent');
  await assert.rejects(lookup({ kind: 'gitTag', name: 'v9.9.9' }), /HTTP 502/);
  // Reads only: one registry token, then HEAD and GET requests, never a write.
  assert.equal(seen.filter(([u]) => u.startsWith('https://ghcr.io/token')).length, 1);
  for (const [, method] of seen) assert.ok(method === 'GET' || method === 'HEAD', method);
});

// The workflow's shape, read as text: zero dependencies here, so no YAML parser.
const WORKFLOW = readFileSync(new URL('../workflows/publish-image.yml', import.meta.url), 'utf8');
const jobOf = (name) => {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, name);
  const next = WORKFLOW.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next === -1 ? WORKFLOW.slice(start) : WORKFLOW.slice(start, start + 1 + next);
};

test('permissions: read at the top, packages: write only on publish, contents: write only on release', () => {
  const top = WORKFLOW.slice(WORKFLOW.indexOf('\npermissions:'), WORKFLOW.indexOf('\njobs:'));
  assert.match(top, /contents: read/);
  assert.doesNotMatch(top, /write/);
  const publish = jobOf('publish');
  const release = jobOf('release');
  assert.match(publish, /packages: write/);
  assert.doesNotMatch(publish, /contents: write/);
  assert.match(release, /contents: write/);
  assert.doesNotMatch(release, /packages: write/);
  assert.match(release, /needs: publish/);
  assert.match(release, /if: needs\.publish\.outputs\.version != ''/);
});

test('the check runs before the build, and the release is made on the commit built', () => {
  const publish = jobOf('publish');
  const at = (s) => {
    const i = publish.indexOf(s);
    assert.notEqual(i, -1, s);
    return i;
  };
  assert.ok(at('publish.mjs check') < at('docker build'));
  assert.ok(at('docker build') < at('docker push'));
  assert.match(publish, /--label "org\.opencontainers\.image\.revision=\$GITHUB_SHA"/);
  assert.match(publish, /--label "org\.opencontainers\.image\.version=\$LABEL_VERSION"/);
  // The commands, not the comments above them, which name `gh release create` too.
  const release = jobOf('release').slice(jobOf('release').indexOf('run: |'));
  assert.notEqual(release.indexOf('publish.mjs release-free'), -1);
  assert.ok(release.indexOf('publish.mjs release-free') < release.indexOf('gh release create'));
  assert.match(release, /gh release create "v\$VERSION" --target "\$GITHUB_SHA"/);
});
