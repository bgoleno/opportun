// A separate process that serves the app on a Postgres database with the server's process handlers
// (pgConnectionEnds.test.ts, https://github.com/bgoleno/opportun/issues/963): what an uncaught error
// ends, ends here, and not the test run.
import { randomBytes } from 'node:crypto';
import { buildApp } from '../../src/app';
import { PostgresConfig } from '../../src/config';
import { installProcessHandlers } from '../../src/obs/log';

// The address by environment, not as an argument others could list.
const url = process.env.PG_SERVER_CHILD_URL;
const dataDir = process.argv[2];
if (url === undefined || dataDir === undefined)
  throw new Error('usage: PG_SERVER_CHILD_URL=<url> pgServerChild <dir>');

installProcessHandlers();
const app = await buildApp(
  {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    sqliteDir: dataDir,
    baseUrl: 'http://localhost:3000',
    masterKey: randomBytes(32),
    logLevel: 'error',
    db: new PostgresConfig(url, 4, 'disable'),
    demo: false,
    aiAllowLoopbackHttp: false,
    telemetryAllowPrivate: false,
    trustedProxies: [],
  },
  { jobRunner: false },
);
const at = await app.listen({ port: 0, host: '127.0.0.1' });
process.stdout.write(`listening ${at}\n`);
