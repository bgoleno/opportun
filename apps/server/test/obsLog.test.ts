// The log gate (design.md 14.8, 14.9; https://github.com/bgoleno/opportun/issues/345, FR-T5). Every
// record is rebuilt in the logger's destination: a catalogued message keeps its catalogued keys,
// any other message becomes a fixed marker with no keys, an error keeps its type and frame lines,
// and pino's pid and hostname are never written. Driven through a real pino logger, so what the
// gate sees is what pino writes: a child's bindings, the error serializer's output, the message.
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../src/db/client';
import {
  configureGateWatchdog,
  gateHeldError,
  logHeldGate,
  logSlowTransaction,
  type WatchdogClock,
} from '../src/db/gate';
import { setUnknownKeyMode, UnknownTelemetryKeyError } from '../src/obs/gate';
import { createLogger, frameLines, gatedDestination, logRequest, WITHHELD } from '../src/obs/log';
import { captureLogs, testApp } from './helpers';

const NAME = 'Jane Doe';
const EMAIL = 'jane.doe@example.com';
const PHONE = '+1 (206) 555-0142';
const COMPANY = 'Acme Robotics';
const PERSONAL = [NAME, EMAIL, PHONE, '206', COMPANY];

afterEach(() => setUnknownKeyMode('throw'));

function capture() {
  const lines: string[] = [];
  const log = createLogger({ level: 'trace', stream: { write: (l) => lines.push(l) } });
  return {
    log,
    lines,
    records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    text: () => lines.join(''),
  };
}

const UUID = '01a1c825-2bed-7d78-891e-ce1f8b129bf7';

describe('the log gate (#345)', () => {
  it('keeps a catalogued message with its catalogued keys, the level and the time', () => {
    const c = capture();
    c.log.warn({ 'opportun.company.id': UUID }, 'ats detection failed');
    const [r] = c.records();
    expect(r).toEqual({
      level: 40,
      time: expect.any(Number),
      msg: 'ats detection failed',
      'opportun.company.id': UUID,
    });
  });

  it('writes no pid and no hostname: a host name is often a person’s', () => {
    const c = capture();
    c.log.info('shutting down');
    expect(Object.keys(c.records()[0]!)).toEqual(['level', 'time', 'msg']);
  });

  it('replaces a message the catalog does not list with a marker, and keeps none of its keys', () => {
    const c = capture();
    c.log.warn(
      { reqId: 'req-1', url: `/api/v1/people?email=${EMAIL}` },
      `could not reach ${EMAIL}`,
    );
    expect(c.records()).toEqual([{ level: 40, time: expect.any(Number), msg: WITHHELD }]);
  });

  it('drops a catalogued key whose value is not of its type', () => {
    setUnknownKeyMode('drop');
    const c = capture();
    c.log.warn({ 'opportun.company.id': COMPANY }, 'ats detection failed');
    expect(c.records()[0]).not.toHaveProperty('opportun.company.id');
    expect(c.text()).not.toContain(COMPANY);
  });

  it('throws under the test runner on a key the catalog does not list for Opportun’s own message', () => {
    const c = capture();
    expect(() => c.log.warn({ board: COMPANY }, 'ats detection failed')).toThrow(
      UnknownTelemetryKeyError,
    );
  });

  it('in production drops and does not throw on such a key', () => {
    setUnknownKeyMode('drop');
    const c = capture();
    c.log.warn({ board: COMPANY }, 'ats detection failed');
    expect(c.records()[0]).toEqual({
      level: 40,
      time: expect.any(Number),
      msg: 'ats detection failed',
    });
  });

  it('reduces an error to its type and frame lines: never its message or its properties', () => {
    const c = capture();
    const err = Object.assign(new TypeError(`cannot reach ${EMAIL} for ${NAME}`), {
      code: PHONE,
      person: NAME,
    });
    c.log.error({ err }, 'unhandled error');
    const [r] = c.records();
    expect(r).toMatchObject({ msg: 'unhandled error', 'error.type': 'TypeError' });
    expect(Object.keys(r!).sort()).toEqual(['error.type', 'level', 'msg', 'stack', 'time']);
    for (const frame of r!.stack as string[]) expect(frame).toMatch(/^at /);
    for (const p of PERSONAL) expect(c.text()).not.toContain(p);
  });

  it('a child logger’s bindings do not pass either', () => {
    setUnknownKeyMode('drop');
    const c = capture();
    c.log.child({ user: EMAIL, name: NAME }).info('shutting down');
    expect(c.records()[0]).toEqual({ level: 30, time: expect.any(Number), msg: 'shutting down' });
  });

  it('a line that is not a JSON record is dropped, never passed on unread', () => {
    const lines: string[] = [];
    gatedDestination({ write: (l) => lines.push(l) }).write(
      `plain text from a library: ${EMAIL}\n`,
    );
    expect(lines).toEqual([]);
  });
});

describe('frame lines (#345, 14.8)', () => {
  it('keep a frame inside the install root with its relative path, and only a placeholder for one outside', () => {
    const inside = new Error('x').stack!;
    const frames = frameLines(inside, 'x');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((f) => f.includes('apps/server/test/obsLog.test.ts'))).toBe(true);
    for (const f of frames) expect(f).not.toContain('/Volumes/');
    expect(
      frameLines(
        [
          `Error: mail for ${EMAIL}`,
          '    at handler (/home/jane/elsewhere/lib.js:1:2)',
          `    at ${NAME} (/tmp/x.js:3:4)`,
          '    at node:internal/process/task_queues:95:5',
          `    { person: '${NAME}' }`,
        ].join('\n'),
        `mail for ${EMAIL}`,
      ),
      // Outside the install root a frame keeps no name either (#381): one placeholder for the run.
    ).toEqual(['at <external>']);
  });
});

describe('what an error and a record\u2019s shape may carry (#345, sec on #376)', () => {
  it('a frame-shaped line in an error\u2019s message, or a cause\u2019s text, is not taken for a frame', () => {
    const c = capture();
    const err = new Error(`first line\n    at Leak.Name (${process.cwd()}/leak.ts:1:1)`);
    // What an errWithCause serializer appends after the frames: never read.
    err.stack = `${err.stack}\ncaused by: Error: ${NAME}\n    at Cause.Leak (${process.cwd()}/c.ts:2:2)`;
    c.log.error({ err }, 'unhandled error');
    const stack = c.records()[0]!.stack as string[];
    expect(stack.length).toBeGreaterThan(0);
    expect(c.text()).not.toContain('Leak.Name');
    expect(c.text()).not.toContain('Cause.Leak');
    expect(c.text()).not.toContain(NAME);
  });

  it('a record naming an event keeps a different message only if that message is catalogued', () => {
    setUnknownKeyMode('drop');
    const c = capture();
    c.log.info({ event: 'job.finished' }, `job done for ${EMAIL}`);
    expect(c.records()[0]).toEqual({ level: 30, time: expect.any(Number), msg: WITHHELD });
  });

  it('drops a trace id not shaped as 32 hex digits, and an error type not shaped as a code', () => {
    const c = capture();
    c.log.error(
      { trace_id: EMAIL, err: { type: `${NAME} Error`, stack: 'Error: x' } },
      'unhandled error',
    );
    const r = c.records()[0]!;
    expect(r).not.toHaveProperty('trace_id');
    expect(r).not.toHaveProperty('error.type');
    expect(c.text()).not.toContain(NAME);
    expect(c.text()).not.toContain(EMAIL);
  });
});

describe('the access log line (#345, 14.9)', () => {
  it('says the method, the route template, the status, the route id and the address, nothing else', () => {
    const c = capture();
    logRequest(c.log, {
      method: 'get',
      route: '/api/v1/opportunities/:id',
      statusCode: 200,
      ip: '203.0.113.7',
      params: { id: UUID, note: NAME },
    });
    expect(c.records()[0]).toEqual({
      level: 30,
      time: expect.any(Number),
      msg: 'request completed',
      'http.request.method': 'GET',
      'http.route': '/api/v1/opportunities/:id',
      'http.response.status_code': 200,
      'client.address': '203.0.113.7',
      'opportun.route.id': UUID,
    });
  });

  it('writes no path: a request url given as the route is refused by its type', () => {
    setUnknownKeyMode('drop');
    const c = capture();
    logRequest(c.log, {
      method: 'GET',
      route: `/api/v1/opportunities/${UUID}`,
      statusCode: 404,
      ip: undefined,
      params: { id: EMAIL },
    });
    expect(c.records()[0]).not.toHaveProperty('http.route');
    expect(c.records()[0]).not.toHaveProperty('opportun.route.id');
    expect(c.text()).not.toContain(UUID);
    expect(c.text()).not.toContain(EMAIL);
  });
});

/** A watchdog clock this test advances by hand (as dbGate.test.ts does, issue #72). */
function handClock(): { clock: WatchdogClock; advance: (ms: number) => void } {
  let now = 0;
  const timers: { at: number; cb: () => void }[] = [];
  return {
    clock: {
      now: () => now,
      setTimeout: (cb, ms) => {
        const entry = { at: now + ms, cb };
        timers.push(entry);
        return entry as unknown as NodeJS.Timeout;
      },
      clearTimeout: (timer) => {
        const i = timers.indexOf(timer as unknown as { at: number; cb: () => void });
        if (i !== -1) timers.splice(i, 1);
      },
    },
    advance: (ms) => {
      now += ms;
      for (const t of timers.filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.cb();
      }
    },
  };
}

describe('a held gate keeps its call site as a frame (#381)', () => {
  it('in the record the watchdog logs', () => {
    const c = capture();
    // The call site withTransaction names when no label was set: a frame line (db/client.ts).
    const site = `at runImport (${process.cwd()}/src/jobs/import.ts:10:5)`;
    c.log.warn(
      {
        'opportun.db.gate_label': site,
        'opportun.db.gate_held_ms': 5_000,
        err: gateHeldError(site),
      },
      'database write gate held too long',
    );
    const r = c.records()[0]!;
    expect(r['error.type']).toBe('GateHeld');
    expect(r.stack).toEqual(['at runImport (apps/server/src/jobs/import.ts:10:5)']);
  });

  it("from the app's own reporter, for a transaction held past the threshold", async () => {
    const logs = captureLogs();
    const { app } = await testApp({ logLevel: 'warn' }, { logStream: logs });
    const { clock, advance } = handClock();
    try {
      // The app's reporter stays (no `report`): only the threshold and the clock change.
      configureGateWatchdog({ ms: 40, clock });
      const held = withTransaction(
        app.db,
        async () => {
          await new Promise((r) => setTimeout(r, 5));
        },
        { isTestRun: false },
      );
      await new Promise((r) => setTimeout(r, 1));
      advance(50);
      await held;
      const line = logs.lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.msg === 'database write gate held too long');
      expect(line).toMatchObject({ 'error.type': 'GateHeld' });
      expect(line!.stack).toEqual([expect.stringContaining('apps/server/test/obsLog.test.ts')]);
    } finally {
      configureGateWatchdog({});
      await app.close();
    }
  });
});

describe('a stack whose header no longer matches its message (#381, sec)', () => {
  // A V8 stack is formatted on its first read, with the message of that moment. Code that
  // reassigns the message afterwards leaves a header the current message no longer counts.
  const FAKE = `    at ${NAME.replace(' ', '')} (/srv/elsewhere/data.js:1:1)`;
  const logged = (err: Error) => {
    const c = capture();
    c.log.error({ err }, 'unhandled error');
    return { record: c.records()[0]!, text: c.text() };
  };

  it('a message lengthened after the stack was read: no frames, rather than a miscount', () => {
    const err = new Error('one');
    void err.stack;
    err.message = 'two\nthree';
    const { record } = logged(err);
    expect(record['error.type']).toBe('Error');
    expect(record).not.toHaveProperty('stack');
  });

  it('a message shortened after the stack was read: its old lines are never taken by name', () => {
    const err = new Error(`x\n${FAKE}`);
    void err.stack;
    err.message = 'x';
    const { record, text } = logged(err);
    expect(text).not.toContain(NAME.replace(' ', ''));
    // The old line still parses as a frame, but one outside the install root: the fixed
    // placeholder, then this file's own frame.
    expect(record.stack).toEqual(
      expect.arrayContaining(['at <external>', expect.stringContaining('obsLog.test.ts')]),
    );
  });

  it('a message shortened to nothing after the stack was read: no frames', () => {
    const err = new Error(`x\n${FAKE}`);
    void err.stack;
    err.message = '';
    const { record, text } = logged(err);
    expect(text).not.toContain(NAME.replace(' ', ''));
    expect(record).not.toHaveProperty('stack');
  });

  it('a message shortened before the stack was read: the stack follows it, frames kept', () => {
    const err = new Error(`x\n${FAKE}`);
    err.message = 'x';
    const { record, text } = logged(err);
    expect(text).not.toContain(NAME.replace(' ', ''));
    expect((record.stack as string[])[0]).toContain('obsLog.test.ts');
  });

  it('an empty message: the header is the name alone, frames kept', () => {
    const { record } = logged(new Error(''));
    expect((record.stack as string[])[0]).toContain('obsLog.test.ts');
  });

  it('a frame outside the install root keeps its place with no name, runs of them as one', () => {
    const lines = frameLines(
      [
        'Error: x',
        `    at ours (${process.cwd()}/src/a.ts:1:2)`,
        '    at Lib.call (/srv/lib/node_modules/dep/index.js:3:4)',
        `${FAKE}`,
        '    at node:internal/process/task_queues:95:5',
        `    at again (${process.cwd()}/src/b.ts:5:6)`,
      ].join('\n'),
      'x',
    );
    expect(lines).toEqual([
      'at ours (apps/server/src/a.ts:1:2)',
      'at <external>',
      'at again (apps/server/src/b.ts:5:6)',
    ]);
  });

  it('a frame inside the install root whose name is not an identifier keeps only its path', () => {
    // The case the placeholder cannot cover: a fake frame that names a path inside the root.
    expect(
      frameLines(['Error: x', `    at ${NAME} (${process.cwd()}/src/a.ts:1:2)`].join('\n'), 'x'),
    ).toEqual(['at (apps/server/src/a.ts:1:2)']);
  });

  it('frames outside the install root never fill the cap', () => {
    const outside = Array.from({ length: 40 }, (_, i) => `    at dep${i} (/srv/dep.js:${i + 1}:1)`);
    const lines = frameLines(
      ['Error: x', ...outside, `    at ours (${process.cwd()}/src/a.ts:1:2)`].join('\n'),
      'x',
    );
    expect(lines).toEqual(['at <external>', 'at ours (apps/server/src/a.ts:1:2)']);
  });
});

describe("a dependency's frames under the install root are not the app's (#399)", () => {
  const root = join(process.cwd(), '..', '..');
  const dep = (i: number) =>
    `    at Dep${i}.call (${root}/node_modules/.pnpm/fastify@5.0.0/node_modules/fastify/lib/x.js:${i + 1}:1)`;

  it('25 dependency frames before an app frame: one placeholder, then the app frame', () => {
    const stack = [
      'Error: x',
      ...Array.from({ length: 25 }, (_, i) => dep(i)),
      `    at ours (${process.cwd()}/src/a.ts:1:2)`,
    ].join('\n');
    expect(frameLines(stack, 'x')).toEqual(['at <external>', 'at ours (apps/server/src/a.ts:1:2)']);
  });

  it("a dependency inside the app's own folder too, and the app's frames are unchanged", () => {
    const stack = [
      'Error: x',
      `    at first (${process.cwd()}/src/a.ts:1:2)`,
      `    at Lib.run (${process.cwd()}/node_modules/dep/index.js:3:4)`,
      dep(1),
      `    at second (${process.cwd()}/src/b.ts:5:6)`,
    ].join('\n');
    expect(frameLines(stack, 'x')).toEqual([
      'at first (apps/server/src/a.ts:1:2)',
      'at <external>',
      'at second (apps/server/src/b.ts:5:6)',
    ]);
  });
});

describe('a cause, taken from where pino puts it (#399, sec on #389)', () => {
  const logged = (err: Error) => {
    const c = capture();
    c.log.error({ err }, 'unhandled error');
    return c.records()[0]!;
  };
  const ours = (r: Record<string, unknown>) =>
    (r.stack as string[] | undefined)?.some((f) => f.includes('obsLog.test.ts')) === true;

  it('a cause with no message: pino writes "outer: " and "caused by: Error", frames kept', () => {
    expect(ours(logged(new Error('outer', { cause: new Error('') })))).toBe(true);
  });

  it('an error with no message of its own and a cause: frames kept', () => {
    expect(ours(logged(new Error('', { cause: new Error('inner') })))).toBe(true);
  });

  it('a cause with no message fits only the cut at the very end of the message', () => {
    // pino would give `x: ` for this error; `x: y` is a message reassigned after the stack was
    // read, and the empty cause cannot account for its `y`.
    const stack = [
      'Error: x',
      `    at Jane (${process.cwd()}/src/a.ts:1:2)`,
      'caused by: Error',
      `    at inner (${process.cwd()}/src/b.ts:3:4)`,
    ].join('\n');
    expect(frameLines(stack, 'x: y')).toEqual([]);
    expect(frameLines(stack, 'x: ')).toEqual(['at Jane (apps/server/src/a.ts:1:2)']);
  });

  it("a caused-by line in the error's own message is not taken for the cause's", () => {
    // Its own message has a line shaped like pino's; the real cause's line comes after the
    // frames, and it is that one the cut is tied to.
    const err = new Error('x\ncaused by: Error: z', { cause: new Error('y') });
    expect(ours(logged(err))).toBe(true);
  });
});

describe('errors that kept their frames on main keep them (tl on #389)', () => {
  const logged = (err: Error) => {
    const c = capture();
    c.log.error({ err }, 'unhandled error');
    return c.records()[0]!;
  };
  const ours = (r: Record<string, unknown>) =>
    (r.stack as string[] | undefined)?.some((f) => f.includes('obsLog.test.ts')) === true;

  it('an error with a cause: pino writes the messages joined, the header has its own alone', () => {
    const inner = new Error(`no route to ${EMAIL}`);
    expect(ours(logged(new Error('outer', { cause: inner })))).toBe(true);
    // What fetch() throws for a host that does not resolve.
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND x.example'), { code: 'ENOTFOUND' });
    const r = logged(new TypeError('fetch failed', { cause: dns }));
    expect(r['error.type']).toBe('TypeError');
    expect(ours(r)).toBe(true);
  });

  it('with no cause, a message cut to a prefix of its own after the read still gives no frames (sec on #389)', () => {
    // No `caused by:` line, so the message's `: ` is its own: the shorter prefix is not tried.
    const err = new Error(`x\n    at ${NAME.replace(' ', '')} (${process.cwd()}/src/fake.ts:1:1)`);
    void err.stack;
    err.message = 'x: something else';
    const r = logged(err);
    expect(r['error.type']).toBe('Error');
    expect(r).not.toHaveProperty('stack');
  });

  it("with a cause, a prefix is tried only where the rest is the cause's message", () => {
    const err = new Error(`x\n    at ${NAME.replace(' ', '')} (${process.cwd()}/src/fake.ts:1:1)`, {
      cause: new Error('z'),
    });
    void err.stack;
    // pino gives `x: y: z`: cut where `z` follows, the header would be `x: y`, which it is not;
    // cut at the first `: `, what follows is `y: z`, not the cause's message.
    err.message = 'x: y';
    const r = logged(err);
    expect(r).not.toHaveProperty('stack');
  });

  it('an error thrown inside a builtin: its location-less frame is a placeholder, ours follow', () => {
    let thrown: Error | undefined;
    try {
      JSON.parse('{bad');
    } catch (err) {
      thrown = err as Error;
    }
    const r = logged(thrown!);
    expect((r.stack as string[])[0]).toBe('at <external>');
    expect(ours(r)).toBe(true);
    let invalid: Error | undefined;
    try {
      new Date('nope').toISOString();
    } catch (err) {
      invalid = err as Error;
    }
    expect(ours(logged(invalid!))).toBe(true);
  });
});

describe("the database's default reporters keep their frames (tl on #389)", () => {
  /** The gated lines written to stderr while `fn` runs (processLogger, through dbLog). */
  async function stderrOf(fn: () => void, msg: string): Promise<Record<string, unknown>> {
    const lines: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });
    try {
      fn();
      const end = Date.now() + 5_000;
      for (;;) {
        const found = lines
          .flatMap((l) => l.split('\n'))
          .filter((l) => l.startsWith('{'))
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((l) => l.msg === msg);
        if (found !== undefined) return found;
        if (Date.now() > end) throw new Error(`no line "${msg}"`);
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      write.mockRestore();
    }
  }

  it('a held gate, with no app wired (a CLI)', async () => {
    const site = `at runImport (${process.cwd()}/src/jobs/import.ts:10:5)`;
    const r = await stderrOf(
      () => logHeldGate({ label: site, heldMs: 5_000 }),
      'database write gate held too long',
    );
    expect(r).toMatchObject({ 'error.type': 'GateHeld' });
    expect(r.stack).toEqual(['at runImport (apps/server/src/jobs/import.ts:10:5)']);
  });

  it('a slow transaction, with the stack of its caller', async () => {
    const caller = new Error('withTransaction caller').stack!;
    const r = await stderrOf(
      () => logSlowTransaction({ durationMs: 30, awaitedOutside: true, stack: caller }),
      'slow transaction held the database write gate',
    );
    expect(r).toMatchObject({ 'error.type': 'SlowTransaction' });
    expect(r.stack).toEqual(expect.arrayContaining([expect.stringContaining('obsLog.test.ts')]));
  });
});
