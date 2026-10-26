// The pure half of the SQLite-to-Postgres copy tool (iteration 4 Task 14): the table plan
// (column kinds, primary keys, FK-safe order), the value normalization both engines' rows go
// through, and the per-table checksum. Engine-free, so it runs on both legs; the copy itself
// is exercised end to end on the Postgres leg (copyToPg.test.ts).
import { describe, expect, it } from 'vitest';
import {
  CopyDataError,
  TableDigest,
  canonicalJson,
  copyOrder,
  fromPg,
  fromSqlite,
  parentsFirst,
  sealedEnvelopes,
  tableSpecs,
  type SanitizeCounter,
} from '../src/db/copyPlan';
import { TABLE_EXPORTS } from '../src/db/schema.shared';

const noSanitize = (): SanitizeCounter => ({ count: 0 });
const at = { table: 't', column: 'c', rowKey: 'r1' };

describe('copy plan', () => {
  it('covers every schema table with its primary key and column kinds', () => {
    const specs = tableSpecs();
    expect(specs).toHaveLength(TABLE_EXPORTS.length);
    const byName = new Map(specs.map((s) => [s.name, s]));
    expect(byName.get('sync_state')?.pk).toEqual(['user_id', 'integration']);
    expect(byName.get('profiles')?.pk).toEqual(['user_id']);
    expect(byName.get('settings')?.pk).toEqual(['key']);
    const users = byName.get('users');
    const kind = (name: string) => users?.columns.find((c) => c.name === name)?.kind;
    expect(kind('is_admin')).toBe('bool');
    expect(kind('totp_recovery')).toBe('json');
    expect(kind('created_at')).toBe('int');
    expect(kind('email')).toBe('text');
    const runs = byName.get('task_runs');
    expect(runs?.columns.find((c) => c.name === 'est_cost')?.kind).toBe('real');
    expect(byName.get('prompts')?.selfRefs).toEqual([{ column: 'parent_id', references: 'id' }]);
    expect(byName.get('resumes')?.selfRefs).toEqual([
      { column: 'parent_resume_id', references: 'id' },
    ]);
  });

  it('orders tables so every parent precedes its children (pinned)', () => {
    const order = copyOrder(tableSpecs()).map((s) => s.name);
    expect(order).toEqual([
      'users',
      'sessions',
      'device_tokens',
      'oauth_accounts',
      'secrets',
      'audit_log',
      'prompts',
      'profiles',
      'role_targets',
      'resume_rules',
      'companies',
      'opportunities',
      'opportunity_dedupe_candidates',
      'stage_history',
      'activities',
      'next_steps',
      'attachments',
      'resumes',
      'tailoring_sessions',
      'resume_match_reports',
      'discovery_sources',
      'discovery_runs',
      'mail_filter_rules',
      'task_runs',
      'contacts',
      // discovery_results moved below communications when it gained source_communication_id
      // (design D3b): a lead names the message it was parsed out of, so the message copies first.
      'communications',
      'discovery_results',
      'dismissal_feedback',
      'sync_state',
      'jobs',
      'settings',
    ]);
    const position = new Map(order.map((n, i) => [n, i]));
    for (const spec of tableSpecs()) {
      for (const parent of spec.parents) {
        expect(position.get(parent)).toBeLessThan(position.get(spec.name) ?? -1);
      }
    }
  });

  it('refuses a dependency cycle between tables', () => {
    const a = { name: 'a', columns: [], pk: ['id'], parents: ['b'], selfRefs: [] };
    const b = { name: 'b', columns: [], pk: ['id'], parents: ['a'], selfRefs: [] };
    expect(() => copyOrder([a, b])).toThrow(/cycle.*a.*b|cycle.*b.*a/);
  });

  it('orders self-referencing rows parents first and refuses a cycle', () => {
    const rows = [
      { id: 'c', parent: 'b' },
      { id: 'b', parent: 'a' },
      { id: 'a', parent: null },
      { id: 'd', parent: null },
    ];
    const ordered = parentsFirst(rows, (r) => r.id, [(r) => r.parent]).map((r) => r.id);
    expect(ordered.indexOf('a')).toBeLessThan(ordered.indexOf('b'));
    expect(ordered.indexOf('b')).toBeLessThan(ordered.indexOf('c'));
    expect(ordered).toHaveLength(4);
    const loop = [
      { id: 'x', parent: 'y' },
      { id: 'y', parent: 'x' },
    ];
    expect(() => parentsFirst(loop, (r) => r.id, [(r) => r.parent])).toThrow(CopyDataError);
  });
});

describe('value normalization', () => {
  it('maps SQLite booleans, integers and reals to the values Postgres stores', () => {
    expect(fromSqlite('bool', 1n, at, noSanitize())).toEqual({ cell: 'B1', param: true });
    expect(fromSqlite('bool', 0n, at, noSanitize())).toEqual({ cell: 'B0', param: false });
    expect(fromSqlite('int', 1792195200017n, at, noSanitize())).toEqual({
      cell: 'I1792195200017',
      param: 1792195200017,
    });
    expect(fromSqlite('real', 0.25, at, noSanitize()).cell).toBe('R0.25');
    expect(fromSqlite('real', 3n, at, noSanitize()).cell).toBe('R3');
    expect(fromSqlite('text', null, at, noSanitize())).toEqual({ cell: 'N', param: null });
    // The same values as node-postgres returns them (int8 parsed to number, bool native).
    expect(fromPg('bool', true)).toBe('B1');
    expect(fromPg('int', 1792195200017)).toBe('I1792195200017');
    expect(fromPg('real', 0.25)).toBe('R0.25');
    expect(fromPg('real', 3)).toBe('R3');
  });

  it('refuses values Postgres would store differently, naming the row', () => {
    expect(() => fromSqlite('bool', 2n, at, noSanitize())).toThrow(/t\.c.*r1/);
    expect(() => fromSqlite('int', 2n ** 60n, at, noSanitize())).toThrow(/safe integer/);
    expect(() => fromSqlite('int', 1.5, at, noSanitize())).toThrow(CopyDataError);
    expect(() => fromSqlite('text', 42n, at, noSanitize())).toThrow(/text.*integer/);
    expect(() => fromSqlite('text', Buffer.from('x'), at, noSanitize())).toThrow(/blob/);
    expect(() => fromSqlite('json', '{not json', at, noSanitize())).toThrow(
      /t\.c of row r1: invalid JSON/,
    );
  });

  it('compares JSON by decoded value: key order and spacing do not matter, types do', () => {
    const src = fromSqlite('json', '{"b":1,"a":[true,null,"x"]}', at, noSanitize());
    expect(src.cell).toBe(fromPg('json', '{"a": [true, null, "x"], "b": 1}'));
    // A JSON string "123" is not the number 123 (the Wave 2 double-parse trap).
    const str = fromSqlite('json', '"123"', at, noSanitize());
    const num = fromSqlite('json', '123', at, noSanitize());
    expect(str.cell).not.toBe(num.cell);
    expect(str.param).toBe('"123"');
    expect(fromPg('json', '"123"')).toBe(str.cell);
    // SQL NULL and JSON null stay distinct, and JSON null is written as jsonb null.
    const jsonNull = fromSqlite('json', 'null', at, noSanitize());
    expect(jsonNull.cell).not.toBe('N');
    expect(jsonNull.param).toBe('null');
    expect(fromPg('json', 'null')).toBe(jsonNull.cell);
    expect(fromPg('json', null)).toBe('N');
  });

  it('passes the source JSON text through, so numbers keep their precision', () => {
    const big = fromSqlite('json', '{"n":12345678901234567891}', at, noSanitize());
    expect(big.param).toBe('{"n":12345678901234567891}');
  });

  it('removes NUL characters and lone surrogates through cleanText and counts them', () => {
    const counter = noSanitize();
    const text = fromSqlite('text', 'a\u0000b', at, counter);
    expect(text.param).toBe('ab');
    expect(counter.count).toBe(1);
    const json = fromSqlite('json', '{"k\\u0000":"v\\u0000","n":["\\ud800x"]}', at, counter);
    expect(JSON.parse(json.param as string)).toEqual({ k: 'v', n: ['x'] });
    expect(json.reencoded).toBe(true);
    expect(fromSqlite('json', '{"a":1}', at, counter).reencoded).toBeUndefined();
    expect(counter.count).toBe(2);
    expect(json.cell).toBe(fromPg('json', '{"k": "v", "n": ["x"]}'));
    const clean = fromSqlite('text', 'emoji 🎉 ok', at, counter);
    expect(clean.param).toBe('emoji 🎉 ok');
    expect(counter.count).toBe(2);
  });

  it('canonical JSON sorts keys at every depth', () => {
    expect(canonicalJson({ b: { d: 1, c: [{ f: 1, e: 2 }] }, a: null })).toBe(
      '{"a":null,"b":{"c":[{"e":2,"f":1}],"d":1}}',
    );
  });
});

describe('table checksum', () => {
  const rows = [
    { key: '["Tb"]', line: '["Tb","I2"]' },
    { key: '["Ta"]', line: '["Ta","I1"]' },
  ];

  it('is independent of row order and changes with any cell', () => {
    const one = new TableDigest('t');
    const two = new TableDigest('t');
    for (const r of rows) one.add(r.key, r.line);
    for (const r of [...rows].reverse()) two.add(r.key, r.line);
    expect(one.finish()).toEqual(two.finish());
    expect(one.finish().rows).toBe(2);
    const changed = new TableDigest('t');
    changed.add('["Ta"]', '["Ta","I1"]');
    changed.add('["Tb"]', '["Tb","I3"]');
    expect(changed.finish().checksum).not.toBe(one.finish().checksum);
  });

  it('refuses a duplicate primary key', () => {
    const d = new TableDigest('t');
    d.add('["Ta"]', '["Ta"]');
    expect(() => d.add('["Ta"]', '["Ta"]')).toThrow(/duplicate primary key/);
  });
});

describe('sealed envelopes', () => {
  it('finds vault envelopes in text and inside JSON values', () => {
    const env = { ciphertext: 'Y2lwaGVy', iv: 'aXY=', tag: 'dGFn', keyVersion: 1 };
    expect(sealedEnvelopes(JSON.stringify(env))).toEqual([{ path: '$', sealed: env }]);
    expect(
      sealedEnvelopes({ clientId: 'x', sealedSecret: JSON.stringify(env), nested: [env] }),
    ).toEqual([
      { path: '$.sealedSecret', sealed: env },
      { path: '$.nested[0]', sealed: env },
    ]);
    expect(sealedEnvelopes('plain text')).toEqual([]);
  });

  it('refuses rather than ignores a value that names ciphertext but is not an envelope (#148)', () => {
    // Valid JSON, wrong shape (ciphertext is a number): this used to silently come back as
    // "no envelope here", which is exactly the shrug #148 is about.
    expect(() => sealedEnvelopes('{"ciphertext":1}')).toThrow(/not a sealed envelope/);
    // Not valid JSON at all, the more direct case corruption would actually produce.
    expect(() => sealedEnvelopes('{"ciphertext":"trunc')).toThrow(/not valid JSON/);
    // The same failure, nested inside a JSON value rather than at the top.
    expect(() => sealedEnvelopes({ sealedSecret: '{"ciphertext":"trunc' })).toThrow(
      /not valid JSON/,
    );
  });
});
