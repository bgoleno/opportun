// The layer rule (https://github.com/bgoleno/opportun/issues/763; docs/architecture.md 6.2): repos
// and lib import neither jobs/ nor routes/, apart from the job modules eslint.config.js names. Run
// through the repository's real eslint.config.js, as logLintRules.test.ts does, so the rule also
// fails here if it is unwired, aimed at the wrong files, or replaced by a later block, and so the
// NFR-SEC11 filesystem ban is shown to still apply to the same files.
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
const LIB = 'apps/server/src/lib/errors.ts';
const REPO = 'apps/server/src/repos/companies.ts';
const NESTED = 'apps/server/src/lib/alertParsers/linkedin.ts';
const JOB = 'apps/server/src/jobs/backup.ts';
const RULE = '@typescript-eslint/no-restricted-imports';

describe('the layer rule (#763)', () => {
  it('refuses a job module in lib/ and repos/', async () => {
    const code = "import { triageMessage } from '../jobs/mailIngest';\nvoid triageMessage;\n";
    expect(await rules(code, LIB)).toContain(RULE);
    expect(await rules(code, REPO)).toContain(RULE);
  });

  it('refuses a route module, and one a folder deeper', async () => {
    expect(await rules("import { x } from '../routes/capture';\nvoid x;\n", LIB)).toContain(RULE);
    expect(await rules("import { x } from '../../jobs/mailIngest';\nvoid x;\n", NESTED)).toContain(
      RULE,
    );
  });

  it('allows the job modules it names, and a type-only import of any', async () => {
    expect(
      await rules("import { enqueue } from '../jobs/runner';\nvoid enqueue;\n", LIB),
    ).not.toContain(RULE);
    expect(
      await rules(
        "import type { RunStats } from '../jobs/mailIngest';\nexport type X = RunStats;\n",
        LIB,
      ),
    ).not.toContain(RULE);
  });

  it('allows a named job module a folder deeper, and refuses an unnamed one there', async () => {
    const seed = 'apps/server/src/lib/demo/seed.ts';
    expect(
      await rules(
        "import { removeIfUnreferenced } from '../../jobs/attachmentSweep';\nvoid removeIfUnreferenced;\n",
        seed,
      ),
    ).not.toContain(RULE);
    expect(
      await rules(
        "import { triageMessage } from '../../jobs/mailIngest';\nvoid triageMessage;\n",
        seed,
      ),
    ).toContain(RULE);
  });

  it('refuses the registry from lib/: the job handlers are defined in jobs/ (#788)', async () => {
    expect(
      await rules(
        "import { requireService } from '../jobs/registry';\nvoid requireService;\n",
        LIB,
      ),
    ).toContain(RULE);
    // A type-only import of a handler's types is still fine.
    expect(
      await rules(
        "import type { JobHandler } from '../jobs/registry';\nexport type X = JobHandler<unknown>;\n",
        LIB,
      ),
    ).not.toContain(RULE);
  });

  it('leaves jobs/ alone: the rule is for the layers below it', async () => {
    expect(
      await rules("import { triageMessage } from './mailIngest';\nvoid triageMessage;\n", JOB),
    ).not.toContain(RULE);
  });

  it('keeps the NFR-SEC11 filesystem ban on those same files', async () => {
    expect(
      await rules("import { readFileSync } from 'node:fs';\nvoid readFileSync;\n", LIB),
    ).toContain('no-restricted-imports');
    expect(
      await rules("import { readFileSync } from 'node:fs';\nvoid readFileSync;\n", REPO),
    ).toContain('no-restricted-imports');
  });
});
