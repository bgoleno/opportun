// The HTTP route boundary (design.md 14.2, 14.4, 14.9; https://github.com/bgoleno/opportun/issues/343).
// Every request records http.server.request.duration by its route template (never its URL),
// method and status; a 5xx carries error.type (the thrown error's class or code, else the
// status) and writes one `error` event in the request's trace. Requests under /api/v1 also get
// a SERVER span, `{method} {route}`.
//
// The context (14.2): a hook cannot wrap the code that runs after it, and the async context set
// in onRequest is lost while the body is parsed. So onRequest starts the span and calls `done`
// inside its context, preValidation enters that context again, and the request keeps it as
// `request.obsContext` for a handler that passes it to a workflow span explicitly. onResponse
// ends the span.
//
// The user (14.6): preValidation also puts the request's user in that context, under the key
// packages/ai defines, so the AI router knows whose request a model call belongs to. It is set
// there, not in onRequest, because the session lookup (plugins/session.ts) and a connector
// route's device-token check are onRequest hooks that run after this plugin's.
//
// With collection off, onRequest returns after one check and leaves nothing on the request, so
// the other hooks find nothing to do (14.11).
import type { Context } from '@opentelemetry/api';
import { context } from '@opentelemetry/api';
import { USER_CONTEXT_KEY } from '@opportun/ai';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  isCollecting,
  obs,
  prepareRecord,
  prepareSpan,
  prepareSpanAttributes,
  recordPrepared,
  type GatedSpanAttributes,
  type PreparedRecord,
  type PreparedSpan,
  type StartedSpan,
} from '../obs';
import { logRequest } from '../obs/log';
import { OTHER } from '../obs/catalog';
import { errorType, httpMethod } from '../obs/outbound';

declare module 'fastify' {
  interface FastifyRequest {
    /** The request's trace context while collection is on (14.2); null otherwise. */
    obsContext: Context | null;
  }
}

/** What onRequest leaves for the later hooks; absent when collection was off at the start. */
interface Observed {
  started: number;
  method: string;
  route: string;
  span: StartedSpan | undefined;
  errorType: string | undefined;
}

const observed = new WeakMap<FastifyRequest, Observed>();

/** Spans for the API only (14.2); the SPA's files and /healthz get the metric alone. */
const SPAN_PREFIX = '/api/v1';

// Prepared attributes (https://github.com/bgoleno/opportun/issues/374, tl's 2a). A request's span
// and metric carry the same few values for every request of a route: its template, method and
// status. They are gated once per (method, route), for the span, and per (method, route, status),
// for the metric and the span's status, then reused, as obs/database.ts does for statements. A
// 5xx is not cached: its error.type varies, so it goes through the gate each time. Both caches are
// bounded, because a route that is not one of the registered templates is _OTHER and the SPA's
// files are routes of their own; past the bound a request is gated as before.
export const HTTP_PREPARED_MAX = 1_000;

interface PreparedDone {
  record: PreparedRecord;
  status: GatedSpanAttributes;
}

const preparedSpans = new Map<string, PreparedSpan>();
const preparedDone = new Map<string, PreparedDone>();

function spanFor(method: string, route: string): PreparedSpan {
  const key = `${method} ${route}`;
  const known = preparedSpans.get(key);
  if (known !== undefined) return known;
  const p = prepareSpan('http.server', { 'http.request.method': method, 'http.route': route });
  if (preparedSpans.size < HTTP_PREPARED_MAX) preparedSpans.set(key, p);
  return p;
}

function doneFor(method: string, route: string, status: number): PreparedDone {
  const key = `${method} ${route} ${status}`;
  const known = preparedDone.get(key);
  if (known !== undefined) return known;
  const p: PreparedDone = {
    record: prepareRecord('http.server.request.duration', {
      'http.request.method': method,
      'http.route': route,
      'http.response.status_code': status,
    }),
    status: prepareSpanAttributes('http.server', { 'http.response.status_code': status }),
  };
  if (preparedDone.size < HTTP_PREPARED_MAX) preparedDone.set(key, p);
  return p;
}

/** How many (method, route, status) entries are prepared; for tests. */
export function httpPreparedCount(): number {
  return preparedDone.size;
}

/** Empties both caches; for tests. */
export function clearHttpPrepared(): void {
  preparedSpans.clear();
  preparedDone.clear();
}

function onRequest(req: FastifyRequest, _reply: FastifyReply, done: () => void): void {
  if (!isCollecting()) {
    done();
    return;
  }
  const route = req.routeOptions.url ?? OTHER;
  const method = httpMethod(req.method);
  const span =
    route.startsWith(SPAN_PREFIX) || req.url.startsWith(SPAN_PREFIX)
      ? obs.startPreparedSpan(spanFor(method, route))
      : undefined;
  observed.set(req, { started: performance.now(), method, route, span, errorType: undefined });
  if (span === undefined) {
    done();
    return;
  }
  req.obsContext = span.context;
  context.with(span.context, done);
}

/** The signed-in user, by session cookie or device token; undefined when nobody is. */
function requestUser(req: FastifyRequest): string | undefined {
  return req.userCtx?.userId ?? req.deviceCtx?.userId;
}

function preValidation(req: FastifyRequest, _reply: FastifyReply, done: () => void): void {
  if (req.obsContext === null) {
    done();
    return;
  }
  const userId = requestUser(req);
  if (userId !== undefined) req.obsContext = req.obsContext.setValue(USER_CONTEXT_KEY, userId);
  context.with(req.obsContext, done);
}

function onError(req: FastifyRequest, _reply: FastifyReply, err: Error, done: () => void): void {
  const o = observed.get(req);
  if (o !== undefined) o.errorType = errorType(err);
  done();
}

function onResponse(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  // #345: Opportun's own access log line, collection on or off (design 14.9): the route's
  // template, never the request's url. Fastify's own request logging is off (app.ts).
  logRequest(req.log, {
    method: req.method,
    route: req.routeOptions.url,
    statusCode: reply.statusCode,
    ip: req.ip,
    params: req.params,
  });
  const o = observed.get(req);
  if (o === undefined) {
    done();
    return;
  }
  observed.delete(req);
  const status = reply.statusCode;
  // A 4xx is the client's error, not the server's (the HTTP conventions): no error.type.
  const failure = status >= 500 ? (o.errorType ?? String(status)) : undefined;
  const seconds = (performance.now() - o.started) / 1000;
  if (failure === undefined) {
    // The common case: attributes prepared once per (method, route, status).
    const prepared = doneFor(o.method, o.route, status);
    recordPrepared(prepared.record, seconds);
    o.span?.setGated(prepared.status);
  } else {
    obs.record('http.server.request.duration', seconds, {
      'http.request.method': o.method,
      'http.route': o.route,
      'http.response.status_code': status,
      'error.type': failure,
    });
    const userId = requestUser(req);
    // Inside the request's context, so the event carries the span's trace id.
    context.with(o.span?.context ?? context.active(), () =>
      obs.event(
        'error',
        { 'error.type': failure, 'http.route': o.route },
        userId === undefined ? {} : { userId },
      ),
    );
    o.span?.set({ 'http.response.status_code': status });
    o.span?.fail(failure);
  }
  o.span?.end();
  done();
}

async function obsHttp(app: FastifyInstance): Promise<void> {
  app.decorateRequest('obsContext', null);
  app.addHook('onRequest', onRequest);
  app.addHook('preValidation', preValidation);
  app.addHook('onError', onError);
  app.addHook('onResponse', onResponse);
}

/** Not encapsulated: its hooks see every route. Register first, so its onRequest runs first. */
export const obsHttpPlugin = fp(obsHttp, { name: 'opportun-obs-http' });
