// Shared setup for route tests: a fresh app with two signed-in users (a is the admin).
import type { FastifyInstance } from 'fastify';
import { afterEach } from 'vitest';
import type { Config } from '../src/config';
import { testApp, type TestAppOptions } from './helpers';
import { registerTwoUsers, type TestClient } from './isolation';

export interface ApiEnv {
  app: FastifyInstance;
  dataDir: string;
  a: TestClient;
  b: TestClient;
}

/**
 * Returns a factory that boots one app per call; every app it boots is closed after the
 * test. Call it at describe/module scope so the afterEach hook is registered.
 */
export function useApi(
  opts?: () => TestAppOptions,
): (overrides?: Partial<Config>) => Promise<ApiEnv> {
  const open: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((app) => app.close()));
  });
  return async (overrides = {}) => {
    const { app, dataDir } = await testApp(overrides, opts?.() ?? {});
    open.push(app);
    const { a, b } = await registerTwoUsers(app);
    return { app, dataDir, a, b };
  };
}
