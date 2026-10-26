// Development launcher for `pnpm dev`: fills in local defaults (port 8080, a data dir
// under apps/server/data, a generated master key kept beside it) and starts the server.
// Real deployments configure the environment explicitly; nothing here runs in production.
/* eslint-disable security/detect-non-literal-fs-filename -- dev-only launcher; paths come
   from DATA_DIR or this file's location, never from a request. */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const dataDir = resolve(process.env.DATA_DIR ?? join(here, '..', 'data', 'dev'));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const keyFile = join(dataDir, 'master.key');
if (
  (process.env.OPPORTUN_MASTER_KEY ?? '') === '' &&
  (process.env.OPPORTUN_MASTER_KEY_FILE ?? '') === ''
) {
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    console.log(`[dev] generated a development master key at ${keyFile}`);
  }
  process.env.OPPORTUN_MASTER_KEY_FILE = keyFile;
}
process.env.DATA_DIR = dataDir;
process.env.PORT ??= '8080';
// The browser talks to Vite on 5173, which proxies /api here.
process.env.OPPORTUN_BASE_URL ??= 'http://localhost:5173';

const { main } = await import('../src/index');
await main();
