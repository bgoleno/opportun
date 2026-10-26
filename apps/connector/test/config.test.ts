import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configFiles,
  defaultConfigDir,
  loadConfig,
  loadState,
  normalizeServerUrl,
  parseConfig,
  saveConfig,
  saveState,
} from '../src/config';
import { nodeFs } from '../src/nodeIo';
import { CONFIG, makeIo, withConfig } from './fakes';

describe('config location', () => {
  it('lives under ~/.config/opportun-connector, or XDG_CONFIG_HOME when set', () => {
    expect(defaultConfigDir({ HOME: '/Users/me' })).toBe('/Users/me/.config/opportun-connector');
    expect(defaultConfigDir({ HOME: '/Users/me', XDG_CONFIG_HOME: '/x/cfg' })).toBe(
      '/x/cfg/opportun-connector',
    );
    expect(() => defaultConfigDir({})).toThrow(/HOME/);
    expect(configFiles('/d')).toEqual({
      dir: '/d',
      config: '/d/config.json',
      state: '/d/state.json',
    });
  });
});

describe('server url', () => {
  it('requires https, except for a loopback address', () => {
    expect(normalizeServerUrl(' https://opportun.example/ ')).toBe('https://opportun.example');
    expect(normalizeServerUrl('https://example.org/opportun//')).toBe(
      'https://example.org/opportun',
    );
    expect(normalizeServerUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(normalizeServerUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
    expect(() => normalizeServerUrl('http://opportun.example')).toThrow(/https/);
    expect(() => normalizeServerUrl('ftp://opportun.example')).toThrow(/https/);
    expect(() => normalizeServerUrl('not a url')).toThrow(/address/);
    expect(() => normalizeServerUrl('https://me:pw@opportun.example')).toThrow(/credentials/);
    expect(() => normalizeServerUrl('https://opportun.example/?q=1')).toThrow(/query/);
  });
});

describe('parseConfig', () => {
  it('accepts a complete config', () => {
    expect(parseConfig(JSON.stringify(CONFIG))).toEqual(CONFIG);
  });

  it('fills the watch interval when absent', () => {
    const rest: Partial<typeof CONFIG> = { ...CONFIG };
    delete rest.intervalMinutes;
    expect(parseConfig(JSON.stringify(rest)).intervalMinutes).toBe(15);
  });

  it.each([
    ['not json', /not valid JSON/],
    [JSON.stringify({ ...CONFIG, token: 'secret' }), /device token/],
    [JSON.stringify({ ...CONFIG, mailboxes: [] }), /mailbox/],
    [JSON.stringify({ ...CONFIG, mailboxes: ['Inbox', 3] }), /mailbox/],
    [JSON.stringify({ ...CONFIG, lookbackDays: 0 }), /lookback/],
    [JSON.stringify({ ...CONFIG, lookbackDays: 5000 }), /lookback/],
    [JSON.stringify({ ...CONFIG, intervalMinutes: 0.5 }), /interval/],
    [JSON.stringify({ ...CONFIG, serverUrl: 'http://opportun.example' }), /https/],
  ])('refuses %s', (text, message) => {
    expect(() => parseConfig(text)).toThrow(message);
  });
});

describe('load and save', () => {
  it('saves the config 0600 in a 0700 directory and reads it back', async () => {
    const { io, fs } = makeIo();
    await saveConfig(io, CONFIG);
    const files = configFiles(io.configDir);
    expect(fs.dirs.get(files.dir)).toBe(0o700);
    expect(fs.files.get(files.config)?.mode).toBe(0o600);
    expect(await loadConfig(io)).toEqual(CONFIG);
  });

  it('explains a missing config', async () => {
    const { io } = makeIo();
    await expect(loadConfig(io)).rejects.toThrow(/opportun-connector init/);
  });

  it('keeps the cursor in a state file next to the config', async () => {
    const { io, fs } = makeIo();
    expect(await loadState(io)).toEqual({ cursor: null });
    await saveState(io, { cursor: 1234 });
    expect(fs.files.get(configFiles(io.configDir).state)?.mode).toBe(0o600);
    expect(await loadState(io)).toEqual({ cursor: 1234 });
  });

  it('treats a corrupt state file as no cursor', async () => {
    const { io, fs } = makeIo();
    await withConfig(fs, CONFIG, { cursor: 'yesterday' });
    expect(await loadState(io)).toEqual({ cursor: null });
  });
});

describe.skipIf(process.platform === 'win32')('node file system permissions', () => {
  let dir = '';
  afterEach(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('writes the config file 0600 and its directory 0700, even over a looser file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'opportun-connector-'));
    const { io } = makeIo({ fs: nodeFs, configDir: join(dir, 'cfg', 'opportun-connector') });
    const files = configFiles(io.configDir);
    await nodeFs.mkdir(files.dir, 0o700);
    await nodeFs.writeText(files.config, '{}', 0o644);
    await saveConfig(io, CONFIG);
    expect((await stat(files.config)).mode & 0o777).toBe(0o600);
    expect((await stat(files.dir)).mode & 0o777).toBe(0o700);
    expect(await loadConfig(io)).toEqual(CONFIG);
    expect(await nodeFs.readText(join(dir, 'missing.json'))).toBeNull();
  });
});
