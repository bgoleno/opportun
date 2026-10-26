// A separate process that boots the full app against a shared data dir. boot.test.ts starts
// several of these, waits until each has loaded its modules, then releases them together
// so their migration runs overlap the way two containers starting at once would.
import { randomBytes } from 'node:crypto';
import { buildApp } from '../../src/app';
import { queryOne } from '../db';

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error('usage: bootChild <dataDir>');

process.stdout.write('ready\n');
process.stdin.once('data', () => {
  buildApp(
    {
      port: 0,
      host: '127.0.0.1',
      dataDir,
      sqliteDir: dataDir,
      baseUrl: 'http://localhost:3000',
      masterKey: randomBytes(32),
      logLevel: 'silent',
      db: { dialect: 'sqlite' },
      demo: false,
      aiAllowLoopbackHttp: false,
      trustedProxies: [],
    },
    { jobRunner: false },
  )
    .then(async (app) => {
      const row = (await queryOne(app, 'SELECT count(*) AS n FROM __drizzle_migrations')) as {
        n: number;
      };
      await app.close();
      process.stdout.write(`${JSON.stringify({ ok: true, migrations: row.n })}\n`);
      process.exit(0);
    })
    .catch((err: unknown) => {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: String(err), stack: err instanceof Error ? err.stack : undefined })}\n`,
      );
      process.exit(1);
    });
});
