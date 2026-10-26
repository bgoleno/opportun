// Resolves the session cookie into req.userCtx for /api requests and exposes requireUser
// as an app decorator. Registered after the security plugin, so forged unsafe requests are
// rejected by CSRF before any session lookup.
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
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

async function session(app: FastifyInstance): Promise<void> {
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
}

export const sessionPlugin = fp(session, {
  name: 'opportun-session',
  dependencies: ['@fastify/cookie', 'opportun-security'],
});
