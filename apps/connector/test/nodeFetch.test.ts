// nodeFetch refuses redirects (issue #341): the bearer token and, on the batch push, a page
// of mail content must never follow a 3xx to wherever it points. Two real loopback servers,
// not a stub: the thing under test is undici's actual redirect: 'error' handling, and a fake
// fetch that merely returns a canned response could not tell a refused redirect from one
// that was silently followed and then happened to fail for an unrelated reason.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFetch } from '../src/nodeIo';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('nodeFetch', () => {
  let servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(close));
    servers = [];
  });

  it('never lets a redirect reach its target: the second server sees no request at all', async () => {
    let targetHits = 0;
    let originHits = 0;
    const target = createServer((_req, res) => {
      targetHits += 1;
      res.writeHead(200).end('ok');
    });
    servers.push(target);
    const targetUrl = await listen(target);

    const origin = createServer((_req, res) => {
      originHits += 1;
      res.writeHead(302, { location: targetUrl }).end();
    });
    servers.push(origin);
    const originUrl = await listen(origin);

    await expect(
      nodeFetch(originUrl, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: '{"messages":[]}',
      }),
    ).rejects.toThrow();

    // The point of the test, not a side note: a request that followed the redirect and then
    // failed for some other reason would also make the assertion above pass. Only this
    // proves the body (and, on a real push, the token) never travelled.
    expect(targetHits).toBe(0);
    // The setup itself worked: the redirect really was issued, not skipped by a mistake
    // that would make the test pass for the wrong reason.
    expect(originHits).toBe(1);
  });
});
