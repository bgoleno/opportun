// The layer rule (https://github.com/bgoleno/opportun/issues/763; docs/architecture.md 6.2): repos
// and lib import neither jobs/ nor routes/, apart from the job modules eslint.config.js names. Run
// through the repository's real eslint.config.js, as logLintRules.test.ts does, so the rule also
// fails here if it is unwired, aimed at the wrong files, or replaced by a later block, and so the
// NFR-SEC11 filesystem ban is shown to still apply to the same files.
import { describe, expect, it } from 'vitest';
import { serverLint } from './serverLint';

const { rules, configFor } = await serverLint([
  '@typescript-eslint/no-restricted-imports',
  'no-restricted-imports',
]);

// Real source paths, as the config's blocks pick by path. The text linted is the fixture's, never the
// file's own.
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

  it('allows a type-only import of any job module', async () => {
    expect(
      await rules(
        "import type { RunStats } from '../jobs/mailIngest';\nexport type X = RunStats;\n",
        LIB,
      ),
    ).not.toContain(RULE);
  });

  it('refuses a job module a folder deeper too', async () => {
    const seed = 'apps/server/src/lib/demo/seed.ts';
    for (const mod of ['attachmentSweep', 'mailIngest']) {
      expect(await rules(`import { x } from '../../jobs/${mod}';\nvoid x;\n`, seed), mod).toContain(
        RULE,
      );
    }
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

  it('refuses the job modules taken off the list as lib/ took their place (#788)', async () => {
    for (const mod of [
      'runner',
      'discoveryKinds',
      'gmailSync',
      'submissionSnapshot',
      'backup',
      'dbIntegrityCheck',
      'postingReconcile',
      'atsDetect',
    ]) {
      expect(await rules(`import { x } from '../jobs/${mod}';\nvoid x;\n`, LIB), mod).toContain(
        RULE,
      );
    }
  });

  it('names no job module as an exception any more: repos/ and lib/ import none (#788)', async () => {
    const config = (await configFor(LIB)) as {
      rules: Record<string, [unknown, { patterns: { group: string[] }[] }]>;
    };
    const [, options] = config.rules['@typescript-eslint/no-restricted-imports']!;
    const negations = options.patterns.flatMap((p) => p.group.filter((g) => g.startsWith('!')));
    expect(negations).toEqual([]);
  });

  it('leaves jobs/ alone: the rule is for the layers below it', async () => {
    expect(
      await rules("import { triageMessage } from './mailIngest';\nvoid triageMessage;\n", JOB),
    ).not.toContain(RULE);
    // Spelled as the rule's own patterns are, which the one above is not: aimed at jobs/ too, it would
    // refuse these.
    for (const mod of ['../jobs/mailIngest', '../routes/capture']) {
      expect(await rules(`import { x } from '${mod}';\nvoid x;\n`, JOB), mod).not.toContain(RULE);
    }
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
