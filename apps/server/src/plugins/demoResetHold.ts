// On a demo server, every request that carries a session cookie or a device token holds the demo
// reset's gate (lib/demoResetGate.ts, #618) from before its session or token is looked up until
// its response is closed. A request already in when the nightly reset starts finishes first; one
// that arrives during it waits, and then finds its session or token gone. Registered before the
// session plugin, so the lookup itself is inside the hold. Not registered off the demo.
//
// Released when the raw response closes: that covers a reply sent the usual way, a hijacked one
// (the tailoring chat's stream, which keeps a reference of its own until its last write, see
// routes/tailoring.ts) and a client that went away. onResponse releases too, for a reply whose raw
// close is not seen (Fastify's inject); release is idempotent.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { DemoResetGate, Hold } from '../lib/demoResetGate';

declare module 'fastify' {
  interface FastifyRequest {
    /** This request's hold on the demo reset's gate; null off the demo or with no credentials. */
    demoResetHold: Hold | null;
  }
}

/** A session cookie or a bearer token: the requests the reset could leave behind. */
function carriesCredentials(req: FastifyRequest): boolean {
  const session = req.cookies.opportun_session;
  return (session !== undefined && session.length > 0) || req.headers.authorization !== undefined;
}

async function demoResetHold(app: FastifyInstance, opts: { gate: DemoResetGate }): Promise<void> {
  app.decorateRequest('demoResetHold', null);
  app.addHook('onRequest', async (req, reply) => {
    if (!carriesCredentials(req)) return;
    const hold = await opts.gate.shared();
    req.demoResetHold = hold;
    reply.raw.once('close', () => hold.release());
  });
  app.addHook('onResponse', async (req) => {
    req.demoResetHold?.release();
  });
}

export const demoResetHoldPlugin = fp(demoResetHold, { name: 'demo-reset-hold' });
