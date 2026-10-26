// The security-sensitive path globs CONTRIBUTING.md names as needing extra review (auth,
// crypto, adapters, fetchers; see also SECURITY.md's threat model). Kept here as a pure,
// dependency-free module rather than only inside workflow YAML, so there is one place to update
// when a new auth/crypto/adapter/fetcher file shows up, and one place to unit test the matching
// logic without needing a live CI run (issue #63).
//
// Grouped by the same four categories CONTRIBUTING.md names, so the list stays a mechanical
// expression of what the docs already declare rather than a second list to remember separately.
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
  // crypto
  '**/lib/secretBox.ts',
  // adapters
  '**/adapters/**',
  // fetchers (safeFetch is the SSRF-safe chokepoint; mcpClient does its own outbound
  // connection handling for user-configured MCP servers, SECURITY.md's "HTTP MCP sources
  // and DNS rebinding" deviation)
  '**/lib/safeFetch.ts',
  '**/lib/mcpClient.ts',
];

/** The changed paths, in order, that match a security-sensitive glob. */
export function matchingSecurityPaths(changedPaths) {
  return changedPaths.filter((changed) =>
    SECURITY_SENSITIVE_GLOBS.some((glob) => path.matchesGlob(changed, glob)),
  );
}
