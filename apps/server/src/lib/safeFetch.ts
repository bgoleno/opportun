// SSRF-safe outbound fetch (NFR-SEC6, design 6.3). Every adapter that fetches a URL it did not
// author (discovery, ATS APIs, careers pages, link snapshots) goes through safeFetch:
//   - https only, no embedded credentials;
//   - the host must be on the caller's allowlist (an entry also covers its subdomains), and
//     prohibited hosts are refused whatever the allowlist says (the compliance boundary, C-1);
//   - allowPublic mode (a user-entered URL such as a company careers page) drops the allowlist
//     only: any public https host may be fetched, except prohibited hosts, and every other rule
//     below (public addresses on every hop, redirect limit, caps) still applies;
//   - DNS is resolved here and every answer must be public; the connection is then pinned to
//     the checked address, so a second lookup cannot rebind it to a private one;
//   - redirects are followed manually (at most 3), each hop checked like the first;
//   - default 15 s deadline for the whole exchange and a 5 MB body cap;
//   - a per-host token bucket allows 1 request per second (callers wait, not fail).
import { lookup } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export type FetchBlockedReason =
  'scheme' | 'host_not_allowed' | 'private_address' | 'too_large' | 'timeout' | 'redirect_blocked';

export class FetchBlockedError extends Error {
  override name = 'FetchBlockedError';
  readonly reason: FetchBlockedReason;

  constructor(reason: FetchBlockedReason, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.reason = reason;
  }
}

export interface SafeFetchOptions {
  allowHosts: string[];
  /**
   * Any public https host instead of the allowlist (user-entered URLs). PROHIBITED_HOSTS stay
   * refused and the private-address and redirect checks are unchanged.
   */
  allowPublic?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  /**
   * A request with a body instead of a GET: a form POST (an OAuth token endpoint) or, with
   * `method`, a JSON POST/PATCH/PUT (Reactive Resume). A request with a body never follows a
   * redirect: the body may carry a credential, so any 3xx is refused.
   */
  post?: RequestBody;
  /**
   * Extra request headers (an API key header). A request that carries them never follows a
   * redirect, not even to the same host: the allowlist matches subdomains and ignores the
   * port, so following one could hand the credential to a host or port it was not meant
   * for. Refused together with allowPublic for the same reason.
   */
  headers?: Record<string, string>;
  /**
   * C-1's official-API clause: ONE exact URL from OFFICIAL_API_URLS this call may fetch
   * although its host is prohibited. Any URL not on that list is refused outright; any other
   * URL on the host is still refused, the host must still be on allowHosts, and the call must
   * carry a body or caller headers, so a redirect is never followed.
   */
  officialApiUrl?: string;
}

export interface RequestBody {
  contentType: string;
  body: string;
  /** Default POST. */
  method?: 'POST' | 'PATCH' | 'PUT';
}

export interface SafeFetchResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  /**
   * The URL actually answered, after following every redirect (issue #20): a starting URL that
   * 30x's straight into its destination gives the caller no other way to learn where it landed.
   * Each hop (this one included) already passed the same host/address checks as the first —
   * following a redirect re-invokes checkHop on the new target before it is ever fetched — so
   * surfacing it is informational, not a new trust boundary.
   */
  url: string;
}

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 3;
const BUCKET_INTERVAL_MS = 1000;

/**
 * Hosts never fetched, whatever an allowlist says (design 6.2: user capture and official
 * exports only). Matched like allowlist entries, so subdomains are covered.
 */
export const PROHIBITED_HOSTS: readonly string[] = ['linkedin.com', 'lnkd.in'];

/**
 * The C-1 carve-out. C-1 lists "any official API the user has access to" as a supported path,
 * and OAuth sign-in (FR-S4) is exactly that: the user consents on LinkedIn, then the server
 * calls these two official endpoints with that grant. They are the ONLY URLs on a prohibited
 * host that may ever be fetched, one exact URL per call (SafeFetchOptions.officialApiUrl), and
 * this list is the sole authority: safeFetch refuses any officialApiUrl not on it, so no
 * caller can bless a new URL from outside. Only lib/oauthProviders.ts uses them.
 */
export const OFFICIAL_API_URLS = {
  linkedinToken: 'https://www.linkedin.com/oauth/v2/accessToken',
  linkedinUserinfo: 'https://api.linkedin.com/v2/userinfo',
} as const;
const OFFICIAL_API_URL_SET: ReadonlySet<string> = new Set(Object.values(OFFICIAL_API_URLS));

/**
 * Public, unauthenticated applicant-tracking APIs for discovery adapters (M3). Kept here so
 * the compliance grep in safeFetch.test.ts sees every allowlist in one place.
 */
export const ATS_ALLOW_HOSTS: readonly string[] = [
  'boards-api.greenhouse.io',
  'api.lever.co',
  'api.ashbyhq.com',
  'api.smartrecruiters.com',
  'apply.workable.com',
];

// ---------------------------------------------------------------------------
// Address classification

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback, and the deprecated IPv4-compatible form (::a.b.c.d)
  ['::ffff:0:0:0', 96], // IPv4-translated (embeds an IPv4 address)
  ['64:ff9b::', 96], // NAT64 (embeds an IPv4 address)
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments (Teredo included)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/**
 * The IPv4 address inside an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:hhhh:hhhh). The
 * mapped form is the only one worth unwrapping, because it is the only one a dual-stack lookup
 * really answers with; the other IPv6 forms that embed an IPv4 address (6to4, NAT64,
 * IPv4-compatible, IPv4-translated) are transition mechanisms blocked by range above, so no
 * embedded private address can ride in on one.
 */
function mappedIpv4(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  if (!lower.startsWith('::ffff:')) return undefined;
  const rest = lower.slice('::ffff:'.length);
  if (isIP(rest) === 4) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (hex === null) return undefined;
  const hi = parseInt(hex[1] ?? '0', 16);
  const lo = parseInt(hex[2] ?? '0', 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/** True for loopback, private, link-local and other non-public ranges, and for non-IPs. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = mappedIpv4(ip);
    if (v4 !== undefined) return blocked.check(v4, 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  // Not an address at all: fail closed.
  return true;
}

// ---------------------------------------------------------------------------
// Injected IO (tests replace DNS, the transport and the clock)

/** One request to make: the URL, connected to the already-checked address. */
export interface FetchTarget {
  url: URL;
  address: string;
  /** Present only for a request with a body (SafeFetchOptions.post). */
  post?: RequestBody;
  /** Present only when the caller passed headers (SafeFetchOptions.headers). */
  headers?: Record<string, string>;
}

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer>;
}

export interface SafeFetchDeps {
  resolve(host: string): Promise<string[]>;
  request(target: FetchTarget, signal: AbortSignal): Promise<RawResponse>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** An HTTPS GET (or POST/PATCH/PUT with a body) whose socket can only reach `target.address` (DNS pinning). */
function pinnedRequest(target: FetchTarget, signal: AbortSignal): Promise<RawResponse> {
  const family = isIP(target.address);
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if (options.all === true) {
      (callback as (err: null, addresses: { address: string; family: number }[]) => void)(null, [
        { address: target.address, family },
      ]);
    } else {
      callback(null, target.address, family);
    }
  };
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      target.url,
      {
        method: target.post === undefined ? 'GET' : (target.post.method ?? 'POST'),
        lookup: pinned,
        signal,
        headers: {
          ...target.headers,
          'user-agent': 'Opportun',
          // A caller may ask for a media type (Workday's CXS API wants application/json).
          accept: target.headers?.accept ?? '*/*',
          'accept-encoding': 'identity',
          ...(target.post === undefined
            ? {}
            : {
                'content-type': target.post.contentType,
                'content-length': String(Buffer.byteLength(target.post.body)),
              }),
        },
      },
      (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }),
    );
    req.once('error', reject);
    req.end(target.post?.body);
  });
}

const realDeps: SafeFetchDeps = {
  resolve: async (host) =>
    (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
  request: pinnedRequest,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// ---------------------------------------------------------------------------

function hostMatches(host: string, entries: readonly string[]): boolean {
  return entries.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/\.$/, '');
    return entry.length > 0 && (host === entry || host.endsWith(`.${entry}`));
  });
}

/** True for a prohibited host or any subdomain of one (a trailing dot is ignored). */
export function isProhibitedHost(host: string): boolean {
  return hostMatches(host.toLowerCase().replace(/\.$/, ''), PROHIBITED_HOSTS);
}

function parseTarget(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlockedError('scheme', 'not a valid URL');
  }
  if (url.protocol !== 'https:') throw new FetchBlockedError('scheme', url.protocol);
  if (url.username !== '' || url.password !== '') {
    throw new FetchBlockedError('scheme', 'credentials in URL');
  }
  return url;
}

function toHeaders(raw: RawResponse['headers']): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}

function header(raw: RawResponse['headers'], name: string): string | undefined {
  // eslint-disable-next-line security/detect-object-injection -- a fixed header name
  const value = raw[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Rejects when the signal aborts, so a transport that ignores it cannot outlive the deadline. */
function untilAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new FetchBlockedError('timeout'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new FetchBlockedError('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Builds a safeFetch over the given IO, with its own per-host rate buckets. */
export function createSafeFetch(deps: SafeFetchDeps) {
  /** host -> time the next token is available. */
  const nextFree = new Map<string, number>();

  async function takeToken(host: string, signal: AbortSignal): Promise<void> {
    const now = deps.now();
    const at = Math.max(now, nextFree.get(host) ?? now);
    nextFree.set(host, at + BUCKET_INTERVAL_MS);
    if (at > now) await untilAbort(deps.sleep(at - now), signal);
  }

  /** Scheme, prohibited and allowed hosts, and a public pinned address for one hop. */
  async function checkHop(
    url: URL,
    allowHosts: readonly string[],
    allowPublic: boolean,
    officialApiUrl: string | undefined,
  ): Promise<FetchTarget> {
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (isProhibitedHost(host) && (officialApiUrl === undefined || url.href !== officialApiUrl)) {
      throw new FetchBlockedError('host_not_allowed', host);
    }
    if (!allowPublic && !hostMatches(host, allowHosts)) {
      throw new FetchBlockedError('host_not_allowed', host);
    }
    const literal = host.startsWith('[') ? host.slice(1, -1) : host;
    if (isIP(literal) !== 0) {
      if (isPrivateAddress(literal)) throw new FetchBlockedError('private_address', literal);
      return { url, address: literal };
    }
    const addresses = await deps.resolve(host);
    if (addresses.length === 0) throw new Error(`no address for ${host}`);
    // Any private answer blocks: the transport would otherwise be free to pick it.
    const bad = addresses.find((a) => isPrivateAddress(a));
    if (bad !== undefined) throw new FetchBlockedError('private_address', `${host} -> ${bad}`);
    return { url, address: addresses[0] as string };
  }

  async function readBody(res: RawResponse, maxBytes: number): Promise<Buffer> {
    const declared = Number(header(res.headers, 'content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new FetchBlockedError('too_large', `${declared} bytes declared`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      // Leaving the loop destroys the stream: nothing more is read.
      if (size > maxBytes) throw new FetchBlockedError('too_large', `over ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function discard(res: RawResponse): Promise<void> {
    // A redirect body is never read; ending the iteration releases the socket.
    const it = res.body[Symbol.asyncIterator]();
    await it.return?.();
  }

  return async function safeFetchWith(
    url: string,
    opts: SafeFetchOptions,
  ): Promise<SafeFetchResponse> {
    if (opts.headers !== undefined && opts.allowPublic === true) {
      throw new Error('safeFetch: caller headers are not allowed with allowPublic');
    }
    if (opts.officialApiUrl !== undefined) {
      const official = parseTarget(opts.officialApiUrl);
      if (
        !OFFICIAL_API_URL_SET.has(opts.officialApiUrl) ||
        official.href !== opts.officialApiUrl ||
        official.search !== '' ||
        official.hash !== '' ||
        opts.allowPublic === true ||
        (opts.post === undefined && opts.headers === undefined)
      ) {
        throw new Error(
          'safeFetch: officialApiUrl must be one of OFFICIAL_API_URLS, exactly, on a request with a body or headers, and never with allowPublic',
        );
      }
    }
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const { signal } = controller;
    try {
      let current = parseTarget(url);
      for (let hop = 0; ; hop++) {
        const checked = await checkHop(
          current,
          opts.allowHosts,
          opts.allowPublic === true,
          opts.officialApiUrl,
        );
        const target: FetchTarget = {
          ...checked,
          ...(opts.post === undefined ? {} : { post: opts.post }),
          ...(opts.headers === undefined ? {} : { headers: opts.headers }),
        };
        await takeToken(target.url.hostname.toLowerCase(), signal);
        const res = await untilAbort(deps.request(target, signal), signal);
        if (res.status >= 300 && res.status < 400 && res.status !== 304) {
          await discard(res);
          if (opts.post !== undefined) {
            throw new FetchBlockedError('redirect_blocked', 'redirect of a request with a body');
          }
          if (opts.headers !== undefined) {
            throw new FetchBlockedError('redirect_blocked', 'redirect of a credentialed request');
          }
          const location = header(res.headers, 'location');
          if (location === undefined || location === '') {
            throw new FetchBlockedError('redirect_blocked', 'redirect without a location');
          }
          if (hop >= MAX_REDIRECTS) {
            throw new FetchBlockedError('redirect_blocked', `more than ${MAX_REDIRECTS}`);
          }
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            throw new FetchBlockedError('redirect_blocked', 'invalid location');
          }
          current = parseTarget(next.toString());
          continue;
        }
        const body = await untilAbort(readBody(res, maxBytes), signal);
        return {
          status: res.status,
          headers: toHeaders(res.headers),
          body,
          url: target.url.toString(),
        };
      }
    } catch (err) {
      if (err instanceof FetchBlockedError) throw err;
      if (signal.aborted) throw new FetchBlockedError('timeout', `${timeoutMs} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The process-wide safeFetch (real DNS, pinned HTTPS, shared per-host buckets). */
const defaultFetch = createSafeFetch(realDeps);

export async function safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeFetchResponse> {
  return defaultFetch(url, opts);
}
