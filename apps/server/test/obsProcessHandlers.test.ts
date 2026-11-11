// The process's own output goes through the log gate too (#345, sec's point 2 on #376): an
// uncaught exception, an unhandled rejection and a warning, each in a child process that installs
// the server's handlers, with personal data in the error. Node's default handlers would print it.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CHILD = fileURLToPath(new URL('./fixtures/crashChild.ts', import.meta.url));

function run(how: string) {
  const res = spawnSync(process.execPath, ['--import', 'tsx', CHILD, how], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  const lines = res.stderr
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { status: res.status, stderr: res.stderr, stdout: res.stdout, lines };
}

function clean(text: string): void {
  for (const datum of ['Jane Doe', 'jane.doe@example.com', '555-0142', 'Leak.Name']) {
    expect(text, datum).not.toContain(datum);
  }
}

describe('the process handlers (#345)', () => {
  it('an uncaught exception is one gated line, then the exit Node would make', () => {
    const r = run('exception');
    expect(r.status).toBe(1);
    expect(r.lines).toEqual([
      expect.objectContaining({ level: 60, msg: 'uncaught exception', 'error.type': 'Error' }),
    ]);
    // A frame-shaped line in the message is not taken for a frame; the real frames are kept.
    expect((r.lines[0]!.stack as string[]).length).toBeGreaterThan(0);
    clean(r.stderr + r.stdout);
  });

  it('an unhandled rejection likewise', () => {
    const r = run('rejection');
    expect(r.status).toBe(1);
    expect(r.lines).toEqual([
      expect.objectContaining({ msg: 'unhandled rejection', 'error.type': 'TypeError' }),
    ]);
    clean(r.stderr + r.stdout);
  });

  it('a warning is its type and code only, and Node prints nothing of its own', () => {
    const r = run('warning');
    expect(r.status).toBe(0);
    expect(r.lines).toEqual([
      expect.objectContaining({
        msg: 'process warning',
        'opportun.warning.type': 'DeprecationWarning',
        'opportun.warning.code': 'XDEP900',
      }),
    ]);
    clean(r.stderr + r.stdout);
  });
});
