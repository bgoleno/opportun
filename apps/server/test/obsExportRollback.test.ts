// When the exporters cannot be built (here: the export module fails to load, as with a broken
// install), the PUT that turned export on must not leave it stored as on, or GET would say export
// is on while nothing is sent (tl on https://github.com/bgoleno/opportun/pull/377). A file of its
// own, because the mock replaces obs/export/otlp.ts for every test in it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachedExporters, setCollecting } from '../src/obs';
import { stopExport } from '../src/obs/export/manager';
import { readExport } from '../src/obs/export/settings';
import { useApi } from './api';

vi.mock('../src/obs/export/otlp', () => {
  throw new Error('export module failed to load');
});

const boot = useApi();
const PASSWORD = 'correct horse battery';

afterEach(async () => {
  await stopExport();
  await setCollecting(false);
});

describe('PUT /api/v1/obs/export when the exporters cannot be built', () => {
  it('answers with an error and leaves the stored switch as it was', async () => {
    const { app, a } = await boot({ telemetryAllowPrivate: true });
    const on = await a.request({
      method: 'PUT',
      url: '/api/v1/obs/settings',
      payload: { collect: true },
    });
    expect(on.statusCode).toBe(200);
    const r = await a.request({
      method: 'PUT',
      url: '/api/v1/obs/export',
      payload: {
        password: PASSWORD,
        enabled: true,
        destination: { type: 'otlp', scheme: 'http', host: '127.0.0.1', port: 4318 },
      },
    });
    expect(r.statusCode).toBe(500);
    expect((await readExport(app.db)).enabled).toBe(false);
    expect(attachedExporters()).toEqual([]);
    const seen = (await a.request({ method: 'GET', url: '/api/v1/obs/export' })).json() as {
      enabled: boolean;
    };
    expect(seen.enabled).toBe(false);
  });
});
