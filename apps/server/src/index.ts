import { pathToFileURL } from 'node:url';
import { buildApp } from './app';
import { loadConfig } from './config';

/** Server entry point: load config, build the app, listen. */
export async function main(): Promise<void> {
  const cfg = loadConfig();
  // End-to-end fakes (OPPORTUN_*_MOCK=1, never in production): loaded only when asked for.
  const env = process.env;
  const wantsMocks = [
    env.OPPORTUN_AI_MOCK,
    env.OPPORTUN_DOCS_MOCK,
    env.OPPORTUN_GMAIL_MOCK,
    env.OPPORTUN_SOURCE_MOCK,
    env.OPPORTUN_OAUTH_MOCK,
  ].includes('1');
  const mocks = wantsMocks
    ? (await import('./testSupport/index')).testSupportFromEnv(env, cfg)
    : undefined;
  const app = await buildApp(cfg, mocks?.build ?? {});
  if (mocks !== undefined) {
    await mocks.register(app);
    app.log.warn({ mocks: mocks.enabled }, 'TEST MOCKS ENABLED: external provider calls are fake');
  }
  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ port: cfg.port, host: cfg.host });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    // Config errors are operator-facing; print the message plainly.
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
