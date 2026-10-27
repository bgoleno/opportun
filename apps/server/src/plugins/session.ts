// Resolves the session cookie into req.userCtx for /api requests and exposes requireUser
// as an app decorator. Registered after the security plugin, so forged unsafe requests are
// rejected by CSRF before any session lookup.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { DEMO_USERS } from '../cli/seedDemoFixture';
import '../lib/deviceTokens';
import { getSessionUser } from '../lib/sessions';
import { requireUser } from '../repos/base';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * True when the session lookup itself threw (reportsSessionErrors routes only; issue
     * #108). Never set from a lookup that correctly found no session: that is userCtx staying
     * null, same as always. A route that does not opt in never sees this field change, and
     * the lookup failure still propagates for it exactly as before (a 500, like any other
     * unhandled error), so this is additive rather than a change in what "not signed in"
     * means app-wide.
     */
    sessionLookupFailed: boolean;
  }
}

export interface SessionOptions {
  /** OPPORTUN_DEMO=1: label each signed-in /api response with its demo visitor (see below). */
  demo?: boolean;
}

/** Response header naming the demo visitor behind a request. Demo deployments only. */
export const ACTOR_HEADER = 'x-opportun-actor';

const DEMO_ACTOR_LABELS: ReadonlyMap<string, string> = new Map(
  DEMO_USERS.map((u) => [u.id, u.email.split('@')[0] ?? u.id]),
);

function sessionKey(token: string): string {
  return createHash('sha256').update(`actor:${token}`).digest('hex').slice(0, 10);
}

async function session(app: FastifyInstance, opts: SessionOptions): Promise<void> {
  app.decorateRequest('userCtx', null);
  app.decorateRequest('deviceCtx', null);
  app.decorateRequest('sessionLookupFailed', false);
  app.decorate('requireUser', requireUser);
  app.addHook('onRequest', async (req) => {
    const route = req.routeOptions.url ?? '';
    if (!req.url.startsWith('/api/') && !route.startsWith('/api/')) return;
    // Device routes are bearer-only: a cookie there never becomes a session (strict separation).
    if (req.routeOptions.config.deviceAuth === true) return;
    // Literal property: the cookie name is SESSION_COOKIE (routes/auth.ts).
    const token = req.cookies.opportun_session;
    if (token === undefined || token.length === 0) {
      req.userCtx = null;
      return;
    }
    if (req.routeOptions.config.reportsSessionErrors !== true) {
      req.userCtx = await getSessionUser(app.db, token);
      return;
    }
    try {
      req.userCtx = await getSessionUser(app.db, token);
    } catch (err) {
      req.log.error({ err }, 'session lookup failed');
      req.sessionLookupFailed = true;
      req.userCtx = null;
    }
  });
  if (opts.demo === true) {
    // The host Caddy's access log (docs/demo-deployment.md, "Tracking demo visits") cannot read
    // the session cookie, and the demo accounts are shared logins, so the app names the visitor
    // for it: <account>.<session key>, e.g. demo-user2.3fa91c04d2. Two people signed in as the
    // same account hold different sessions, so they get different values, and one value is
    // enough to follow one visitor without joining it to the IP column. The account part is a
    // seeded label, never an email. The key is a domain-separated hash of the session token, so
    // it is not the stored sessions.id and cannot be turned back into a cookie; it is stable for
    // the life of the session and changes on the next sign-in. Off outside the demo: a real
    // install's users should not be named in response headers.
    app.addHook('onSend', async (req, reply, payload) => {
      const token = req.cookies.opportun_session;
      if (req.userCtx !== null && token !== undefined && token.length > 0) {
        const account = DEMO_ACTOR_LABELS.get(req.userCtx.userId) ?? 'demo-other';
        void reply.header(ACTOR_HEADER, `${account}.${sessionKey(token)}`);
      }
      return payload;
    });
  }
}

export const sessionPlugin = fp<SessionOptions>(session, {
  name: 'opportun-session',
  dependencies: ['@fastify/cookie', 'opportun-security'],
});
