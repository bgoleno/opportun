// The end of the HTTP server's part of a stop (https://github.com/bgoleno/opportun/issues/1004). Node's
// close waits for every connection, and ends those that are idle as it begins and no others. One whose
// answer was still to come is kept afterwards for Fastify's keep-alive time (72 s), as is one that never
// asked for anything; and one whose answer has been handed over and is still being read counts as idle,
// and is cut. So, from the moment the server is told to stop:
// - a connection with nothing to answer is closed, one that never asked included (one in the middle of
//   asking is not);
// - the last answer of any other says `connection: close`, and the connection is closed when all of it
//   has been sent (its headers may have gone before the stop: a chat's stream, a download);
// - whatever is still open after HTTP_STOP_MS is closed as it is.
// A request that comes meanwhile is Fastify's own 503. Nothing changes while the server is not stopping.
// Nothing here waits: Fastify gives a hook 10 s, and then fails the close (sec on
// https://github.com/bgoleno/opportun/pull/1012).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

/**
 * How long a stop waits for what is in hand, from when it begins. Longer than a statement can wait for
 * a Postgres host that has vanished (a minute, https://github.com/bgoleno/opportun/issues/981), so that
 * request still has its answer, and shorter than systemd's 90 s before it kills.
 */
export const HTTP_STOP_MS = 65_000;

export interface HttpStopOptions {
  /** Instead of HTTP_STOP_MS (tests). */
  boundMs?: number | undefined;
}

async function httpStop(app: FastifyInstance, opts: HttpStopOptions): Promise<void> {
  const { server } = app;
  /** Each connection, and its requests whose answer has not all been sent (a client can ask ahead). */
  const pending = new Map<Socket, number>();
  let stopping = false;

  server.on('connection', (socket: Socket) => {
    pending.set(socket, 0);
    socket.once('close', () => pending.delete(socket));
  });
  // Before Fastify's own listener, so that a request is counted by the time it is answered.
  server.prependListener('request', ({ socket }: IncomingMessage, answer: ServerResponse) => {
    const before = pending.get(socket);
    if (before === undefined) return;
    pending.set(socket, before + 1);
    answer.once('finish', () => {
      const now = pending.get(socket);
      if (now === undefined) return; // it has gone
      pending.set(socket, now - 1);
      if (stopping && now === 1) socket.destroySoon();
    });
  });
  // What node's close() calls, and nothing else does. Node knows which connection is in the middle of
  // asking, and takes an answer for done once it has been handed all of it: one that is still being sent
  // is kept from it here. If a node's close() ever stops calling it, httpStop.test.ts's slow readers fail.
  const closeIdle = server.closeIdleConnections.bind(server);
  server.closeIdleConnections = () => {
    const answering = [...pending].filter(([, n]) => n > 0).map(([socket]) => socket);
    for (const socket of answering) socket.destroy = () => socket;
    try {
      closeIdle();
    } finally {
      for (const socket of answering) Reflect.deleteProperty(socket, 'destroy');
    }
    for (const socket of pending.keys()) if (socket.bytesRead === 0) socket.destroy();
  };
  app.addHook('onSend', (req, reply, _payload, done) => {
    // Not while another answer is behind it on the connection, which this would lose.
    const behind = (pending.get(req.raw.socket) ?? 1) > 1;
    if (stopping && !behind) reply.header('connection', 'close');
    done();
  });
  app.addHook('preClose', (done) => {
    stopping = true;
    // Unref'd: while anything is open the process is there for it to fire, and nothing else needs it.
    const cut = setTimeout(() => server.closeAllConnections(), opts.boundMs ?? HTTP_STOP_MS);
    cut.unref();
    server.once('close', () => clearTimeout(cut));
    done();
  });
}

/** Registered first, so that its hooks are on every route. */
export const httpStopPlugin = fp(httpStop, { name: 'http-stop' });
