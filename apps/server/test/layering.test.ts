// The server's layering (docs/architecture.md 6.2; https://github.com/bgoleno/opportun/issues/765):
// cli/ holds commands an operator runs by hand, which import the runtime; the runtime (routes,
// plugins, jobs, lib, repos) never imports a command. The demo's constants and seed live in
// lib/demo/ so the session plugin, the demo guards and the nightly reset can reach them without
// reaching into cli/.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every module specifier a file imports or re-exports, static or dynamic. */
function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) found.push(m[1]!);
  return found;
}

describe('the runtime never imports from cli/ (#765)', () => {
  it('no module outside src/cli imports a module under src/cli', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel.startsWith('cli/')) continue;
      for (const spec of specifiers(await readFile(file, 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const target = relative(SRC, join(file, '..', spec));
        if (target === 'cli' || target.startsWith('cli/')) offenders.push(`${rel} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the demo constants and seed are in lib/demo, which cli/ imports', async () => {
    const cli = await readFile(join(SRC, 'cli/seedDemo.ts'), 'utf8');
    expect(specifiers(cli)).toContain('../lib/demo/seed');
    for (const runtime of ['lib/demoAccounts.ts', 'lib/demoOwnData.ts', 'plugins/session.ts']) {
      const specs = specifiers(await readFile(join(SRC, runtime), 'utf8'));
      expect(specs.some((s) => s.endsWith('demo/fixture')), runtime).toBe(true);
    }
    const reset = specifiers(await readFile(join(SRC, 'jobs/demoReset.ts'), 'utf8'));
    expect(reset).toContain('../lib/demo/seed');
  });
});
