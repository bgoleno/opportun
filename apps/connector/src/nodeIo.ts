// The real implementations of the ConnectorIo seams. Everything else in the package is pure
// over ConnectorIo; this is the only module that touches the file system, the network,
// child processes or the terminal.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { Clock, ConnectorIo, FetchLike, FileSystem, OsascriptRunner, Prompt } from './types';

/** osascript output ceiling: a page of 100 messages at 500k characters is far below it. */
const MAX_OSASCRIPT_OUTPUT = 512 * 1024 * 1024;
/** One batch request, including a slow upload of up to ~12MB. */
const REQUEST_TIMEOUT_MS = 120_000;

export interface LogLimits {
  /** Rotate once the live file would exceed this many bytes. */
  maxBytes: number;
  /** Backups kept beyond the live file (.1 is newest, .<maxBackups> is dropped on rotation). */
  maxBackups: number;
}

/**
 * watch runs forever under launchd, which redirects its inherited stdout/stderr straight to one
 * file (StandardOutPath/StandardErrorPath) and keeps that fd open for the process's whole life
 * (#21). An external rotator like newsyslog renaming the file would not help: the already-open
 * fd keeps writing into the renamed inode until the process itself restarts, which `watch`'s
 * whole design (ride out errors, keep looping) makes rare. So nodeIo owns the file itself when
 * told to, and reopens a fresh one on rotation instead of relying on anyone else's cooperation.
 */
export const DEFAULT_LOG_LIMITS: LogLimits = { maxBytes: 5 * 1024 * 1024, maxBackups: 5 };

// `path` below is the operator-configured log path (OPPORTUN_CONNECTOR_LOG_FILE), never mail
// content, same justification as nodeFs's disable above.
/* eslint-disable security/detect-non-literal-fs-filename */
function rotateLog(path: string, maxBackups: number): void {
  const oldest = `${path}.${maxBackups}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let i = maxBackups - 1; i >= 1; i--) {
    const src = `${path}.${i}`;
    if (existsSync(src)) renameSync(src, `${path}.${i + 1}`);
  }
  if (existsSync(path)) renameSync(path, `${path}.1`);
}

/**
 * Appends `line`, rotating first if the file is already over the cap. A log inherited from
 * before this existed, already far over the cap, is rotated whole into `.1` on this first
 * write rather than truncated or deleted: nothing already on disk is lost, it just stops
 * growing further.
 */
function appendToRotatingLog(path: string, line: string, limits: LogLimits): void {
  mkdirSync(dirname(path), { recursive: true });
  let size = 0;
  try {
    size = statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (size > limits.maxBytes) rotateLog(path, limits.maxBackups);
  appendFileSync(path, line, { mode: 0o600 });
}
/* eslint-enable security/detect-non-literal-fs-filename */

// Paths below come from the user's config directory, never from mail content.
/* eslint-disable security/detect-non-literal-fs-filename */
export const nodeFs: FileSystem = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  async writeText(path, text, mode) {
    // Write a fresh sibling and rename it over the target: never a half-written config, and
    // the result has `mode` even if the old file was looser.
    const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, text, { mode, flag: 'wx' });
      await chmod(tmp, mode);
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  },
  async mkdir(path, mode) {
    await mkdir(path, { recursive: true, mode });
    await chmod(path, mode);
  },
};
/* eslint-enable security/detect-non-literal-fs-filename */

export const nodeOsascript: OsascriptRunner = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('osascript', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OSASCRIPT_OUTPUT) child.kill();
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: size > MAX_OSASCRIPT_OUTPUT ? 1 : (code ?? 1),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr:
          size > MAX_OSASCRIPT_OUTPUT
            ? 'osascript output exceeded the connector limit'
            : Buffer.concat(err).toString('utf8'),
      });
    });
  });

export const nodeFetch: FetchLike = async (url, init) => {
  let res: Response;
  try {
    // Every call here carries the device token and, for the batch push, a page of mail
    // content; redirect: 'error' refuses to follow a 3xx rather than silently resending
    // either to a server the caller never configured (packages/extension/src/api.ts takes
    // the same stance for the browser's fetch; do not reinstate the default 'follow' here
    // as a convenience).
    res = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // undici says only "fetch failed"; the cause names the real problem (ECONNREFUSED, ...).
    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
    const detail = typeof cause?.code === 'string' ? cause.code : cause?.message;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(typeof detail === 'string' ? `${message} (${detail})` : message, {
      cause: err,
    });
  }
  return { status: res.status, headers: res.headers, text: () => res.text() };
};

export const nodeClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted === true) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    }),
};

/** A terminal prompt; `secret` answers are not echoed. */
export const nodePrompt: Prompt = async (question, opts = {}) => {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  try {
    const pending = rl.question(question);
    muted = opts.secret === true;
    const answer = await pending;
    if (muted) process.stdout.write('\n');
    return answer;
  } finally {
    rl.close();
  }
};

/**
 * `logFile`, when given, routes stdout and stderr through the rotating writer above instead of
 * the real process streams (both into the same file, matching the one file launchd's plist
 * used to point both StandardOutPath and StandardErrorPath at). `logLimits` is only there for
 * tests to use a cap small enough to actually exercise rotation; real callers take the default.
 */
export function nodeIo(
  configDir: string,
  logFile?: string,
  logLimits: LogLimits = DEFAULT_LOG_LIMITS,
): ConnectorIo {
  const write =
    (toRealStream: (line: string) => void) =>
    (line: string): void => {
      if (logFile !== undefined) appendToRotatingLog(logFile, `${line}\n`, logLimits);
      else toRealStream(line);
    };
  return {
    fs: nodeFs,
    fetch: nodeFetch,
    osascript: nodeOsascript,
    clock: nodeClock,
    stdout: write((line) => process.stdout.write(`${line}\n`)),
    stderr: write((line) => process.stderr.write(`${line}\n`)),
    random: Math.random,
    configDir,
    prompt: nodePrompt,
  };
}
