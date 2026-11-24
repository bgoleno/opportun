// The end of the HTTP server's part of a stop (https://github.com/bgoleno/opportun/issues/1004). Node's
// close waits for every connection, and ends those that are idle as it begins and no others: one whose
// answer was still to come is kept afterwards for Fastify's keep-alive time (72 s), as is one that
// never asked for anything. So, from the moment the server is told to stop:
// - an answer that is still to be sent says `connection: close`, and one whose headers have gone (a
//   chat's stream, a download) has its connection closed when all of it has been sent;
// - a connection that never sent anything is closed;
// - whatever is still open after HTTP_STOP_MS is closed as it is.
// A request that comes meanwhile is Fastify's own 503. Nothing changes while the server is not stopping.
import type { ServerResponse } from 'node:http';
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
  const sockets = new Set<Socket>();
  const answers = new Set<ServerResponse>();
  let stopping = false;

  app.server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  app.addHook('onRequest', (_req, reply, done) => {
    const answer = reply.raw;
    answers.add(answer);
    answer.once('finish', () => answers.delete(answer));
    answer.once('close', () => answers.delete(answer));
    done();
  });
  app.addHook('onSend', (_req, reply, _payload, done) => {
    if (stopping) reply.header('connection', 'close');
    done();
  });
  app.addHook('onResponse', (req, _reply, done) => {
    // Once all of the answer is written: what its headers said is no matter now.
    if (stopping) req.raw.socket.destroySoon();
    done();
  });
  app.addHook('preClose', async () => {
    stopping = true;
    // Unref'd: while anything is open the process is there for it to fire, and nothing else needs it.
    const cut = setTimeout(() => app.server.closeAllConnections(), opts.boundMs ?? HTTP_STOP_MS);
    cut.unref();
    app.server.once('close', () => clearTimeout(cut));
    // Node counts an answer as ended once it has been given all of it, and its close would cut one that
    // its client is still reading.
    const unread = [...answers].filter((a) => a.writableEnded && !a.writableFinished);
    await Promise.all(unread.map((a) => new Promise((sent) => a.once('close', sent))));
    for (const socket of sockets) if (socket.bytesRead === 0) socket.destroy();
  });
}

/** Registered first, so that its hooks are on every route. */
export const httpStopPlugin = fp(httpStop, { name: 'http-stop' });
