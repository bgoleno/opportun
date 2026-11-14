// https://github.com/bgoleno/opportun/issues/568: the CLI password reset hashes with the pepper set
// the server loads from its environment. It used the current secret under version 1 whatever
// OPPORTUN_PEPPER_VERSION said, so after a rotation (version 2, with V1 the old secret) the
// temporary password was stamped v1, checked against the old secret, and never signed in.
//
// Run the way an operator runs it: `node --import tsx src/cli/resetPassword.ts <email>` in a child
// process, against the test app's SQLite folder. SQLite only: the child cannot reach the Postgres
// test database, and the fault does not depend on the database.
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
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
const SERVER_DIR = new URL('..', import.meta.url).pathname;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Runs the CLI against `dataDir` with `env`; resolves with its exit code and output. */
function runCli(
  dataDir: string,
  email: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, ...env };
  // The test's own database settings would point the child elsewhere.
  delete childEnv.DB_DIALECT;
  delete childEnv.DATABASE_URL;
  delete childEnv.SQLITE_DIR;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, email], {
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

    const cli = await runCli(booted.dataDir, 'ada@example.com', PEPPER_ENV);
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
