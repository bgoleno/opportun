// The catalog and the gate (design.md 14.4, 14.8, NFR-PRV6;
// https://github.com/bgoleno/opportun/issues/353). Every key has a type from 14.8's table, the
// base has no Gen AI entry, and the gate keeps only listed keys with values of their type: no
// personal data fits any of them.
import { afterEach, describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_TYPES,
  ATTRIBUTES,
  type AttrType,
  EVENTS,
  fixedServiceHosts,
  isLocalOnly,
  METRICS,
  OTHER,
  SPANS,
} from '../src/obs/catalog';
import {
  checkValue,
  gateAttributes,
  setUnknownKeyMode,
  UnknownTelemetryKeyError,
} from '../src/obs/gate';
import { ATS_ALLOW_HOSTS } from '../src/lib/safeFetch';

afterEach(() => setUnknownKeyMode('throw'));

const TYPES = ['enum', 'enum_list', 'int', 'number', 'bool', 'id', 'code', 'model', 'route', 'ip'];

/**
 * client.address holds the request's address for the local access log (sec's O7 on #352): an
 * IP is its whole point, so it is the one key the personal-datum checks below leave out. It is
 * local only, whatever any flag says.
 */
const IP_KEY = 'client.address';

/** Known personal data, the kind NFR-PRV6 names, in the shapes a careless call might pass. */
const PERSONAL = [
  'Jane Doe',
  'jane.doe@example.com',
  '+1 (206) 555-0142',
  'https://example.com/jobs/123?email=jane.doe@example.com',
  "SELECT * FROM users WHERE email = 'jane.doe@example.com'",
  'Error: could not reach jane.doe@example.com',
  '10.1.2.3',
  'fe80::1',
  'Acme Corp',
];

describe('the catalog (#353)', () => {
  it('gives every attribute a type from the design table', () => {
    for (const [key, type] of Object.entries(ATTRIBUTES)) {
      expect(TYPES, key).toContain(type.kind);
    }
  });

  it('lists only catalogued keys on every metric, span and event', () => {
    const keys = new Set(Object.keys(ATTRIBUTES));
    const used = [
      ...Object.values(METRICS).flatMap((m) => m.attributes),
      ...Object.values(SPANS).flatMap((s) => s.attributes),
      ...Object.values(EVENTS).flatMap((e) => e.fields),
    ];
    for (const k of used) expect(keys.has(k), k).toBe(true);
  });

  it('has no Gen AI entry: FR-T4 part 2 adds them', () => {
    const names = [
      ...Object.keys(METRICS),
      ...Object.keys(SPANS),
      ...Object.keys(EVENTS),
      ...Object.keys(ATTRIBUTES),
    ];
    expect(names.filter((n) => n.startsWith('gen_ai.') || n.includes('.gen_ai.'))).toEqual([]);
  });

  it('holds the five instance metrics of 14.4, with bucket boundaries for each histogram', () => {
    expect(Object.keys(METRICS).sort()).toEqual([
      'db.client.operation.duration',
      'http.client.request.duration',
      'http.server.request.duration',
      'opportun.job.duration',
      'opportun.obs.dropped',
    ]);
    for (const [name, m] of Object.entries(METRICS)) {
      expect(m.scope, name).toBe('instance');
      if (m.instrument === 'histogram') {
        const b = 'buckets' in m ? m.buckets : [];
        expect(b.length, name).toBeGreaterThan(0);
        expect(
          [...b].sort((x, y) => x - y),
          name,
        ).toEqual([...b]);
      }
    }
    expect(Object.keys(EVENTS)).toEqual(['error']);
  });

  it('keeps every id key local unless the catalog marks it exportable (14.8)', () => {
    expect(isLocalOnly('user.id')).toBe(true);
    expect(isLocalOnly('http.route')).toBe(false);
    for (const [key, type] of Object.entries(ATTRIBUTES)) {
      if (type.kind !== 'id') continue;
      const exportable = 'exportable' in type && type.exportable === true;
      expect(isLocalOnly(key as keyof typeof ATTRIBUTES), key).toBe(!exportable);
    }
  });

  it('has client.address as its only ip key, local only and never exportable', () => {
    const ipKeys = Object.entries(ATTRIBUTES)
      .filter(([, type]) => type.kind === 'ip')
      .map(([key]) => key);
    expect(ipKeys).toEqual([IP_KEY]);
    expect(isLocalOnly(IP_KEY)).toBe(true);
    const ip = ATTRIBUTE_TYPES.get(IP_KEY) ?? { kind: 'bool' };
    expect(checkValue(ip, '10.1.2.3')).toBe('10.1.2.3');
    expect(checkValue(ip, 'fe80::1')).toBe('fe80::1');
    expect(checkValue(ip, 'jane.doe@example.com')).toBeUndefined();
    expect(checkValue(ip, '10.1.2.3:443')).toBeUndefined();
  });

  it('gives every code and model key its source (14.8)', () => {
    for (const [key, type] of Object.entries(ATTRIBUTES) as [string, AttrType][]) {
      if (type.kind !== 'code' && type.kind !== 'model') continue;
      const source = 'source' in type ? type.source : '';
      expect(source.trim().length, key).toBeGreaterThan(0);
    }
  });

  it('server.address takes exact hosts from a literal list, never a pattern', () => {
    // 14.8 at b8dcc27: ATS_ALLOW_HOSTS, the AI providers' fixed API hosts, and Google's.
    expect([...fixedServiceHosts()].sort()).toEqual(
      [
        ...ATS_ALLOW_HOSTS,
        'api.anthropic.com',
        'api.openai.com',
        'accounts.google.com',
        'oauth2.googleapis.com',
        'openidconnect.googleapis.com',
        'www.googleapis.com',
        'gmail.googleapis.com',
        // @googleapis/docs calls docs.googleapis.com (lib/google.ts).
        'docs.googleapis.com',
      ].sort(),
    );
    for (const h of fixedServiceHosts()) expect(h, h).toMatch(/^[a-z0-9.-]+$/);
    const type = ATTRIBUTES['server.address'];
    expect(checkValue(type, 'api.openai.com')).toBe('api.openai.com');
    expect(checkValue(type, 'apply.workable.com')).toBe('apply.workable.com');
    // A tenant's own host names its company (a Workday board): target only.
    expect(checkValue(type, 'acme.myworkdayjobs.com')).toBeUndefined();
    expect(checkValue(type, 'gateway.internal.example')).toBeUndefined();
  });
});

describe('checkValue (#353)', () => {
  it('accepts each type only in its shape', () => {
    expect(checkValue({ kind: 'int' }, 3)).toBe(3);
    expect(checkValue({ kind: 'int' }, 3.5)).toBeUndefined();
    expect(checkValue({ kind: 'number' }, Number.NaN)).toBeUndefined();
    expect(checkValue({ kind: 'bool' }, 'true')).toBeUndefined();
    expect(checkValue({ kind: 'id' }, '0193f3c2-7b1a-7c3e-9a2b-1c2d3e4f5a6b')).toBeTruthy();
    expect(checkValue({ kind: 'id' }, '0af7651916cd43dd8448eb211c80319c')).toBeTruthy();
    expect(checkValue({ kind: 'id' }, 'b7ad6b7169203331')).toBeTruthy();
    expect(checkValue({ kind: 'id' }, 'jane')).toBeUndefined();
    expect(checkValue({ kind: 'code', source: 'test' }, 'ECONNREFUSED')).toBe('ECONNREFUSED');
    expect(checkValue({ kind: 'code', source: 'test' }, 'x'.repeat(65))).toBeUndefined();
    expect(checkValue({ kind: 'enum', values: ['a'] }, 'b')).toBeUndefined();
    expect(checkValue({ kind: 'enum_list', values: ['a', 'b'] }, ['a', 'b'])).toEqual(['a', 'b']);
    expect(checkValue({ kind: 'enum_list', values: ['a'] }, ['a', 'c'])).toBeUndefined();
  });

  it('a model id keeps its shape; anything else, a path among them, becomes OTHER', () => {
    const model = { kind: 'model', source: 'test' } as const;
    expect(checkValue(model, 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(checkValue(model, 'meta-llama/llama-4:70b')).toBe('meta-llama/llama-4:70b');
    expect(checkValue(model, '/models/llama.gguf')).toBe(OTHER);
    expect(checkValue(model, 'a/b/c')).toBe(OTHER);
    expect(checkValue(model, 'x'.repeat(129))).toBe(OTHER);
    expect(checkValue(model, 'jane.doe@example.com')).toBe(OTHER);
    expect(checkValue(model, 42)).toBeUndefined();
  });

  it('a route is a template shape, never free text', () => {
    const route = { kind: 'route' } as const;
    expect(checkValue(route, '/api/v1/opportunities/:id')).toBe('/api/v1/opportunities/:id');
    expect(checkValue(route, OTHER)).toBe(OTHER);
    expect(checkValue(route, '/api/v1/search?q=jane')).toBeUndefined();
    expect(checkValue(route, 'GET /x')).toBeUndefined();
  });

  it('no personal datum fits any type but model, where it becomes OTHER', () => {
    for (const [key, type] of Object.entries(ATTRIBUTES)) {
      if (key === IP_KEY) continue;
      for (const p of PERSONAL) {
        const out = checkValue(type, p);
        expect(out === undefined || out === OTHER, `${key} took ${p}`).toBe(true);
      }
    }
  });
});

describe('gateAttributes (#353)', () => {
  const drops: string[] = [];
  const count = (signal: string, reason: string) => drops.push(`${signal}:${reason}`);

  it('keeps listed keys with valid values, and drops and counts the rest', () => {
    drops.length = 0;
    setUnknownKeyMode('drop');
    const out = gateAttributes(
      'metrics',
      ['http.request.method', 'http.response.status_code'],
      {
        'http.request.method': 'GET',
        'http.response.status_code': 'two hundred',
        'user.email': 'jane.doe@example.com',
        'http.route': '/api/v1/x',
      },
      count,
    );
    expect(out).toEqual({ 'http.request.method': 'GET' });
    // A wrong value, an unknown key, and a catalogued key this record does not list.
    expect(drops.sort()).toEqual([
      'metrics:invalid_value',
      'metrics:unknown_key',
      'metrics:unknown_key',
    ]);
  });

  it('throws on an unknown key under the test runner, so a missed catalog entry fails CI', () => {
    expect(() =>
      gateAttributes('logs', ['error.type'], { message: 'boom' }, () => undefined),
    ).toThrow(UnknownTelemetryKeyError);
  });

  it('with production behaviour, no personal datum passes, under any key', () => {
    setUnknownKeyMode('drop');
    // client.address included: an `ip` key is log only, so a span drops it (sec's O9 on #352).
    const keys = Object.keys(ATTRIBUTES) as (keyof typeof ATTRIBUTES)[];
    for (const p of PERSONAL) {
      const attrs: Record<string, unknown> = {
        note: p,
        message: p,
        url: p,
        ...Object.fromEntries(keys.map((k) => [k, p])),
      };
      const out = gateAttributes('spans', keys, attrs, () => undefined);
      const text = JSON.stringify(out);
      expect(text, p).not.toContain(p);
      expect(
        Object.values(out).every((v) => v === OTHER),
        p,
      ).toBe(true);
    }
  });
});

describe('client.address is log only (#353, sec O9 on #352)', () => {
  const ADDRESS = '203.0.113.7';
  const allowed = [IP_KEY, 'http.request.method'] as const;
  const attrs = { [IP_KEY]: ADDRESS, 'http.request.method': 'GET' };

  it('a span, a metric point and an event lose it, even when their entry lists it', () => {
    for (const signal of ['spans', 'metrics', 'logs'] as const) {
      const drops: string[] = [];
      // Test mode throws on an unknown key; a catalogued key outside the log is not one.
      const out = gateAttributes(signal, allowed, attrs, (sig, reason) =>
        drops.push(`${sig}:${reason}`),
      );
      expect(out, signal).toEqual({ 'http.request.method': 'GET' });
      expect(drops, signal).toEqual([`${signal}:unknown_key`]);
    }
  });

  it('only the local log destination keeps it', () => {
    const out = gateAttributes('logs', allowed, attrs, () => undefined, { localLog: true });
    expect(out).toEqual({ [IP_KEY]: ADDRESS, 'http.request.method': 'GET' });
    // The flag keeps nothing else: a wrong value is still dropped.
    const bad = gateAttributes(
      'logs',
      allowed,
      { [IP_KEY]: 'jane.doe@example.com' },
      () => undefined,
      {
        localLog: true,
      },
    );
    expect(bad).toEqual({});
  });
});
