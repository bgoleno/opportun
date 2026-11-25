// Environment settings are read in config.ts only (https://github.com/bgoleno/opportun/issues/773):
// a direct process.env read anywhere else in apps/server/src fails lint, in any of its spellings.
// The reads that are not settings (an entry point handing the environment to config's loaders, a
// child process's environment, test-run detection) carry their own eslint-disable-next-line with
// the reason, line by line, so a new read in those same files still fails. Run through the
// repository's real eslint.config.js, as logLintRules.test.ts does.
import { describe, expect, it } from 'vitest';
import { serverLint } from './serverLint';

const { rules } = await serverLint(['no-restricted-properties', 'no-restricted-imports']);

// Real source paths, as the config's blocks pick by path. The text linted is the fixture's, never the
// file's own.
const LIB = 'apps/server/src/lib/errors.ts';
const CONFIG = 'apps/server/src/config.ts';
// A file that keeps exempt reads of its own, each on its own disabled line.
const EXEMPT_FILE = 'apps/server/src/app.ts';

describe('environment reads (#773)', () => {
  it('refuse process.env outside config.ts', async () => {
    expect(await rules('export const x = process.env.FOO;\n', LIB)).toContain(
      'no-restricted-properties',
    );
  });

  it('refuse a destructured env from process', async () => {
    expect(await rules('const { env } = process;\nexport const x = env.FOO;\n', LIB)).toContain(
      'no-restricted-properties',
    );
  });

  it("refuse env imported from 'node:process' or 'process'", async () => {
    expect(
      await rules("import { env } from 'node:process';\nexport const x = env.FOO;\n", LIB),
    ).toContain('no-restricted-imports');
    expect(
      await rules("import { env } from 'process';\nexport const x = env.FOO;\n", LIB),
    ).toContain('no-restricted-imports');
  });

  it('still refuse the filesystem in the same block (NFR-SEC11)', async () => {
    expect(
      await rules("import { readFileSync } from 'node:fs';\nvoid readFileSync;\n", LIB),
    ).toContain('no-restricted-imports');
  });

  it('allow them in config.ts', async () => {
    expect(await rules('export const x = process.env.FOO;\n', CONFIG)).not.toContain(
      'no-restricted-properties',
    );
  });

  it('refuse a new read in a file that keeps exempt ones: exemptions are per line', async () => {
    expect(await rules('export const x = process.env.FOO;\n', EXEMPT_FILE)).toContain(
      'no-restricted-properties',
    );
  });
});
