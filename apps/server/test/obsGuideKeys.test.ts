// The guide's table of catalogued names stays in step with obs/catalog.ts (design.md 14.12, FR-T2
// "the guide's table of catalogued keys"; https://github.com/bgoleno/opportun/issues/342): one row
// per attribute key, with whether export sends it. A key added to the catalog without a row, or a
// row whose Exported column disagrees with the catalog, fails here.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTES, isLocalOnly, type AttrKey } from '../src/obs/catalog';

const GUIDE = join(__dirname, '..', '..', '..', 'docs', 'guide', 'settings.md');

async function guideRows(): Promise<{ key: string; exported: string }[]> {
  const text = await readFile(GUIDE, 'utf8');
  const start = text.indexOf('<!-- catalog-keys:start -->');
  const end = text.indexOf('<!-- catalog-keys:end -->');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text
    .slice(start, end)
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => {
      const cells = line.split('|').map((c) => c.trim());
      return { key: (cells[1] ?? '').replace(/`/g, ''), exported: cells[3] ?? '' };
    });
}

describe("the guide's table of catalogued names", () => {
  it('has one row per catalog key, in the catalog, with the right Exported column', async () => {
    const rows = await guideRows();
    const expected = Object.keys(ATTRIBUTES).map((key) => ({
      key,
      exported: isLocalOnly(key as AttrKey) ? 'no' : 'yes',
    }));
    expect([...rows].sort((a, b) => a.key.localeCompare(b.key))).toEqual(
      [...expected].sort((a, b) => a.key.localeCompare(b.key)),
    );
  });
});
