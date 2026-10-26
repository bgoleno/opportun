// SSRF-safe fetch (NFR-SEC6, design 6.3). DNS and the HTTPS transport are injected, so every
// rule is exercised without the network: scheme, host allowlist, private ranges (literal and
// resolved, on every redirect hop), redirect limit, size cap, timeout and the per-host bucket.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ATS_ALLOW_HOSTS,
  createSafeFetch,
  OFFICIAL_API_URLS,
  FetchBlockedError,
  isPrivateAddress,
  safeFetch,
  type FetchTarget,
  type RawResponse,
  type SafeFetchDeps,
} from '../src/lib/safeFetch';

const PUBLIC_IP = '93.184.216.34';

function body(...chunks: string[]): AsyncIterable<Buffer> {
  return (async function* () {
    for (const c of chunks) yield Buffer.from(c);
  })();
}

function ok(text = 'hello', headers: Record<string, string> = {}): RawResponse {
  return { status: 200, headers, body: body(text) };
}

interface Harness extends SafeFetchDeps {
  requests: FetchTarget[];
  sleeps: number[];
}

/** Deps with a DNS table and a scripted transport (one response per call, in order). */
function harness(
  dnsTable: Record<string, string[]>,
  responses: (RawResponse | ((t: FetchTarget, signal: AbortSignal) => Promise<RawResponse>))[],
): Harness {
  const dns = new Map(Object.entries(dnsTable));
  const h: Harness = {
    requests: [],
    sleeps: [],
    now: () => 0,
    sleep: async (ms) => {
      h.sleeps.push(ms);
    },
    resolve: async (host) => {
      const ips = dns.get(host);
      if (ips === undefined) throw new Error(`no dns entry for ${host}`);
      return ips;
    },
    request: async (target, signal) => {
      h.requests.push(target);
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected request');
      return typeof next === 'function' ? next(target, signal) : next;
    },
  };
  return h;
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof FetchBlockedError) return err.reason;
    throw err;
  }
  throw new Error('expected a FetchBlockedError');
}

const ALLOW = { allowHosts: ['jobs.example.com', 'example.org'] };

describe('safeFetch', () => {
  it('fetches an allowed https host, pinned to the address it checked', async () => {
    const h = harness({ 'jobs.example.com': [PUBLIC_IP] }, [ok('posting', { 'x-a': '1' })]);
    const res = await createSafeFetch(h)('https://jobs.example.com/p/1', ALLOW);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('posting');
    expect(res.headers.get('x-a')).toBe('1');
    expect(h.requests).toEqual([
      { url: new URL('https://jobs.example.com/p/1'), address: PUBLIC_IP },
    ]);
  });

  it('blocks http:// and other schemes before any lookup', async () => {
    const h = harness({}, []);
    const fetch = createSafeFetch(h);
    expect(await reason(fetch('http://jobs.example.com/', ALLOW))).toBe('scheme');
    expect(await reason(fetch('file:///etc/passwd', ALLOW))).toBe('scheme');
    expect(await reason(fetch('not a url', ALLOW))).toBe('scheme');
    expect(await reason(fetch('https://user:pw@jobs.example.com/', ALLOW))).toBe('scheme');
    expect(h.requests).toEqual([]);
  });

  it('blocks hosts outside the allowlist; subdomains of an entry are allowed', async () => {
    const h = harness({ 'careers.example.org': [PUBLIC_IP] }, [ok()]);
    const fetch = createSafeFetch(h);
    expect(await reason(fetch('https://evil.example.net/', ALLOW))).toBe('host_not_allowed');
    expect(await reason(fetch('https://notexample.org/', ALLOW))).toBe('host_not_allowed');
    expect((await fetch('https://careers.example.org/', ALLOW)).status).toBe(200);
  });

  it('never fetches linkedin.com, even when a caller allowlists it', async () => {
    const h = harness({ 'www.linkedin.com': [PUBLIC_IP] }, [ok()]);
    const opts = { allowHosts: ['linkedin.com', 'www.linkedin.com'] };
    expect(await reason(createSafeFetch(h)('https://www.linkedin.com/jobs/1', opts))).toBe(
      'host_not_allowed',
    );
    expect(h.requests).toEqual([]);
  });

  it('blocks https://127.0.0.1 and other literal private addresses', async () => {
    const h = harness({}, []);
    const fetch = createSafeFetch(h);
    const allowIps = { allowHosts: ['127.0.0.1', '10.1.2.3', '[::1]', '169.254.169.254'] };
    expect(await reason(fetch('https://127.0.0.1/', allowIps))).toBe('private_address');
    expect(await reason(fetch('https://10.1.2.3/', allowIps))).toBe('private_address');
    expect(await reason(fetch('https://[::1]/', allowIps))).toBe('private_address');
    expect(await reason(fetch('https://169.254.169.254/latest/', allowIps))).toBe(
      'private_address',
    );
    expect(h.requests).toEqual([]);
  });

  it('blocks a hostname that resolves to 10.x (any private answer blocks)', async () => {
    const h = harness({ 'jobs.example.com': [PUBLIC_IP, '10.0.0.7'] }, []);
    expect(await reason(createSafeFetch(h)('https://jobs.example.com/', ALLOW))).toBe(
      'private_address',
    );
    expect(h.requests).toEqual([]);
  });

  it('blocks a hostname that resolves to a 6to4 address wrapping 127.0.0.1', async () => {
    const h = harness({ 'jobs.example.com': ['2002:7f00:1::1'] }, []);
    expect(await reason(createSafeFetch(h)('https://jobs.example.com/', ALLOW))).toBe(
      'private_address',
    );
    expect(h.requests).toEqual([]);
  });

  it('re-checks every redirect hop: a redirect to a private address is blocked', async () => {
    const h = harness(
      { 'jobs.example.com': [PUBLIC_IP], 'internal.example.org': ['192.168.1.10'] },
      [{ status: 302, headers: { location: 'https://internal.example.org/admin' }, body: body() }],
    );
    expect(await reason(createSafeFetch(h)('https://jobs.example.com/', ALLOW))).toBe(
      'private_address',
    );
    expect(h.requests).toHaveLength(1);
  });

  it('re-checks scheme and host on redirects too', async () => {
    const toHttp = harness({ 'jobs.example.com': [PUBLIC_IP] }, [
      { status: 301, headers: { location: 'http://jobs.example.com/' }, body: body() },
    ]);
    expect(await reason(createSafeFetch(toHttp)('https://jobs.example.com/', ALLOW))).toBe(
      'scheme',
    );
    const offList = harness({ 'jobs.example.com': [PUBLIC_IP] }, [
      { status: 307, headers: { location: 'https://elsewhere.example.net/' }, body: body() },
    ]);
    expect(await reason(createSafeFetch(offList)('https://jobs.example.com/', ALLOW))).toBe(
      'host_not_allowed',
    );
  });

  it('follows up to 3 redirects (relative ones included) and blocks the 4th', async () => {
    const hop = (to: string): RawResponse => ({
      status: 302,
      headers: { location: to },
      body: body(),
    });
    const dns = { 'jobs.example.com': [PUBLIC_IP] };
    const three = harness(dns, [hop('/a'), hop('/b'), hop('/c'), ok('done')]);
    const res = await createSafeFetch(three)('https://jobs.example.com/', ALLOW);
    expect(res.body.toString()).toBe('done');
    expect(three.requests.map((r) => r.url.pathname)).toEqual(['/', '/a', '/b', '/c']);

    const four = harness(dns, [hop('/a'), hop('/b'), hop('/c'), hop('/d')]);
    expect(await reason(createSafeFetch(four)('https://jobs.example.com/', ALLOW))).toBe(
      'redirect_blocked',
    );
    const noLocation = harness(dns, [{ status: 302, headers: {}, body: body() }]);
    expect(await reason(createSafeFetch(noLocation)('https://jobs.example.com/', ALLOW))).toBe(
      'redirect_blocked',
    );
  });

  it('enforces the size cap from content-length and while streaming', async () => {
    const dns = { 'jobs.example.com': [PUBLIC_IP] };
    const declared = harness(dns, [ok('x', { 'content-length': '6000000' })]);
    expect(await reason(createSafeFetch(declared)('https://jobs.example.com/', ALLOW))).toBe(
      'too_large',
    );
    const streamed = harness(dns, [{ status: 200, headers: {}, body: body('12345', '67890') }]);
    expect(
      await reason(
        createSafeFetch(streamed)('https://jobs.example.com/', { ...ALLOW, maxBytes: 8 }),
      ),
    ).toBe('too_large');
    const exact = harness(dns, [{ status: 200, headers: {}, body: body('1234', '5678') }]);
    const res = await createSafeFetch(exact)('https://jobs.example.com/', {
      ...ALLOW,
      maxBytes: 8,
    });
    expect(res.body.toString()).toBe('12345678');
  });

  it('times out a slow response and aborts the transport', async () => {
    let aborted = false;
    const h = harness({ 'jobs.example.com': [PUBLIC_IP] }, [
      (_t, signal) =>
        new Promise<RawResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    ]);
    expect(
      await reason(createSafeFetch(h)('https://jobs.example.com/', { ...ALLOW, timeoutMs: 20 })),
    ).toBe('timeout');
    expect(aborted).toBe(true);
  });

  it('sends a form POST with its body, and refuses any redirect of a request with a body', async () => {
    const post = { contentType: 'application/x-www-form-urlencoded', body: 'a=1&b=2' };
    const h = harness({ 'jobs.example.com': [PUBLIC_IP] }, [ok('{}')]);
    const res = await createSafeFetch(h)('https://jobs.example.com/token', { ...ALLOW, post });
    expect(res.status).toBe(200);
    expect(h.requests).toEqual([
      { url: new URL('https://jobs.example.com/token'), address: PUBLIC_IP, post },
    ]);

    const redirect: RawResponse = {
      status: 307,
      headers: { location: 'https://example.org/elsewhere' },
      body: body(''),
    };
    const r = harness({ 'jobs.example.com': [PUBLIC_IP], 'example.org': [PUBLIC_IP] }, [redirect]);
    expect(
      await reason(createSafeFetch(r)('https://jobs.example.com/token', { ...ALLOW, post })),
    ).toBe('redirect_blocked');
    expect(r.requests).toHaveLength(1);
  });

  it('sends a JSON PATCH with its body and refuses to redirect it', async () => {
    const post = { contentType: 'application/json', body: '{"a":1}', method: 'PATCH' as const };
    const h = harness({ 'jobs.example.com': [PUBLIC_IP] }, [ok('{}')]);
    await createSafeFetch(h)('https://jobs.example.com/r/1', { ...ALLOW, post });
    expect(h.requests).toEqual([
      { url: new URL('https://jobs.example.com/r/1'), address: PUBLIC_IP, post },
    ]);
    const redirect: RawResponse = {
      status: 308,
      headers: { location: 'https://jobs.example.com/r/2' },
      body: body(''),
    };
    const r = harness({ 'jobs.example.com': [PUBLIC_IP] }, [redirect]);
    expect(
      await reason(createSafeFetch(r)('https://jobs.example.com/r/1', { ...ALLOW, post })),
    ).toBe('redirect_blocked');
  });

  it('sends caller headers, and never follows any redirect of a request that carries them', async () => {
    const headers = { 'x-api-key': 'k-secret' };
    const h = harness({ 'jobs.example.com': [PUBLIC_IP] }, [ok()]);
    await createSafeFetch(h)('https://jobs.example.com/first', { ...ALLOW, headers });
    expect(h.requests.map((t) => t.headers)).toEqual([headers]);

    // A subdomain matches the allowlist and a port change keeps the host: both would still
    // hand over the key if credentialed redirects were followed. None is.
    for (const location of [
      'https://evil.jobs.example.com/steal',
      'https://jobs.example.com:9999/steal',
      'https://jobs.example.com/same-origin',
      'https://attacker.example.net/steal',
    ]) {
      const hop: RawResponse = { status: 302, headers: { location }, body: body('') };
      const r = harness(
        {
          'jobs.example.com': [PUBLIC_IP],
          'evil.jobs.example.com': [PUBLIC_IP],
          'attacker.example.net': [PUBLIC_IP],
        },
        [hop, ok()],
      );
      expect(
        await reason(createSafeFetch(r)('https://jobs.example.com/first', { ...ALLOW, headers })),
        location,
      ).toBe('redirect_blocked');
      expect(r.requests, location).toHaveLength(1);
    }
  });

  it('refuses caller headers together with allowPublic (a credential could follow a redirect anywhere)', async () => {
    const h = harness({ 'jobs.example.com': [PUBLIC_IP] }, [ok()]);
    await expect(
      createSafeFetch(h)('https://jobs.example.com/', {
        allowHosts: [],
        allowPublic: true,
        headers: { 'x-api-key': 'k' },
      }),
    ).rejects.toThrow(/allowPublic/);
    expect(h.requests).toHaveLength(0);
  });

  it('rate limits each host to 1 request per second (token bucket)', async () => {
    let clock = 0;
    const h = harness({ 'jobs.example.com': [PUBLIC_IP], 'example.org': [PUBLIC_IP] }, [
      ok(),
      ok(),
      ok(),
    ]);
    h.now = () => clock;
    h.sleep = async (ms) => {
      h.sleeps.push(ms);
      clock += ms;
    };
    const fetch = createSafeFetch(h);
    await fetch('https://jobs.example.com/1', ALLOW);
    clock += 250;
    await fetch('https://jobs.example.com/2', ALLOW);
    // A different host has its own bucket.
    await fetch('https://example.org/', ALLOW);
    expect(h.sleeps).toEqual([750]);
  });
});

describe('safeFetch allowPublic mode (user-entered URLs)', () => {
  const PUBLIC = { allowHosts: [] as string[], allowPublic: true };

  it('fetches any public https host without an allowlist entry', async () => {
    const h = harness({ 'careers.initech.example': [PUBLIC_IP] }, [ok('careers')]);
    const res = await createSafeFetch(h)('https://careers.initech.example/jobs', PUBLIC);
    expect(res.body.toString()).toBe('careers');
  });

  it('still refuses prohibited hosts (linkedin.com, trailing-dot form included)', async () => {
    const h = harness({ 'www.linkedin.com': [PUBLIC_IP], 'linkedin.com': [PUBLIC_IP] }, []);
    const fetch = createSafeFetch(h);
    expect(await reason(fetch('https://www.linkedin.com/company/x', PUBLIC))).toBe(
      'host_not_allowed',
    );
    expect(await reason(fetch('https://www.linkedin.com./company/x', PUBLIC))).toBe(
      'host_not_allowed',
    );
    expect(await reason(fetch('https://lnkd.in/abc', PUBLIC))).toBe('host_not_allowed');
    expect(h.requests).toEqual([]);
  });

  it('still blocks http, private names and literals, and redirects into private space', async () => {
    const h = harness(
      {
        'intranet.example': ['10.0.0.8'],
        'careers.initech.example': [PUBLIC_IP],
        'admin.initech.example': ['192.168.1.1'],
      },
      [{ status: 302, headers: { location: 'https://admin.initech.example/' }, body: body() }],
    );
    const fetch = createSafeFetch(h);
    expect(await reason(fetch('http://careers.initech.example/', PUBLIC))).toBe('scheme');
    expect(await reason(fetch('https://intranet.example/', PUBLIC))).toBe('private_address');
    expect(await reason(fetch('https://10.1.2.3/', PUBLIC))).toBe('private_address');
    expect(await reason(fetch('https://careers.initech.example/', PUBLIC))).toBe('private_address');
    expect(h.requests.map((r) => r.url.hostname)).toEqual(['careers.initech.example']);
  });

  it('a redirect from a public page to linkedin.com is refused', async () => {
    const h = harness({ 'careers.initech.example': [PUBLIC_IP] }, [
      { status: 301, headers: { location: 'https://www.linkedin.com/company/x' }, body: body() },
    ]);
    expect(await reason(createSafeFetch(h)('https://careers.initech.example/', PUBLIC))).toBe(
      'host_not_allowed',
    );
    expect(h.requests).toHaveLength(1);
  });
});

describe('isPrivateAddress', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2002:7f00:1::',
    '2002:a00:1::1',
    '::7f00:1',
    '::127.0.0.1',
    '::10.0.0.1',
    '::ffff:0:127.0.0.1',
    'not-an-ip',
  ])('%s is private (or not a usable public address)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '172.32.0.1',
    '2606:4700::1111',
    '2003::1',
    '::ffff:93.184.216.34',
  ])('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('the real transport', () => {
  it('resolves through DNS and blocks localhost without connecting', async () => {
    expect(await reason(safeFetch('https://localhost/', { allowHosts: ['localhost'] }))).toBe(
      'private_address',
    );
  });
});

describe('safeFetch officialApiUrl (C-1 official-API carve-out)', () => {
  const TOKEN = 'https://www.' + 'linkedin.com/oauth/v2/accessToken';
  const DNS = { ['www.' + 'linkedin.com']: [PUBLIC_IP] };
  const POST = { contentType: 'application/x-www-form-urlencoded', body: 'code=x' };
  const opts = (extra: Record<string, unknown> = {}) => ({
    allowHosts: [new URL(TOKEN).hostname],
    officialApiUrl: TOKEN,
    post: POST,
    ...extra,
  });

  it('lets exactly the named URL through a prohibited host', async () => {
    const h = harness(DNS, [ok('{}')]);
    expect((await createSafeFetch(h)(TOKEN, opts())).status).toBe(200);
    expect(h.requests.map((r) => r.url.href)).toEqual([TOKEN]);
  });

  it('refuses any other URL on that host, even with the allowance passed', async () => {
    const h = harness(DNS, []);
    const fetch = createSafeFetch(h);
    for (const other of [
      'https://www.' + 'linkedin.com/in/someone',
      'https://www.' + 'linkedin.com/oauth/v2/accessToken/x',
      TOKEN + '?next=/feed',
      TOKEN + '#frag',
      'https://www.' + 'linkedin.com/OAUTH/v2/accessToken',
    ]) {
      expect(await reason(fetch(other, opts())), other).toBe('host_not_allowed');
    }
    expect(h.requests).toEqual([]);
  });

  it('still requires the host on the allowlist', async () => {
    const h = harness(DNS, []);
    expect(await reason(createSafeFetch(h)(TOKEN, opts({ allowHosts: ['example.org'] })))).toBe(
      'host_not_allowed',
    );
  });

  it('is only for requests that never follow a redirect (a body or caller headers)', async () => {
    const h = harness(DNS, []);
    const bare = { allowHosts: [new URL(TOKEN).hostname], officialApiUrl: TOKEN };
    await expect(createSafeFetch(h)(TOKEN, bare)).rejects.toThrow(/officialApiUrl/);
    const redirect = harness(DNS, [
      { status: 302, headers: { location: 'https://www.' + 'linkedin.com/feed' }, body: body() },
    ]);
    expect(await reason(createSafeFetch(redirect)(TOKEN, opts()))).toBe('redirect_blocked');
  });

  it('refuses any officialApiUrl that safeFetch itself does not list', async () => {
    const h = harness({ ...DNS, 'example.org': [PUBLIC_IP], 'api.linkedin.com': [PUBLIC_IP] }, []);
    const fetch = createSafeFetch(h);
    for (const url of [
      'https://www.' + 'linkedin.com/in/someone',
      'https://api.' + 'linkedin.com/v2/me',
      'https://example.org/api',
    ]) {
      await expect(
        fetch(url, { allowHosts: [new URL(url).hostname], officialApiUrl: url, post: POST }),
        url,
      ).rejects.toThrow(/officialApiUrl/);
    }
    expect(h.requests).toEqual([]);
  });

  it('refuses a malformed allowance and never applies it to allowPublic', async () => {
    const h = harness(DNS, []);
    await expect(
      createSafeFetch(h)(TOKEN, opts({ officialApiUrl: TOKEN + '?a=1' })),
    ).rejects.toThrow(/officialApiUrl/);
    await expect(
      createSafeFetch(h)(TOKEN, { ...opts(), allowHosts: [], allowPublic: true }),
    ).rejects.toThrow(/officialApiUrl/);
    expect(h.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Compliance boundary (design 6.2): linkedin.com is never an allowed fetch target.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SOURCE_DIRS = ['apps/server/src', 'packages/ai/src', 'packages/core/src'];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('allowlists and linkedin.com (grep)', () => {
  it('no allowlist constant anywhere in the server or packages names linkedin', async () => {
    const files = (await Promise.all(SOURCE_DIRS.map((d) => sourceFiles(join(ROOT, d))))).flat();
    // Labeled with the file for a readable failure message, but the file's own absolute path
    // (ROOT plus wherever this checkout happens to live, e.g. a worktree directory someone
    // named after the thing being searched for) must never be part of what the linkedin check
    // below searches: that is the haystack the assertion is supposed to be independent of.
    const allowlists: string[] = [];
    const allowlistContents: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      // Every `..._ALLOW_HOSTS = [...]` / `allowHosts: [...]` literal, up to its closing bracket.
      const pattern = /(?:[A-Z_]*ALLOW_?HOSTS[^=\n]*=\s*\[|allowHosts\s*:\s*\[)([^\]]*)\]/g;
      for (const m of text.matchAll(pattern)) {
        allowlists.push(`${file}: ${m[1]}`);
        allowlistContents.push(m[1] ?? '');
      }
    }
    // The scan must see the real allowlist, or it proves nothing.
    expect(allowlists.some((l) => l.includes('safeFetch.ts') && l.includes('greenhouse'))).toBe(
      true,
    );
    for (const content of allowlistContents)
      expect(content.toLowerCase()).not.toContain('linkedin');
    expect(ATS_ALLOW_HOSTS.some((h) => h.toLowerCase().includes('linkedin'))).toBe(false);
  });

  it('linkedin.com appears only in safeFetch.ts: the prohibited hosts and the official APIs', async () => {
    const files = await sourceFiles(join(ROOT, 'apps/server/src'));
    const hits: string[] = [];
    const mailOnly: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (!/linkedin\.com/i.test(line)) return;
        const where = `${file}:${i + 1}: ${line.trim()}`;
        // A mail address (the job alert sender, Task 12) names the domain without being a
        // fetch target: every occurrence must sit right after '@' in a quoted string.
        const asAddress = line.replace(/'[a-z0-9._-]+@linkedin\.com'/gi, '');
        if (!/linkedin\.com/i.test(asAddress)) mailOnly.push(where);
        else hits.push(where);
      });
    }
    // Exactly three lines, all in safeFetch.ts: PROHIBITED_HOSTS and the two official-API
    // endpoints of the C-1 carve-out (OAuth sign-in), and nothing else on the domain.
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => /\/lib\/safeFetch\.ts:\d+: /.test(h))).toBe(true);
    expect(hits.filter((h) => /PROHIBITED_HOSTS/.test(h))).toHaveLength(1);
    const urls = hits.flatMap((h) =>
      [...h.matchAll(/'(https:\/\/[^']*linkedin\.com[^']*)'/gi)].map((m) => m[1]),
    );
    expect(urls.sort()).toEqual([
      'https://api.linkedin.com/v2/userinfo',
      'https://www.linkedin.com/oauth/v2/accessToken',
    ]);
    expect(Object.values(OFFICIAL_API_URLS).sort()).toEqual(urls);
    // Exactly one mail address literal: the LinkedIn alert sender.
    expect(mailOnly).toHaveLength(1);
    expect(mailOnly[0]).toMatch(
      /lib\/alertParsers\/linkedin\.ts:\d+: export const LINKEDIN_ALERT_SENDER = 'jobalerts-noreply@linkedin\.com';$/,
    );
  });

  it('only safeFetch.ts and the oauth registry mention officialApiUrl', async () => {
    const files = (await Promise.all(SOURCE_DIRS.map((d) => sourceFiles(join(ROOT, d))))).flat();
    const users: string[] = [];
    for (const file of files) {
      if ((await readFile(file, 'utf8')).includes('officialApiUrl')) users.push(file);
    }
    expect(users.map((f) => f.slice(ROOT.length)).sort()).toEqual([
      'apps/server/src/lib/oauthProviders.ts',
      'apps/server/src/lib/safeFetch.ts',
    ]);
  });
});
