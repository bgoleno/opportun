// The security-sensitive path globs: the files in the areas CONTRIBUTING.md names as needing extra
// review (see also SECURITY.md's threat model). Kept here as a pure, dependency-free module rather
// than only inside workflow YAML, so there is one place to update when a new sensitive file shows
// up, and one place to unit test the matching logic without needing a live CI run (issue #63).
//
// Grouped by the areas CONTRIBUTING.md names, so the list stays an expression of what the docs
// declare rather than a second list to remember separately.
import path from 'node:path';

export const SECURITY_SENSITIVE_GLOBS = [
  // auth
  '**/lib/passwords.ts',
  // the peppers and their versions (pepperSet.ts today; a later pepper*.ts with them, tl on #610)
  '**/lib/pepper*.ts',
  '**/lib/reauth.ts',
  '**/lib/sessions.ts',
  '**/lib/totp.ts',
  '**/lib/twoFactor.ts',
  '**/lib/deviceTokens.ts',
  '**/lib/oauthProviders.ts',
  '**/lib/oauthState.ts',
  '**/lib/passwordReset.ts',
  '**/plugins/session.ts',
  '**/routes/auth.ts',
  '**/routes/googleAuth.ts',
  '**/routes/oauthLogin.ts',
  '**/cli/resetPassword.ts',
  '**/routes/deviceTokens.ts',
  // bearer device tokens, no session and no CSRF
  '**/routes/connectorApply.ts',
  '**/routes/connectorMail.ts',
  '**/routes/connectorCapture.ts',
  // response headers; the CSRF check, which safe methods, device routes, paths outside /api/ and
  // CSRF_EXEMPT skip; and the refusal of a device route with no token check
  '**/plugins/security.ts',
  // the transaction that decides who becomes the first admin
  '**/lib/registration.ts',
  // Google account connection: its OAuth client and tokens
  '**/lib/google.ts',
  // the device token on the connector, the extension and the web app, where it is typed, kept,
  // sent, shown or masked. Exact paths, because **/settings.ts or **/api.ts would take in unrelated
  // files.
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
  'packages/extension/popup.html',
  'apps/web/src/routes/settings/-devices.tsx',
  'apps/web/src/routes/settings/-extensionSetup.tsx',
  // the web pages where another credential is typed or shown once: a password, a 2FA code or its
  // recovery codes, an OAuth client secret, a linked sign-in, an API or provider key (#256). The
  // server enforces every check; these are where the browser handles the value.
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
  // the web app's one API client: it sends the CSRF header and sets the credentials mode
  'apps/web/src/lib/api.ts',
  // the AI settings client: provider keys, and the user-set baseUrl the server then fetches
  'apps/web/src/components/ai/api.ts',
  // the audit trail and its redaction. It has no category of its own in CONTRIBUTING.md; it is
  // here because auth, reauth and token changes are among what it records.
  '**/lib/audit.ts',
  // crypto
  '**/lib/secretBox.ts',
  // the secrets vault's API, which takes values that secretBox then encrypts
  '**/routes/secrets.ts',
  // loads the vault master key and the peppers
  'apps/server/src/config.ts',
  // reads the user's AI provider keys from the vault
  '**/lib/ai.ts',
  // adapters
  '**/adapters/**',
  // fetchers (safeFetch is the SSRF-safe chokepoint; mcpClient does its own outbound
  // connection handling for user-configured MCP servers, SECURITY.md's "HTTP MCP sources
  // and DNS rebinding" deviation)
  '**/lib/safeFetch.ts',
  '**/lib/mcpClient.ts',
  // the SSRF check for the AI provider path, whose baseUrl the user controls
  '**/lib/aiProviderFetch.ts',
  // sends the user's AI provider key in an outbound request to check it
  '**/lib/aiKeyValidate.ts',
  // the extension's permissions: its host permissions and what it may run
  'packages/extension/src/manifest.ts',
  // CI: the workflows, which include the job that applies this label, plus the script that job
  // calls and this list itself, so a PR that removes a glob gets the label
  '.github/workflows/**',
  '.github/scripts/check-security-paths.mjs',
  '.github/scripts/security-paths.mjs',
  // decides what the Publish image jobs holding packages: write and contents: write publish:
  // which image tags, git tag and Release, and which refusals stop them (#478)
  '.github/scripts/publish.mjs',
  // the merge procedure for protected main, and the script that deletes a deployment's files
  // and data (#256)
  'scripts/merge-when-green.sh',
  'deploy/destroy.sh',
  // The areas added in #610 (decision 139), as sec confirmed them there.
  // the order of credential writes against a password change or reset (#561)
  '**/lib/passwordLock.ts',
  // assisted apply submissions: what a submission records, the review that clears it, the jobs
  // that sweep and follow it up, and the state machine and field limits they enforce
  'apps/server/src/routes/submissions.ts',
  'apps/server/src/repos/submission*.ts',
  'apps/server/src/lib/submission*.ts',
  'apps/server/src/jobs/submission*.ts',
  'packages/core/src/submissionStateMachine.ts',
  'packages/core/src/schemas/submission.ts',
  // the extension's form filler, which writes into a third-party page, and the popup that drives it
  'packages/extension/src/greenhouseFill.ts',
  'packages/extension/src/fillReport.ts',
  'packages/extension/src/popup.ts',
  // deployment: the Compose files, the image, and the TLS proxy with its trusted-proxy settings.
  // Dockerfile and Dockerfile.<variant>, not Dockerfile*: matching ignores case on some systems,
  // and Dockerfile* would then take in the tests named dockerfile*.test.ts.
  'deploy/compose*.yml',
  '**/Dockerfile',
  '**/Dockerfile.*',
  'deploy/Caddyfile',
  // the board probe and ATS detection: outbound fetches to boards, and the posting identities the
  // destination check later trusts
  'apps/server/src/jobs/networkBoardProbe.ts',
  'apps/server/src/jobs/atsDetect.ts',
  'apps/server/src/jobs/atsJobRefBackfill.ts',
  'apps/server/src/lib/atsJobRef.ts',
  // the outbound AI provider clients, and tasks.ts, which fences untrusted text in prompts
  'packages/ai/src/providers.ts',
  // every provider's batch client, as each lands (*Batch.ts, tl on #610)
  'packages/ai/src/*Batch.ts',
  'packages/ai/src/batch.ts',
  'packages/ai/src/keyCheck.ts',
  'packages/ai/src/router.ts',
  'packages/ai/src/tasks.ts',
  // the demo boundary: shared and dedicated accounts, the seed, and the nightly reset
  'apps/server/src/lib/demo*.ts',
  // the seed and its fixture (moved out of cli/ in #765)
  'apps/server/src/lib/demo/*.ts',
  'apps/server/src/cli/seedDemo*.ts',
  'apps/server/src/cli/createDemoAccount.ts',
  'apps/server/src/jobs/demoReset.ts',
  // data export and import: what leaves and enters an account in bulk
  '**/lib/exporter.ts',
  '**/lib/importer.ts',
  '**/routes/importExport.ts',
  // the filesystem boundary for stored files
  '**/lib/storage.ts',
  // the observability settings, behind an admin's password step-up
  '**/routes/obsSettings.ts',
];

/** The changed paths, in order, that match a security-sensitive glob. */
export function matchingSecurityPaths(changedPaths) {
  return changedPaths.filter((changed) =>
    SECURITY_SENSITIVE_GLOBS.some((glob) => path.matchesGlob(changed, glob)),
  );
}
