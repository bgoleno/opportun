import { describe, expect, it } from 'vitest';
import {
  alertSenders,
  DEFAULT_ALERT_SENDERS,
  isAlertDigest,
} from '../src/adapters/sources/alertEmail';
import { useApi } from './api';
import { queryOne } from './db';

const boot = useApi();

describe('theme setting', () => {
  it('defaults to auto, persists per user under a namespaced key', async () => {
    const { app, a, b } = await boot();
    expect((await a.request({ method: 'GET', url: '/api/v1/settings/theme' })).json()).toEqual({
      pref: 'auto',
    });

    const set = await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/theme',
      payload: { pref: 'dark' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ pref: 'dark' });
    expect((await a.request({ method: 'GET', url: '/api/v1/settings/theme' })).json()).toEqual({
      pref: 'dark',
    });
    // Another user's preference is independent.
    expect((await b.request({ method: 'GET', url: '/api/v1/settings/theme' })).json()).toEqual({
      pref: 'auto',
    });

    await a.request({ method: 'PATCH', url: '/api/v1/settings/theme', payload: { pref: 'light' } });
    const row = (await queryOne(
      app,
      'SELECT user_id AS "userId", value FROM settings WHERE key = ?',
      `theme:${a.userId}`,
    )) as { userId: string; value: string };
    expect(row.userId).toBe(a.userId);
    expect(JSON.parse(row.value)).toBe('light');
  });

  it('rejects unknown values', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/theme',
      payload: { pref: 'purple' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('requires a session and a CSRF token', async () => {
    const { app, a } = await boot();
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/theme' })).statusCode).toBe(
      401,
    );
    const noCsrf = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/theme',
      payload: { pref: 'dark' },
      cookies: { opportun_session: a.session },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});

// Issue #15: the list (alertEmail.ts) always existed and was always read with defaults, but
// nothing could write it, so only LinkedIn's and Indeed's default addresses were ever in effect.
describe('alert senders setting', () => {
  it('defaults to LinkedIn and Indeed until configured, usingDefaults true', async () => {
    const { a } = await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/settings/alert-senders' });
    expect(res.json()).toEqual({
      senders: [...DEFAULT_ALERT_SENDERS],
      usingDefaults: true,
      defaults: [...DEFAULT_ALERT_SENDERS],
    });
  });

  it('persists an explicit list, usingDefaults false, independent per user', async () => {
    const { a, b } = await boot();
    const set = await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/alert-senders',
      payload: { senders: ['alerts@ziprecruiter.example', ...DEFAULT_ALERT_SENDERS] },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({
      senders: ['alerts@ziprecruiter.example', ...DEFAULT_ALERT_SENDERS],
      usingDefaults: false,
      defaults: [...DEFAULT_ALERT_SENDERS],
    });
    const get = await a.request({ method: 'GET', url: '/api/v1/settings/alert-senders' });
    expect(get.json()).toMatchObject({ usingDefaults: false });
    // Another user is unaffected.
    expect(
      (await b.request({ method: 'GET', url: '/api/v1/settings/alert-senders' })).json(),
    ).toMatchObject({ usingDefaults: true });
  });

  it('lowercases and trims addresses on write', async () => {
    const { app, a } = await boot();
    await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/alert-senders',
      payload: { senders: ['  Alerts@Example.com  '] },
    });
    expect(await alertSenders(app.db, { userId: a.userId, isAdmin: false })).toEqual([
      'alerts@example.com',
    ]);
  });

  it('an explicit empty list is a real state, distinct from unconfigured', async () => {
    // Principle 6: [] is not "ignore me, use the defaults" — it is "match nothing", and
    // isAlertDigest must actually stop matching the defaults once that is what was asked for.
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    expect(await isAlertDigest(app.db, ctx, DEFAULT_ALERT_SENDERS[0]!)).toBe(true);

    const set = await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/alert-senders',
      payload: { senders: [] },
    });
    expect(set.json()).toEqual({
      senders: [],
      usingDefaults: false,
      defaults: [...DEFAULT_ALERT_SENDERS],
    });
    expect(await isAlertDigest(app.db, ctx, DEFAULT_ALERT_SENDERS[0]!)).toBe(false);
    expect(await alertSenders(app.db, ctx)).toEqual([]);
  });

  it('senders: null resets to defaults by removing the override, not by copying it', async () => {
    const { app, a } = await boot();
    await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/alert-senders',
      payload: { senders: ['custom@example.com'] },
    });
    const reset = await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/alert-senders',
      payload: { senders: null },
    });
    expect(reset.json()).toEqual({
      senders: [...DEFAULT_ALERT_SENDERS],
      usingDefaults: true,
      defaults: [...DEFAULT_ALERT_SENDERS],
    });
    // The row is gone, not holding a frozen copy of today's defaults.
    expect(
      await queryOne(app, 'SELECT 1 FROM settings WHERE key = ?', `alert_senders:${a.userId}`),
    ).toBeUndefined();
  });

  it('rejects a malformed address and an over-long list', async () => {
    const { a } = await boot();
    const tooShort = await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/alert-senders',
      payload: { senders: ['x'] },
    });
    expect(tooShort.statusCode).toBe(400);
    expect(tooShort.json().error.code).toBe('validation');

    const tooMany = await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/alert-senders',
      payload: { senders: Array.from({ length: 101 }, (_, i) => `a${i}@example.com`) },
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it('requires a session and a CSRF token', async () => {
    const { app, a } = await boot();
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/settings/alert-senders' })).statusCode,
    ).toBe(401);
    const noCsrf = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/alert-senders',
      payload: { senders: [] },
      cookies: { opportun_session: a.session },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});
