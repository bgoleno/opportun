// The log and event catalog stays complete (design.md 14.8, 14.9;
// https://github.com/bgoleno/opportun/issues/345). Read from the source, so a new audit action, a
// new log message or a new setting fails CI until the catalog lists it, instead of reaching the log
// as a withheld marker in silence.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_STORE_SETTING, RR_URL_SETTING } from '../src/adapters/reactiveResume';
import { GMAIL_ADDRESS_SETTING, MAIL_LABEL_SETTING } from '../src/adapters/gmail';
import { ALERT_SENDERS_SETTING } from '../src/adapters/sources/alertEmail';
import { DISCOVERY_DEFAULT_CRON_SETTING } from '../src/jobs/atsDetect';
import { CONSUMER_VETO_SETTING } from '../src/repos/mailFilters';
import { DAILY_REVIEW_CAP_SETTING } from '../src/repos/submissionReview';
import { CHECKLIST_SETTING, TOUR_SETTING } from '../src/routes/onboarding';
import { NETWORK_BOARD_CHECK_SETTING } from '../src/jobs/networkBoardProbe';
import { AUDIT_EVENTS, ATTRIBUTES, LOG_MESSAGES, SETTING_NAMES } from '../src/obs/catalog';
import { OAUTH_PROVIDERS } from '../src/lib/oauthProviders';
import { EXTENSION_TARGETS } from '../src/routes/artifacts';

const SRC = join(import.meta.dirname, '..', 'src');

function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

const FILES = sources().map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));

describe('the event catalog (#345)', () => {
  it('lists every action an audit() call writes', () => {
    const listed = new Set<string>(AUDIT_EVENTS);
    const found = new Set<string>();
    for (const { path, text } of FILES) {
      if (path === join('lib', 'audit.ts')) continue;
      for (const m of text.matchAll(/\baudit\(\s*[\w.]+\s*,\s*'([a-z0-9_.]+)'/g)) found.add(m[1]!);
      for (const m of text.matchAll(
        /\baudit\(\s*[\w.]+\s*,\s*[^,'`]*\?\s*'([a-z0-9_.]+)'\s*:\s*'([a-z0-9_.]+)'/g,
      )) {
        found.add(m[1]!);
        found.add(m[2]!);
      }
    }
    expect(found.size).toBeGreaterThan(60);
    for (const name of found) expect(listed.has(name), name).toBe(true);
  });
});

describe('the log message catalog (#345)', () => {
  it('lists every fixed message Opportun’s own log calls write', () => {
    const missing: string[] = [];
    for (const { path, text } of FILES) {
      // The first argument may be an object literal or a variable holding one (`fields`). Run
      // over this repository's own source in a test, never over input from outside.
      const re =
        // eslint-disable-next-line security/detect-unsafe-regex
        /\.(?:trace|debug|info|warn|error|fatal)\(\s*(?:(?:\{[^}]*\}|[\w.]+)\s*,\s*)?'((?:[^'\\]|\\.)+)'/g;
      for (const m of text.matchAll(re)) {
        if (!LOG_MESSAGES.has(m[1]!)) missing.push(`${path}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every key a message lists is catalogued', () => {
    for (const [msg, keys] of LOG_MESSAGES) {
      for (const key of keys) expect(Object.keys(ATTRIBUTES), `${msg}: ${key}`).toContain(key);
    }
  });
});

describe('the lists the catalog keeps by hand (#345)', () => {
  it('match the code they come from', () => {
    expect([...ATTRIBUTES['opportun.oauth.provider'].values]).toEqual([...OAUTH_PROVIDERS]);
    expect([...ATTRIBUTES['opportun.artifact.target'].values]).toEqual(
      EXTENSION_TARGETS.map((t) => t.id),
    );
    // Every setting written through writeUserSetting (repos/userSettings.ts), and the theme.
    expect([...SETTING_NAMES].sort()).toEqual(
      [
        'theme',
        DAILY_REVIEW_CAP_SETTING,
        CONSUMER_VETO_SETTING,
        ALERT_SENDERS_SETTING,
        RR_URL_SETTING,
        DOCUMENT_STORE_SETTING,
        MAIL_LABEL_SETTING,
        GMAIL_ADDRESS_SETTING,
        DISCOVERY_DEFAULT_CRON_SETTING,
        TOUR_SETTING,
        CHECKLIST_SETTING,
        NETWORK_BOARD_CHECK_SETTING,
      ].sort(),
    );
    const callers = FILES.flatMap(({ text }) =>
      [...text.matchAll(/writeUserSetting\(\s*\w+\s*,\s*\w+\s*,\s*([A-Z_]+)\b/g)].map((m) => m[1]!),
    );
    expect(new Set(callers)).toEqual(
      new Set([
        'DAILY_REVIEW_CAP_SETTING',
        'CONSUMER_VETO_SETTING',
        'GMAIL_ADDRESS_SETTING',
        'RR_URL_SETTING',
        'DOCUMENT_STORE_SETTING',
        'DISCOVERY_DEFAULT_CRON_SETTING',
        'ALERT_SENDERS_SETTING',
        'MAIL_LABEL_SETTING',
        'NETWORK_BOARD_CHECK_SETTING',
        'TOUR_SETTING',
        'CHECKLIST_SETTING',
      ]),
    );
  });
});

describe('what test setup loads (#345)', () => {
  it('db/gate.ts imports nothing of obs/ statically: it would load the catalog and @opportun/ai first', () => {
    // test/setup.ts imports db/gate.ts before any test file's vi.mock: a static import of the
    // logger there loads the catalog, @opportun/ai and its real providers, and every test that
    // mocks a provider then calls the real one (found merging #366, 44 tests reaching the network).
    const gate = FILES.find((f) => f.path === join('db', 'gate.ts'))!.text;
    expect(gate).not.toMatch(/^import [^;]*from '\.\.\/obs\//m);
  });
});
