import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import security from 'eslint-plugin-security';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

const fsBan = {
  paths: [
    { name: 'fs', message: 'Use apps/server/src/lib/storage.ts for filesystem access.' },
    { name: 'node:fs', message: 'Use apps/server/src/lib/storage.ts for filesystem access.' },
    { name: 'fs/promises', message: 'Use apps/server/src/lib/storage.ts for filesystem access.' },
    {
      name: 'node:fs/promises',
      message: 'Use apps/server/src/lib/storage.ts for filesystem access.',
    },
  ],
};

// Raw SQL goes through db/client's rawAll/rawGet/rawRun: on the async driver a raw
// db.all(sql) returns positional arrays, and db.run(sql) is lazy.
const rawSqlBan = [
  {
    selector:
      "CallExpression[callee.property.name=/^(all|get|run|values)$/][arguments.0.type='TaggedTemplateExpression'][arguments.0.tag.name='sql']",
    message: 'Use rawAll/rawGet/rawRun from db/client for raw SQL.',
  },
  {
    selector:
      "CallExpression[callee.property.name=/^(all|get|run|values)$/][arguments.0.callee.object.name='sql']",
    message: 'Use rawAll/rawGet/rawRun from db/client for raw SQL.',
  },
];

// Transactions only through withTransaction (it holds the write gate); db/client.ts owns the
// one call to drizzle's transaction(). The root handle also refuses it at runtime.
const transactionBan = {
  selector: "CallExpression[callee.property.name='transaction']",
  message: 'Open transactions with withTransaction (db/client), never .transaction().',
};

// Issue #292: vitest's threads pool (apps/server/vitest.config.ts sets no pool/isolate
// override, except for the two files issue #298 moved to their own forked project) runs test
// files as worker threads sharing one process.env, not separate processes, so a mutation here
// can leak into another test file scheduled onto the same worker. A save-and-restore
// try/finally (or vi.stubEnv) doesn't fix this: both restore after the test, neither isolates
// a sibling file sharing the process while the mutation is in effect. The fix is for the
// production code under test to take the environment as a parameter instead, so the test
// passes a literal object (see ConnectOptions#isTestRun and TransactionOptions#isTestRun in
// db/client.ts, backup.ts's pgDumpEnv, and mcpClient.ts's minimalEnv/CallOptions#env, all
// added for exactly this). Caught at author time, not at run time, which only fires after the
// test that mutated has already gone (the next sibling file is the one that goes red).
//
// This check is a property of the code we grepped for, not a guarantee: Object.assign
// (process.env, {...}) and aliasing through a local (const e = process.env; e.X = 'y') both
// mutate the real process.env but match none of the selectors below, and an AST rule can't
// follow a reference to catch the second one. Worth saying so rather than letting the rule's
// presence be mistaken for a stronger guarantee than it is.
//
// test/dbClientPg.test.ts and test/schemaConformance.test.ts still trip these selectors
// syntactically -- this rule has no idea they run under vitest.config.ts's `forks` project,
// where the mutation genuinely is per-process (issue #298) -- so each call site there carries
// its own eslint-disable-next-line, not a file-level exemption. An exemption that outlives
// its reason is how a guard quietly stops guarding: a file-level ignore here would also wave
// through any *other*, unrelated process.env mutation someone adds to either file later.
const envMutationBan = [
  {
    selector:
      "AssignmentExpression[left.object.object.name='process'][left.object.property.name='env']",
    message:
      'process.env.X = ... leaks to every test file sharing this worker thread (issue ' +
      '#292). Have the code under test take the environment as a parameter instead.',
  },
  {
    selector: "AssignmentExpression[left.object.name='process'][left.property.name='env']",
    message:
      'process.env = ... leaks to every test file sharing this worker thread (issue ' +
      '#292). Have the code under test take the environment as a parameter instead.',
  },
  {
    selector:
      "UnaryExpression[operator='delete'][argument.object.object.name='process'][argument.object.property.name='env']",
    message:
      'delete process.env.X leaks to every test file sharing this worker thread (issue ' +
      '#292). Have the code under test take the environment as a parameter instead.',
  },
  {
    // vi.stubEnv restores after the test too, same as a hand-written try/finally: it does not
    // isolate a sibling file sharing this worker thread while the stub is live, which is the
    // only thing that matters here. Banning direct assignment but not this would just point
    // whoever hits the rule at this instead.
    selector: "CallExpression[callee.object.name='vi'][callee.property.name='stubEnv']",
    message:
      'vi.stubEnv mutates the real process.env and leaks to every test file sharing this ' +
      'worker thread (issue #292), the same as a direct assignment it restores after the ' +
      'test but does not isolate a sibling file sharing the process in the meantime. Have ' +
      'the code under test take the environment as a parameter instead.',
  },
  {
    selector: "CallExpression[callee.object.name='vi'][callee.property.name='unstubAllEnvs']",
    message:
      'vi.unstubAllEnvs implies a prior vi.stubEnv, banned for the same reason (issue ' +
      '#292): it leaks to every test file sharing this worker thread. Have the code under ' +
      'test take the environment as a parameter instead.',
  },
];

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/routeTree.gen.ts',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  security.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // The SPA and the capture extension run in the browser (vite.config.ts runs in node).
    files: ['apps/web/src/**', 'apps/web/public/**', 'packages/extension/src/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // NFR-SEC11: filesystem access in the server only through the storage module.
    files: ['apps/server/src/**'],
    ignores: ['apps/server/src/lib/storage.ts'],
    rules: {
      'no-restricted-imports': ['error', fsBan],
    },
  },
  {
    // The server's data layer is async (iteration 4): a statement or transaction that is not
    // awaited runs out of order and loses its error. Type-aware, so it sees drizzle builders.
    // no-restricted-syntax deliberately does not live in this block (issue #305): every
    // no-restricted-syntax block below has a `files`/`ignores` pair that overlaps no other
    // one, so each file gets exactly one block's value for that rule rather than the last
    // matching block silently discarding an earlier one's array (flat config keeps only the
    // last matching block's value per rule name; it does not merge array-valued rules across
    // blocks with overlapping `files`). #292's own env-mutation block used to be last in this
    // file and, being the last block whose `files` matched apps/server/test/**, silently
    // replaced this block's and the transaction-ban block's rawSqlBan/transactionBan for every
    // test file in apps/server -- found by Jane while fixing #298, confirmed already live on
    // main independent of anything in this branch. Keep every block below mutually exclusive
    // by file: a fifth block added here, or a merge that re-spreads every earlier block's
    // array into a new last one, is technically correct today and leaves the identical trap
    // for whoever edits this file next. apps/server/test/_scratch_rule_check.test.ts (not
    // committed) with a raw `.transaction()` call, a raw tagged-template sql query and a
    // `process.env` assignment, run through `eslint`, must report all three or this has
    // regressed; confirmed before closing #305, not assumed from reading the blocks.
    files: ['apps/server/src/**/*.ts', 'apps/server/test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: `${import.meta.dirname}/apps/server`,
      },
    },
    rules: {
      // checkThenables: drizzle's query builders and db.run(sql) are lazy thenables, not
      // Promises; un-awaited they never execute. Fastify's reply and register are thenable
      // by design and safe to leave un-awaited.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          checkThenables: true,
          allowForKnownSafePromises: [
            { from: 'package', name: ['FastifyReply', 'FastifyInstance'], package: 'fastify' },
          ],
        },
      ],
    },
  },
  {
    // Transactions only through withTransaction (it holds the write gate); db/client.ts owns
    // the one call to drizzle's transaction(). The root handle also refuses it at runtime.
    // Source only: apps/server/test/**/*.ts gets the same two bans, plus envMutationBan, from
    // the dedicated test block below -- not from here, so this block and that one never both
    // match the same file.
    //
    // Source only, not just "not db/client.ts": `ignores` also excludes every *.test.ts,
    // including one colocated with its source (apps/server/src/foo.test.ts, the pattern
    // packages/core already uses for index.test.ts, stateMachine.test.ts, mailText.test.ts,
    // though apps/server itself has none today). The rule this config means to state is "a
    // test file under apps/server gets all three bans wherever it lives" -- expressed here by
    // excluding every test shape from the source block and letting the dedicated test block
    // below (whose own `files` covers both shapes) be the one place that states it, rather
    // than a fifth block enumerating one more path (#312; closed, not just narrowed, by this
    // same restructuring).
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/db/client.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...rawSqlBan, transactionBan],
    },
  },
  {
    // db/client.ts itself: the one file allowed to call .transaction() (it's where
    // withTransaction is implemented), but still bound by rawSqlBan like every other source
    // file -- its own rawAll/rawGet/rawRun are how a raw query is supposed to reach the driver,
    // not an exemption for the rest of the file to bypass them.
    files: ['apps/server/src/db/client.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...rawSqlBan],
    },
  },
  {
    // apps/server tests: the same two bans as the source files they test, plus envMutationBan
    // (issue #292/#298's own reasoning, in that const's comment above) -- wherever such a test
    // lives, not just under test/: apps/server/src/**/*.test.ts is included for exactly the
    // colocated shape the block above excludes, so the two stay disjoint regardless of layout
    // (#312) rather than correct only because apps/server happens not to colocate tests today.
    // One block carrying all three selector sets, not three separate blocks whose files
    // overlap -- see this file's first no-floating-promises block for why that matters.
    files: ['apps/server/test/**/*.ts', 'apps/server/src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...rawSqlBan, transactionBan, ...envMutationBan],
    },
  },
  {
    // Tests build fixtures in per-test temp dirs; non-literal paths there are expected.
    files: ['**/test/**', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    // envMutationBan for every test file OUTSIDE apps/server (packages/extension, apps/web,
    // apps/connector): rawSqlBan and transactionBan are drizzle/db/client concepts that don't
    // exist there. `ignores: ['apps/server/**']`, not just 'apps/server/test/**' -- the whole
    // app, not just its test directory, is load-bearing, not tidiness: a test colocated with
    // its source (apps/server/src/foo.test.ts) matches both block one's `files` and this
    // block's broader `*.test.ts` glob, and this file already colocates core/'s own tests
    // that way (index.test.ts, stateMachine.test.ts, mailText.test.ts) even though
    // apps/server itself has not adopted the layout -- so excluding only the test/ directory
    // leaves exactly the clobber #305 fixes everywhere else, re-triggered by a layout choice
    // rather than a new file glob. Without excluding all of apps/server/**, this block, being
    // last, would silently replace the union above with envMutationBan alone for any such
    // file, reintroducing #305's exact bug under a different trigger.
    files: ['**/test/**', '**/*.test.ts', '**/*.test.tsx'],
    ignores: ['apps/server/**'],
    rules: {
      'no-restricted-syntax': ['error', ...envMutationBan],
    },
  },
);
