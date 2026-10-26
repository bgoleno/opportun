// The extension's manifest.json, one per browser, emitted by vite.config.ts at build time.
// Least privilege by construction (C-1, unit-tested):
// - no background worker, no content scripts: nothing runs unless the user opens the popup
//   and clicks, and then only in the active tab (activeTab + scripting, one injection);
// - host access to www.linkedin.com only, plus the user's own server origin, requested at
//   runtime for that one origin when the settings are saved (optional_host_permissions). The
//   optional http pattern is wide because match patterns cannot say "private host"; the rule
//   that matters lives in settings.ts isPrivateHost (ADR-14);
// - the default extension CSP (script-src 'self'): no remote code.

export type BrowserTarget = 'chrome' | 'firefox';

/**
 * What this one build is, so "which build is loaded" is answerable by looking at
 * chrome://extensions or Firefox's about:debugging/about:addons (both show manifest
 * `version`/`version_name` without opening DevTools), not by rebuilding and diffing bytes
 * by hand (#92, costed out in #79). See buildStamp.ts for how each piece is produced.
 */
export interface BuildStamp {
  /** sha256 of this build's own bundled files, truncated to 8 hex chars. Always present. */
  contentHash: string;
  /** Short commit sha, or undefined when git wasn't available to ask (shown as "unknown"
   * rather than omitted: design.md principle 6, report only outcomes you observed). */
  commit: string | undefined;
  /** When this build ran, UTC ISO 8601. */
  builtAt: string;
}

/**
 * Chrome's toolbar/management-page/store sizes, the same set Firefox expects for its toolbar
 * and about:addons icons. Without these, an installed-but-unpinned extension shows a generated
 * placeholder and sits inside the puzzle-piece menu rather than its own pinned icon (#82).
 */
const ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

/**
 * The public half of a keypair generated once for this project (design D18). Chrome derives an
 * unpacked extension's id from this when present, and from the folder's path when absent, so
 * without it every re-download after a server upgrade is a different extension with empty
 * storage and the user re-pastes a token every time. It is a public key: it signs nothing, it
 * keeps nothing secret, and the private half was discarded because unpacked loading never
 * needs it. Firefox has no equivalent problem; browser_specific_settings.gecko.id already
 * fixes its id.
 */
const CHROME_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAorNfDN16jCH0TjwrG4QqYva1tAtOSJEHSfxhW0nvAZdl5gICgnZFg0byWwq9KV9zDD6hC8dwiRmCwkWSUXpLa4d9xvYhFrUNdUZQa4UPyjW0fXp6cwbFYKN36rbOfGp+atHBSVofHlC0kiZWtOVhqfuUsvr8x4FZYQl8+tifEnOa984VqDnUv2FzUkRA/nMk/nU/bk82gnGl0gtpyHKGkieLmmwlEvubN+8SlDw/wABoDG/Lpn8zZxxq/ht847HXguD8z6K+cLihgQC+II8HQcUQN2v4UNf0Fpcx5r1ECBKrn5mBmV0VlcwOVmENqA6R2EADF2dVPMrQDoGkoUr3WQIDAQAB';

export function buildManifest(
  target: BrowserTarget,
  version: string,
  stamp: BuildStamp,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: 'Opportun Capture',
    short_name: 'Opportun',
    version,
    // `version` itself must stay a bare dotted-integer string (Chrome and Firefox both
    // enforce this for update comparisons; a +build suffix is invalid semver-in-a-manifest
    // here even though it's valid semver generally). `version_name` carries the stamp
    // instead: both browsers display it in place of `version` wherever they show one.
    version_name: `${version}+${stamp.contentHash} (${stamp.commit ?? 'unknown'}, ${stamp.builtAt})`,
    description:
      'Send the profile or job posting you are looking at to your own Opportun server, one click at a time.',
    action: {
      default_popup: 'popup.html',
      default_title: 'Capture to Opportun',
      default_icon: ICONS,
    },
    icons: ICONS,
    permissions: ['activeTab', 'scripting', 'storage'],
    host_permissions: ['https://www.linkedin.com/*'],
    // Broader than the rule settings.ts enforces, because match patterns cannot express
    // "a private host" (design D17, ADR-14). Nothing here is granted at install time: the
    // popup asks for one origin, at runtime, and the user approves it.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
  };
  if (target === 'chrome') manifest.key = CHROME_KEY;
  if (target === 'firefox') {
    manifest.browser_specific_settings = {
      gecko: {
        id: 'capture@opportun',
        // optional_host_permissions and scripting in MV3.
        strict_min_version: '128.0',
        // What leaves the device, in Mozilla's taxonomy: the captured page text
        // (websiteContent) and the bearer device token (authenticationInfo), both sent only to
        // the server the user configures. Honored from Firefox ~140 (and by AMO signing);
        // earlier versions ignore the key.
        data_collection_permissions: { required: ['websiteContent', 'authenticationInfo'] },
      },
    };
  }
  return manifest;
}
