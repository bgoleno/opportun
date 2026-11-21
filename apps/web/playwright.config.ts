// End-to-end tests (NFR-QLT1): the built SPA served by the real server, with AI, Google Docs,
// Gmail and job boards replaced by the server's env-gated fakes (apps/server/src/testSupport).
// Run with `pnpm --filter @opportun/web e2e`, which builds the SPA first.
//
// Two servers: the main one, where every flow registers its own user, and a seeded demo server
// (OPPORTUN_DEMO=1, the `demo` project, e2e/demo.spec.ts) for assisted apply on the demo's shared
// accounts and on an account made for one person (#547, slice 4 of #542).
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4317);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
/** A fresh database per run: the server is never reused across runs. */
const DATA_DIR = join(tmpdir(), `opportun-e2e-${PORT}`);

const DEMO_PORT = PORT + 1;
export const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}`;
/** The demo server's own database, seeded before it starts, and fresh per run as well. */
export const DEMO_DATA_DIR = join(tmpdir(), `opportun-e2e-demo-${DEMO_PORT}`);
/**
 * The shared accounts' passwords on the e2e demo server (seedDemo reads them from its
 * environment). Test values for a throwaway server, never a deployment's.
 */
export const DEMO_PASSWORDS = {
  admin: 'e2e demo admin password',
  user1: 'e2e demo user1 password',
  user2: 'e2e demo user2 password',
  user3: 'e2e demo user3 password',
  user4: 'e2e demo user4 password',
} as const;

/**
 * The demo server's database, SQLite, named outright. A web server's command, and a CLI a test
 * runs, get this runner's own environment under their entries, and CI's postgres leg sets
 * DB_DIALECT and DATABASE_URL for the whole job. Inherited, the demo seed went into the main
 * server's Postgres database, whose admin registration then found the demo's users
 * (registration_closed). Everything that opens the demo's database spreads this.
 */
export const DEMO_DB_ENV = { DB_DIALECT: 'sqlite', DATABASE_URL: '', DB_SSL: '' } as const;

/** The server's env-gated fakes, the same on both servers. */
const FAKES = {
  LOG_LEVEL: 'warn',
  OPPORTUN_AI_MOCK: '1',
  OPPORTUN_DOCS_MOCK: '1',
  OPPORTUN_GMAIL_MOCK: '1',
  OPPORTUN_SOURCE_MOCK: '1',
  OPPORTUN_OAUTH_MOCK: '1',
} as const;

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
  projects: [
    { name: 'chromium', testIgnore: 'demo.spec.ts', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'demo',
      testMatch: 'demo.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: DEMO_URL },
    },
  ],
  webServer: [
    {
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
        ...FAKES,
        // Assisted apply (#79), on as unset would be (#455), and named so e2e/assistedApply.spec.ts
        // can rely on it. Its feature-off view is checked there by answering the route as the
        // server does with the flag off.
        OPPORTUN_SUBMISSIONS: '1',
        // The e2e suite runs on either engine: CI's e2e (postgres) variant passes these
        // through; locally they are unset and the server stays on SQLite in DATA_DIR.
        // An empty value counts as unset: the CI sqlite leg defines these as '' via the
        // matrix expression.
        ...(process.env.DB_DIALECT ? { DB_DIALECT: process.env.DB_DIALECT } : {}),
        ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
        ...(process.env.DB_SSL ? { DB_SSL: process.env.DB_SSL } : {}),
      },
    },
    {
      // The demo as deploy/compose.demo.yml runs it: seeded first (seedDemo, its three gates
      // passed by these settings), then started. Always on SQLite, the demo's decided engine
      // (#280), even on CI's postgres leg: the seed refuses a database with users other than its
      // own, so it could never share the main server's. Its nightly reset (DEMO_RESET_CRON) is
      // the only scheduled job that would disturb a run, and only one started at that minute.
      command: `rm -rf "${DEMO_DATA_DIR}" && node --import tsx src/cli/seedDemo.ts && node --import tsx src/index.ts`,
      cwd: '../server',
      url: `${DEMO_URL}/healthz`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        PORT: String(DEMO_PORT),
        DATA_DIR: DEMO_DATA_DIR,
        OPPORTUN_BASE_URL: DEMO_URL,
        OPPORTUN_MASTER_KEY: randomBytes(32).toString('hex'),
        ...FAKES,
        OPPORTUN_DEMO: '1',
        // What deploy/compose.demo.yml sets, so the seed knows the demo overlay is applied.
        OPPORTUN_DEMO_SEED_ACK: '1',
        OPPORTUN_DEMO_ADMIN_PASSWORD: DEMO_PASSWORDS.admin,
        OPPORTUN_DEMO_USER1_PASSWORD: DEMO_PASSWORDS.user1,
        OPPORTUN_DEMO_USER2_PASSWORD: DEMO_PASSWORDS.user2,
        OPPORTUN_DEMO_USER3_PASSWORD: DEMO_PASSWORDS.user3,
        OPPORTUN_DEMO_USER4_PASSWORD: DEMO_PASSWORDS.user4,
        // Stored per account by the seed and never called: OPPORTUN_AI_MOCK answers every AI
        // call, and the apply path makes none.
        OPPORTUN_DEMO_AI_KEY: 'sk-ant-e2e-not-a-real-key',
        // On, as unset would be: the one switch for everyone, the demo included (#545).
        OPPORTUN_SUBMISSIONS: '1',
        ...DEMO_DB_ENV,
      },
    },
  ],
});
