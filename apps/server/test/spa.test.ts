import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECURITY_HEADERS } from '../src/plugins/security';
import { captureLogs, testApp } from './helpers';

const INDEX =
  '<!doctype html><html><head><title>Opportun</title></head><body>spa-root</body></html>';

describe('SPA static serving', () => {
  let webDir: string;
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    webDir = await mkdtemp(join(tmpdir(), 'opportun-web-'));
    await mkdir(join(webDir, 'assets'));
    await writeFile(join(webDir, 'index.html'), INDEX);
    await writeFile(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1);');
    await writeFile(join(webDir, 'theme-init.js'), '/* theme */');
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await rm(webDir, { recursive: true, force: true });
  });

  it('serves index.html for client routes like /pipeline', async () => {
    ({ app } = await testApp({ webDir }));
    for (const url of ['/', '/pipeline', '/settings/role-targets', '/login?redirect=%2F']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toMatch(/^text\/html/);
      expect(res.body, url).toContain('spa-root');
      expect(res.headers['cache-control'], url).toBe('no-cache');
      expect(res.headers['content-security-policy']).toBe(
        SECURITY_HEADERS['content-security-policy'],
      );
    }
  });

  it('serves built files with long-lived caching for hashed assets', async () => {
    ({ app } = await testApp({ webDir }));
    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.headers['cache-control']).toContain('immutable');
    const theme = await app.inject({ method: 'GET', url: '/theme-init.js' });
    expect(theme.statusCode).toBe(200);
    expect(theme.body).toBe('/* theme */');
  });

  it('404s unknown /api/v1 routes and missing assets as JSON, never the SPA', async () => {
    ({ app } = await testApp({ webDir }));
    for (const url of ['/api/v1/nope', '/api/v1/settings/nope', '/api', '/assets/missing.js']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: { code: 'not_found' } });
    }
    const post = await app.inject({ method: 'POST', url: '/pipeline', payload: {} });
    expect(post.statusCode).toBe(404);
    expect(post.body).not.toContain('spa-root');
  });

  it('warns that the build may be newer than the process when a hashed asset has no route', async () => {
    const logs = captureLogs();
    ({ app } = await testApp({ webDir, logLevel: 'warn' }, { logStream: logs }));
    const res = await app.inject({ method: 'GET', url: '/assets/app-newhash.js' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found' } });
    expect(logs.text()).toContain('/assets/app-newhash.js');
    expect(logs.text()).toMatch(/restart/i);
  });

  it('stays quiet for unknown API paths, which are ordinary 404s', async () => {
    const logs = captureLogs();
    ({ app } = await testApp({ webDir, logLevel: 'warn' }, { logStream: logs }));
    for (const url of ['/api/v1/nope', '/api']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    expect(logs.text()).toBe('');
  });

  it('leaves /healthz and the API untouched', async () => {
    ({ app } = await testApp({ webDir }));
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({
      status: 'ok',
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
  });

  it('does not serve the SPA when no build is present', async () => {
    ({ app } = await testApp({ webDir: join(webDir, 'does-not-exist') }));
    const res = await app.inject({ method: 'GET', url: '/pipeline' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found' } });
  });
});
