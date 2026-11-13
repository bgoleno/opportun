// Run with `node --test .github/scripts` (zero dependencies). The Publish image workflow cannot be
// run to test it: a dispatch publishes a public image and a public Release. So the refusals, the
// notes and the workflow's shape are proven here (https://github.com/bgoleno/opportun/issues/478).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  changelogSection,
  check,
  escapeCommandData,
  gitTagOf,
  isVersion,
  liveLookup,
  releaseFree,
  releaseNotes,
  run,
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
  // What git refuses as a tag name (tl on #489), and what is not semver.
  for (const bad of [
    '0.3.2-rc..1',
    '0.3.2-rc.',
    '0.3.2-.rc',
    '0.3.2-rc.lock',
    '01.3.2',
    '0.3.2-rc_1',
  ]) {
    assert.equal(isVersion(bad), false, bad);
  }
  // Strict SemVer: a numeric identifier has no leading zero; `0` alone and alphanumerics are fine.
  for (const bad of ['0.3.2-01', '0.3.2-rc.01']) assert.equal(isVersion(bad), false, bad);
  for (const ok of ['0.3.2-0', '0.3.2-rc.0', '0.3.2-0rc', '0.3.2-x-y'])
    assert.equal(isVersion(ok), true, ok);
  assert.equal(isVersion(`0.3.2-${'a'.repeat(58)}`), true);
  assert.equal(isVersion(`0.3.2-${'a'.repeat(59)}`), false, 'over 64 characters');
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
  // A draft Release reads as absent on releases/tags/, so the list is asked too (tl on #489).
  assert.deepEqual(asked, ['gitTag:v0.3.2', 'release:v0.3.2', 'draftRelease:v0.3.2']);
  for (const exists of ['gitTag:v0.3.2', 'release:v0.3.2', 'draftRelease:v0.3.2']) {
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
  // The run lines, not the comments above them (tl on #489: a comment named the check first).
  assert.ok(at('run: node .github/scripts/publish.mjs check') < at('          docker build \\'));
  assert.ok(at('          docker build \\') < at('          docker push "$IMAGE:$TAG"'));
  // The digest is read right after the sha push, before any version or latest tag.
  assert.ok(at('          docker push "$IMAGE:$TAG"') < at('digest="$(docker inspect'));
  assert.ok(at('digest="$(docker inspect') < at('docker tag "$IMAGE:$TAG" "$IMAGE:$VERSION"'));
  assert.match(publish, /--label "org\.opencontainers\.image\.revision=\$GITHUB_SHA"/);
  assert.match(publish, /--label "org\.opencontainers\.image\.version=\$LABEL_VERSION"/);
  // The commands, not the comments above them, which name `gh release create` too.
  const release = jobOf('release').slice(jobOf('release').indexOf('run: |'));
  assert.notEqual(release.indexOf('publish.mjs release-free'), -1);
  assert.ok(release.indexOf('publish.mjs release-free') < release.indexOf('gh release create'));
  assert.match(release, /gh release create "v\$VERSION" --target "\$GITHUB_SHA"/);
});

test('a message is escaped as a workflow command: a newline cannot start a second one', () => {
  assert.equal(escapeCommandData('a%b\r\n::add-mask::x'), 'a%25b%0D%0A::add-mask::x');
});

/** run() with effects captured: lines said, outputs set, files written. */
function cli(lookup, changelog = CHANGELOG) {
  const said = [];
  const outputs = [];
  const files = new Map();
  const io = {
    say: (line) => said.push(line),
    setOutput: (values) => outputs.push(values),
    writeFile: (file, text) => files.set(file, text),
    changelog: () => changelog,
    lookup,
  };
  return { said, outputs, files, io };
}
const ENV = {
  REF: 'refs/heads/main',
  GITHUB_SHA: SHA,
  IMAGE,
  GITHUB_REPOSITORY: 'bgoleno/opportun',
  DIGEST,
};

test('the check command: refuses with one escaped error line and exit 1, or writes the outputs', async () => {
  const bad = cli(nothingExists().lookup);
  assert.equal(await run(['check'], { ...ENV, VERSION: '0.3.2\n::add-mask::x' }, bad.io), 1);
  assert.equal(bad.said.length, 1);
  assert.doesNotMatch(bad.said[0], /\n/);
  assert.match(bad.said[0], /^::error::version "0\.3\.2\\n::add-mask::x" is not/);
  assert.deepEqual(bad.outputs, []);
  // A raw newline reaching the message (here from a lookup's error) is escaped, not printed.
  const broken = cli(async () => {
    throw new Error('HTTP 500\n::add-mask::x');
  });
  assert.equal(await run(['check'], { ...ENV, VERSION: '' }, broken.io), 1);
  assert.deepEqual(broken.said, [
    '::error::could not check whether ghcr.io/bgoleno/opportun:sha-d4d97b6 exists: HTTP 500%0A::add-mask::x',
  ]);
  const ok = cli(nothingExists().lookup);
  assert.equal(await run(['check'], { ...ENV, VERSION: '0.3.2' }, ok.io), 0);
  assert.deepEqual(ok.outputs, [
    { tag: 'sha-d4d97b6', version: '0.3.2', latest: 'true', label_version: '0.3.2' },
  ]);
});

test('the release-free command: exit 0 only when both are free, 1 otherwise (sec X3 on #489)', async () => {
  assert.equal(
    await run(['release-free'], { ...ENV, VERSION: '0.3.2' }, cli(nothingExists().lookup).io),
    0,
  );
  const taken = cli(async (q) => (q.kind === 'release' ? 'present' : 'absent'));
  assert.equal(await run(['release-free'], { ...ENV, VERSION: '0.3.2' }, taken.io), 1);
  assert.match(taken.said[0], /^::error::release v0\.3\.2 exists already/);
  const none = cli(nothingExists().lookup);
  assert.equal(await run(['release-free'], { ...ENV, VERSION: '' }, none.io), 1);
  assert.match(none.said[0], /not a version/);
});

test('the notes command writes the notes; a bad digest or an unknown command exits 1', async () => {
  const ok = cli(nothingExists().lookup);
  assert.equal(await run(['notes', '/tmp/notes.md'], { ...ENV, VERSION: '0.3.2' }, ok.io), 0);
  assert.match(ok.files.get('/tmp/notes.md'), /Image: `ghcr\.io\/bgoleno\/opportun:0\.3\.2`/);
  const badDigest = cli(nothingExists().lookup);
  assert.equal(
    await run(['notes', 'n.md'], { ...ENV, VERSION: '0.3.2', DIGEST: 'x' }, badDigest.io),
    1,
  );
  assert.equal(badDigest.files.size, 0);
  const unknown = cli(nothingExists().lookup);
  assert.equal(await run(['publish'], ENV, unknown.io), 1);
});

test('every checkout leaves no credentials behind, and the push step stops on any failure', () => {
  // Each checkout's next few lines (its `with:` block) set persist-credentials: false.
  const lines = WORKFLOW.split('\n');
  const checkouts = lines.flatMap((line, i) =>
    line.includes('uses: actions/checkout@') ? [i] : [],
  );
  assert.equal(checkouts.length, 2);
  for (const i of checkouts) {
    assert.ok(
      lines.slice(i + 1, i + 5).some((l) => l.trim() === 'persist-credentials: false'),
      `checkout at line ${i + 1}`,
    );
  }
  const push = jobOf('publish').slice(jobOf('publish').indexOf('- name: Push'));
  const script = push.slice(push.indexOf('run: |'));
  assert.match(script, /set -euo pipefail/);
  // `a && b` in an if-body is exempt from set -e: a failed docker tag would go unnoticed.
  assert.doesNotMatch(
    script.slice(0, script.indexOf('- name:') === -1 ? undefined : script.indexOf('- name:')),
    /docker tag[^\n]*&&/,
  );
});

test('the registry token: anonymous only after a 401, and a 5xx is an error', async () => {
  const token = (first) => {
    const seen = [];
    const fetchImpl = async (url, opts = {}) => {
      seen.push(opts.headers?.Authorization === undefined ? 'anonymous' : 'basic');
      if (url.startsWith('https://ghcr.io/token')) {
        const status = seen.length === 1 ? first : 200;
        return { status, json: async () => ({ token: 'pull-token' }) };
      }
      return { status: 404 };
    };
    return { seen, lookup: liveLookup({ image: IMAGE, repository: 'r/r', token: 't', fetchImpl }) };
  };
  const refused = token(401);
  assert.equal(await refused.lookup({ kind: 'image', name: 'sha-0000000' }), 'absent');
  assert.deepEqual(refused.seen.slice(0, 2), ['basic', 'anonymous']);
  const down = token(503);
  await assert.rejects(
    down.lookup({ kind: 'image', name: 'sha-0000000' }),
    /token answered HTTP 503/,
  );
  assert.deepEqual(down.seen, ['basic']);
});

test('a draft Release with the tag reads as present', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://api.github.com/repos/bgoleno/opportun/releases?per_page=100');
    return {
      status: 200,
      json: async () => [{ tag_name: 'v0.3.1' }, { tag_name: 'v0.3.2', draft: true }],
    };
  };
  const lookup = liveLookup({
    image: IMAGE,
    repository: 'bgoleno/opportun',
    token: 't',
    fetchImpl,
  });
  assert.equal(await lookup({ kind: 'draftRelease', name: 'v0.3.2' }), 'present');
  assert.equal(await lookup({ kind: 'draftRelease', name: 'v0.3.3' }), 'absent');
});
