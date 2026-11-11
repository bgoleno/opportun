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
import { isCollecting, obs, type StartedSpan } from '../obs';
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

/**
 * The one label of the SPA's built assets (#371). routes/spa.ts registers each file as a route of
 * its own (wildcard: false), and under /assets/ their names are content hashes, new with every
 * deploy: as their own templates, each deploy would add a series per file.
 */
export const SPA_ASSET_ROUTE = '/assets/*';

/** The route's template, the SPA's assets under one label, or _OTHER when no route matched. */
function routeLabel(url: string | undefined): string {
  if (url === undefined) return OTHER;
  return url.startsWith('/assets/') ? SPA_ASSET_ROUTE : url;
}

function onRequest(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!isCollecting()) {
    done();
    return;
  }
  const route = routeLabel(req.routeOptions.url);
  const method = httpMethod(req.method);
  const span =
    route.startsWith(SPAN_PREFIX) || req.url.startsWith(SPAN_PREFIX)
      ? obs.startSpan('http.server', { 'http.request.method': method, 'http.route': route })
      : undefined;
  observed.set(req, { started: performance.now(), method, route, span, errorType: undefined });
  // The one place an abort shows for every method: the response closes before it finished. A
  // request whose body was read has already ended its own stream normally, so Fastify's
  // onRequestAbort never fires for it, and a slow POST (an AI call) is the likeliest to be
  // abandoned (tl on #391). A completed request closes after onResponse, finished, and its entry
  // is gone by then.
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) recordAbort(req);
  });
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

/**
 * A request the client closed before it was answered (#371): no onResponse comes, so without this
 * it recorded no metric and its span never ended. Recorded with no status code, none having been
 * sent, and error.type `aborted`, with the span failed: an unanswered request is not a success. A
 * proxy giving up on a slow request looks exactly like this to the server, and it is not like a
 * 4xx, which the server answered; design 14.4 counts a request's errors as its points with
 * error.type. No `error` event: the server did not fail. The entry is removed, so nothing records
 * it twice.
 */
function recordAbort(req: FastifyRequest): void {
  const o = observed.get(req);
  if (o === undefined) return;
  observed.delete(req);
  obs.record('http.server.request.duration', (performance.now() - o.started) / 1000, {
    'http.request.method': o.method,
    'http.route': o.route,
    'error.type': ABORTED,
  });
  o.span?.fail(ABORTED);
  o.span?.end();
}

const ABORTED = 'aborted';

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
  const attributes: Record<string, unknown> = {
    'http.request.method': o.method,
    'http.route': o.route,
    'http.response.status_code': status,
    ...(failure === undefined ? {} : { 'error.type': failure }),
  };
  obs.record('http.server.request.duration', (performance.now() - o.started) / 1000, attributes);
  if (failure !== undefined) {
    const userId = requestUser(req);
    // Inside the request's context, so the event carries the span's trace id.
    context.with(o.span?.context ?? context.active(), () =>
      obs.event(
        'error',
        { 'error.type': failure, 'http.route': o.route },
        userId === undefined ? {} : { userId },
      ),
    );
  }
  if (o.span !== undefined) {
    o.span.set({ 'http.response.status_code': status });
    if (failure !== undefined) o.span.fail(failure);
    o.span.end();
  }
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
