import { defineConfig, type Plugin } from 'vite';
import pkg from './package.json' with { type: 'json' };
import { hashContents, resolveCommit } from './src/buildStamp.ts';
import { buildManifest, type BrowserTarget, type BuildStamp } from './src/manifest.ts';

// Resolved once per `vite build` process (chrome and firefox each run as their own
// invocation of this config, per the `build` script in package.json).
const commit = resolveCommit();
const builtAt = new Date().toISOString();

/** Emits manifest.json for the target browser next to the bundled popup. */
function manifest(target: BrowserTarget): Plugin {
  return {
    name: 'opportun-extension-manifest',
    generateBundle(_options, bundle) {
      // Hashes this build's own output, not source: a dirty tree or an extra local commit
      // changes the bytes, so the hash tracks what's actually running rather than a label
      // that could lag it (#79: the question that mattered was "does this match current
      // source", answered here without needing git at all).
      const files = new Map<string, Uint8Array | string>();
      for (const [fileName, output] of Object.entries(bundle)) {
        files.set(fileName, output.type === 'chunk' ? output.code : output.source);
      }
      const stamp: BuildStamp = { contentHash: hashContents(files), commit, builtAt };
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(buildManifest(target, pkg.version, stamp), null, 2)}\n`,
      });
    },
  };
}

// `vite build --mode chrome` and `--mode firefox` (the build script runs both). Everything
// the extension runs is bundled from this package: no remote code, no CDN, no inline script.
export default defineConfig(({ mode }) => {
  const target: BrowserTarget = mode === 'firefox' ? 'firefox' : 'chrome';
  return {
    base: './',
    plugins: [manifest(target)],
    build: {
      outDir: `dist/${target}`,
      emptyOutDir: true,
      // Unminified and without source maps: small enough to read, and what a store or a
      // user reviewing the unpacked extension sees is the code itself.
      minify: false,
      sourcemap: false,
      modulePreload: { polyfill: false },
      rollupOptions: { input: 'popup.html' },
    },
    test: {
      include: ['test/**/*.test.ts'],
    },
  };
});
