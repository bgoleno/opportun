// The one sender every export destination posts through (design.md 14.10 rule 4;
// https://github.com/bgoleno/opportun/issues/342). Built like the pinned request in
// lib/safeFetch.ts, and used instead of a stock exporter's HTTP client, so these hold in one
// place whatever a library or an OTEL_* variable would do:
// - the socket connects to the address checkDestination checked, never to a fresh lookup;
// - a redirect is never followed (node:http does not follow, and nothing here retries one);
// - one timeout, 10 seconds, covers the whole exchange, response body included;
// - the response body is read and thrown away;
// - the caller gets an outcome class (14.10: refused, timed out, TLS, authentication, 4xx, 5xx,
//   blocked), never the response's status text, headers or body: a destination's answer can
//   quote anything.
// No connection is kept: each request has its own socket (agent: false), so turning export off
// leaves nothing open.
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export const SEND_TIMEOUT_MS = 10_000;

export type SendOutcome =
  | 'ok'
  | 'refused'
  | 'timeout'
  | 'tls'
  | 'auth'
  | 'http_3xx'
  | 'http_4xx'
  | 'http_5xx'
  | 'network'
  | 'blocked';

export interface SendRequest {
  /** Built by endpointsFor from the destination's fields; never from user text. */
  url: string;
  /** The checked address (checkDestination); the only one the socket may reach. */
  address: string;
  body: Uint8Array;
  contentType: string;
  /** The destination's credential header, lowercased names; never Host or a framing header. */
  headers: Readonly<Record<string, string>>;
}

export interface SendOptions {
  timeoutMs?: number;
}

function statusOutcome(status: number): SendOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 300 && status < 400) return 'http_3xx';
  if (status >= 400 && status < 500) return 'http_4xx';
  return 'http_5xx';
}

const TLS_CODE =
  /^(?:EPROTO|ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT)/;

function errorOutcome(err: unknown, timedOut: boolean): SendOutcome {
  if (timedOut) return 'timeout';
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ECONNREFUSED') return 'refused';
  if (typeof code === 'string' && TLS_CODE.test(code)) return 'tls';
  return 'network';
}

/** Posts one batch. Never throws: every failure is an outcome class. */
export function send(req: SendRequest, opts: SendOptions = {}): Promise<SendOutcome> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return Promise.resolve('blocked');
  }
  const family = isIP(req.address);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || family === 0) {
    return Promise.resolve('blocked');
  }
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if (options.all === true) {
      (callback as (err: null, addresses: { address: string; family: number }[]) => void)(null, [
        { address: req.address, family },
      ]);
    } else {
      callback(null, req.address, family);
    }
  };
  const make = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let done = false;
    let timedOut = false;
    const finish = (outcome: SendOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const r = make(
      url,
      {
        method: 'POST',
        lookup: pinned,
        agent: false,
        headers: {
          // The credential header first, so nothing it is named can replace the sender's own.
          ...req.headers,
          'user-agent': 'Opportun',
          'accept-encoding': 'identity',
          'content-type': req.contentType,
          'content-length': String(req.body.byteLength),
        },
      },
      (res: IncomingMessage) => {
        const outcome = statusOutcome(res.statusCode ?? 0);
        // Discarded, but read to the end, so the timeout covers a body that never ends.
        res.on('data', () => undefined);
        res.once('end', () => finish(outcome));
        res.once('error', (err) => finish(errorOutcome(err, timedOut)));
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      r.destroy(new Error('export send timed out'));
      finish('timeout');
    }, opts.timeoutMs ?? SEND_TIMEOUT_MS);
    timer.unref();
    r.once('error', (err) => finish(errorOutcome(err, timedOut)));
    r.end(req.body);
  });
}
