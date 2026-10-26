import { defineConfig } from 'vite';

// One self-contained ESM file for node: @opportun/core's mail helpers are bundled in, node
// built-ins stay imports, so the installed CLI needs nothing but node.
export default defineConfig({
  build: {
    ssr: 'src/index.ts',
    outDir: 'dist',
    target: 'node22',
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: 'opportun-connector.js',
        banner: '#!/usr/bin/env node',
      },
    },
  },
  ssr: { noExternal: true, target: 'node' },
});
