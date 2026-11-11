// The two log lint rules (design.md 14.9; https://github.com/bgoleno/opportun/issues/345): no
// console.* in apps/server/src or packages/ai/src, and no interpolated text in a log message. Run
// through the repository's real eslint.config.js, as apps/web's no-arbitrary-width test does, so
// they also fail if a rule is unwired, aimed at the wrong files, or replaced by a later block (the
// trap the config's own comments describe for no-restricted-syntax, #305).
import { join, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const eslint = new ESLint({ cwd: repoRoot });

async function rules(code: string, path: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(repoRoot, path) });
  const fatal = result?.messages.find((m) => m.fatal);
  if (fatal) throw new Error(`fixture did not parse: ${fatal.message}`);
  return (result?.messages ?? []).map((m) => m.ruleId ?? '');
}

// Real source paths: the server's lint is type-aware, so a fixture must be a file its project
// knows. The text linted is the fixture's, never the file's own.
const SERVER = 'apps/server/src/obs/log.ts';
const CLIENT = 'apps/server/src/db/client.ts';
const AI = 'packages/ai/src/telemetry.ts';

describe('the log lint rules (#345)', () => {
  it('refuse console.* in the server and in the AI package', async () => {
    expect(await rules("console.error('x');\n", SERVER)).toContain('no-console');
    expect(await rules("console.warn('x');\n", AI)).toContain('no-console');
  });

  it('refuse a log message built from data, by template or by concatenation', async () => {
    const log = 'declare const log: { warn(o: unknown, m?: string): void };\n';
    const id = 'declare const id: string;\n';
    expect(await rules(`${log}${id}log.warn({}, \`failed for \${id}\`);\n`, SERVER)).toContain(
      'no-restricted-syntax',
    );
    expect(await rules(`${log}${id}log.warn({}, 'failed for ' + id);\n`, SERVER)).toContain(
      'no-restricted-syntax',
    );
    // db/client.ts has a no-restricted-syntax block of its own: the rule is in it too.
    expect(await rules(`${log}${id}log.warn(\`failed for \${id}\`);\n`, CLIENT)).toContain(
      'no-restricted-syntax',
    );
  });

  it('let a fixed message with its data in keys through, and leave the other bans in place', async () => {
    const log = 'declare const log: { warn(o: unknown, m?: string): void };\n';
    expect(
      await rules(
        `${log}log.warn({ 'opportun.company.id': 'x' }, 'ats detection failed');\n`,
        SERVER,
      ),
    ).not.toContain('no-restricted-syntax');
    // The raw SQL ban still fires in the same file: the log ban was added to the block, not
    // put in one that replaces it.
    expect(
      await rules(
        "import { sql } from 'drizzle-orm';\ndeclare const db: { run(q: unknown): unknown };\nvoid db.run(sql`SELECT 1`);\n",
        SERVER,
      ),
    ).toContain('no-restricted-syntax');
  });
});
