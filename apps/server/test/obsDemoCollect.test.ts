// Collect on the demo deployment (https://github.com/bgoleno/opportun/issues/360; sec's O5 on
// https://github.com/bgoleno/opportun/pull/359): with OPPORTUN_DEMO=1, Collect is off at boot
// and in the GET whatever the stored row says. Only an operator reaches that state, by turning
// the demo flag on over a database that had Collect on, and the nightly demo reset does not
// clear the row (it belongs to no user). The stored row is left alone. Without the demo flag
// the stored value applies as before.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Config } from '../src/config';
import { obsMetricPoints, settings } from '../src/db/schema';
import { flushNow, isCollecting, obs, setCollecting } from '../src/obs';
import { collectInEffect, OBS_COLLECT_KEY, startObsFromSettings } from '../src/obs/config';
import { useApi } from './api';
import { countRows, sqliteOnly } from './db';

const boot = useApi();

afterEach(async () => {
  await setCollecting(false);
});

async function storeCollectOn(app: FastifyInstance) {
  await app.db
    .insert(settings)
    .values({ key: OBS_COLLECT_KEY, userId: null, value: true, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value: true } })
    .run();
}

/** One value through the store, then the rows the three telemetry tables hold. */
async function recordAndCount(app: FastifyInstance): Promise<number> {
  obs.record('opportun.job.duration', 1, { 'opportun.job.outcome': 'done' });
  await flushNow();
  return countRows(app, obsMetricPoints);
}

describe('the rule: Collect in effect (#360)', () => {
  it('is off on the demo whatever is stored, and the stored value elsewhere', async () => {
    const { app } = await boot();
    expect(await collectInEffect(app.db, { demo: false })).toBe(false);
    await storeCollectOn(app);
    expect(await collectInEffect(app.db, { demo: false })).toBe(true);
    expect(await collectInEffect(app.db, { demo: true })).toBe(false);
  });

  it('at boot: a stored true on the demo does not collect; the non-demo control does', async () => {
    const { app } = await boot();
    await storeCollectOn(app);
    await startObsFromSettings(app.db, app.log, { demo: true });
    expect(isCollecting()).toBe(false);
    expect(await recordAndCount(app)).toBe(0);

    await startObsFromSettings(app.db, app.log, { demo: false });
    expect(isCollecting()).toBe(true);
    expect(await recordAndCount(app)).toBeGreaterThan(0);
    // The stored row is left alone: it means something again if the demo flag is removed.
    const row = (await app.db.select().from(settings).all()).find((r) => r.key === OBS_COLLECT_KEY);
    expect(row?.value).toBe(true);
  });

  it('in the GET: the demo answers false over a stored true', async () => {
    const { app, a } = await boot({ demo: true });
    await storeCollectOn(app);
    const get = await a.request({ method: 'GET', url: '/api/v1/obs/settings' });
    expect(get.json()).toEqual({ collect: false });
  });
});

// The whole path, app.ts included: a database with Collect stored on, booted again as the demo.
// SQLite only: it reopens the same data directory, which the Postgres harness does not offer.
describe.runIf(sqliteOnly)('booting the demo over a database with Collect on (#360)', () => {
  const dirs: string[] = [];
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((x) => x.close()));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function bootOn(dataDir: string, masterKey: Buffer, demo: boolean) {
    const cfg: Config = {
      port: 0,
      host: '127.0.0.1',
      dataDir,
      sqliteDir: dataDir,
      baseUrl: 'http://localhost:3000',
      masterKey,
      logLevel: 'silent',
      db: { dialect: 'sqlite' },
      demo,
      aiAllowLoopbackHttp: false,
      trustedProxies: [],
    };
    const app = await buildApp(cfg, { jobRunner: false });
    apps.push(app);
    await app.ready();
    return app;
  }

  it.each([
    ['the demo', true, false],
    ['the non-demo control', false, true],
  ])('%s', async (_name, demo, collects) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'opportun-test-'));
    dirs.push(dataDir);
    const key = randomBytes(32);
    const first = await bootOn(dataDir, key, false);
    await storeCollectOn(first);
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const app = await bootOn(dataDir, key, demo);
    expect(isCollecting()).toBe(collects);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const rows = await recordAndCount(app);
    if (collects) expect(rows).toBeGreaterThan(0);
    else expect(rows).toBe(0);
  });
});
