// The version and commit this server was built from (https://github.com/bgoleno/opportun/issues/480).
// They come from the build, not from a network call: the Publish image workflow passes them to
// deploy/Dockerfile as build args, and its runtime stage keeps them as OPPORTUN_VERSION and
// OPPORTUN_COMMIT. A local build or `pnpm dev` sets neither, and reads as a development build.
// package.json's 0.1.0 is never used: it is not the released version.

export interface BuildInfo {
  /** The version it was published as, e.g. 0.3.1; null for a build without one. */
  version: string | null;
  /** The commit it was built from, cut to 7 characters; null when unknown. */
  commit: string | null;
}

// The publish workflow's own version pattern (MAJOR.MINOR.PATCH, optionally -prerelease), so only
// what it would accept is shown. Checked in two parts rather than one pattern with an optional
// group, which the lint's unsafe-regex rule refuses.
const VERSION_CORE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const PRERELEASE = /^[0-9A-Za-z.-]+$/;

function isVersion(value: string): boolean {
  const dash = value.indexOf('-');
  if (dash === -1) return VERSION_CORE.test(value);
  return VERSION_CORE.test(value.slice(0, dash)) && PRERELEASE.test(value.slice(dash + 1));
}

// A git object name as GITHUB_SHA gives it: lowercase hex.
const COMMIT = /^[0-9a-f]{7,40}$/;

/** Reads both, and treats anything that is not a version or a commit as unknown. */
export function readBuildInfo(env: NodeJS.ProcessEnv): BuildInfo {
  const version = env.OPPORTUN_VERSION?.trim() ?? '';
  const commit = env.OPPORTUN_COMMIT?.trim() ?? '';
  return {
    version: isVersion(version) ? version : null,
    commit: COMMIT.test(commit) ? commit.slice(0, 7) : null,
  };
}
