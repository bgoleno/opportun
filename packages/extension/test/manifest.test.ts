import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildManifest, type BuildStamp } from '../src/manifest';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const STAMP: BuildStamp = {
  contentHash: 'abc12345',
  commit: 'a1b2c3d',
  builtAt: '2026-10-20T21:45:12.000Z',
};

describe('buildManifest', () => {
  it.each(['chrome', 'firefox'] as const)('%s: MV3, popup only, least privilege', (target) => {
    const m = buildManifest(target, '1.2.3', STAMP) as Record<string, unknown>;
    expect(m.manifest_version).toBe(3);
    expect(m.version).toBe('1.2.3');
    expect(m.permissions).toEqual(['activeTab', 'scripting', 'storage']);
    expect(m.host_permissions).toEqual(['https://www.linkedin.com/*']);
    // The user's own server is asked for at runtime, for its origin only.
    // Broader than the rule the code enforces, deliberately: Chrome match patterns cannot
    // express "a private host", so settings.ts narrows it (design D17, ADR-14). Granting still
    // happens one origin at a time, at runtime, with the user's approval.
    expect(m.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    // C-1: widening the optional list must never widen what is granted at install time.
    expect(m.host_permissions).toEqual(['https://www.linkedin.com/*']);
    const icons = {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    };
    expect(m.action).toEqual({
      default_popup: 'popup.html',
      default_title: 'Capture to Opportun',
      default_icon: icons,
    });
    // #82: without these, an installed-but-unpinned extension shows a generated placeholder
    // and sits inside the puzzle-piece menu rather than its own pinned toolbar icon.
    expect(m.icons).toEqual(icons);
    // C-1: nothing runs in the background or in pages on its own.
    expect(m).not.toHaveProperty('background');
    expect(m).not.toHaveProperty('content_scripts');
    expect(m).not.toHaveProperty('externally_connectable');
    expect(m).not.toHaveProperty('web_accessible_resources');
    // No remote code: the default extension CSP (script-src 'self') is not loosened.
    expect(m).not.toHaveProperty('content_security_policy');
  });

  it('every icon path in the manifest names a file vite actually ships', () => {
    const icons = (buildManifest('chrome', '1.0.0', STAMP) as { icons: Record<string, string> })
      .icons;
    for (const relativePath of Object.values(icons)) {
      expect(existsSync(join(PUBLIC_DIR, relativePath)), relativePath).toBe(true);
    }
  });

  it('firefox carries an add-on id; chrome does not', () => {
    expect(buildManifest('firefox', '1.0.0', STAMP)).toMatchObject({
      browser_specific_settings: { gecko: { id: 'capture@opportun' } },
    });
  });

  it('the chrome key is chrome-only: firefox already has a stable id', () => {
    // Design D18: a stable extension id, so re-downloading after a server upgrade is the same
    // extension and keeps its saved address and token. Chrome otherwise derives the id from
    // the unpacked folder's path, making every re-download a new extension with empty storage.
    const chrome = buildManifest('chrome', '1.0.0', STAMP) as Record<string, unknown>;
    expect(typeof chrome.key).toBe('string');
    expect((chrome.key as string).length).toBeGreaterThan(300);
    expect(buildManifest('firefox', '1.0.0', STAMP)).not.toHaveProperty('key');
  });

  it('firefox declares the data that leaves the device: page text and the bearer token', () => {
    expect(buildManifest('firefox', '1.0.0', STAMP)).toMatchObject({
      browser_specific_settings: {
        gecko: {
          data_collection_permissions: { required: ['websiteContent', 'authenticationInfo'] },
        },
      },
    });
    expect(buildManifest('chrome', '1.0.0', STAMP)).not.toHaveProperty('browser_specific_settings');
  });

  it('#92: carries a version_name build stamp, since version itself must stay a bare dotted-integer string', () => {
    const m = buildManifest('chrome', '1.2.3', STAMP) as Record<string, unknown>;
    // Chrome and Firefox both show version_name instead of version wherever they display
    // one (chrome://extensions, about:debugging, about:addons), with no DevTools needed.
    expect(m.version_name).toBe('1.2.3+abc12345 (a1b2c3d, 2026-10-20T21:45:12.000Z)');
  });

  it('#92: a commit that could not be determined shows as "unknown", not silently omitted', () => {
    // design.md principle 6: a path that degrades to a lesser input must say so, not
    // substitute something that looks like success. This is the Docker image build, whose
    // .dockerignore excludes .git from the build context on purpose (see vite.config.ts).
    const stamp: BuildStamp = {
      contentHash: 'abc12345',
      commit: undefined,
      builtAt: '2026-10-20T21:45:12.000Z',
    };
    const m = buildManifest('chrome', '1.2.3', stamp) as Record<string, unknown>;
    expect(m.version_name).toBe('1.2.3+abc12345 (unknown, 2026-10-20T21:45:12.000Z)');
  });

  it('#92: version stays a bare dotted-integer string regardless of the stamp', () => {
    // Required by both Chrome and Firefox for update comparisons; a +build suffix there
    // would be invalid even though it is valid semver generally.
    const m = buildManifest('firefox', '1.2.3', STAMP) as Record<string, unknown>;
    expect(m.version).toBe('1.2.3');
    expect(m.version).not.toContain('+');
  });
});
