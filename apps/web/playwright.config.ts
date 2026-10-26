// End-to-end tests (NFR-QLT1): the built SPA served by the real server, with AI, Google Docs,
// Gmail and job boards replaced by the server's env-gated fakes (apps/server/src/testSupport).
// Run with `pnpm --filter @opportun/web e2e`, which builds the SPA first.
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4317);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
/** A fresh database per run: the server is never reused across runs. */
const DATA_DIR = join(tmpdir(), `opportun-e2e-${PORT}`);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  workers: 1,
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    colorScheme: 'light',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `rm -rf "${DATA_DIR}" && node --import tsx src/index.ts`,
    cwd: '../server',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      DATA_DIR,
      OPPORTUN_BASE_URL: BASE_URL,
      OPPORTUN_MASTER_KEY: randomBytes(32).toString('hex'),
      LOG_LEVEL: 'warn',
      OPPORTUN_AI_MOCK: '1',
      OPPORTUN_DOCS_MOCK: '1',
      OPPORTUN_GMAIL_MOCK: '1',
      OPPORTUN_SOURCE_MOCK: '1',
      OPPORTUN_OAUTH_MOCK: '1',
      // The e2e suite runs on either engine: CI's e2e (postgres) variant passes these
      // through; locally they are unset and the server stays on SQLite in DATA_DIR.
      // An empty value counts as unset: the CI sqlite leg defines these as '' via the
      // matrix expression.
      ...(process.env.DB_DIALECT ? { DB_DIALECT: process.env.DB_DIALECT } : {}),
      ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
      ...(process.env.DB_SSL ? { DB_SSL: process.env.DB_SSL } : {}),
    },
  },
});
