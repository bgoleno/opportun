import { defaultExclude, defaultInclude, defineConfig } from 'vitest/config';

// test/dbClientPg.test.ts and test/schemaConformance.test.ts force a second module
// evaluation of db/schema under DB_DIALECT=postgres (vi.stubEnv + vi.resetModules), because
// SCHEMA_DIALECT is a module-load-time constant by design (ADR-4 Task 7: chosen once, so a
// process never mixes the two dialects) -- a parameter can't stand in for that the way #292's
// fix worked elsewhere. Under the default `threads` pool that mutation is a cross-file hazard
// (process.env is shared by every file scheduled onto the same worker; issue #292), so these
// two run in their own project under the `forks` pool instead, where process.env is genuinely
// per-file because each one is a separate OS process (issue #298).
//
// `extends: true` on a project pulls in this file's own settings below (confirmed with a
// temporary console.log in test/setup.ts: setupFiles did NOT fire for a project when it was
// declared in a *different* config file extending this one, only when declared as a project
// of this file itself). defaultInclude/defaultExclude are spread explicitly rather than left
// to inherit silently, for the same reason: verify, don't assume, once a config change here
// governs every PR's required check.
const DIALECT_ISOLATED_FILES = ['test/dbClientPg.test.ts', 'test/schemaConformance.test.ts'];

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // The Postgres leg's template database (a no-op on SQLite runs).
    globalSetup: ['./test/globalSetup.pg.ts'],
    // Full values in assertion messages: a parity failure (search, schema, seed rows) on the
    // Postgres CI leg must be diagnosable from the log alone.
    chaiConfig: { truncateThreshold: 0 },
    // Booting a test app on the Postgres leg copies the template database; under full
    // parallel load on a CI runner that occasionally exceeds vitest's 10s hook default
    // (observed once on main run 39088417778). Harmless headroom on SQLite.
    hookTimeout: 30_000,
    // The same argument for the tests themselves (issue #36). A full parallel run on a
    // developer machine already busy with other work failed 14 tests across 11 files, every
    // one of them "Test timed out in 5000ms" and none of them near a real hang: database
    // migrations, an importer round-trip, isolation checks. The default measures the machine,
    // not the code. A genuinely stuck test still fails, six seconds later than it used to.
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          include: defaultInclude,
          exclude: [...defaultExclude, ...DIALECT_ISOLATED_FILES],
        },
      },
      {
        extends: true,
        test: {
          name: 'server (dialect-isolated)',
          include: DIALECT_ISOLATED_FILES,
          pool: 'forks',
        },
      },
    ],
  },
});
