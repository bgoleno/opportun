// https://github.com/bgoleno/opportun/issues/587: an eslint-plugin-security rule whose warnings
// have all been triaged is an error, so a new hit fails `pnpm verify`. Like
// no-arbitrary-width.test.ts, this runs the repo's real eslint.config.js, so it also fails if a
// later block turns a rule back to a warning, or off, for one package. It lives in apps/web
// because a test outside every workspace package is run by no `pnpm test`. lintText takes each
// fixture path only to pick the config blocks that apply to it.
import { ESLint, type Linter } from 'eslint';
import security from 'eslint-plugin-security';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// import.meta.dirname, not new URL('..', import.meta.url): under jsdom, URL is jsdom's.
const repoRoot = resolve(import.meta.dirname, '../../../..');
const eslint = new ESLint({ cwd: repoRoot });

/** Each eslint-plugin-security rule that is an error so far, with a fixture that hits it. */
const ERROR_RULES = [
  [
    'security/detect-possible-timing-attacks',
    'export function same(password: string, given: string): boolean {\n  if (password === given) return true;\n  return false;\n}\n',
  ],
  [
    'security/detect-unsafe-regex',
    'export const repeated = (text: string): boolean => /^(a+)+$/.test(text);\n',
  ],
  [
    'security/detect-non-literal-fs-filename',
    "import { readFileSync } from 'node:fs';\nexport const read = (p: string): string => readFileSync(p, 'utf8');\n",
  ],
  [
    'security/detect-non-literal-regexp',
    'export const match = (p: string, s: string): boolean => new RegExp(p).test(s);\n',
  ],
  [
    'security/detect-object-injection',
    'export function put(o: Record<string, unknown>, key: string, v: unknown): void {\n  o[key] = v;\n}\n',
  ],
] as const;

// One source file per package, and a server test file, which has config blocks of its own. The
// server's files are type-checked (projectService), which parses only files its tsconfig holds, so
// those two fixtures take the path of a real file: the fixture's text is linted in its place, and
// the file on disk is not changed.
const PATHS = [
  'apps/server/src/app.ts',
  'apps/server/test/helpers.ts',
  'apps/web/src/lint-fixture.ts',
  'apps/connector/src/lint-fixture.ts',
  'packages/core/src/lint-fixture.ts',
  'packages/ai/src/lint-fixture.ts',
  'packages/extension/src/lint-fixture.ts',
];

async function severityOf(rule: string, code: string, path: string): Promise<number | undefined> {
  const [result] = await eslint.lintText(code, { filePath: join(repoRoot, path) });
  // A fixture that fails to parse reports nothing, which would read as "the rule stayed silent".
  const fatal = result?.messages.find((m) => m.fatal);
  if (fatal) throw new Error(`fixture did not parse at ${path}: ${fatal.message}`);
  return result?.messages.find((m) => m.ruleId === rule)?.severity;
}

/**
 * Rules eslint.config.js turns off for test files, on purpose (#587): tests build fixtures in
 * per-test temporary folders, and index their own fixture and schema objects by keys they define.
 * Everywhere else they are errors.
 */
const OFF_IN_TESTS: ReadonlySet<string> = new Set([
  'security/detect-non-literal-fs-filename',
  'security/detect-object-injection',
]);
const isTestPath = (path: string) => path.includes('/test/') || /\.test\.tsx?$/.test(path);

describe('triaged eslint-plugin-security rules are errors (#587)', () => {
  for (const [rule, code] of ERROR_RULES) {
    it.each(PATHS)(`${rule} is enforced as configured in %s`, async (path) => {
      const expected = OFF_IN_TESTS.has(rule) && isTestPath(path) ? undefined : 2;
      expect(await severityOf(rule, code, path)).toBe(expected);
    });
  }
});

const SEVERITY: Readonly<Record<string, number>> = { off: 0, warn: 1, error: 2 };
function severityIn(entry: Linter.RuleEntry | undefined): number | undefined {
  const level = Array.isArray(entry) ? entry[0] : entry;
  return typeof level === 'string' ? SEVERITY[level] : level;
}

// The fixtures above pin the rules one at a time. This pins the whole plugin: every rule its
// recommended config turns on resolves to an error for every package (or off on a test path, for
// OFF_IN_TESTS), so a rule a plugin upgrade adds to `recommended` as a warning fails here until it
// is triaged, instead of joining a pile of warnings nobody reads.
describe('every eslint-plugin-security recommended rule is an error (#587)', () => {
  const recommended = Object.keys(security.configs.recommended.rules ?? {});

  it('the recommended config has rules to check', () => {
    expect(recommended.length).toBeGreaterThan(0);
  });

  it.each(PATHS)('in %s', async (path) => {
    const config = (await eslint.calculateConfigForFile(join(repoRoot, path))) as Linter.Config;
    const got = Object.fromEntries(recommended.map((r) => [r, severityIn(config.rules?.[r])]));
    const want = Object.fromEntries(
      recommended.map((r) => [r, OFF_IN_TESTS.has(r) && isTestPath(path) ? 0 : 2]),
    );
    expect(got).toEqual(want);
  });
});
