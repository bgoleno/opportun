// https://github.com/bgoleno/opportun/issues/819 (sec's sweep): the Reactive Resume key save, the
// telemetry export settings and the Collect switch stored their change, and for export started
// sending to the new destination, then wrote their audit row outside that transaction. A failed
// audit write left the change, and data going to a new destination, with no record of it. Each now
// writes its audit row in the change's transaction, and export starts only after that commit.
//
// The failure is injected at the audit step itself: the real insert runs, through whatever
// executor the step passed, and then the step throws.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRrBaseUrl, rrKeySet } from '../src/adapters/reactiveResume';
import { auditLog } from '../src/db/schema';
import { attachedExporters, isCollecting, setCollecting } from '../src/obs';
import { readCollect } from '../src/obs/config';
import { stopExport } from '../src/obs/export/manager';
import { readExport } from '../src/obs/export/settings';
import { useApi } from './api';
import { fakeGoogle } from './fakeGoogle';
import { fakeReactiveResume, RR_ORIGIN } from './fakeReactiveResume';
import { PASSWORD, type TestClient } from './isolation';

let failing: string | null = null;

vi.mock('../src/lib/audit', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/audit')>();
  return {
    ...real,
    audit: async (...args: Parameters<typeof real.audit>) => {
      await real.audit(...args);
      if (args[1] === failing) throw new Error('audit write failed');
    },
  };
});

afterEach(async () => {
  failing = null;
  await stopExport();
  await setCollecting(false);
});

const boot = useApi(() => ({
  build: { google: fakeGoogle(), rrFetch: fakeReactiveResume().fetch },
}));

const rowsOf = async (app: FastifyInstance, event: string) =>
  (await app.db.select().from(auditLog).where(eq(auditLog.event, event)).all()).length;

async function failing500(
  app: FastifyInstance,
  event: string,
  step: () => ReturnType<TestClient['request']>,
) {
  const before = await rowsOf(app, event);
  failing = event;
  const res = await step();
  failing = null;
  expect(res.statusCode, res.body).toBe(500);
  // Rolled back with the change.
  expect(await rowsOf(app, event)).toBe(before);
}

describe('the Collect switch: the audit row commits with it (#819)', () => {
  it('a switch whose audit write fails leaves Collect off, stored and in the process', async () => {
    const { app, a } = await boot();
    await failing500(app, 'telemetry.collect.updated', () =>
      a.request({ method: 'PUT', url: '/api/v1/obs/settings', payload: { collect: true } }),
    );
    expect(await readCollect(app.db)).toBe(false);
    expect(isCollecting()).toBe(false);
  });
});

describe('the telemetry export settings: the audit row commits with them (#819)', () => {
  it('a save whose audit write fails stores nothing and sends nothing to the new destination', async () => {
    const { app, a } = await boot({ telemetryAllowPrivate: true });
    const on = await a.request({
      method: 'PUT',
      url: '/api/v1/obs/settings',
      payload: { collect: true },
    });
    expect(on.statusCode).toBe(200);
    const before = await readExport(app.db);
    await failing500(app, 'telemetry.export.updated', () =>
      a.request({
        method: 'PUT',
        url: '/api/v1/obs/export',
        payload: {
          password: PASSWORD,
          enabled: true,
          destination: { type: 'otlp', scheme: 'http', host: '127.0.0.1', port: 4318 },
        },
      }),
    );
    expect(await readExport(app.db)).toEqual(before);
    expect(attachedExporters()).toEqual([]);
  });
});

describe('the Reactive Resume key: the audit row commits with it (#819)', () => {
  it('a save whose audit write fails stores no key and no address', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    await failing500(app, 'integration.reactive_resume_saved', () =>
      a.request({
        method: 'PUT',
        url: '/api/v1/integrations/reactive-resume',
        payload: { baseUrl: RR_ORIGIN, apiKey: 'rr-key-819-0123456789' },
      }),
    );
    expect(await rrKeySet(app.db, ctx)).toBe(false);
    expect(await readRrBaseUrl(app.db, ctx)).toBeNull();
  });
});

// sec and tl on #826 (as #815 ruled for removals): turning Collect or export off is a stop. It
// commits and takes effect first, and is recorded after, so a failed audit write never leaves
// export sending after the admin turned it off.
describe('turning telemetry off holds when its audit write fails (#819, sec and tl on #826)', () => {
  const exportTo127 = (a: TestClient, enabled: boolean) =>
    a.request({
      method: 'PUT',
      url: '/api/v1/obs/export',
      payload: {
        password: PASSWORD,
        enabled,
        ...(enabled
          ? { destination: { type: 'otlp', scheme: 'http', host: '127.0.0.1', port: 4318 } }
          : {}),
      },
    });

  async function exporting(a: TestClient) {
    const on = await a.request({
      method: 'PUT',
      url: '/api/v1/obs/settings',
      payload: { collect: true },
    });
    expect(on.statusCode).toBe(200);
    expect((await exportTo127(a, true)).statusCode).toBe(200);
    expect(attachedExporters().length).toBeGreaterThan(0);
  }

  async function stopped500(event: string, step: () => ReturnType<TestClient['request']>) {
    failing = event;
    const res = await step();
    failing = null;
    expect(res.statusCode, res.body).toBe(500);
  }

  it('Collect turned off stays off, and export with it', async () => {
    const { app, a } = await boot({ telemetryAllowPrivate: true });
    await exporting(a);
    await stopped500('telemetry.collect.updated', () =>
      a.request({ method: 'PUT', url: '/api/v1/obs/settings', payload: { collect: false } }),
    );
    expect(await readCollect(app.db)).toBe(false);
    expect(isCollecting()).toBe(false);
    expect((await readExport(app.db)).enabled).toBe(false);
    expect(attachedExporters()).toEqual([]);
  });

  it('export turned off stays off, and sends nothing', async () => {
    const { app, a } = await boot({ telemetryAllowPrivate: true });
    await exporting(a);
    await stopped500('telemetry.export.updated', () => exportTo127(a, false));
    expect((await readExport(app.db)).enabled).toBe(false);
    expect(attachedExporters()).toEqual([]);
  });
});
