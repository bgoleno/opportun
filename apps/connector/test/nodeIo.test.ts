// nodeIo's rotating log file (#21): launchd's StandardOutPath/StandardErrorPath append to one
// file forever, with no cap, because watch() never exits to let an external rotator reopen it.
// nodeIo owns the file itself instead, so it can rotate without anyone else's cooperation.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeFs, nodeIo } from '../src/nodeIo';

describe('nodeIo rotating log file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opportun-connector-log-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes straight to process.stdout/stderr when no log file is configured', () => {
    // No file is created anywhere under dir; nothing to assert on disk beyond that.
    const io = nodeIo(dir);
    expect(() => io.stdout('hello')).not.toThrow();
    expect(() => io.stderr('oops')).not.toThrow();
  });

  it('appends stdout and stderr lines to the configured log file in order', () => {
    const path = join(dir, 'connector.log');
    const io = nodeIo(dir, path, { maxBytes: 1_000, maxBackups: 2 });
    io.stdout('one');
    io.stderr('two');
    expect(readFileSync(path, 'utf8')).toBe('one\ntwo\n');
  });

  it('rotates the live file to .1 once it is over the cap', () => {
    const path = join(dir, 'connector.log');
    const io = nodeIo(dir, path, { maxBytes: 10, maxBackups: 2 });
    io.stdout('first line is over ten bytes');
    io.stdout('second');
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('first line is over ten bytes\n');
    expect(readFileSync(path, 'utf8')).toBe('second\n');
  });

  it('shifts older backups down and drops the oldest beyond maxBackups', () => {
    const path = join(dir, 'connector.log');
    const io = nodeIo(dir, path, { maxBytes: 1, maxBackups: 2 });
    io.stdout('a');
    io.stdout('b');
    io.stdout('c');
    io.stdout('d');
    expect(readFileSync(path, 'utf8')).toBe('d\n');
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('c\n');
    expect(readFileSync(`${path}.2`, 'utf8')).toBe('b\n');
  });

  it('rotates a pre-existing, already-oversized log whole on the first write, without truncating it', () => {
    const path = join(dir, 'connector.log');
    const inherited = 'old unbounded log line\n'.repeat(5);
    writeFileSync(path, inherited);
    const io = nodeIo(dir, path, { maxBytes: 10, maxBackups: 2 });
    io.stdout('new line after upgrade');
    expect(readFileSync(`${path}.1`, 'utf8')).toBe(inherited);
    expect(readFileSync(path, 'utf8')).toBe('new line after upgrade\n');
  });
});

describe('nodeFs.readTextAndMode (#699: one open, its mode and its text)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opportun-connector-read-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives the text and the permission bits of the one file it opened, and null for none', async () => {
    const own = join(dir, 'own');
    writeFileSync(own, 'odt_x\n', { mode: 0o600 });
    expect(await nodeFs.readTextAndMode(own)).toEqual({
      isFile: true,
      size: 6,
      mode: 0o600,
      text: 'odt_x\n',
    });
    const shared = join(dir, 'shared');
    writeFileSync(shared, 'y');
    chmodSync(shared, 0o644);
    expect(await nodeFs.readTextAndMode(shared)).toEqual({
      isFile: true,
      size: 1,
      mode: 0o644,
      text: 'y',
    });
    expect(await nodeFs.readTextAndMode(join(dir, 'nope'))).toBeNull();
  });

  // tl and sec on #740: a path to a FIFO or a huge file (/dev/zero, say) must not hang init or read
  // without end, as --token-stdin stops at 4 KiB.
  it('a FIFO is not opened for reading: it is reported, and nothing waits for a writer', async () => {
    const fifo = join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    const got = await nodeFs.readTextAndMode(fifo);
    expect(got).toMatchObject({ isFile: false, text: null });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a file over the limit is reported by its size, and not read', async () => {
    const big = join(dir, 'big');
    writeFileSync(big, 'x'.repeat(5_000), { mode: 0o600 });
    expect(await nodeFs.readTextAndMode(big)).toEqual({
      isFile: true,
      size: 5_000,
      mode: 0o600,
      text: null,
    });
  });
});
