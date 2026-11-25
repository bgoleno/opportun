// A TCP proxy in front of the test Postgres that can stop passing anything on, without closing
// anything: what a connection sees of a database host that has vanished, or of a network that drops
// its packets (https://github.com/bgoleno/opportun/issues/981).
import net from 'node:net';

interface Pair {
  client: net.Socket;
  server: net.Socket | undefined;
  held: boolean;
}

export interface PgProxy {
  /** `url` with the proxy for its server. */
  through(url: string): string;
  /** From now on nothing passes, either way, on any connection there is or comes. */
  vanish(): void;
  /** What is sent on the connections there are still reaches the server; its answers do not come. */
  holdAnswers(): void;
  /** A new connection passes again. Those there are stay as they are: they never hear more. */
  back(): void;
  /** Passes on what is sent to the server slowly: one piece (64 KB at most) each `ms`. */
  slow(ms: number): void;
  /** How many connections have been made. */
  made(): number;
  close(): Promise<void>;
}

export async function pgProxy(url: string): Promise<PgProxy> {
  const target = new URL(url);
  const pairs = new Set<Pair>();
  let accepting = true;
  let made = 0;
  let pieceMs = 0;
  const listener = net.createServer((client) => {
    made += 1;
    client.on('error', () => undefined);
    const pair: Pair = { client, server: undefined, held: !accepting };
    pairs.add(pair);
    if (!accepting) {
      client.pause();
      return;
    }
    const server = net.connect(Number(target.port || 5432), target.hostname);
    pair.server = server;
    server.on('error', () => undefined);
    client.on('data', (d) => {
      server.write(d);
      if (pieceMs === 0) return;
      client.pause();
      setTimeout(() => {
        if (!pair.held) client.resume();
      }, pieceMs);
    });
    server.on('data', (d) => client.write(d));
    // An end is passed on only while anything is.
    client.on('close', () => {
      if (!pair.held) server.destroy();
    });
    server.on('close', () => {
      if (!pair.held) client.destroy();
    });
  });
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  const { port } = listener.address() as net.AddressInfo;
  const hold = (bothWays: boolean) => {
    for (const pair of pairs) {
      pair.held = true;
      pair.server?.pause();
      if (bothWays) pair.client.pause();
    }
  };
  return {
    through(of) {
      const u = new URL(of);
      u.hostname = '127.0.0.1';
      u.port = String(port);
      return u.toString();
    },
    vanish() {
      accepting = false;
      hold(true);
    },
    holdAnswers: () => hold(false),
    back() {
      accepting = true;
    },
    slow(ms) {
      pieceMs = ms;
    },
    made: () => made,
    async close() {
      for (const { client, server } of pairs) {
        client.destroy();
        server?.destroy();
      }
      await new Promise((done) => listener.close(done));
    },
  };
}
