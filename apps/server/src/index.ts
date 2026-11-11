import { pathToFileURL } from 'node:url';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { createLogger, installProcessHandlers } from './obs/log';

/** Server entry point: load config, build the app, listen. */
export async function main(): Promise<void> {
  // Before anything else: a crash or a warning from here on goes through the log gate (#345).
  installProcessHandlers();
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
    app.log.warn(
      { 'opportun.mocks.count': mocks.enabled.length },
      'TEST MOCKS ENABLED: external provider calls are fake',
    );
  }
  const shutdown = (signal: string): void => {
    app.log.info({ 'opportun.process.signal': signal }, 'shutting down');
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
  // Fastify's own "Server listening at <address>" is not a catalogued message (14.8): this one is.
  app.log.info({ 'server.port': cfg.port }, 'server listening');
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    if (err instanceof ConfigError) {
      // A config error is operator-facing, and quotes only the operator's own environment,
      // before the app or any user data exists: its message is printed plainly, as the one way
      // to say which variable is wrong (design 14.9 keeps every other message to the catalog).
      process.stderr.write(`${err.message}\n`);
    } else {
      createLogger({ level: 'error' }).error({ err }, 'server failed to start');
    }
    process.exit(1);
  });
}
