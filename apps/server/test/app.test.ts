import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config';
import { captureLogs, testApp } from './helpers';
import { queryOne, sqliteOnly } from './db';

const KEY_HEX = randomBytes(32).toString('hex');

function without(env: Record<string, string>, key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k !== key));
}

describe('loadConfig', () => {
  const base = {
    OPPORTUN_MASTER_KEY: KEY_HEX,
    OPPORTUN_BASE_URL: 'https://opportun.example.com',
    DATA_DIR: '/data',
  };

  it('reads all settings from the environment', () => {
    const cfg = loadConfig({ ...base, PORT: '8080', LOG_LEVEL: 'debug', SMTP_URL: 'smtp://x' });
    expect(cfg.port).toBe(8080);
    expect(cfg.dataDir).toBe('/data');
    expect(cfg.baseUrl).toBe('https://opportun.example.com');
    expect(cfg.masterKey.equals(Buffer.from(KEY_HEX, 'hex'))).toBe(true);
    expect(cfg.logLevel).toBe('debug');
    expect(cfg.smtpUrl).toBe('smtp://x');
  });

  it('applies defaults for optional settings', () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(3000);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.logLevel).toBe('info');
    expect(cfg.smtpUrl).toBeUndefined();
  });

  it('throws naming OPPORTUN_MASTER_KEY when no key is configured', () => {
    expect(() => loadConfig(without(base, 'OPPORTUN_MASTER_KEY'))).toThrow(/OPPORTUN_MASTER_KEY/);
  });

  it('throws naming OPPORTUN_BASE_URL when it is missing', () => {
    expect(() => loadConfig(without(base, 'OPPORTUN_BASE_URL'))).toThrow(/OPPORTUN_BASE_URL/);
  });

  it('rejects a master key that is not 32 bytes of hex', () => {
    expect(() => loadConfig({ ...base, OPPORTUN_MASTER_KEY: 'abcd' })).toThrow(
      /OPPORTUN_MASTER_KEY/,
    );
    expect(() => loadConfig({ ...base, OPPORTUN_MASTER_KEY: 'z'.repeat(64) })).toThrow(
      /OPPORTUN_MASTER_KEY/,
    );
  });

  it('rejects an invalid PORT', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('honors OPPORTUN_HOST', () => {
    expect(loadConfig({ ...base, OPPORTUN_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(loadConfig({ ...base, OPPORTUN_HOST: '::' }).host).toBe('::');
    expect(loadConfig({ ...base, OPPORTUN_HOST: '100.64.0.7' }).host).toBe('100.64.0.7');
    expect(loadConfig({ ...base, OPPORTUN_HOST: 'localhost' }).host).toBe('localhost');
  });

  it('rejects an OPPORTUN_HOST that is not a bind address', () => {
    expect(() => loadConfig({ ...base, OPPORTUN_HOST: '0.0.0.0 ' })).toThrow(/OPPORTUN_HOST/);
    expect(() => loadConfig({ ...base, OPPORTUN_HOST: 'my host' })).toThrow(/OPPORTUN_HOST/);
    expect(() => loadConfig({ ...base, OPPORTUN_HOST: 'http://x' })).toThrow(/OPPORTUN_HOST/);
  });

  it('reads the master key from OPPORTUN_MASTER_KEY_FILE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opportun-key-'));
    try {
      const file = join(dir, 'master.key');
      await writeFile(file, `${KEY_HEX}\n`);
      const env = without(base, 'OPPORTUN_MASTER_KEY');
      const cfg = loadConfig({ ...env, OPPORTUN_MASTER_KEY_FILE: file });
      expect(cfg.masterKey.equals(Buffer.from(KEY_HEX, 'hex'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('app', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('boots and serves /healthz', async () => {
    ({ app } = await testApp());
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      db: 'ok',
      queueLagMs: 0,
      databaseIntegrity: null,
    });
  });

  // Issue #205: the exact gap the owner's 2026-10-20 incident needed closed -- a known-bad
  // live database must not answer an unqualified ok. Still 200, deliberately, not 503: see
  // HealthSchema's own comment in app.ts for why (killing and restarting a process fixes
  // nothing a corrupt file on disk, and the #198 drill found the app keeps serving most
  // requests normally throughout).
  it('reports a known database-integrity failure in the body, at 200 not 503', async () => {
    ({ app } = await testApp());
    const badCheck = {
      ok: false,
      checkedAt: Date.UTC(2026, 9, 21, 2, 30),
      detail: 'row 2 missing from index x',
    };
    await app.storage.writeText('backups/.live-check.json', JSON.stringify(badCheck));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'corrupted',
      db: 'ok',
      queueLagMs: 0,
      databaseIntegrity: badCheck,
    });
  });

  it('still reports a clean, checked database as ok, not corrupted', async () => {
    ({ app } = await testApp());
    const goodCheck = { ok: true, checkedAt: Date.UTC(2026, 9, 21, 2, 30), detail: null };
    await app.storage.writeText('backups/.live-check.json', JSON.stringify(goodCheck));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', databaseIntegrity: goodCheck });
  });

  it.runIf(sqliteOnly)('opens the database in WAL mode with foreign keys on', async () => {
    ({ app } = await testApp());
    expect(await queryOne(app, 'PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
    expect(await queryOne(app, 'PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
  });

  it('returns 404 JSON for unknown api routes', async () => {
    ({ app } = await testApp());
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('notes that a loopback host is unreachable from another device', async () => {
    const logs = captureLogs();
    ({ app } = await testApp({ host: '127.0.0.1', logLevel: 'info' }, { logStream: logs }));
    expect(logs.text()).toMatch(/cannot be reached from another device/);
  });

  it('says nothing about loopback when bound to a reachable address', async () => {
    const logs = captureLogs();
    ({ app } = await testApp({ host: '0.0.0.0', logLevel: 'info' }, { logStream: logs }));
    expect(logs.text()).not.toMatch(/cannot be reached from another device/);
  });
});
