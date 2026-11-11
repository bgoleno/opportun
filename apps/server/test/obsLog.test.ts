// The log gate (design.md 14.8, 14.9; https://github.com/bgoleno/opportun/issues/345, FR-T5). Every
// record is rebuilt in the logger's destination: a catalogued message keeps its catalogued keys,
// any other message becomes a fixed marker with no keys, an error keeps its type and frame lines,
// and pino's pid and hostname are never written. Driven through a real pino logger, so what the
// gate sees is what pino writes: a child's bindings, the error serializer's output, the message.
import { afterEach, describe, expect, it } from 'vitest';
import { setUnknownKeyMode, UnknownTelemetryKeyError } from '../src/obs/gate';
import { createLogger, frameLines, gatedDestination, logRequest, WITHHELD } from '../src/obs/log';

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
  it('keep a frame inside the install root with its relative path, and drop the path of one outside', () => {
    const inside = new Error('x').stack!;
    const frames = frameLines(inside);
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
      ),
    ).toEqual(['at handler']);
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
