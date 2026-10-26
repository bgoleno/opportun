/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.OPPORTUN_API_URL ?? 'http://localhost:8080';
// Tests import route modules directly; regenerating the route tree there is noise.
const isTest = process.env.VITEST !== undefined;

export default defineConfig({
  plugins: [
    // Must run before the React plugin so generated route code is transformed too.
    !isTest &&
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
        routeFileIgnorePattern: '\\.test\\.tsx?$',
        quoteStyle: 'single',
        semicolons: true,
      }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
      '/healthz': { target: API_TARGET, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
    // Issue #72: vitest's 5_000 ms default was too tight once the full suite runs in parallel.
    // Several unrelated files (dashboard, devices, purgeCard, oauthProviders) timed out
    // transiently under full-suite contention across separate runs, each passing cleanly in
    // isolation and together, just not alongside everything else — worker-pool contention
    // eating into an already-tight default, not a slow or broken test. Same remedy #56 already
    // applied server-side (apps/server/vitest.config.ts): more real headroom, not a smaller
    // suite.
    testTimeout: 15_000,
  },
});
