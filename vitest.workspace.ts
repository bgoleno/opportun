import { defineConfig } from 'vitest/config';

// Root multi-project config. Each package also runs its own tests via `pnpm -r test`.
// Vitest 4+ no longer auto-discovers workspace files, so run this one explicitly:
//   pnpm exec vitest run --config vitest.workspace.ts
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
