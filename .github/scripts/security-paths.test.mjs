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
  // A made-up name, so it claims nothing: the same file name as lib/passwords.ts, outside lib/.
  // (This used apps/web/src/lib/api.ts, which sends the CSRF header and is now on the list:
  // https://github.com/bgoleno/opportun/issues/256.)
  assert.deepEqual(matchingSecurityPaths(['apps/server/src/routes/passwords.ts']), []);
});

test('an empty change set matches nothing', () => {
  assert.deepEqual(matchingSecurityPaths([]), []);
});

// https://github.com/bgoleno/opportun/issues/248, https://github.com/bgoleno/opportun/issues/252
// and https://github.com/bgoleno/opportun/issues/254: changes to these got no automatic flag, and
// the need for a security review was caught by hand. Each must still exist, because a glob left
// behind by a rename stops matching without any error, which is the same miss again.
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
  'apps/server/src/config.ts',
  'apps/server/src/lib/ai.ts',
  'apps/web/src/routes/settings/-devices.tsx',
  'apps/web/src/routes/settings/-extensionSetup.tsx',
  'packages/extension/popup.html',
  'packages/extension/src/manifest.ts',
  '.github/scripts/check-security-paths.mjs',
  '.github/scripts/publish.mjs',
  '.github/workflows/ci.yml',
  '.github/workflows/identifier-guard.yml',
  '.github/workflows/publish-image.yml',
  '.github/workflows/security.yml',
  // https://github.com/bgoleno/opportun/issues/256: the web pages where a credential is typed or
  // shown once, the web client that sends the CSRF header, the AI settings client that carries a
  // user-set baseUrl and the provider keys, the merge procedure, and the script that deletes a
  // deployment's files.
  'apps/web/src/routes/login.tsx',
  'apps/web/src/routes/register.tsx',
  'apps/web/src/routes/settings/security.tsx',
  'apps/web/src/routes/settings/-password.tsx',
  'apps/web/src/routes/settings/-setPassword.tsx',
  'apps/web/src/routes/settings/-twoFactor.tsx',
  'apps/web/src/routes/settings/-linkedAccounts.tsx',
  'apps/web/src/routes/settings/-oauthProviders.tsx',
  'apps/web/src/routes/settings/-reactiveResume.tsx',
  'apps/web/src/components/ai/ProviderKeysCard.tsx',
  'apps/web/src/components/google/GoogleSetup.tsx',
  'apps/web/src/lib/api.ts',
  'apps/web/src/components/ai/api.ts',
  'scripts/merge-when-green.sh',
  'deploy/destroy.sh',
  // https://github.com/bgoleno/opportun/issues/610 (decision 139), the areas sec confirmed there:
  // assisted apply submissions, server side and the core rules they enforce
  'apps/server/src/routes/submissions.ts',
  'apps/server/src/repos/submissions.ts',
  'apps/server/src/repos/submissionReview.ts',
  'apps/server/src/repos/submissionConfirm.ts',
  'apps/server/src/repos/submissionOutcome.ts',
  'apps/server/src/lib/submissionDigest.ts',
  'apps/server/src/lib/submissionMatch.ts',
  'apps/server/src/jobs/submissionExpire.ts',
  'apps/server/src/jobs/submissionFollowup.ts',
  'apps/server/src/jobs/submissionSnapshot.ts',
  'packages/core/src/submissionStateMachine.ts',
  'packages/core/src/schemas/submission.ts',
  // the extension's form filler and its popup
  'packages/extension/src/greenhouseFill.ts',
  'packages/extension/src/fillReport.ts',
  'packages/extension/src/popup.ts',
  // deployment: Compose, the image and the TLS proxy
  'deploy/compose.yml',
  'deploy/compose.demo.yml',
  'deploy/compose.shared-proxy.yml',
  'deploy/Dockerfile',
  'deploy/Caddyfile',
  // the board probe and ATS detection
  'apps/server/src/jobs/networkBoardProbe.ts',
  'apps/server/src/jobs/atsDetect.ts',
  'apps/server/src/jobs/atsJobRefBackfill.ts',
  'apps/server/src/lib/atsJobRef.ts',
  // the AI provider clients and the untrusted-text fence
  'packages/ai/src/providers.ts',
  'packages/ai/src/anthropicBatch.ts',
  'packages/ai/src/batch.ts',
  'packages/ai/src/keyCheck.ts',
  'packages/ai/src/router.ts',
  'packages/ai/src/tasks.ts',
  // credential-write ordering, the demo boundary, export and import, file storage, admin step-up
  'apps/server/src/lib/passwordLock.ts',
  'apps/server/src/lib/demoAccounts.ts',
  'apps/server/src/lib/demoDedicated.ts',
  'apps/server/src/lib/demoOwnData.ts',
  'apps/server/src/lib/demoSharedAdmin.ts',
  'apps/server/src/cli/seedDemo.ts',
  'apps/server/src/cli/seedDemoFixture.ts',
  'apps/server/src/cli/createDemoAccount.ts',
  'apps/server/src/jobs/demoReset.ts',
  'apps/server/src/lib/exporter.ts',
  'apps/server/src/lib/importer.ts',
  'apps/server/src/routes/importExport.ts',
  'apps/server/src/lib/storage.ts',
  'apps/server/src/routes/obsSettings.ts',
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

test('a Dockerfile variant added later is flagged too (#610)', () => {
  const file = 'deploy/Dockerfile.dev';
  assert.deepEqual(matchingSecurityPaths([file]), [file]);
});

test('a workflow added later is flagged too', () => {
  const file = '.github/workflows/added-later.yml';
  assert.deepEqual(matchingSecurityPaths([file]), [file]);
});

// Fails if a glob for one of the files above grows to take in its neighbours, or the label stops
// meaning anything. This list claims each real file is not sensitive, so read a file before adding
// it: a shared name is not a reason (https://github.com/bgoleno/opportun/issues/254). Where no real
// neutral file exists, a made-up name does the job and claims nothing.
const NOT_SENSITIVE = [
  // real files beside them
  'apps/server/src/routes/companies.ts',
  'apps/server/src/routes/opportunities.ts',
  'apps/server/src/lib/sourceLabels.ts',
  'apps/server/src/lib/lookback.ts',
  'apps/web/src/routes/settings/role-targets.tsx',
  // process wiring only (sec on #255). It replaces apps/connector/src/normalize.ts, which bounds its
  // parsing against a hostile mail body and so is not neutral (#256).
  'apps/connector/src/index.ts',
  'apps/web/src/routes/pipeline.tsx',
  'apps/web/src/lib/utils.ts',
  'apps/web/src/components/ai/UsageTable.tsx',
  'packages/extension/src/normalize.ts',
  '.github/pull_request_template.md',
  // real files with the same name as a connector or extension file above, which is why those
  // are listed by exact path: **/settings.ts or **/api.ts would take these in
  'apps/server/src/routes/settings.ts',
  'apps/server/test/api.ts',
  'apps/web/src/components/tour/api.ts',
  // made-up names one step away from them
  'apps/server/src/plugins/requestLogger.ts',
  'apps/server/src/plugins/securityHeaders.ts',
  'apps/server/src/routes/secretsHelper.ts',
  'apps/server/src/routes/audit.ts',
  'apps/server/src/routes/security.ts',
  'apps/server/src/lib/secrets.ts',
  'apps/server/src/lib/auditHelper.ts',
  'apps/server/src/lib/aiHelper.ts',
  'scripts/format-docs.sh',
  'deploy/example.sh',
  // the only other config.ts and types.ts in the repository are on the list or not neutral, so
  // these guard **/config.ts and **/types.ts with names that exist nowhere
  'packages/core/src/config.ts',
  'apps/server/src/lib/types.ts',
  // #610: neighbours of the new areas, which must stay out. The page that shows a submission, the
  // extension's page reader, an AI file with no outbound call, the demo notice in the web app, and
  // the tests that read the Dockerfile.
  'apps/web/src/components/apply/SubmissionDetail.tsx',
  'packages/extension/src/extract.ts',
  'packages/ai/src/pricing.ts',
  'apps/web/src/components/SharedDemoNotice.tsx',
  'apps/server/test/dockerfilePgdg.test.ts',
  // made-up names one step away from the deploy globs
  'deploy/composeNotes.md',
  'deploy/Caddyfile.example',
];

for (const file of NOT_SENSITIVE) {
  test(`does not flag ${file}`, () => {
    assert.deepEqual(matchingSecurityPaths([file]), []);
  });
}

// Off the list by decision, which is not a claim that they are harmless, so they are not in
// NOT_SENSITIVE: https://github.com/bgoleno/opportun/issues/252 and
// https://github.com/bgoleno/opportun/issues/254. Changing this is a decision to revisit.
const OFF_THE_LIST_BY_DECISION = [
  // storage.ts was here until #610, where sec put the filesystem boundary on the list.
  '.github/scripts/security-paths.test.mjs',
];

for (const file of OFF_THE_LIST_BY_DECISION) {
  test(`leaves ${file} off the list, as decided`, () => {
    assert.deepEqual(matchingSecurityPaths([file]), []);
  });
}
