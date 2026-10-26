// Extension artifacts (FR-C5; design D1, D10, D15, D16, D21, D22). The image carries an
// unpacked extension per browser target. This route zips the requested one and adds the
// server's own address, so the only thing a user ever pastes into the extension is a token.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testApp } from './helpers';
import { registerTwoUsers, type TestClient } from './isolation';

describe('extension artifacts', () => {
  let artifactsDir: string;
  let app: FastifyInstance | undefined;
  let a: TestClient;

  async function boot(overrides: Record<string, unknown> = {}): Promise<void> {
    ({ app } = await testApp({ artifactsDir, ...overrides }));
    ({ a } = await registerTwoUsers(app));
  }

  const entries = (payload: Buffer): Record<string, Uint8Array> =>
    unzipSync(new Uint8Array(payload));

  beforeEach(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), 'opportun-artifacts-'));
    for (const target of ['chrome', 'firefox']) {
      await mkdir(join(artifactsDir, target, 'assets'), { recursive: true });
      await writeFile(join(artifactsDir, target, 'manifest.json'), `{"name":"${target}"}`);
      await writeFile(join(artifactsDir, target, 'popup.html'), '<!doctype html>');
      await writeFile(join(artifactsDir, target, 'assets', 'popup.js'), 'console.log(1);');
    }
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it('lists the targets it has', async () => {
    await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/artifacts/extension' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      targets: {
        id: string;
        label: string;
        filename: string;
        available: boolean;
        buildStamp: string | null;
      }[];
      buildCommand: string;
      baseUrl: string;
    };
    expect(body.targets.map((t) => t.id)).toEqual(['chrome', 'firefox']);
    expect(body.targets.every((t) => t.available)).toBe(true);
    expect(body.targets[0]?.label).toBe('Chrome, Edge, Brave');
    expect(body.targets[0]?.filename).toMatch(/^opportun-chrome.*\.zip$/);
    expect(body.buildCommand).toContain('@opportun/extension');
    // The fixture manifest carries no version_name (#118): null, not a made-up placeholder.
    expect(body.targets.every((t) => t.buildStamp === null)).toBe(true);
  });

  it('#118: hands back the same build stamp an installed copy would show, for the setup dialog to compare against', async () => {
    await writeFile(
      join(artifactsDir, 'chrome', 'manifest.json'),
      JSON.stringify({
        version: '0.1.0',
        version_name: '0.1.0+abc12345 (d4c5383, 2026-10-21T05:19:32.775Z)',
      }),
    );
    await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/artifacts/extension' });
    const body = res.json() as { targets: { id: string; buildStamp: string | null }[] };
    expect(body.targets.find((t) => t.id === 'chrome')?.buildStamp).toBe(
      '0.1.0+abc12345 (d4c5383, 2026-10-21T05:19:32.775Z)',
    );
    // Unrelated to version_name's presence: firefox's fixture manifest still has none.
    expect(body.targets.find((t) => t.id === 'firefox')?.buildStamp).toBeNull();
  });

  it('tells the caller which address the download will carry (design D21)', async () => {
    await boot({ baseUrl: 'http://localhost:3000' });
    const res = await a.request({
      method: 'GET',
      url: '/api/v1/artifacts/extension',
      headers: { host: 'nas.local:8080' },
    });
    expect((res.json() as { baseUrl: string }).baseUrl).toBe('http://nas.local:8080');
  });

  it('serves a zip holding the extension files plus opportun-server.json', async () => {
    await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/artifacts/extension/chrome' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="opportun-chrome/);
    const files = entries(res.rawPayload);
    // Chrome loads an unpacked *folder*, and the install steps name it, so the archive carries
    // one. Without it, unzip on Linux splatters the files into the download directory and the
    // instruction to "choose that folder" points at whatever else is in there.
    expect(Object.keys(files).sort()).toEqual([
      'opportun-chrome/assets/popup.js',
      'opportun-chrome/manifest.json',
      'opportun-chrome/opportun-server.json',
      'opportun-chrome/popup.html',
    ]);
    expect(strFromU8(files['opportun-chrome/manifest.json'] as Uint8Array)).toBe(
      '{"name":"chrome"}',
    );
  });

  it('keeps the firefox archive flat, because about:debugging reads the zip itself', async () => {
    await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/artifacts/extension/firefox' });
    expect(Object.keys(entries(res.rawPayload)).sort()).toEqual([
      'assets/popup.js',
      'manifest.json',
      'opportun-server.json',
      'popup.html',
    ]);
  });

  it('bakes the base URL the request arrived on, not OPPORTUN_BASE_URL', async () => {
    await boot({ baseUrl: 'http://localhost:3000' });
    const res = await a.request({
      method: 'GET',
      url: '/api/v1/artifacts/extension/chrome',
      headers: { host: 'owner-mac.local:8080' },
    });
    const baked = JSON.parse(
      strFromU8(entries(res.rawPayload)['opportun-chrome/opportun-server.json'] as Uint8Array),
    );
    expect(baked).toEqual({ baseUrl: 'http://owner-mac.local:8080' });
  });

  it('keeps a path prefix from the configured base URL', async () => {
    await boot({ baseUrl: 'http://localhost:3000/opportun' });
    const res = await a.request({
      method: 'GET',
      url: '/api/v1/artifacts/extension/chrome',
      headers: { host: 'nas.local:8080' },
    });
    const baked = JSON.parse(
      strFromU8(entries(res.rawPayload)['opportun-chrome/opportun-server.json'] as Uint8Array),
    );
    expect(baked.baseUrl).toBe('http://nas.local:8080/opportun');
  });

  it('refuses an unknown target with a JSON 404', async () => {
    await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/artifacts/extension/safari' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found' } });
  });

  it('refuses a target that is a path rather than a name', async () => {
    await boot();
    for (const target of ['..', '../chrome', 'chrome/assets']) {
      const res = await a.request({
        method: 'GET',
        url: `/api/v1/artifacts/extension/${encodeURIComponent(target)}`,
      });
      expect(res.statusCode, target).toBe(404);
    }
  });

  it('reports every target unavailable when the artifacts are not built', async () => {
    await rm(artifactsDir, { recursive: true, force: true });
    await boot();
    const list = await a.request({ method: 'GET', url: '/api/v1/artifacts/extension' });
    const body = list.json() as { targets: { available: boolean }[] };
    expect(body.targets.every((t) => !t.available)).toBe(true);
    const res = await a.request({ method: 'GET', url: '/api/v1/artifacts/extension/chrome' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found' } });
  });

  it('refuses a target name longer than any target could be', async () => {
    await boot();
    const res = await a.request({
      method: 'GET',
      url: `/api/v1/artifacts/extension/${'x'.repeat(70)}`,
    });
    // Longer still is refused earlier, as an over-long URI.
    expect(res.statusCode).toBe(400);
  });

  it('requires a session', async () => {
    await boot();
    for (const url of ['/api/v1/artifacts/extension', '/api/v1/artifacts/extension/chrome']) {
      const res = await app!.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });
});
