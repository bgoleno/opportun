// The server raises Node's stack frame limit once, at startup
// (https://github.com/bgoleno/opportun/issues/436, qa on
// https://github.com/bgoleno/opportun/pull/429). Node keeps 10 frames by default, so an error
// thrown under 10 or more dependency frames lost Opportun's own frame before the log gate saw
// it, and collapsing the dependency's frames into one placeholder (#399) could not bring it back.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { rawRun, withTransaction } from '../src/db/client';
import { createLogger, raiseStackTraceLimit, STACK_TRACE_LIMIT } from '../src/obs/log';
import { openTestDb } from './helpers';

const DEFAULT = Error.stackTraceLimit;
afterEach(() => {
  Error.stackTraceLimit = DEFAULT;
});

/**
 * A dependency in a `node_modules` folder of its own, outside the install root: `deep(n)` calls
 * itself n times and then throws, so every frame above its caller is the dependency's.
 */
function dependency(): { deep: (n: number) => never; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'opportun-436-'));
  const pkg = join(dir, 'node_modules', 'deep-dep');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'index.cjs'),
    [
      'function deep(n) {',
      "  if (n === 0) throw new TypeError('thrown by the dependency');",
      '  return deep(n - 1);',
      '}',
      'module.exports = { deep };',
    ].join('\n'),
  );
  const load = createRequire(import.meta.url);
  return {
    ...(load(join(pkg, 'index.cjs')) as { deep: (n: number) => never }),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** What the log gate writes for an error that a dependency throws from 16 frames down. */
function loggedStack(): string[] {
  const dep = dependency();
  try {
    let caught: unknown;
    function callerInOpportun(): void {
      try {
        dep.deep(15);
      } catch (err) {
        caught = err;
      }
    }
    callerInOpportun();
    const lines: string[] = [];
    createLogger({ level: 'error', stream: { write: (l) => lines.push(l) } }).error(
      { err: caught },
      'unhandled error',
    );
    const [record] = lines.map((l) => JSON.parse(l) as { stack?: string[] });
    return record?.stack ?? [];
  } finally {
    dep.done();
  }
}

describe('the stack frame limit (#436)', () => {
  it('an error a dependency throws under 16 of its own frames logs the Opportun frame that called it', () => {
    raiseStackTraceLimit();
    const stack = loggedStack();
    expect(stack[0]).toBe('at <external>');
    expect(stack).toContainEqual(
      expect.stringMatching(
        /^at callerInOpportun \(apps\/server\/test\/stackTraceLimit\.test\.ts:\d+:\d+\)$/,
      ),
    );
  });

  it('at Node’s default of 10 frames, the same error loses that frame: the reason for the setting', () => {
    expect(Error.stackTraceLimit).toBe(10);
    expect(loggedStack()).toEqual(['at <external>']);
  });

  it('db/client.ts’s short stack for a transaction’s holder restores the raised limit', async () => {
    raiseStackTraceLimit();
    const opened = await openTestDb();
    try {
      // isTestRun: false takes the production path, which names the holder from a short stack.
      await withTransaction(opened.handle.db, (tx) => rawRun(tx, sql`SELECT 1`), {
        isTestRun: false,
      });
      expect(Error.stackTraceLimit).toBe(STACK_TRACE_LIMIT);
    } finally {
      await opened.close();
    }
  });

  it('the server sets it when it starts, before it reads its configuration', () => {
    const child = fileURLToPath(new URL('./fixtures/startupLimitChild.ts', import.meta.url));
    // No configuration at all: main() stops at the first missing setting.
    const res = spawnSync(process.execPath, ['--import', 'tsx', child], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    const line = res.stdout.split('\n').find((l) => l.startsWith('{'));
    expect(line, res.stderr).toBeDefined();
    expect(JSON.parse(line!)).toEqual({ limit: STACK_TRACE_LIMIT, stoppedAt: 'ConfigError' });
  });
});
