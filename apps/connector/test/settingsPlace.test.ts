// Someone with a revoked or stolen device token reads these messages to find where to act, so
// they have to name the place as the app shows it. The card was renamed once and the connector
// kept the old name (https://github.com/bgoleno/opportun/issues/235). This scans the source
// rather than each message's output so that a message added later is covered too, and it reads
// the app's own files so that renaming the card again fails here.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PLACE = 'Settings > Integrations > Extensions and Connectors';

const CONNECTOR = new URL('../', import.meta.url);
const SETTINGS_ROUTES = new URL('../../web/src/routes/settings/', import.meta.url);
const read = (path: string, base: URL = CONNECTOR) => readFileSync(new URL(path, base), 'utf8');

/** Rejoins a message split across string pieces and a doc line wrapped inside the name. */
const asRead = (text: string) => text.replace(/['"`]\s*\+\s*['"`]/g, '').replace(/\s+/g, ' ');

/**
 * Every use of a word places are named with, outside PLACE. It matches the words, not a separator,
 * so "the Devices page" and "Settings/Integrations/Devices" fail too. macOS's System Settings is
 * allowed. An ordinary use such as "other devices" fails as well: that false alarm is expected, so
 * reword the message rather than loosen this. A place named with none of these words, such as "the
 * Connectors card", still passes.
 */
const wrongPlaces = (text: string) =>
  asRead(text)
    .split(PLACE)
    .join('')
    .match(/(?<!System )\bSettings\b|\bIntegrations\b|\bDevices\b/gi) ?? [];

const SCANNED = [
  'README.md',
  ...readdirSync(new URL('src/', CONNECTOR), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `src/${file}`),
];

describe('the place connector messages send a user to', () => {
  it('is what the app shows: the Integrations tab and its card', () => {
    expect(read('route.tsx', SETTINGS_ROUTES)).toContain("label: 'Integrations'");
    expect(read('integrations.tsx', SETTINGS_ROUTES)).toContain('<DevicesCard');
    expect(read('-devices.tsx', SETTINGS_ROUTES)).toContain(
      '<CardTitle>Extensions and Connectors</CardTitle>',
    );
  });

  it.each(SCANNED)('is the only one %s names', (file) => {
    expect(wrongPlaces(read(file))).toEqual([]);
  });

  // Without these, the scan above would pass on files it never read or on text it cannot match.
  it.each(['README.md', 'src/cli.ts', 'src/config.ts', 'src/sync.ts'])(
    'is named by %s, so the scan has something to check',
    (file) => {
      expect(SCANNED).toContain(file);
      expect(asRead(read(file)).includes(PLACE)).toBe(true);
    },
  );

  it.each([
    ['the old name', 'Create one under Settings > Integrations > Devices.'],
    ['a tab with no card', 'Create one under Settings > Devices, then run init.'],
    ['a name split across string pieces', "'under Settings > ' +\n  'Integrations > Devices.'"],
    ['a name wrapped across doc lines', 'under Settings >\nIntegrations > Devices.'],
    ['the card without Settings', 'Create one under Integrations > Devices.'],
    ['the old card in plain words', 'Create one on the Devices page in Settings.'],
    ['the tab in plain words', 'Create one on the Integrations tab of Settings.'],
    ['ASCII arrows', 'Create one under Settings -> Integrations -> Devices.'],
    ['arrows', 'Create one under Settings → Integrations → Devices.'],
    ['slashes', 'Create one under Settings/Integrations/Devices.'],
    ['lower case', 'Create one under settings > integrations > devices.'],
    ['a level below the place', `Create one under ${PLACE} > Devices.`],
  ])('the check catches %s', (_label, text) => {
    expect(wrongPlaces(text)).not.toEqual([]);
  });

  it.each([
    ['the place itself', `Create one in Opportun under ${PLACE}.`],
    ['the place wrapped across doc lines', PLACE.replace('Integrations', '\n  Integrations')],
    ["macOS's own settings", "'Allow it in System Settings > ' +\n  'Privacy & Security.'"],
  ])('the check allows %s', (_label, text) => {
    expect(wrongPlaces(text)).toEqual([]);
  });
});
