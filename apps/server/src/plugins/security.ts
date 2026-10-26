// Security middleware (NFR-SEC2, NFR-SEC5): response headers, double-submit CSRF and the
// central error handler. Registered once at the root so it covers every route.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { InvalidTransitionError } from '@opportun/core';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * A device-token route (lib/deviceTokens deviceRoute): bearer-only, so no CSRF check and
     * no session resolution. Only valid together with the requireDeviceToken preHandler.
     */
    deviceAuth?: boolean;
    /**
     * Opts a route into telling a failed session lookup apart from a clean "not signed in"
     * (plugins/session.ts, issue #108), instead of the lookup failure propagating and 500ing
     * like any other unhandled error. A route takes this on only when it has something better
     * to say for that case; everything else keeps today's behavior.
     */
    reportsSessionErrors?: boolean;
  }
}

/** Marks the requireDeviceToken preHandler so a deviceAuth route without it is refused. */
export const DEVICE_AUTH_MARK = Symbol.for('opportun.deviceAuth');

export const CSRF_COOKIE = 'opportun_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export const SECURITY_HEADERS = {
  // img-src 'self' data: is the one loosening of default-src 'self', for the TOTP enrollment
  // QR (a server-rendered PNG data URL; docs/superpowers/plans/2026-10-17-iteration-3-m5.md,
  // Task 3). Scripts, styles, frames and connections stay same-origin only.
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
} as const;

/**
 * Strict-Transport-Security, sent only when the instance is served over HTTPS (its public
 * base URL is https). On plain-HTTP local installs the header would be ignored at best.
 */
export const HSTS_HEADER = { 'strict-transport-security': 'max-age=31536000' } as const;

export interface SecurityOptions {
  /** Send HSTS on every response (set when OPPORTUN_BASE_URL is https). */
  hsts?: boolean;
}

/**
 * Unsafe-method routes reachable without a session, so without a CSRF cookie yet. The 2FA
 * verify step is the second half of login: its credential is the pending token in the body.
 */
const CSRF_EXEMPT = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/2fa/verify',
]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ValidationIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

/**
 * Whether this request arrived over HTTPS, which is what the Secure flag on a cookie has to
 * follow. One install answers at localhost, at <machine>.local and at a LAN IP at the same
 * time (ADR-14), so OPPORTUN_BASE_URL cannot decide it for all of them: a Secure cookie
 * never travels the plain-HTTP paths and login silently fails there. req.protocol reads
 * X-Forwarded-Proto only from a proxy app.ts already trusts, and the socket otherwise.
 */
export function isSecureRequest(req: FastifyRequest): boolean {
  return req.protocol === 'https';
}

/**
 * Sets the readable (not HttpOnly) CSRF cookie alongside a new session. The SPA echoes
 * it in x-csrf-token; a cross-site page can neither read it nor set the header.
 */
export function issueCsrfCookie(reply: FastifyReply, secure: boolean, expires: Date): string {
  const token = randomBytes(32).toString('base64url');
  reply.setCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    secure,
    expires,
  });
  return token;
}

export function clearCsrfCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(CSRF_COOKIE, { httpOnly: false, sameSite: 'lax', path: '/', secure });
}

function pathOf(req: FastifyRequest): string {
  const q = req.url.indexOf('?');
  return q === -1 ? req.url : req.url.slice(0, q);
}

function needsCsrf(req: FastifyRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return false;
  // Bearer-only device routes ignore cookies entirely, so there is nothing to forge.
  if (req.routeOptions.config.deviceAuth === true) return false;
  const route = req.routeOptions.url;
  const path = pathOf(req);
  const isApi = path.startsWith('/api/') || (route?.startsWith('/api/') ?? false);
  if (!isApi) return false;
  // Exempt by matched route pattern, never by a client-controlled string alone.
  return route === undefined || !CSRF_EXEMPT.has(route);
}

function csrfMatches(req: FastifyRequest): boolean {
  // Literal properties: CSRF_COOKIE and CSRF_HEADER.
  const cookie = req.cookies.opportun_csrf;
  const header = req.headers['x-csrf-token'];
  if (typeof cookie !== 'string' || typeof header !== 'string') return false;
  if (cookie.length === 0) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

function zodIssues(err: ZodError): ValidationIssue[] {
  return err.issues.map((i) => ({
    path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
    code: i.code,
    message: i.message,
  }));
}

const CLIENT_CODES = new Map<number, string>([
  [400, 'bad_request'],
  [404, 'not_found'],
  [405, 'method_not_allowed'],
  [406, 'not_acceptable'],
  [413, 'payload_too_large'],
  [415, 'unsupported_media_type'],
  [429, 'rate_limited'],
]);

function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send({ error: { ...err.details, code: err.code } });
  }
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: { code: 'validation', issues: zodIssues(err) } });
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    const context = err.validationContext;
    const issues: ValidationIssue[] = err.validation.map((v) => ({
      path: [
        ...(context === undefined ? [] : [context]),
        ...v.instancePath.split('/').filter((s) => s.length > 0),
      ],
      code: v.keyword,
      message: v.message ?? 'Invalid input',
    }));
    return reply.code(400).send({ error: { code: 'validation', issues } });
  }
  if (err instanceof InvalidTransitionError) {
    return reply.code(422).send({
      error: { code: 'invalid_transition', message: err.message, from: err.from, to: err.to },
    });
  }
  const status = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
  if (status >= 400 && status < 500 && !isResponseSerializationError(err)) {
    // Framework-level client errors (bad JSON, wrong content type, body too large).
    return reply.code(status).send({ error: { code: CLIENT_CODES.get(status) ?? 'bad_request' } });
  }
  // Unknown: the full error goes to the server log only.
  req.log.error({ err }, 'unhandled error');
  return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
}

function hasDeviceAuth(preHandler: unknown): boolean {
  const list: unknown[] = Array.isArray(preHandler) ? preHandler : [preHandler];
  return list.some(
    (h) =>
      typeof h === 'function' &&
      // eslint-disable-next-line security/detect-object-injection -- a module-private symbol key
      (h as unknown as Record<symbol, unknown>)[DEVICE_AUTH_MARK] === true,
  );
}

async function security(app: FastifyInstance, opts: SecurityOptions): Promise<void> {
  const headers = opts.hsts === true ? { ...SECURITY_HEADERS, ...HSTS_HEADER } : SECURITY_HEADERS;
  // A deviceAuth route skips CSRF and sessions; without device auth it would be wide open.
  app.addHook('onRoute', (route) => {
    const config = route.config as { deviceAuth?: boolean } | undefined;
    if (config?.deviceAuth === true && !hasDeviceAuth(route.preHandler)) {
      throw new Error(
        `route ${route.method.toString()} ${route.url} sets deviceAuth without requireDeviceToken`,
      );
    }
  });
  app.addHook('onRequest', async (req, reply) => {
    if (needsCsrf(req) && !csrfMatches(req)) {
      return reply.code(403).send({ error: { code: 'csrf' } });
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.headers(headers);
    return payload;
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found' } }));
}

/** Not encapsulated: hooks and handlers apply to the whole app. Register after @fastify/cookie. */
export const securityPlugin = fp(security, {
  name: 'opportun-security',
  dependencies: ['@fastify/cookie'],
});
