// The Publish image workflow's checks and its Release notes
// (https://github.com/bgoleno/opportun/issues/478, as tl shaped it there). A plain module, with no
// dependencies, so publish.test.mjs can prove the refusals without a live dispatch: a dispatch
// publishes a public image and a public Release, so the workflow itself is never run to test it.
//
// Commands (run by .github/workflows/publish-image.yml):
//   node .github/scripts/publish.mjs check         before building: refuse, or write the tags
//   node .github/scripts/publish.mjs release-free  in the release job: the tag and Release are free
//   node .github/scripts/publish.mjs notes <file>  in the release job: write the Release notes
// Inputs come from the environment (VERSION is free text from the dispatch form, so it is never
// put on a command line): VERSION, REF, GITHUB_SHA, GITHUB_REPOSITORY, IMAGE, GH_TOKEN, DIGEST.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** MAJOR.MINOR.PATCH, optionally -prerelease, with no leading v: one spelling per version. */
export function isVersion(value) {
  const dash = value.indexOf('-');
  const core = dash === -1 ? value : value.slice(0, dash);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(core)) return false;
  return dash === -1 || /^[0-9A-Za-z.-]+$/.test(value.slice(dash + 1));
}

/** The git tag and Release name for a version: `v` + the version, as the git convention has it. */
export const gitTagOf = (version) => `v${version}`;

/** The image's sha tag: exactly seven characters of the commit, so it can be typed by hand. */
export const shaTagOf = (sha) => `sha-${sha.slice(0, 7)}`;

/**
 * The text of CHANGELOG.md's `## <version> (YYYY-MM-DD)` section, up to the next `## ` heading,
 * trimmed; null when there is no such section, or it is empty. A release is the commit that
 * renames `## Unreleased` to that heading, so the Release's notes are the curated ones.
 */
export function changelogSection(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => {
    const m = /^## (\S+) \(\d{4}-\d{2}-\d{2}\)$/.exec(line);
    return m !== null && m[1] === version;
  });
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body === '' ? null : body;
}

/**
 * Every check before anything is built or pushed, in order: the ones that need no network first.
 * `lookup` answers 'present' or 'absent' for { kind: 'image' | 'gitTag' | 'release', name }, and
 * throws when it cannot tell. Returns the refusal (a message) or the tags to build and push.
 */
export async function check({ version, ref, sha, image, changelog, lookup }) {
  if (version !== '' && !isVersion(version)) {
    return {
      refused: `version '${version}' is not MAJOR.MINOR.PATCH (optionally -prerelease), without a leading v`,
    };
  }
  const onMain = ref === 'refs/heads/main';
  // A git tag and a Release on a commit that is not on main would be a public release of it.
  if (version !== '' && !onMain) {
    return { refused: `a version is published only from main; this run is on ${ref}` };
  }
  if (version !== '' && changelogSection(changelog, version) === null) {
    return {
      refused: `CHANGELOG.md has no '## ${version} (YYYY-MM-DD)' section with notes; commit it first`,
    };
  }
  const tag = shaTagOf(sha);
  const wanted = [{ kind: 'image', name: tag, what: `${image}:${tag}` }];
  if (version !== '') {
    wanted.push(
      { kind: 'image', name: version, what: `${image}:${version}` },
      { kind: 'gitTag', name: gitTagOf(version), what: `the git tag ${gitTagOf(version)}` },
      { kind: 'release', name: gitTagOf(version), what: `the Release ${gitTagOf(version)}` },
    );
  }
  for (const w of wanted) {
    let answer;
    try {
      answer = await lookup({ kind: w.kind, name: w.name });
    } catch (err) {
      // Fail closed: a check that could not be made is not a check that passed.
      return { refused: `could not check whether ${w.what} exists: ${err.message}` };
    }
    if (answer !== 'absent') {
      return {
        refused:
          w.name === tag
            ? `${w.what} already exists: one build per commit, so a sha tag never moves. Make a new commit to rebuild.`
            : `${w.what} already exists. Pick a new version.`,
      };
    }
  }
  return {
    tag,
    version,
    latest: onMain,
    // The image's org.opencontainers.image.version label: the version, else its sha tag.
    labelVersion: version === '' ? tag : version,
  };
}

/**
 * In the release job, just before creating: the git tag and the Release are still free. Returns
 * the refusal, or null. `gh release create` on a tag that exists would attach the Release to that
 * tag's commit, not to the one built.
 */
export async function releaseFree(version, lookup) {
  for (const kind of ['gitTag', 'release']) {
    let answer;
    try {
      answer = await lookup({ kind, name: gitTagOf(version) });
    } catch (err) {
      return `could not check ${kind} ${gitTagOf(version)}: ${err.message}`;
    }
    if (answer !== 'absent') return `${kind} ${gitTagOf(version)} exists already`;
  }
  return null;
}

/** The Release's notes: the CHANGELOG section, then the image with its digest, and the commit. */
export function releaseNotes({ changelog, version, image, digest, sha, repository }) {
  const section = changelogSection(changelog, version);
  if (section === null) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const at = /@(sha256:[0-9a-f]{64})$/.exec(digest);
  if (at === null) throw new Error(`not an image digest: ${digest}`);
  return [
    section,
    '',
    '---',
    '',
    `Image: \`${image}:${version}\` (\`${at[1]}\`)`,
    '',
    `Commit: [\`${sha.slice(0, 7)}\`](https://github.com/${repository}/commit/${sha})`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The live lookups and the command line. Only reads, with the job's own token.

/** 'present' for 200, 'absent' for 404, and an error for anything else. */
function presence(status, what) {
  if (status === 200) return 'present';
  if (status === 404) return 'absent';
  throw new Error(`${what} answered HTTP ${status}`);
}

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** A lookup over GHCR's registry API and GitHub's REST API. */
export function liveLookup({ image, repository, token, fetchImpl = fetch }) {
  const [registry, ...path] = image.split('/');
  const repoPath = path.join('/');
  let registryToken;
  async function pullToken() {
    if (registryToken !== undefined) return registryToken;
    const url = `https://${registry}/token?scope=repository:${repoPath}:pull`;
    const basic = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    let res = await fetchImpl(url, { headers: { Authorization: basic } });
    // A public package also answers without credentials.
    if (res.status !== 200) res = await fetchImpl(url);
    if (res.status !== 200) throw new Error(`${registry} token answered HTTP ${res.status}`);
    registryToken = (await res.json()).token;
    return registryToken;
  }
  return async ({ kind, name }) => {
    if (kind === 'image') {
      const res = await fetchImpl(`https://${registry}/v2/${repoPath}/manifests/${name}`, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${await pullToken()}`, Accept: MANIFEST_TYPES },
      });
      return presence(res.status, `${image}:${name}`);
    }
    const route = kind === 'gitTag' ? `git/ref/tags/${name}` : `releases/tags/${name}`;
    const res = await fetchImpl(`https://api.github.com/repos/${repository}/${route}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    return presence(res.status, `GitHub's ${route}`);
  };
}

function output(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  else console.log(lines.join('\n'));
}

function refuse(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

async function main(argv, env) {
  const version = (env.VERSION ?? '').trim();
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const lookup = liveLookup({
    image: env.IMAGE,
    repository: env.GITHUB_REPOSITORY,
    token: env.GH_TOKEN,
  });
  if (argv[0] === 'check') {
    const result = await check({
      version,
      ref: env.REF,
      sha: env.GITHUB_SHA,
      image: env.IMAGE,
      changelog,
      lookup,
    });
    if (result.refused) refuse(result.refused);
    output({
      tag: result.tag,
      version: result.version,
      latest: String(result.latest),
      label_version: result.labelVersion,
    });
  } else if (argv[0] === 'release-free') {
    if (!isVersion(version)) refuse(`not a version: '${version}'`);
    const refused = await releaseFree(version, lookup);
    if (refused !== null) refuse(refused);
  } else if (argv[0] === 'notes') {
    writeFileSync(
      argv[1],
      releaseNotes({
        changelog,
        version,
        image: env.IMAGE,
        digest: env.DIGEST,
        sha: env.GITHUB_SHA,
        repository: env.GITHUB_REPOSITORY,
      }),
    );
  } else {
    refuse(`unknown command: ${argv[0]}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).catch((err) => refuse(err.message));
}
