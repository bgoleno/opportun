// nodeIo's rotating log file (#21): launchd's StandardOutPath/StandardErrorPath append to one
// file forever, with no cap, because watch() never exits to let an external rotator reopen it.
// nodeIo owns the file itself instead, so it can rotate without anyone else's cooperation.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeIo } from '../src/nodeIo';

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
