// An empty ANTHROPIC_BASE_URL or OPENAI_BASE_URL is unset (https://github.com/bgoleno/opportun/issues/423).
// deploy/compose.yml passes both as `${VAR:-}`, an empty string when the user's .env does not set
// them. The AI SDK creates its default providers when its module is evaluated, reads both
// variables from the environment itself, and throws "baseURL must be a non-empty string" on an
// empty one, so the process stopped before the server's own code ran (qa on #421: a crash loop).
// The server's own reader already treats empty as unset (operatorBaseUrls), so a test that
// called it, or loadConfig, would pass without the fix: these tests start the real processes.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SERVER = join(__dirname, '..');
const SRC = join(SERVER, 'src');
const SDK_REFUSAL = 'baseURL must be a non-empty string';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

/**
 * A minimal environment, built from nothing rather than from this process's: on CI's Postgres leg
 * the suite's own DB_DIALECT and DATABASE_URL must not reach the child, and a developer's own
 * ANTHROPIC_BASE_URL must not decide the result.
 */
function childEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'production',
    LOG_LEVEL: 'warn',
    ...extra,
  };
}

interface Run {
  code: number | null;
  stderr: string;
}

/** Runs `file` under tsx with `env`, and resolves when it exits. */
function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', file, ...args], {
      cwd: SERVER,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

/**
 * Starts the real server (src/index.ts, the image's CMD) with `vars` on a fresh data directory and
 * SQLite, and resolves with /healthz's body once it answers, or with how the process ended if it
 * exits first.
 */
async function startAndProbe(
  vars: NodeJS.ProcessEnv,
): Promise<{ healthz: unknown } | { exited: Run }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'opportun-empty-ai-url-'));
  temps.push(dataDir);
  const port = await freePort();
  const env = childEnv({
    OPPORTUN_MASTER_KEY: 'ab'.repeat(32),
    OPPORTUN_BASE_URL: `http://localhost:${port}`,
    OPPORTUN_HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    DB_DIALECT: 'sqlite',
    ...vars,
  });
  const child = spawn(process.execPath, ['--import', 'tsx', join(SRC, 'index.ts')], {
    cwd: SERVER,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ exited: Run }>((resolve) => {
    child.on('exit', (code) => resolve({ exited: { code, stderr } }));
  });
  const healthy = (async (): Promise<{ healthz: unknown }> => {
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.ok) return { healthz: await res.json() };
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  try {
    return await Promise.race([healthy, exited]);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
  }
}

describe('an empty AI base URL is unset (issue 423)', () => {
  // The control first: unset, the server starts, so a red below is the empty value's doing.
  const CASES: [string, NodeJS.ProcessEnv][] = [
    ['neither set', {}],
    ['ANTHROPIC_BASE_URL empty', { ANTHROPIC_BASE_URL: '' }],
    ['OPENAI_BASE_URL empty', { OPENAI_BASE_URL: '' }],
    ['both empty', { ANTHROPIC_BASE_URL: '', OPENAI_BASE_URL: '' }],
    // The server's own reader trims (operatorBaseUrls), and the SDK refuses blanks as well.
    ['ANTHROPIC_BASE_URL blank', { ANTHROPIC_BASE_URL: '  ' }],
  ];

  it.each(CASES)(
    'the server starts and answers /healthz: %s',
    async (_name, vars) => {
      const result = await startAndProbe(vars);
      expect(result, JSON.stringify(result)).toMatchObject({
        healthz: { status: 'ok', db: 'ok' },
      });
    },
    60_000,
  );

  it('a CLI run through `docker compose run opportun` loads too: copyToPostgres reaches its usage check', async () => {
    // Every CLI loads the AI SDK through its imports, and compose hands a `run` the same
    // environment as the server. Exit 2 is the CLI's own "bad usage": it got as far as main().
    const result = await run(
      join(SRC, 'cli', 'copyToPostgres.ts'),
      ['--no-such-flag'],
      childEnv({ ANTHROPIC_BASE_URL: '', OPENAI_BASE_URL: '' }),
    );
    expect(result.stderr).not.toContain(SDK_REFUSAL);
    expect(result.code, result.stderr).toBe(2);
  }, 60_000);

  it('every entry point imports the module first, before anything that can load the SDK', () => {
    // An entry point is a file that runs main() when started directly; the module must come
    // before every other import, since ES modules are evaluated in the order they are imported.
    const entries = [
      join(SRC, 'index.ts'),
      ...readdirSync(join(SRC, 'cli'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => join(SRC, 'cli', f)),
    ].filter((file) => readFileSync(file, 'utf8').includes('const entry = process.argv[1];'));
    expect(entries.length).toBeGreaterThan(4);
    for (const file of entries) {
      const first = readFileSync(file, 'utf8')
        .split('\n')
        .find((line) => line.startsWith('import '));
      expect(first, file).toMatch(/^import '(\.\.\/|\.\/)unsetEmptyAiBaseUrls';$/);
    }
  });
});
