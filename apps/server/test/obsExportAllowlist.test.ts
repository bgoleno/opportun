// The one export allowlist (design.md 14.8; https://github.com/bgoleno/opportun/issues/342, the
// shared export helper criterion: https://github.com/bgoleno/opportun/issues/342#issuecomment-6785861324).
// Every exported metric point, span and log record passes it, whatever reached the slot: only
// catalogued keys (and, when the record names its entry, only that entry's keys), each with a
// value of its type; no local-only key (user.id, every id not marked exportable, client.address);
// a model only when the price table lists it, else _OTHER. What it removes is counted.
import { describe, expect, it, vi } from 'vitest';
import { OTHER } from '../src/obs/catalog';
import { exportAttributes, exportModel, exportSpanName } from '../src/obs/export/allowlist';

const USER = '01a1c881-cef3-7b31-86a2-501450372158';

describe('exportAttributes', () => {
  it('keeps a catalogued key with a value of its type', () => {
    const dropped = vi.fn();
    expect(
      exportAttributes(
        'metrics',
        { 'http.route': '/api/v1/opportunities/:id', 'http.response.status_code': 200 },
        undefined,
        dropped,
      ),
    ).toEqual({ 'http.route': '/api/v1/opportunities/:id', 'http.response.status_code': 200 });
    expect(dropped).not.toHaveBeenCalled();
  });

  it('removes a key the catalog does not list, and counts it as unknown_key', () => {
    const dropped = vi.fn();
    expect(
      exportAttributes(
        'spans',
        { 'http.route': '/x', 'enduser.email': 'a@b.c' },
        undefined,
        dropped,
      ),
    ).toEqual({ 'http.route': '/x' });
    expect(dropped).toHaveBeenCalledWith('spans', 'unknown_key');
  });

  it("removes a catalogued key that is not on the record's own list", () => {
    const dropped = vi.fn();
    expect(
      exportAttributes(
        'metrics',
        { 'db.system.name': 'sqlite', 'http.route': '/x' },
        ['db.system.name'],
        dropped,
      ),
    ).toEqual({ 'db.system.name': 'sqlite' });
    expect(dropped).toHaveBeenCalledWith('metrics', 'unknown_key');
  });

  it('removes a value of the wrong type, and counts it as invalid_value', () => {
    const dropped = vi.fn();
    expect(
      exportAttributes(
        'logs',
        { 'http.route': '/api/v1/opportunities/0f1e2d3c-aaaa-bbbb-cccc-000000000000' },
        undefined,
        dropped,
      ),
    ).toEqual({});
    expect(dropped).toHaveBeenCalledWith('logs', 'invalid_value');
  });

  it('removes every local-only key without counting it: export identifies no user', () => {
    const dropped = vi.fn();
    expect(
      exportAttributes(
        'logs',
        { 'user.id': USER, 'client.address': '203.0.113.9', 'error.type': 'TypeError' },
        undefined,
        dropped,
      ),
    ).toEqual({ 'error.type': 'TypeError' });
    expect(dropped).not.toHaveBeenCalled();
  });

  it('never throws, whatever it is given', () => {
    const odd = { __proto__: null, constructor: 'x', toString: 1 } as unknown as Record<
      string,
      unknown
    >;
    expect(() => exportAttributes('spans', odd, undefined, () => undefined)).not.toThrow();
  });
});

describe('a model leaves only when the price table lists it (14.8)', () => {
  // The base catalog has no model key yet (FR-T4 part 2 adds them), so the rule is exercised
  // directly; exportAttributes applies it to every key whose type is `model`.
  it('a priced model stays; any other model becomes _OTHER', () => {
    expect(exportModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(exportModel('my-private-finetune')).toBe(OTHER);
    expect(exportModel(OTHER)).toBe(OTHER);
  });

  it("a span's name drops an unpriced model the same way", () => {
    expect(exportSpanName('chat my-private-finetune')).toBe(`chat ${OTHER}`);
    expect(exportSpanName('chat claude-sonnet-5-5')).toBe('chat claude-sonnet-5-5');
    expect(exportSpanName('GET')).toBe('GET');
    expect(exportSpanName('job obs.prune')).toBe('job obs.prune');
  });
});
