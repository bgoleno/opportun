import { join, resolve } from 'node:path';
import { ESLint } from 'eslint';

const repoRoot = resolve(import.meta.dirname, '../../..');

/**
 * The repository's real eslint.config.js over a fixture at a server path, for the tests of its own
 * rules. Two things are left out, so that no test's time bounds what is slow and a busy host cannot
 * fail one (https://github.com/bgoleno/opportun/issues/1040, measured in #1039):
 * - the type information its server block asks for (for no-floating-promises), several seconds to
 *   build for the first file linted. None of the rules tested reads it, so a rule given here must not;
 * - every rule but `ruleIds`, as one that does read it fails without.
 * Which rules are on, for which files, at which level and with which options is the config's own.
 *
 * Awaited as the test file is loaded, which Vitest does not bound: the config and its plugins, about a
 * second, are loaded here.
 */
export async function serverLint(ruleIds: readonly string[]) {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
    ruleFilter: ({ ruleId }) => ruleIds.includes(ruleId),
  });
  await eslint.calculateConfigForFile(join(repoRoot, 'apps/server/src/app.ts'));
  return {
    /** The rules that report the code, linted as the file at `path` (the file itself is not read). */
    async rules(code: string, path: string): Promise<string[]> {
      const [result] = await eslint.lintText(code, { filePath: join(repoRoot, path) });
      const fatal = result?.messages.find((m) => m.fatal);
      if (fatal) throw new Error(`fixture did not parse: ${fatal.message}`);
      return (result?.messages ?? []).map((m) => m.ruleId ?? '');
    },
    /** What the config resolves to for the file at `path`. */
    configFor: (path: string) => eslint.calculateConfigForFile(join(repoRoot, path)),
  };
}
