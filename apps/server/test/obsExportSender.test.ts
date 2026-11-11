// The one sender every destination posts through (design.md 14.10 rule 4;
// https://github.com/bgoleno/opportun/issues/342): the socket goes to the checked address only,
// whatever the name resolves to now; a redirect is never followed; the whole exchange times out
// at 10 seconds; the response body is discarded; and the caller learns an outcome class, never
// the response's text.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SEND_TIMEOUT_MS, send } from '../src/obs/export/sender';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      handler(req, res);
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { port: (s.address() as AddressInfo).port, seen };
}

const post = (url: string, extra: Partial<Parameters<typeof send>[0]> = {}) => ({
  url,
  address: '127.0.0.1',
  body: Buffer.from('payload'),
  contentType: 'application/x-protobuf',
  headers: {},
  ...extra,
});

describe('send (14.10 rule 4)', () => {
  it('posts to the checked address, not what the name resolves to, with only its own headers', async () => {
    const { port, seen } = await listen((_req, res) => res.writeHead(200).end('ignored'));
    // The name does not resolve at all: the request reaches the server only through the pin.
    const outcome = await send(
      post(`http://collector.invalid:${port}/v1/metrics`, { headers: { 'x-api-key': 'k' } }),
    );
    expect(outcome).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('/v1/metrics');
    expect(seen[0]?.body).toBe('payload');
    expect(seen[0]?.headers.host).toBe(`collector.invalid:${port}`);
    expect(seen[0]?.headers['content-type']).toBe('application/x-protobuf');
    expect(seen[0]?.headers['x-api-key']).toBe('k');
    // Nothing a library would add from the environment: no traceparent, no extra auth.
    expect(Object.keys(seen[0]?.headers ?? {}).sort()).toEqual([
      'accept-encoding',
      'connection',
      'content-length',
      'content-type',
      'host',
      'user-agent',
      'x-api-key',
    ]);
  });

  it('never follows a redirect: the outcome is the 3xx class and the target is never reached', async () => {
    const target = await listen((_req, res) => res.writeHead(200).end());
    const { port } = await listen((_req, res) =>
      res.writeHead(307, { location: `http://127.0.0.1:${target.port}/v1/metrics` }).end(),
    );
    expect(await send(post(`http://127.0.0.1:${port}/v1/metrics`))).toBe('http_3xx');
    expect(target.seen).toEqual([]);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [400, 'http_4xx'],
    [404, 'http_4xx'],
    [413, 'http_4xx'],
    [500, 'http_5xx'],
    [503, 'http_5xx'],
    [204, 'ok'],
  ] as const)('status %i is %s', async (status, outcome) => {
    const { port } = await listen((_req, res) => res.writeHead(status).end('secret text'));
    expect(await send(post(`http://127.0.0.1:${port}/x`))).toBe(outcome);
  });

  it('a port with nothing listening is refused', async () => {
    const { port } = await listen(() => undefined);
    await new Promise<void>((r) => servers.pop()?.close(() => r()));
    expect(await send(post(`http://127.0.0.1:${port}/x`))).toBe('refused');
  });

  it('a destination that never answers times out, at the timeout given', async () => {
    const { port } = await listen(() => undefined); // never responds
    const started = Date.now();
    expect(await send(post(`http://127.0.0.1:${port}/x`), { timeoutMs: 150 })).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(SEND_TIMEOUT_MS).toBe(10_000);
  });

  it('a body that never ends times out too: the timeout covers the whole exchange', async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200);
      res.write('partial'); // and never ends
    });
    expect(await send(post(`http://127.0.0.1:${port}/x`), { timeoutMs: 150 })).toBe('timeout');
  });

  it('https to a listener that does not speak TLS is the tls class', async () => {
    const { port } = await listen((_req, res) => res.writeHead(200).end());
    expect(await send(post(`https://127.0.0.1:${port}/x`))).toBe('tls');
  });

  it('a URL that is not http or https is never sent', async () => {
    expect(await send(post('ftp://127.0.0.1:21/x'))).toBe('blocked');
  });
});
