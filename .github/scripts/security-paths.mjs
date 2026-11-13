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
  '**/lib/pepperSet.ts',
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
];

/** The changed paths, in order, that match a security-sensitive glob. */
export function matchingSecurityPaths(changedPaths) {
  return changedPaths.filter((changed) =>
    SECURITY_SENSITIVE_GLOBS.some((glob) => path.matchesGlob(changed, glob)),
  );
}
