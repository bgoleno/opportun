// A setting that takes a file is named, never quoted, when the file can't be read: the setting and
// the system's code (lib/fileSetting.ts).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { loadDbConfig, loadMasterKey } from '../src/config';
import { credsFromEnv, DEMO_SEED_ACK_KEY } from '../src/lib/demo/seed';
import { fileSettingProblem } from '../src/lib/fileSetting';

const CANARY = 'canary-value-0123456789';
const temp = mkdtempSync(join(tmpdir(), 'opportun-file-setting-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const DEMO = {
  OPPORTUN_MASTER_KEY: randomBytes(32).toString('hex'),
  OPPORTUN_BASE_URL: 'https://demo.example.com',
  DATA_DIR: temp,
  OPPORTUN_DEMO: '1',
  [DEMO_SEED_ACK_KEY]: '1',
  OPPORTUN_DEMO_ADMIN_PASSWORD: 'demo-admin-password-1',
  OPPORTUN_DEMO_USER1_PASSWORD: 'demo-user1-password-1',
  OPPORTUN_DEMO_USER2_PASSWORD: 'demo-user2-password-1',
  OPPORTUN_DEMO_USER3_PASSWORD: 'demo-user3-password-1',
  OPPORTUN_DEMO_USER4_PASSWORD: 'demo-user4-password-1',
};

const SETTINGS: [string, string, (value: string) => unknown][] = [
  [
    'OPPORTUN_MASTER_KEY_FILE',
    'the master key',
    (v) => loadMasterKey({ OPPORTUN_MASTER_KEY_FILE: v }),
  ],
  [
    'DATABASE_URL_FILE',
    'the URL',
    (v) => loadDbConfig({ DB_DIALECT: 'postgres', DATABASE_URL_FILE: v }),
  ],
  [
    'OPPORTUN_DEMO_AI_KEY_FILE',
    'the key',
    (v) => credsFromEnv({ ...DEMO, OPPORTUN_DEMO_AI_KEY_FILE: v }),
  ],
];

const thrownBy = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('nothing thrown');
};

describe.each(SETTINGS)("%s that can't be read", (setting, holds, load) => {
  it.each<[string, string, string]>([
    ['nothing there', CANARY, 'ENOENT'],
    ['too long for a path', CANARY.repeat(300), 'ENAMETOOLONG'],
    ['a folder', join(temp, '..', temp.split('/').at(-1) ?? ''), 'EISDIR'],
    ['a NUL in it', `${CANARY}\0`, 'ERR_INVALID_ARG_VALUE'],
  ])("is named, with the system's code: %s", (_what, value, code) => {
    const err = thrownBy(() => load(value));
    expect(err.message).toBe(
      `${setting} could not be read (${code}): it takes the path of a file holding ${holds}, not the value itself (value not shown)`,
    );
    // Nor anywhere else in the error: its stack, a cause, a property of its own.
    const whole = inspect(err, { depth: 10, showHidden: true });
    expect(whole).not.toContain(CANARY);
    expect(err.cause).toBeUndefined();
    expect(Object.keys(err).filter((k) => k !== 'name')).toEqual([]);
  });
});

describe('fileSettingProblem', () => {
  it.each<[string, unknown]>([
    ['no code', new Error(CANARY)],
    ['a code that is not one', Object.assign(new Error('x'), { code: CANARY })],
    ['a code with a value after it', Object.assign(new Error('x'), { code: `ENOENT ${CANARY}` })],
    ['not an error', CANARY],
    ['nothing', undefined],
  ])('keeps only a code: %s', (_what, err) => {
    const says = fileSettingProblem('SOME_FILE', 'it', err);
    expect(says).toMatch(/^SOME_FILE could not be read \(unknown\): /);
    expect(says).not.toContain(CANARY);
  });
});
