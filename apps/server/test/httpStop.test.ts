// The server stops within a named bound after its last answer
// (https://github.com/bgoleno/opportun/issues/1004): a kept HTTP connection held the end for over a
// minute, and one that never asked for anything, or never finished asking, for as long.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTTP_STOP_MS } from '../src/plugins/httpStop';
import { testApp } from './helpers';

/** The bound of the tests' own servers. */
const BOUND_MS = 1_500;
/** "Within about a second", on a loaded machine. */
const SOON_MS = 1_000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  at: number;
}
/** One request on `agent`'s connection, its answer read as it comes or, with `slow`, slowly. */
function ask(agent: http.Agent, url: string, opts: { slow?: boolean } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => {
          chunks.push(d);
          if (opts.slow !== true) return;
          res.pause();
          setTimeout(() => res.resume(), 5);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
            at: performance.now(),
          }),
        );
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function server(bound: number | undefined = BOUND_MS) {
  let go: () => void = () => undefined;
  const gate = new Promise<void>((r) => (go = r));
  let asked: () => void = () => undefined;
  const inHand = new Promise<void>((r) => (asked = r));
  const { app } = await testApp(
    {},
    {
      build: bound === undefined ? {} : { httpStopMs: bound },
      setup: (a: FastifyInstance) => {
        a.get('/test/quick', async () => ({ ok: true }));
        a.get('/test/held', async () => {
          asked();
          await gate;
          return { whole: 'x'.repeat(100_000) };
        });
        a.get('/test/stream', (_req, reply) => {
          reply.hijack();
          reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
          reply.raw.write('data: one\n\n');
          asked();
          void gate.then(() => reply.raw.end('data: two\n\n'));
        });
        a.get('/test/big', async () => {
          setTimeout(() => asked(), 50);
          return 'y'.repeat(30_000_000);
        });
      },
    },
  );
  const at = await app.listen({ port: 0, host: '127.0.0.1' });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  cleanups.push(async () => {
    go();
    agent.destroy();
    app.server.closeAllConnections();
    await stop();
  });
  let stopping: Promise<void> | undefined;
  let ended: number | undefined;
  app.server.once('close', () => (ended = performance.now()));
  const stop = (): Promise<void> => (stopping ??= app.close());
  /** The stop, begun; when it has ended its HTTP part, how long that took since `from`. */
  const endedSince = async (from: number): Promise<number> => {
    await vi.waitFor(() => expect(ended).toBeDefined(), { timeout: BOUND_MS + 4_000 });
    return ended! - from;
  };
  const { port } = app.server.address() as net.AddressInfo;
  return {
    app,
    at,
    agent,
    port,
    go: () => go(),
    inHand,
    stop,
    endedSince,
    isEnded: () => ended !== undefined,
  };
}
type Server = Awaited<ReturnType<typeof server>>;

async function raw(s: Server, text?: string): Promise<net.Socket> {
  const socket = net.connect(s.port, '127.0.0.1');
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  if (text !== undefined) socket.write(text);
  cleanups.push(() => void socket.destroy());
  await wait(100);
  return socket;
}

describe('the stop ends soon after the last answer', () => {
  it('a request in hand on a kept connection: answered whole, and told it is the last', async () => {
    const s = await server();
    const answer = ask(s.agent, `${s.at}/test/held`);
    await s.inHand;
    void s.stop();
    await wait(200);
    expect(s.isEnded()).toBe(false);
    s.go();
    const got = await answer;
    expect([got.status, got.headers.connection]).toEqual([200, 'close']);
    expect(JSON.parse(got.body)).toEqual({ whole: 'x'.repeat(100_000) });
    expect(await s.endedSince(got.at)).toBeLessThan(SOON_MS);
  });

  it('an answer whose headers were sent before the stop, as a chat’s stream', async () => {
    const s = await server();
    const answer = ask(s.agent, `${s.at}/test/stream`);
    await s.inHand;
    void s.stop();
    await wait(200);
    expect(s.isEnded()).toBe(false);
    s.go();
    const got = await answer;
    expect(got.body).toBe('data: one\n\ndata: two\n\n');
    expect(await s.endedSince(got.at)).toBeLessThan(SOON_MS);
  });

  it('an answer that its client is still reading: whole, for longer than another takes', async () => {
    const s = await server(10_000);
    const big = ask(s.agent, `${s.at}/test/big`, { slow: true });
    await s.inHand;
    const other = new http.Agent({ keepAlive: true });
    cleanups.push(() => other.destroy());
    const held = ask(other, `${s.at}/test/held`);
    await wait(100);
    void s.stop();
    await wait(100);
    s.go();
    expect((await held).status).toBe(200);
    const got = await big;
    expect(got.body.length).toBe(30_000_000);
    expect(await s.endedSince(got.at)).toBeLessThan(SOON_MS);
  }, 20_000);

  it('a kept connection with nothing in flight, as today', async () => {
    const s = await server();
    expect((await ask(s.agent, `${s.at}/test/quick`)).status).toBe(200);
    const from = performance.now();
    void s.stop();
    expect(await s.endedSince(from)).toBeLessThan(SOON_MS);
  });

  it('a connection that never asked for anything, as a browser opens ahead', async () => {
    const s = await server();
    await raw(s);
    const from = performance.now();
    void s.stop();
    expect(await s.endedSince(from)).toBeLessThan(SOON_MS);
  });
});

describe('the bound', () => {
  it('a request that takes longer is not cut before it, and is at it', async () => {
    const s = await server();
    const answer = ask(s.agent, `${s.at}/test/held`).then(
      () => 'answered',
      (e: NodeJS.ErrnoException) => e.code,
    );
    await s.inHand;
    const from = performance.now();
    void s.stop();
    await wait(BOUND_MS - 300);
    expect(s.isEnded()).toBe(false);
    expect(await answer).toBe('ECONNRESET');
    const took = await s.endedSince(from);
    expect(took).toBeGreaterThan(BOUND_MS - 100);
    expect(took).toBeLessThan(BOUND_MS + SOON_MS);
  });

  it('so is a request never sent whole', async () => {
    const s = await server();
    await raw(s, 'POST /api/v1/auth/login HTTP/1.1\r\nhost: x\r\ncontent-length: 10\r\n\r\n{');
    const from = performance.now();
    void s.stop();
    const took = await s.endedSince(from);
    expect(took).toBeGreaterThan(BOUND_MS - 100);
    expect(took).toBeLessThan(BOUND_MS + SOON_MS);
  });

  it('is longer than a statement can wait for a database that vanished', () => {
    expect(HTTP_STOP_MS).toBeGreaterThan(60_000);
    expect(HTTP_STOP_MS).toBeLessThan(90_000); // systemd's own patience
  });
});

describe('what stays as it was', () => {
  it('while the server is not stopping, a connection is kept and used again', async () => {
    const s = await server();
    const first = await ask(s.agent, `${s.at}/test/quick`);
    const second = await ask(s.agent, `${s.at}/test/quick`);
    expect([first.headers.connection, second.headers.connection]).toEqual([
      'keep-alive',
      'keep-alive',
    ]);
    expect(await new Promise((r) => s.app.server.getConnections((_e, n) => r(n)))).toBe(1);
  });

  it('a new connection is refused while a request in hand is waited for, as before', async () => {
    const s = await server();
    const held = ask(s.agent, `${s.at}/test/held`);
    await s.inHand;
    void s.stop();
    await wait(200);
    const late = net.connect(s.port, '127.0.0.1');
    const [err] = (await once(late, 'error')) as [NodeJS.ErrnoException];
    expect(err.code).toBe('ECONNREFUSED');
    s.go();
    expect((await held).status).toBe(200);
  });

  it('a request that comes during the stop is refused with a 503, as before', async () => {
    const s = await server();
    const held = ask(s.agent, `${s.at}/test/held`);
    await s.inHand;
    const socket = await raw(s, 'GET /test/quick HTTP/1.1\r\nhost: x\r\n\r\nGET ');
    let heard = '';
    socket.setEncoding('utf8').on('data', (d: string) => (heard += d));
    void s.stop();
    await wait(100);
    heard = '';
    socket.write('/test/quick HTTP/1.1\r\nhost: x\r\n\r\n');
    await vi.waitFor(() => expect(heard).toMatch(/^HTTP\/1\.1 503 [\s\S]*connection: close/i));
    s.go();
    expect((await held).status).toBe(200);
  });
});

describe.each(['SIGTERM', 'SIGINT'] as const)('the server itself, on %s', (signal) => {
  async function freePort(): Promise<number> {
    const probe = net.createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address() as net.AddressInfo;
    probe.close();
    await once(probe, 'close');
    return port;
  }
  async function child() {
    const port = await freePort();
    const dataDir = await mkdtemp(join(tmpdir(), 'opportun-test-'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        PATH: process.env.PATH,
        TMPDIR: tmpdir(),
        DATA_DIR: dataDir,
        DB_DIALECT: 'sqlite',
        OPPORTUN_MASTER_KEY: 'ab'.repeat(32),
        OPPORTUN_BASE_URL: 'http://localhost:3000',
        OPPORTUN_HOST: '127.0.0.1',
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    proc.stderr.resume();
    let exited: { code: number | null; at: number } | undefined;
    proc.on('exit', (code) => (exited = { code, at: performance.now() }));
    cleanups.push(() => void proc.kill('SIGKILL'));
    await vi.waitFor(() => expect(out).toContain('server listening'), { timeout: 30_000 });
    return { proc, port, exit: () => exited };
  }

  it('a request in hand is answered, and the process ends soon after', async () => {
    const { proc, port, exit } = await child();
    const agent = new http.Agent({ keepAlive: true });
    cleanups.push(() => agent.destroy());
    const body = JSON.stringify({ email: 'jane@example.com', password: 'no such password' });
    const req = http.request({
      agent,
      port,
      host: '127.0.0.1',
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    });
    req.write(body.slice(0, 10)); // in hand from here: the rest of it comes during the stop
    await wait(500);
    proc.kill(signal);
    await wait(500);
    expect(exit()).toBeUndefined();
    req.end(body.slice(10));
    const [res] = (await once(req, 'response')) as [http.IncomingMessage];
    res.resume();
    await once(res, 'end');
    const at = performance.now();
    expect([res.statusCode, res.headers.connection]).toEqual([401, 'close']);
    await vi.waitFor(() => expect(exit()).toBeDefined(), { timeout: 5_000 });
    expect(exit()!.code).toBe(0);
    expect(exit()!.at - at).toBeLessThan(SOON_MS + 500);
  }, 60_000);

  it('nothing in flight, with a connection kept: at once', async () => {
    const { proc, port, exit } = await child();
    const agent = new http.Agent({ keepAlive: true });
    cleanups.push(() => agent.destroy());
    expect((await ask(agent, `http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    const at = performance.now();
    proc.kill(signal);
    await vi.waitFor(() => expect(exit()).toBeDefined(), { timeout: 5_000 });
    expect(exit()!.code).toBe(0);
    expect(exit()!.at - at).toBeLessThan(SOON_MS + 500);
  }, 60_000);
});
