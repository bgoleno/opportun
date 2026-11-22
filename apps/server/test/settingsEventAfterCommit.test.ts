// https://github.com/bgoleno/opportun/issues/824 (tl on #822): writeUserSetting emitted its
// settings.updated event as it wrote the row, before the surrounding transaction committed
// (it is written inside transactions in submissionReview and reactiveResume), so a rolled-back
// write could still appear in the logs and the telemetry export. It now waits for the commit,
// through #822's afterCommit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../src/db/client';
import { obs } from '../src/obs';
import { writeUserSetting } from '../src/repos/userSettings';
import { useApi } from './api';

const boot = useApi();
let emitted: string[];

beforeEach(() => {
  emitted = [];
  vi.spyOn(obs, 'event').mockImplementation((name: string) => {
    emitted.push(name);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const settingEvents = () => emitted.filter((e) => e === 'settings.updated');

describe('settings.updated is emitted only once its write has committed (#824)', () => {
  it('a rolled-back transaction emits nothing', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    await expect(
      withTransaction(app.db, async (tx) => {
        await writeUserSetting(tx, ctx, 'theme', 'dark');
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(settingEvents()).toEqual([]);
  });

  it('a committed transaction emits once, after the commit', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    await withTransaction(app.db, async (tx) => {
      await writeUserSetting(tx, ctx, 'theme', 'dark');
      expect(settingEvents()).toEqual([]);
    });
    expect(settingEvents()).toEqual(['settings.updated']);
  });

  it('outside a transaction the write commits as it runs, and emits at once', async () => {
    const { app, a } = await boot();
    await writeUserSetting(app.db, { userId: a.userId, isAdmin: false }, 'theme', 'dark');
    expect(settingEvents()).toEqual(['settings.updated']);
  });
});
