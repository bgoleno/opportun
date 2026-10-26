import { describe, expect, it, vi } from 'vitest';
import {
  BAKED_CONFIG_TIMEOUT_MS,
  bakedServerUrl,
  captureEndpoint,
  loadSettings,
  originPattern,
  parseServerUrl,
  saveSettings,
  type SettingsStorage,
} from '../src/settings';

const TOKEN = `odt_${'A'.repeat(43)}`;

/** An in-memory chrome.storage.local stand-in (promise API, like MV3). */
function memoryStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const storage: SettingsStorage = {
    get: async (keys) => Object.fromEntries(Object.entries(data).filter(([k]) => keys.includes(k))),
    set: async (items) => {
      Object.assign(data, items);
    },
  };
  return { data, storage };
}

describe('parseServerUrl', () => {
  it('accepts an https server, trimming whitespace and trailing slashes', () => {
    expect(parseServerUrl('  https://opportun.example.com/ ')).toEqual({
      ok: true,
      base: 'https://opportun.example.com',
    });
    expect(parseServerUrl('https://example.com/opportun//')).toEqual({
      ok: true,
      base: 'https://example.com/opportun',
    });
  });

  it('accepts plain http only for this computer', () => {
    expect(parseServerUrl('http://localhost:8080')).toEqual({
      ok: true,
      base: 'http://localhost:8080',
    });
    expect(parseServerUrl('http://127.0.0.1:3000/')).toEqual({
      ok: true,
      base: 'http://127.0.0.1:3000',
    });
    expect(parseServerUrl('http://opportun.example.com')).toEqual({
      ok: false,
      error: 'insecure',
    });
  });

  it('accepts plain http on a private network (ADR-14, design D17)', () => {
    for (const url of [
      'http://owner-mac.local:8080',
      'http://nas.home.arpa:8080',
      'http://opportun:8080',
      'http://192.168.40.140:8080',
      'http://10.1.2.3:8080',
      'http://172.16.0.1:8080',
      'http://172.31.255.255:8080',
      'http://100.64.0.1:8080',
      'http://169.254.1.1:8080',
      // OpenWrt's default local domain, and a fully qualified mDNS name with the root dot.
      'http://nas.lan:8080',
      'http://owner-mac.local.:8080',
    ]) {
      expect(parseServerUrl(url), url).toEqual({ ok: true, base: url });
    }
  });

  it('says an IPv6 literal is unsupported rather than telling you to use https', () => {
    // https would fail too: a Chrome match pattern cannot name an IPv6 literal, so the
    // permission could never be granted either way.
    expect(parseServerUrl('http://[::1]:8080')).toEqual({ ok: false, error: 'ipv6' });
    expect(parseServerUrl('https://[::1]:8080')).toEqual({ ok: false, error: 'ipv6' });
  });

  it('refuses a host that is only shaped like an address', () => {
    // Both are rejected by the URL parser, before the private-host rule is consulted: a host
    // whose last label is numeric is parsed as IPv4, and these are not valid addresses.
    for (const url of ['http://10.300.1.1', 'http://127.0.0.1.2']) {
      expect(parseServerUrl(url), url).toEqual({ ok: false, error: 'invalid' });
    }
  });

  it('still refuses plain http on a public host', () => {
    for (const url of [
      'http://example.com',
      'http://jobs.example.com:8080',
      'http://8.8.8.8',
      'http://172.32.0.1',
      'http://100.128.0.1',
      'http://notlocal.com',
      // A public domain whose first label only looks like a private address. Accepting these
      // puts the device token on the open internet in clear text.
      'http://10.evil.example.com',
      'http://127.0.0.1.attacker.net',
      'http://172.16.lol.example.com',
      'http://192.168.1.1.example.com',
      'http://100.64.0.1.example.com',
      'http://169.254.1.1.example.com',
    ]) {
      expect(parseServerUrl(url), url).toEqual({ ok: false, error: 'insecure' });
    }
  });

  it('refuses garbage, other schemes, credentials, queries and fragments', () => {
    expect(parseServerUrl('')).toEqual({ ok: false, error: 'invalid' });
    expect(parseServerUrl('opportun.example.com')).toEqual({ ok: false, error: 'invalid' });
    expect(parseServerUrl('ftp://example.com')).toEqual({ ok: false, error: 'invalid' });
    expect(parseServerUrl('https://u:p@example.com')).toEqual({ ok: false, error: 'invalid' });
    expect(parseServerUrl('https://example.com/?a=1')).toEqual({ ok: false, error: 'invalid' });
    expect(parseServerUrl('https://example.com/#x')).toEqual({ ok: false, error: 'invalid' });
  });
});

describe('endpoint and permission pattern', () => {
  it('derive from the base', () => {
    expect(captureEndpoint('https://example.com/opportun')).toBe(
      'https://example.com/opportun/api/v1/connector/capture',
    );
    expect(originPattern('https://example.com/opportun')).toBe('https://example.com/*');
  });

  it('the permission pattern carries no port, matching the declared portless patterns', () => {
    expect(originPattern('http://localhost:8080')).toBe('http://localhost/*');
    expect(originPattern('http://127.0.0.1:3000')).toBe('http://127.0.0.1/*');
    expect(originPattern('https://example.com:8443/opportun')).toBe('https://example.com/*');
  });
});

describe('saveSettings / loadSettings', () => {
  it('round-trips the server URL and token through storage', async () => {
    const { storage, data } = memoryStorage();
    const saved = await saveSettings(storage, {
      serverUrl: 'https://opportun.example.com/',
      token: `  ${TOKEN}\n`,
    });
    expect(saved).toEqual({
      ok: true,
      settings: { serverUrl: 'https://opportun.example.com', token: TOKEN },
    });
    expect(data).toEqual({ serverUrl: 'https://opportun.example.com', token: TOKEN });
    expect(await loadSettings(storage)).toEqual({
      serverUrl: 'https://opportun.example.com',
      token: TOKEN,
    });
  });

  it('loads empty settings from empty or corrupted storage', async () => {
    expect(await loadSettings(memoryStorage().storage)).toEqual({ serverUrl: '', token: '' });
    expect(await loadSettings(memoryStorage({ serverUrl: 42, token: null }).storage)).toEqual({
      serverUrl: '',
      token: '',
    });
  });

  it('refuses a token that is not a device token, without storing anything', async () => {
    const { storage, data } = memoryStorage();
    const r = await saveSettings(storage, {
      serverUrl: 'https://opportun.example.com',
      token: 'my-password',
    });
    expect(r).toEqual({ ok: false, field: 'token', error: 'token_format' });
    expect(data).toEqual({});
  });

  it('refuses an invalid server URL, without storing anything', async () => {
    const { storage, data } = memoryStorage();
    const r = await saveSettings(storage, { serverUrl: 'http://example.com', token: TOKEN });
    expect(r).toEqual({ ok: false, field: 'serverUrl', error: 'insecure' });
    expect(data).toEqual({});
  });
});

describe('bakedServerUrl (design D9, D10)', () => {
  const source = (body: unknown, ok = true) => ({
    url: (path: string) => `chrome-extension://abc/${path}`,
    fetch: async (input: string) => {
      expect(input).toBe('chrome-extension://abc/opportun-server.json');
      return { ok, json: async () => body };
    },
  });

  it('reads the address the download was built with', async () => {
    expect(await bakedServerUrl(source({ baseUrl: 'https://jobs.example.com' }))).toBe(
      'https://jobs.example.com',
    );
  });

  it('keeps a path prefix', async () => {
    expect(await bakedServerUrl(source({ baseUrl: 'https://jobs.example.com/opportun' }))).toBe(
      'https://jobs.example.com/opportun',
    );
  });

  it('is empty when the file is missing, which is how a from-source build reads', async () => {
    expect(await bakedServerUrl(source(undefined, false))).toBe('');
    expect(
      await bakedServerUrl({
        url: (p: string) => p,
        fetch: async () => {
          throw new Error('no such file');
        },
      }),
    ).toBe('');
  });

  it('is empty when the file is malformed or holds an address it would refuse', async () => {
    expect(await bakedServerUrl(source({}))).toBe('');
    expect(await bakedServerUrl(source({ baseUrl: 'not a url' }))).toBe('');
    expect(await bakedServerUrl(source({ baseUrl: 'http://example.com' }))).toBe('');
  });

  it('is empty when the fetch hangs, treating the timeout the same as any other failure (issue #79)', async () => {
    // A value the design already decided to do without on any ordinary failure (empty file,
    // malformed body, refused address) should not be waited on forever when the read itself
    // never returns, so a hang reads as this same empty-string outcome rather than as a popup
    // that cannot become usable until it does.
    vi.useFakeTimers();
    try {
      const hung = {
        url: (p: string) => p,
        fetch: () => new Promise<{ ok: boolean; json(): Promise<unknown> }>(() => {}),
      };
      const result = bakedServerUrl(hung);
      await vi.advanceTimersByTimeAsync(BAKED_CONFIG_TIMEOUT_MS);
      expect(await result).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('loadSettings with a baked address', () => {
  it('pre-fills the address on first run', async () => {
    const { storage } = memoryStorage();
    expect(await loadSettings(storage, 'https://jobs.example.com')).toEqual({
      serverUrl: 'https://jobs.example.com',
      token: '',
    });
  });

  it('leaves a saved address alone', async () => {
    const { storage } = memoryStorage({ serverUrl: 'https://saved.example.com', token: '' });
    expect((await loadSettings(storage, 'https://jobs.example.com')).serverUrl).toBe(
      'https://saved.example.com',
    );
  });

  it('does not store the baked address until the user saves', async () => {
    const { data, storage } = memoryStorage();
    await loadSettings(storage, 'https://jobs.example.com');
    expect(data.serverUrl).toBeUndefined();
  });
});
