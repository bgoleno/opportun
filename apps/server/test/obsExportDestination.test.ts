// Where export may send (design.md 14.10 rules 2, 3 and 5, NFR-PRV7;
// https://github.com/bgoleno/opportun/issues/342 criterion 5 as tl amended it). The server builds
// the URL from the fields; https to a public address by default; loopback, private and shared
// address space only under OPPORTUN_TELEMETRY_ALLOW_PRIVATE=1; link-local, the unspecified and
// reserved ranges and the metadata services never; plain http to a public host never; a mapped
// IPv4 address gets its IPv4 answer.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import {
  checkDestination,
  classifyAddress,
  endpointsFor,
  isAllowedHeaderName,
  LOOKUP_TIMEOUT_MS,
  parseDestination,
  type Destination,
} from '../src/obs/export/destination';

const fixed =
  (...addresses: string[]) =>
  async () =>
    addresses;

function dest(over: Partial<Destination> = {}): Destination {
  return { type: 'otlp', scheme: 'https', host: 'otel.example.com', port: 4318, ...over };
}

describe('classifyAddress (14.10 rule 3)', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['127.0.0.1', 'private'],
    ['127.8.9.10', 'private'],
    ['::1', 'private'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.1.10', 'private'],
    ['fd12:3456::1', 'private'],
    ['fc00::1', 'private'],
    ['100.64.0.1', 'private'],
    ['100.127.255.254', 'private'],
    // Refused flag or not.
    ['169.254.169.254', 'refused'],
    ['169.254.1.1', 'refused'],
    ['fe80::1', 'refused'],
    ['0.0.0.0', 'refused'],
    ['0.1.2.3', 'refused'],
    ['::', 'refused'],
    ['224.0.0.1', 'refused'],
    ['ff02::1', 'refused'],
    ['240.0.0.1', 'refused'],
    ['255.255.255.255', 'refused'],
    ['192.0.2.1', 'refused'],
    ['198.18.0.1', 'refused'],
    ['2001:db8::1', 'refused'],
    // The metadata services inside allowed ranges, by exact address.
    ['100.100.100.200', 'refused'],
    ['fd00:ec2::254', 'refused'],
    // Not an address: fail closed.
    ['not-an-ip', 'refused'],
    ['', 'refused'],
  ])('%s is %s', (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });

  it.each([
    ['::ffff:127.0.0.1', 'private'],
    ['::ffff:7f00:1', 'private'],
    ['::ffff:169.254.169.254', 'refused'],
    ['::ffff:a9fe:a9fe', 'refused'],
    ['::FFFF:100.100.100.200', 'refused'],
    ['::ffff:8.8.8.8', 'public'],
    ['::ffff:808:808', 'public'],
  ])('a mapped IPv4 address gets its IPv4 answer: %s is %s', (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });

  it.each(['fe80::1%en0', 'fe80::1%1', 'fd00:ec2::254%eth0', '::1%lo0'])(
    'an address with a zone id is refused, never thrown on: %s (tl on #377)',
    (ip) => {
      expect(() => classifyAddress(ip)).not.toThrow();
      expect(classifyAddress(ip)).toBe('refused');
    },
  );

  it('just outside each allowed range is not private', () => {
    expect(classifyAddress('172.32.0.1')).toBe('public');
    expect(classifyAddress('100.128.0.1')).toBe('public');
    expect(classifyAddress('11.0.0.1')).toBe('public');
  });
});

describe('checkDestination (14.10 rules 2 and 3)', () => {
  it('a public https destination is accepted and pinned to the checked address', async () => {
    const r = await checkDestination(dest(), { allowPrivate: false, lookup: fixed('8.8.8.8') });
    expect(r).toEqual({ ok: true, address: '8.8.8.8', family: 4 });
  });

  it('plain http to a public host is refused, flag or not', async () => {
    for (const allowPrivate of [false, true]) {
      const r = await checkDestination(dest({ scheme: 'http' }), {
        allowPrivate,
        lookup: fixed('8.8.8.8'),
      });
      expect(r).toEqual({ ok: false, reason: 'plain_http_public' });
    }
  });

  it('a private destination needs the flag; with it, http or https', async () => {
    const lookup = fixed('192.168.1.10');
    expect(await checkDestination(dest(), { allowPrivate: false, lookup })).toEqual({
      ok: false,
      reason: 'private_not_allowed',
    });
    for (const scheme of ['http', 'https'] as const) {
      expect(await checkDestination(dest({ scheme }), { allowPrivate: true, lookup })).toEqual({
        ok: true,
        address: '192.168.1.10',
        family: 4,
      });
    }
  });

  it('every address the name resolves to must pass: one bad answer refuses the name', async () => {
    expect(
      await checkDestination(dest(), {
        allowPrivate: false,
        lookup: fixed('8.8.8.8', '10.0.0.5'),
      }),
    ).toEqual({ ok: false, reason: 'private_not_allowed' });
    expect(
      await checkDestination(dest(), {
        allowPrivate: true,
        lookup: fixed('10.0.0.5', '169.254.169.254'),
      }),
    ).toEqual({ ok: false, reason: 'refused_address' });
    // A public answer beside a private one under the flag, over http: the public one is plain
    // http to a public host.
    expect(
      await checkDestination(dest({ scheme: 'http' }), {
        allowPrivate: true,
        lookup: fixed('10.0.0.5', '8.8.8.8'),
      }),
    ).toEqual({ ok: false, reason: 'plain_http_public' });
  });

  it('link-local and the metadata services are refused even under the flag', async () => {
    for (const ip of ['169.254.169.254', 'fe80::1', '100.100.100.200', 'fd00:ec2::254']) {
      expect(
        await checkDestination(dest({ scheme: 'http', host: ip.includes(':') ? `[${ip}]` : ip }), {
          allowPrivate: true,
          lookup: fixed(ip),
        }),
      ).toEqual({ ok: false, reason: 'refused_address' });
    }
  });

  it('an IP literal is classified itself, with no lookup', async () => {
    const lookup = async () => {
      throw new Error('no lookup for a literal');
    };
    expect(
      await checkDestination(dest({ scheme: 'http', host: '127.0.0.1' }), {
        allowPrivate: true,
        lookup,
      }),
    ).toEqual({ ok: true, address: '127.0.0.1', family: 4 });
    expect(
      await checkDestination(dest({ scheme: 'http', host: '[::1]' }), {
        allowPrivate: true,
        lookup,
      }),
    ).toEqual({ ok: true, address: '::1', family: 6 });
  });

  it('a name that does not resolve, or resolves to nothing, is refused', async () => {
    const fail = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect(await checkDestination(dest(), { allowPrivate: false, lookup: fail })).toEqual({
      ok: false,
      reason: 'unresolvable',
    });
    expect(await checkDestination(dest(), { allowPrivate: false, lookup: fixed() })).toEqual({
      ok: false,
      reason: 'unresolvable',
    });
  });

  it('a lookup that never answers is abandoned as unresolvable, at the timeout (tl on #377)', async () => {
    const never = () => new Promise<string[]>(() => undefined);
    const started = Date.now();
    expect(
      await checkDestination(dest(), { allowPrivate: false, lookup: never, lookupTimeoutMs: 50 }),
    ).toEqual({ ok: false, reason: 'unresolvable' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(LOOKUP_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it('a name that resolves to a scoped link-local address is refused, not an error', async () => {
    expect(
      await checkDestination(dest(), { allowPrivate: true, lookup: fixed('fe80::1%en0') }),
    ).toEqual({ ok: false, reason: 'refused_address' });
  });

  it('a prohibited host is refused before any lookup', async () => {
    expect(
      await checkDestination(dest({ host: 'www.linkedin.com' }), {
        allowPrivate: false,
        lookup: fixed('8.8.8.8'),
      }),
    ).toEqual({ ok: false, reason: 'prohibited_host' });
  });
});

describe('parseDestination: the fields, never a URL (14.10)', () => {
  it.each([
    'otel.example.com/path',
    'user:pw@otel.example.com',
    'otel.example.com:4318',
    'otel.example.com?x=1',
    'otel example.com',
    'http://otel.example.com',
    '-bad.example.com',
    '',
    'a'.repeat(254),
    '[::1',
    '::1',
    // A zone id names an interface, not a host (tl on #377).
    '[fe80::1%en0]',
    '[fe80::1%25en0]',
  ])('refuses the host %j', (host) => {
    expect(parseDestination({ ...dest(), host }).ok).toBe(false);
  });

  it.each(['otel.example.com', 'localhost', '127.0.0.1', '[::1]', '[fd00::5]', 'a-b.c-d.example'])(
    'accepts the host %j',
    (host) => {
      expect(parseDestination({ ...dest(), host }).ok).toBe(true);
    },
  );

  it('the port is 1 to 65535; the scheme http or https', () => {
    for (const port of [0, 65536, 1.5, -1]) {
      expect(parseDestination({ ...dest(), port }).ok).toBe(false);
    }
    expect(parseDestination({ ...dest(), scheme: 'ftp' }).ok).toBe(false);
  });

  it('a base path is absolute segments of safe characters, with no dot segment', () => {
    for (const basePath of ['/', '/otlp', '/a/b-c_d.e']) {
      expect(parseDestination({ ...dest(), basePath }).ok).toBe(true);
    }
    for (const basePath of [
      'otlp',
      '/a?b',
      '/a#b',
      '/a/../b',
      '/a/./b',
      '//evil',
      '/a b',
      '/%2e',
    ]) {
      expect(parseDestination({ ...dest(), basePath }).ok).toBe(false);
    }
  });

  it('InfluxDB needs an organisation and a bucket', () => {
    expect(parseDestination({ ...dest({ type: 'influxdb' }) }).ok).toBe(false);
    expect(
      parseDestination({ ...dest({ type: 'influxdb' }), org: 'home', bucket: 'opportun' }).ok,
    ).toBe(true);
  });
});

describe('endpointsFor: the URL the server builds (14.10)', () => {
  it('OTLP: the three signal paths under the base path', () => {
    expect(endpointsFor(dest({ basePath: '/otlp' }))).toEqual({
      metrics: 'https://otel.example.com:4318/otlp/v1/metrics',
      spans: 'https://otel.example.com:4318/otlp/v1/traces',
      logs: 'https://otel.example.com:4318/otlp/v1/logs',
    });
    expect(endpointsFor(dest()).metrics).toBe('https://otel.example.com:4318/v1/metrics');
  });

  it("Datadog: the Agent's OTLP receiver, all three signals", () => {
    expect(
      endpointsFor(dest({ type: 'datadog', scheme: 'http', host: 'agent', port: 4318 })),
    ).toEqual({
      metrics: 'http://agent:4318/v1/metrics',
      spans: 'http://agent:4318/v1/traces',
      logs: 'http://agent:4318/v1/logs',
    });
  });

  it('Prometheus: metrics only, to its own OTLP receiver', () => {
    expect(endpointsFor(dest({ type: 'prometheus', host: 'prom', port: 9090 }))).toEqual({
      metrics: 'https://prom:9090/api/v1/otlp/v1/metrics',
    });
  });

  it('InfluxDB: metrics only, line protocol to /api/v2/write with the org and bucket encoded', () => {
    expect(
      endpointsFor(
        dest({ type: 'influxdb', host: 'influx', port: 8086, org: 'my org', bucket: 'b&x' }),
      ),
    ).toEqual({
      metrics: 'https://influx:8086/api/v2/write?org=my+org&bucket=b%26x&precision=ms',
    });
  });

  it('an IPv6 literal keeps its brackets', () => {
    expect(endpointsFor(dest({ host: '[fd00::5]' })).metrics).toBe(
      'https://[fd00::5]:4318/v1/metrics',
    );
  });
});

describe('the OTLP header name (14.10 rule 5)', () => {
  it.each(['Authorization', 'X-Api-Key', 'api_key', 'x-honeycomb-team'])('accepts %s', (n) => {
    expect(isAllowedHeaderName(n)).toBe(true);
  });
  it.each([
    'Host',
    'host',
    'Content-Length',
    'transfer-encoding',
    'Connection',
    'Content-Type',
    'X Bad',
    'X:Bad',
    'X\r\nInjected',
    '',
    'é',
  ])('refuses %j', (n) => {
    expect(isAllowedHeaderName(n)).toBe(false);
  });
});

describe('OPPORTUN_TELEMETRY_ALLOW_PRIVATE (config.ts)', () => {
  // As config.test.ts's base: loadConfig reads the environment only, nothing on disk.
  const env = {
    OPPORTUN_MASTER_KEY: randomBytes(32).toString('hex'),
    OPPORTUN_BASE_URL: 'https://opportun.example.com',
    DATA_DIR: '/data',
  };
  it('is off unless set to exactly 1', () => {
    for (const value of [undefined, '', '0', 'true', 'yes', '1 ']) {
      const cfg = loadConfig({ ...env, OPPORTUN_TELEMETRY_ALLOW_PRIVATE: value });
      expect(cfg.telemetryAllowPrivate).toBe(false);
    }
    expect(
      loadConfig({ ...env, OPPORTUN_TELEMETRY_ALLOW_PRIVATE: '1' }).telemetryAllowPrivate,
    ).toBe(true);
  });
});
