// With export off, the exporter packages are not loaded (design.md 14.3;
// https://github.com/bgoleno/opportun/issues/342). obs/export/otlp.ts is the one module that
// imports @opentelemetry/sdk-metrics, @opentelemetry/otlp-transformer and @opentelemetry/resources
// as values, and the manager loads it, and influx.ts, by dynamic import() the first time export is
// built. So no server source may import those packages as values elsewhere, and none may import
// otlp.ts or influx.ts statically. `import type` is erased by TypeScript and loads nothing.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', 'src');
const EXPORT_PACKAGES = /from '@opentelemetry\/(?:sdk-metrics|otlp-transformer|resources)'/;
const LAZY_MODULES = /from '[./]+(?:obs\/)?(?:export\/)?(?:otlp|influx)'/;

async function sources(): Promise<{ rel: string; values: string }[]> {
  const out: { rel: string; values: string }[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (p.endsWith('.ts')) {
        const text = await readFile(p, 'utf8');
        // Type-only imports load nothing at run time.
        out.push({ rel: p.slice(ROOT.length), values: text.replace(/import type [^;]*;/g, '') });
      }
    }
  };
  await walk(ROOT);
  return out;
}

describe('the exporter packages load only when export is built (14.3)', () => {
  it('only obs/export/otlp.ts imports them as values', async () => {
    const offenders = (await sources())
      .filter((f) => EXPORT_PACKAGES.test(f.values))
      .map((f) => f.rel);
    expect(offenders).toEqual(['/obs/export/otlp.ts']);
  });

  it('nothing imports otlp.ts or influx.ts statically: the manager uses import()', async () => {
    const offenders = (await sources())
      .filter((f) => LAZY_MODULES.test(f.values))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
    const manager = (await sources()).find((f) => f.rel === '/obs/export/manager.ts');
    expect(manager?.values).toContain("await import('./otlp')");
    expect(manager?.values).toContain("await import('./influx')");
  });
});
