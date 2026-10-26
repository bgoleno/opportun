import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashContents, resolveCommit } from '../src/buildStamp';

describe('hashContents', () => {
  it('is deterministic for the same files', () => {
    const files = new Map([
      ['popup.js', 'console.log(1)'],
      ['popup.css', 'body{}'],
    ]);
    expect(hashContents(files)).toBe(hashContents(new Map(files)));
  });

  it('changes when any file content changes', () => {
    const before = hashContents(new Map([['popup.js', 'console.log(1)']]));
    const after = hashContents(new Map([['popup.js', 'console.log(2)']]));
    expect(before).not.toBe(after);
  });

  it('changes when a file is added or removed', () => {
    const one = hashContents(new Map([['popup.js', 'x']]));
    const two = hashContents(
      new Map([
        ['popup.js', 'x'],
        ['popup.css', 'y'],
      ]),
    );
    expect(one).not.toBe(two);
  });

  it('is independent of insertion order', () => {
    const a = hashContents(
      new Map([
        ['a.js', '1'],
        ['b.js', '2'],
      ]),
    );
    const b = hashContents(
      new Map([
        ['b.js', '2'],
        ['a.js', '1'],
      ]),
    );
    expect(a).toBe(b);
  });

  it('accepts bytes as well as strings', () => {
    const str = hashContents(new Map([['a.js', 'hi']]));
    const bytes = hashContents(new Map([['a.js', new TextEncoder().encode('hi')]]));
    expect(str).toBe(bytes);
  });

  it('returns a short hex string', () => {
    expect(hashContents(new Map([['a.js', 'x']]))).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('resolveCommit', () => {
  it('resolves the short HEAD sha from a real checkout', () => {
    expect(resolveCommit(process.cwd())).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('reports undefined rather than throwing when there is no git repo to ask', () => {
    const outside = mkdtempSync(join(tmpdir(), 'opportun-no-git-'));
    try {
      expect(resolveCommit(outside)).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
