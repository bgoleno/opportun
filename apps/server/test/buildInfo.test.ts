// The running version and commit (https://github.com/bgoleno/opportun/issues/480). They come
// from the build: the Publish image workflow passes them to deploy/Dockerfile as build args,
// which the runtime stage keeps as OPPORTUN_VERSION and OPPORTUN_COMMIT. No network call.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBuildInfo } from '../src/lib/buildInfo';
import { useApi } from './api';

const ROOT = join(__dirname, '..', '..', '..');
const SHA = 'd4d97b6c0ffee0123456789abcdef0123456789a';

describe('readBuildInfo (issue 480)', () => {
  it('a published version and its commit, the commit cut to 7', () => {
    expect(readBuildInfo({ OPPORTUN_VERSION: '0.3.1', OPPORTUN_COMMIT: SHA })).toEqual({
      version: '0.3.1',
      commit: 'd4d97b6',
    });
  });

  it('only a commit: a build without a version', () => {
    expect(readBuildInfo({ OPPORTUN_VERSION: '', OPPORTUN_COMMIT: SHA })).toEqual({
      version: null,
      commit: 'd4d97b6',
    });
  });

  it('neither: a development build, never a made-up number', () => {
    expect(readBuildInfo({})).toEqual({ version: null, commit: null });
    expect(readBuildInfo({ OPPORTUN_VERSION: '', OPPORTUN_COMMIT: '' })).toEqual({
      version: null,
      commit: null,
    });
  });

  it('anything that is not a version or a commit is unknown, not shown', () => {
    expect(
      readBuildInfo({ OPPORTUN_VERSION: 'v0.3.1', OPPORTUN_COMMIT: 'not-a-sha<script>' }),
    ).toEqual({ version: null, commit: null });
    expect(readBuildInfo({ OPPORTUN_VERSION: '0.3.2-rc.1', OPPORTUN_COMMIT: 'D4D97B6' })).toEqual({
      version: '0.3.2-rc.1',
      commit: null,
    });
  });
});

describe('GET /api/v1/settings/build (issue 480)', () => {
  const boot = useApi();

  it('answers any signed-in user with the version and commit, and nobody else', async () => {
    const { app, a } = await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/settings/build' });
    expect(res.statusCode).toBe(200);
    // The test process sets neither, so it reads as a development build.
    expect(res.json()).toEqual(readBuildInfo(process.env));
    expect(Object.keys(res.json()).sort()).toEqual(['commit', 'version']);
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/settings/build' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('the build passes them in (issue 480)', () => {
  const dockerfile = readFileSync(join(ROOT, 'deploy', 'Dockerfile'), 'utf8');
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'publish-image.yml'), 'utf8');

  it('the runtime stage turns both build args into the environment the server reads', () => {
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    expect(runtime).toMatch(/^ARG OPPORTUN_VERSION=$/m);
    expect(runtime).toMatch(/^ARG OPPORTUN_COMMIT=$/m);
    expect(runtime).toMatch(/OPPORTUN_VERSION=\$\{OPPORTUN_VERSION\}/);
    expect(runtime).toMatch(/OPPORTUN_COMMIT=\$\{OPPORTUN_COMMIT\}/);
  });

  it('the Publish image build passes the checked version and the commit it builds', () => {
    const build = workflow.slice(
      workflow.indexOf('- name: Build'),
      workflow.indexOf('- name: Push'),
    );
    expect(build).toContain('VERSION: ${{ steps.check.outputs.version }}');
    expect(build).toContain('--build-arg "OPPORTUN_VERSION=$VERSION"');
    expect(build).toContain('--build-arg "OPPORTUN_COMMIT=$GITHUB_SHA"');
  });
});
