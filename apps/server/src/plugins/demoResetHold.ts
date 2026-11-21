// On a demo server, every request that carries a session cookie or a device token holds the demo
// reset's gate (lib/demoResetGate.ts, #618), from before its session or token is looked up until
// its handler has finished. A request already in when the nightly reset starts finishes first; one
// that arrives during it waits, and then finds its session or token gone. Registered before the
// session plugin, so the lookup itself is inside the hold. Not registered off the demo.
//
// How long a request can hold it (tl and sec on #618: none may hold longer than the reset waits):
//   - the handler's own run: a route's handler keeps a reference of its own while it runs (the
//     onRoute wrapper below), so a client that goes away mid-handler never lets the reset in under
//     a handler still writing;
//   - before the handler starts (the body still arriving, say), only START_LIMIT_MS: past it the
//     request is ended and gives its place back, and its handler never runs;
//   - once the reply is handed over, nothing: a client that reads it slowly holds nothing;
//   - and every hold's hard bound (HOLD_LIMIT_MS), whatever happens.
// A request that ends while it waits for the gate (its client gone) gives its place back as soon as
// it gets it: the release is attached before the wait, never after.
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import fp from 'fastify-plugin';
import type { DemoResetGate, Hold } from '../lib/demoResetGate';
import { HttpError } from '../lib/errors';

/** How long a request may hold the gate before its handler starts. */
export const START_LIMIT_MS = 20_000;

/**
 * How long a streamed reply (the tailoring chat) may run on a demo server: below the hold's bound,
 * so the stream ends, and its handler saves what it has, while it still holds the gate.
 */
export const STREAM_LIMIT_MS = 40_000;

/**
 * How long one AI provider request may take on a demo server (#656; lib/ai.ts setAiCallLimit):
 * below the hold's bound, for the AI calls a handler or a job makes, streamed or not.
 */
export const AI_CALL_LIMIT_MS = 40_000;

declare module 'fastify' {
  interface FastifyInstance {
    /** On a demo server, how long a streamed reply may run; undefined elsewhere (no limit). */
    demoStreamLimitMs: number | undefined;
  }
  interface FastifyRequest {
    /** This request's hold on the demo reset's gate; null off the demo or with no credentials. */
    demoResetHold: Hold | null;
    /** Set when the request ran out of time before its handler started (START_LIMIT_MS). */
    demoResetHoldLost: boolean;
  }
}

export interface DemoResetHoldOptions {
  gate: DemoResetGate;
  /** Tests set shorter limits; production uses START_LIMIT_MS and the gate's HOLD_LIMIT_MS. */
  startLimitMs?: number;
  holdLimitMs?: number;
  streamLimitMs?: number;
}

/** A session cookie or a bearer token: the requests the reset could leave behind. */
function carriesCredentials(req: FastifyRequest): boolean {
  const session = req.cookies.opportun_session;
  return (session !== undefined && session.length > 0) || req.headers.authorization !== undefined;
}

/** Ends a request's connection: the client gets nothing more, and the body stops arriving. */
function end(reply: FastifyReply): void {
  if (!reply.raw.destroyed) reply.raw.destroy();
}

async function demoResetHold(app: FastifyInstance, opts: DemoResetHoldOptions): Promise<void> {
  const startLimit = opts.startLimitMs ?? START_LIMIT_MS;
  app.decorate('demoStreamLimitMs', opts.streamLimitMs ?? STREAM_LIMIT_MS);
  app.decorateRequest('demoResetHold', null);
  app.decorateRequest('demoResetHoldLost', false);
  const starts = new WeakMap<FastifyRequest, ReturnType<typeof setTimeout>>();

  app.addHook('onRequest', async (req, reply) => {
    if (!carriesCredentials(req)) return;
    // Attached before the wait: a client that goes away while this request waits behind the reset
    // has its close seen here, and the hold is given back the moment it is taken.
    let gone = false;
    let hold: Hold | null = null;
    const letGo = () => {
      gone = true;
      hold?.release();
    };
    reply.raw.once('close', letGo);
    hold = await opts.gate.shared({
      ...(opts.holdLimitMs === undefined ? {} : { limitMs: opts.holdLimitMs }),
      onExpire: () => {
        req.log.warn('a request held the demo reset gate to its limit; ended');
        end(reply);
      },
    });
    if (gone || reply.raw.destroyed || req.raw.destroyed) {
      hold.release();
      return;
    }
    req.demoResetHold = hold;
    // Until the handler starts, the client decides how long this takes: bounded.
    const timer = setTimeout(() => {
      req.demoResetHoldLost = true;
      req.log.warn('a request held the demo reset gate too long before its handler; ended');
      hold?.release();
      end(reply);
    }, startLimit);
    timer.unref?.();
    starts.set(req, timer);
  });

  // The handler's run holds a reference of its own, whatever the connection does.
  app.addHook('onRoute', (route) => {
    const handler = route.handler as RouteHandlerMethod;
    route.handler = async function held(this: FastifyInstance, req, reply) {
      const hold = req.demoResetHold;
      if (hold === null) return handler.call(this, req, reply);
      clearTimeout(starts.get(req));
      // Ended before it could start (out of time, or its client gone): nothing runs.
      const ref = req.demoResetHoldLost ? null : hold.retain();
      if (ref === null) throw new HttpError(503, 'try_again', 'Try again in a moment.');
      try {
        return await handler.call(this, req, reply);
      } finally {
        ref.release();
      }
    } as RouteHandlerMethod;
  });

  // Once the reply is handed over, the request holds nothing more (the handler, if any, is done).
  const giveBack = async (req: FastifyRequest) => {
    clearTimeout(starts.get(req));
    req.demoResetHold?.release();
  };
  app.addHook('onSend', async (req, _reply, payload) => {
    await giveBack(req);
    return payload;
  });
  app.addHook('onResponse', giveBack);
  app.addHook('onRequestAbort', giveBack);
  app.addHook('onError', async (req) => {
    // The reply still goes out through onSend; this covers a request whose reply never does.
    if (req.raw.destroyed) await giveBack(req);
  });
}

export const demoResetHoldPlugin = fp(demoResetHold, { name: 'demo-reset-hold' });
