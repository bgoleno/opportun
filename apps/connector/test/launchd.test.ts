import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const PLIST = fileURLToPath(new URL('../../../deploy/opportun-connector.plist', import.meta.url));

describe('deploy/opportun-connector.plist', () => {
  it('runs watch as a restarting, throttled agent', async () => {
    const xml = await readFile(PLIST, 'utf8');
    expect(xml).toContain('<string>org.opportun.connector</string>');
    expect(xml).toMatch(/opportun-connector<\/string>\s*<string>watch<\/string>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>900<\/integer>/);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it('rotates its own log instead of letting launchd append to it forever (#21)', async () => {
    const xml = await readFile(PLIST, 'utf8');
    expect(xml).toMatch(
      /<key>OPPORTUN_CONNECTOR_LOG_FILE<\/key>\s*<string>[^<]*Library\/Logs\/opportun-connector\.log<\/string>/,
    );
    expect(xml).toMatch(/<key>StandardOutPath<\/key>\s*<string>\/dev\/null<\/string>/);
    expect(xml).toMatch(/<key>StandardErrorPath<\/key>\s*<string>\/dev\/null<\/string>/);
  });

  it.skipIf(process.platform !== 'darwin')('is a valid property list (plutil)', async () => {
    await promisify(execFile)('plutil', ['-lint', PLIST]);
  });
});
