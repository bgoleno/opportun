// Run with `node --test .github/scripts` (zero dependencies: node:test + node:assert). This is
// the part of #63's mechanism that can be proven tonight without a live Actions run: whether the
// glob list actually catches the historical case it was built to catch, and doesn't fire on
// everything else.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { matchingSecurityPaths } from './security-paths.mjs';

// The real file list from commit 78de5f8 (PR #47, "feat(mail): Stage 1 rules 3-7..."), which
// landed issue #5's password-hash-versioning fix under a description that said it touched no
// passwords (issue #63). Trimmed to a representative slice: the five security-sensitive files
// plus a sample of the unrelated mail-ingest work it was actually described as.
const PR_47_FILES = [
  'apps/server/src/lib/passwords.ts',
  'apps/server/src/lib/pepperSet.ts',
  'apps/server/src/lib/reauth.ts',
  'apps/server/src/lib/passwordReset.ts',
  'apps/server/src/routes/auth.ts',
  'apps/server/src/cli/resetPassword.ts',
  'apps/server/src/adapters/gmail.ts',
  'apps/server/src/adapters/mailProvider.ts',
  'apps/server/src/adapters/sources/alertEmail.ts',
  'apps/server/src/jobs/mailIngest.ts',
  'apps/server/src/repos/communications.ts',
  'apps/web/src/components/comms/InboxRow.tsx',
  'docs/install.md',
];

// The real file list from PR #110 ("feat(discovery): a Decided view for accepted/dismissed
// results, with unsuppress", #97): a same-sized, genuinely unrelated web-only PR that must NOT
// be flagged, or the label stops meaning anything.
const PR_110_FILES = [
  'apps/web/e2e/discovery.spec.ts',
  'apps/web/src/components/discovery/DecidedResults.tsx',
  'apps/web/src/components/discovery/api.ts',
  'apps/web/src/components/discovery/decidedResults.test.tsx',
  'apps/web/src/routeTree.gen.ts',
  'apps/web/src/routes/discovery/decided.tsx',
  'apps/web/src/routes/discovery/route.tsx',
];

test('catches the exact historical miss (#47 / issue #5)', () => {
  const matched = matchingSecurityPaths(PR_47_FILES);
  assert.deepEqual(matched, [
    'apps/server/src/lib/passwords.ts',
    'apps/server/src/lib/pepperSet.ts',
    'apps/server/src/lib/reauth.ts',
    'apps/server/src/lib/passwordReset.ts',
    'apps/server/src/routes/auth.ts',
    'apps/server/src/cli/resetPassword.ts',
    'apps/server/src/adapters/gmail.ts',
    'apps/server/src/adapters/mailProvider.ts',
    'apps/server/src/adapters/sources/alertEmail.ts',
  ]);
});

test('does not flag a real, unrelated web-only PR (#110 / #97)', () => {
  assert.deepEqual(matchingSecurityPaths(PR_110_FILES), []);
});

test('adapters/** matches any depth under adapters/, not just its top level', () => {
  assert.deepEqual(matchingSecurityPaths(['apps/server/src/adapters/sources/mcpConfig.ts']), [
    'apps/server/src/adapters/sources/mcpConfig.ts',
  ]);
});

test('a filename that merely contains "adapters" outside the adapters/ directory is not a match', () => {
  assert.deepEqual(matchingSecurityPaths(['apps/server/src/lib/adaptersHelper.ts']), []);
});

test('a same-named file in an unrelated directory is not a match (directory-scoped, not basename-scoped)', () => {
  // apps/web has its own lib/api.ts; it must not be confused with apps/server's auth/crypto libs.
  assert.deepEqual(matchingSecurityPaths(['apps/web/src/lib/api.ts']), []);
});

test('an empty change set matches nothing', () => {
  assert.deepEqual(matchingSecurityPaths([]), []);
});

// https://github.com/bgoleno/opportun/issues/248 and
// https://github.com/bgoleno/opportun/issues/252: changes to these got no automatic flag, and the
// need for a security review was caught by hand. Each must still exist, because a glob left behind
// by a rename stops matching without any error, which is the same miss again.
const FLAGGED_FILES = [
  'apps/server/src/plugins/security.ts',
  'apps/server/src/routes/secrets.ts',
  'apps/server/src/routes/deviceTokens.ts',
  'apps/server/src/routes/connectorApply.ts',
  'apps/server/src/lib/aiProviderFetch.ts',
  'apps/server/src/lib/audit.ts',
  'apps/server/src/routes/connectorMail.ts',
  'apps/server/src/routes/connectorCapture.ts',
  'apps/server/src/lib/aiKeyValidate.ts',
  'apps/server/src/lib/google.ts',
  'apps/server/src/lib/registration.ts',
  'apps/connector/src/cli.ts',
  'apps/connector/src/config.ts',
  'apps/connector/src/push.ts',
  'apps/connector/src/nodeIo.ts',
  'apps/connector/src/types.ts',
  'packages/extension/src/settings.ts',
  'packages/extension/src/api.ts',
  'packages/extension/src/confirmation.ts',
  'packages/extension/src/prefill.ts',
  'packages/extension/src/popupController.ts',
  '.github/scripts/security-paths.mjs',
];

for (const file of FLAGGED_FILES) {
  test(`flags ${file}`, () => {
    assert.ok(
      existsSync(new URL(`../../${file}`, import.meta.url)),
      `${file} is gone: update its glob in security-paths.mjs`,
    );
    assert.deepEqual(matchingSecurityPaths([file]), [file]);
  });
}

// Fails if a glob for one of the files above grows to take in its neighbours, or the label stops
// meaning anything. plugins/ holds only sensitive files today, so its control is a made-up name.
const NOT_SENSITIVE = [
  // real files beside them
  'apps/server/src/routes/companies.ts',
  'apps/server/src/routes/opportunities.ts',
  'apps/server/src/lib/csv.ts',
  'apps/server/src/lib/textSignals.ts',
  'apps/web/src/routes/settings/security.tsx',
  'apps/connector/src/normalize.ts',
  // real files with the same name as a connector or extension file above, which is why those
  // are listed by exact path: **/config.ts or **/api.ts would take these in
  'apps/server/src/config.ts',
  'apps/server/src/routes/settings.ts',
  'apps/server/test/api.ts',
  'apps/web/src/components/ai/api.ts',
  'packages/ai/src/types.ts',
  // outside CONTRIBUTING.md's four categories, decided on issue 252
  'apps/server/src/lib/storage.ts',
  // made-up names one step away from them
  'apps/server/src/plugins/requestLogger.ts',
  'apps/server/src/plugins/securityHeaders.ts',
  'apps/server/src/routes/secretsHelper.ts',
  'apps/server/src/routes/audit.ts',
  'apps/server/src/lib/secrets.ts',
  'apps/server/src/lib/auditHelper.ts',
];

for (const file of NOT_SENSITIVE) {
  test(`does not flag ${file}`, () => {
    assert.deepEqual(matchingSecurityPaths([file]), []);
  });
}
