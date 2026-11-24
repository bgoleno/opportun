// What the popup's bundle is made of, read from the real build (https://github.com/bgoleno/opportun/issues/769).
// The extension reads the capture sites from @opportun/core through a subpath that has no
// dependency of its own, so zod and the rest of core never reach the browser extension. A new
// module from core, or any package, shows in review as a change to this list.
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '../..');

it.each(['chrome', 'firefox'])(
  'the %s bundle takes only named files from outside the extension, and no package',
  async (mode) => {
    const result = await build({
      root: ROOT,
      configFile: resolve(ROOT, 'vite.config.ts'),
      mode,
      logLevel: 'silent',
      build: { write: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) =>
      'output' in r ? r.output : [],
    );
    const modules = outputs
      .flatMap((o) => (o.type === 'chunk' ? o.moduleIds : []))
      .filter((id) => !id.startsWith('\0'))
      .map((id) => relative(REPO, id.split('?')[0] ?? id));
    expect(modules).toContain('packages/extension/src/popup.ts');
    expect(modules.filter((m) => m.includes('node_modules'))).toEqual([]);
    expect(modules.filter((m) => !m.startsWith('packages/extension/')).sort()).toEqual([
      'packages/core/src/linkedinMarkers.ts',
      'packages/core/src/sites/capture.ts',
      'packages/core/src/sites/indeed.ts',
      'packages/core/src/sites/linkedin.ts',
      'packages/core/src/sites/types.ts',
    ]);
  },
  30_000,
);
