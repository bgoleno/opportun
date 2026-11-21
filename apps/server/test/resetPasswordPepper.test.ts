// https://github.com/bgoleno/opportun/issues/568: the CLIs that set a password (the reset, and the
// demo's dedicated account) hash with the pepper set the server loads from its environment. Both
// used the current secret under version 1 whatever OPPORTUN_PEPPER_VERSION said, so after a
// rotation (version 2, with V1 the old secret) the password was stamped v1, checked against the
// old secret, and never signed in.
//
// Run the way an operator runs them (`node --import tsx src/cli/<cli>.ts ...`) in a child
// process, against the test app's SQLite folder. SQLite only: the child cannot reach the Postgres
// test database, and the fault does not depend on the database.
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_SEED_ACK_KEY, seedDemo, type SeedDemoCredentials } from '../src/cli/seedDemo';
import { pepperSet } from '../src/lib/pepperSet';
import { sqliteOnly } from './db';
import { testApp } from './helpers';

const OLD = 'old-pepper-0123456789abcdef';
const NEW = 'new-pepper-0123456789abcdef';
const PEPPER_ENV = {
  OPPORTUN_PEPPER: NEW,
  OPPORTUN_PEPPER_VERSION: '2',
  OPPORTUN_PEPPER_V1: OLD,
};
const CLI = new URL('../src/cli/resetPassword.ts', import.meta.url).pathname;
const DEMO_CLI = new URL('../src/cli/createDemoAccount.ts', import.meta.url).pathname;
const SERVER_DIR = new URL('..', import.meta.url).pathname;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Runs the CLI against `dataDir` with `env`; resolves with its exit code and output. */
function runCli(
  dataDir: string,
  args: string[],
  env: Record<string, string>,
  cli = CLI,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, ...env };
  // The test's own database settings would point the child elsewhere.
  delete childEnv.DB_DIALECT;
  delete childEnv.DATABASE_URL;
  delete childEnv.SQLITE_DIR;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      cwd: SERVER_DIR,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!sqliteOnly)('the CLI password reset under a rotated pepper (#568)', () => {
  it('gives a temporary password that signs in, with OPPORTUN_PEPPER_VERSION=2', async () => {
    const booted = await testApp({ peppers: pepperSet(2, { 1: OLD, 2: NEW }) });
    app = booted.app;
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'ada@example.com', password: 'correct horse battery', displayName: 'Ada' },
    });
    expect(registered.statusCode).toBe(201);

    const cli = await runCli(booted.dataDir, ['ada@example.com'], PEPPER_ENV);
    expect(cli.stderr).toBe('');
    expect(cli.code).toBe(0);
    const password = cli.stdout.trim();
    expect(password.length).toBeGreaterThanOrEqual(32);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ada@example.com', password },
      remoteAddress: '10.0.0.1',
    });
    expect(login.statusCode).toBe(200);
  }, 60_000);
});

describe.skipIf(!sqliteOnly)('the demo dedicated-account CLI under a rotated pepper (#568)', () => {
  const CREDS: SeedDemoCredentials = {
    adminPassword: 'demo admin password 1!',
    userPasswords: [
      'demo user1 password 1!',
      'demo user2 password 1!',
      'demo user3 password 1!',
      'demo user4 password 1!',
    ],
    aiApiKey: 'sk-ant-demo-fixture-key',
  };

  it('gives a password that signs in, with OPPORTUN_PEPPER_VERSION=2', async () => {
    const booted = await testApp({ peppers: pepperSet(2, { 1: OLD, 2: NEW }) });
    app = booted.app;
    // A seeded demo in the app's own database (a literal env, never process.env).
    await seedDemo(app.db, CREDS, undefined, {
      OPPORTUN_MASTER_KEY: 'ab'.repeat(32),
      OPPORTUN_DEMO: '1',
      [DEMO_SEED_ACK_KEY]: '1',
      OPPORTUN_BASE_URL: 'http://localhost:8080',
      DATA_DIR: booted.dataDir,
      ...PEPPER_ENV,
    });

    const cli = await runCli(
      booted.dataDir,
      ['reporter@example.com', 'A Reporter'],
      { ...PEPPER_ENV, OPPORTUN_DEMO: '1' },
      DEMO_CLI,
    );
    expect(cli.stderr).toContain('Created the dedicated demo account');
    expect(cli.code).toBe(0);
    const password = cli.stdout.trim();
    expect(password.length).toBeGreaterThanOrEqual(32);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'reporter@example.com', password },
      remoteAddress: '10.0.0.2',
    });
    expect(login.statusCode).toBe(200);
  }, 60_000);
});
