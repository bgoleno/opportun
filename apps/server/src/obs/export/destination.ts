// Where export may send (design.md 14.10, "Where it may send", NFR-PRV7;
// https://github.com/bgoleno/opportun/issues/342 criterion 5).
//
// The destination is fields, never a URL: the server builds the URL from them (endpointsFor), so
// a URL can never carry a credential, a path the admin did not choose, or a second host. Before a
// connection, checkDestination resolves the host and classifies every address it answers with;
// the sender then connects to the one checked address only (sender.ts), so a second lookup cannot
// rebind the name.
//
// The classes (rule 3):
// - private: loopback, the private ranges and shared address space (100.64.0.0/10, where tailnets
//   live). Allowed only when the operator sets OPPORTUN_TELEMETRY_ALLOW_PRIVATE=1, over http or
//   https: an Agent or a Prometheus beside the app.
// - refused, flag or not: link-local, the unspecified and reserved ranges, multicast, and the
//   metadata services that sit inside the allowed ranges, by exact address. Anything else that
//   lib/safeFetch.ts's isPrivateAddress calls non-public is refused too, so a reserved range this
//   file does not name fails closed instead of passing as public.
// - public: the rest. https only: a public host over plain http is refused always.
// An IPv4-mapped IPv6 address is unwrapped first, as mappedIpv4 in safeFetch.ts does, so it gets
// its IPv4 address's answer.
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { isPrivateAddress, isProhibitedHost } from '../../lib/safeFetch';

export const EXPORT_TYPES = ['otlp', 'datadog', 'prometheus', 'influxdb'] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

/** Which signals each type sends (14.10's table). */
export const TYPE_SIGNALS: Readonly<Record<ExportType, readonly ExportSignal[]>> = {
  otlp: ['metrics', 'spans', 'logs'],
  datadog: ['metrics', 'spans', 'logs'],
  prometheus: ['metrics'],
  influxdb: ['metrics'],
};
export type ExportSignal = 'metrics' | 'spans' | 'logs';

// ---------------------------------------------------------------------------- the fields

/** A host name of LDH labels, an IPv4 literal, or a bracketed IPv6 literal. Nothing else. */
const LABEL = /^[A-Za-z0-9-]{1,63}$/;
function isHostField(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return isIP(host.slice(1, -1)) === 6;
  if (host.length === 0 || host.length > 253) return false;
  return host
    .split('.')
    .every((label) => LABEL.test(label) && !label.startsWith('-') && !label.endsWith('-'));
}

/** Absolute segments of unreserved characters; no empty, `.` or `..` segment, no escapes. */
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
function isBasePath(path: string): boolean {
  if (path === '/') return true;
  if (!path.startsWith('/')) return false;
  return path
    .slice(1)
    .split('/')
    .every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
}

/** An InfluxDB organisation or bucket name: printable, no control characters, URL-encoded. */
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const INFLUX_NAME = /^[^\u0000-\u001f\u007f]{1,128}$/;

/** RFC 9110 token characters, which every header name must be. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
/** Headers the sender sets itself, or that would change how the request is framed. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'content-type',
]);

/** The OTLP header's name (14.10 rule 5): token characters, and not one the sender owns. */
export function isAllowedHeaderName(name: string): boolean {
  return TOKEN.test(name) && !RESERVED_HEADERS.has(name.toLowerCase());
}

const DestinationSchema = z
  .object({
    type: z.enum(EXPORT_TYPES),
    scheme: z.enum(['http', 'https']),
    host: z.string().refine(isHostField, 'host'),
    port: z.number().int().min(1).max(65_535),
    basePath: z.string().max(256).refine(isBasePath, 'basePath').optional(),
    org: z.string().regex(INFLUX_NAME).optional(),
    bucket: z.string().regex(INFLUX_NAME).optional(),
    headerName: z.string().refine(isAllowedHeaderName, 'headerName').optional(),
  })
  .strict()
  .refine((d) => d.type !== 'influxdb' || (d.org !== undefined && d.bucket !== undefined), {
    message: 'org and bucket',
  });

export type Destination = z.infer<typeof DestinationSchema>;

/** The destination's fields, checked for shape; the address check is checkDestination's. */
export function parseDestination(
  input: unknown,
): { ok: true; value: Destination } | { ok: false; field: string } {
  const r = DestinationSchema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, field: String(r.error.issues[0]?.path[0] ?? r.error.issues[0]?.message) };
}

/** The URL of each signal the type sends, built from the fields (14.10's table). */
export function endpointsFor(d: Destination): Partial<Record<ExportSignal, string>> {
  const origin = `${d.scheme}://${d.host}:${d.port}`;
  if (d.type === 'prometheus') return { metrics: `${origin}/api/v1/otlp/v1/metrics` };
  if (d.type === 'influxdb') {
    const q = new URLSearchParams({ org: d.org ?? '', bucket: d.bucket ?? '', precision: 'ms' });
    return { metrics: `${origin}/api/v2/write?${q.toString()}` };
  }
  // The Datadog Agent's OTLP receiver has no base path; an OTLP endpoint may.
  const base =
    d.type === 'otlp' && d.basePath !== undefined && d.basePath !== '/' ? d.basePath : '';
  return {
    metrics: `${origin}${base}/v1/metrics`,
    spans: `${origin}${base}/v1/traces`,
    logs: `${origin}${base}/v1/logs`,
  };
}

// ---------------------------------------------------------------------------- the addresses

const allowedPrivate = new BlockList();
allowedPrivate.addSubnet('127.0.0.0', 8, 'ipv4');
allowedPrivate.addSubnet('10.0.0.0', 8, 'ipv4');
allowedPrivate.addSubnet('172.16.0.0', 12, 'ipv4');
allowedPrivate.addSubnet('192.168.0.0', 16, 'ipv4');
allowedPrivate.addSubnet('100.64.0.0', 10, 'ipv4');
allowedPrivate.addAddress('::1', 'ipv6');
allowedPrivate.addSubnet('fc00::', 7, 'ipv6');

/** The metadata services inside the allowed ranges (AWS's IPv6, Alibaba's), by exact address. */
const METADATA = new Set(['100.100.100.200', 'fd00:ec2::254']);

/**
 * The IPv4 address inside an IPv4-mapped IPv6 address, in either spelling (::ffff:a.b.c.d or
 * ::ffff:hhhh:hhhh); undefined for anything else. The same unwrap as mappedIpv4 in safeFetch.ts,
 * which does not export it.
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

/** The canonical text of an IPv6 address, for the exact metadata match. */
function canonical(ip: string, family: 4 | 6): string {
  if (family === 4) return ip;
  return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
}

export type AddressClass = 'public' | 'private' | 'refused';

/** The class of one resolved address (rule 3). Anything that is not an address is refused. */
export function classifyAddress(raw: string): AddressClass {
  const v4 = isIP(raw) === 6 ? mappedIpv4(raw) : undefined;
  const ip = v4 ?? raw;
  const family = isIP(ip);
  if (family !== 4 && family !== 6) return 'refused';
  if (METADATA.has(canonical(ip, family))) return 'refused';
  if (allowedPrivate.check(ip, family === 4 ? 'ipv4' : 'ipv6')) return 'private';
  // Every other non-public range (link-local, unspecified, multicast, reserved, documentation,
  // the IPv6 transition prefixes) is refused: safeFetch's list is the backstop.
  return isPrivateAddress(ip) ? 'refused' : 'public';
}

export type DestinationRefusal =
  | 'prohibited_host'
  | 'unresolvable'
  | 'refused_address'
  | 'plain_http_public'
  | 'private_not_allowed';

export type DestinationCheck =
  { ok: true; address: string; family: 4 | 6 } | { ok: false; reason: DestinationRefusal };

export interface CheckOptions {
  /** OPPORTUN_TELEMETRY_ALLOW_PRIVATE=1 (config.ts telemetryAllowPrivate). */
  allowPrivate: boolean;
  /** Every address the name resolves to. Tests replace it. */
  lookup?: (host: string) => Promise<string[]>;
}

async function resolveAll(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

/**
 * Checks a destination's host against rules 2 and 3 and returns the address to pin the
 * connection to. Every address the name answers with must pass, so a name that resolves to one
 * public and one private address is judged by the private one.
 */
export async function checkDestination(
  d: Pick<Destination, 'scheme' | 'host'>,
  opts: CheckOptions,
): Promise<DestinationCheck> {
  const bare = d.host.startsWith('[') ? d.host.slice(1, -1) : d.host;
  let addresses: string[];
  if (isIP(bare) !== 0) {
    addresses = [bare];
  } else {
    if (isProhibitedHost(bare)) return { ok: false, reason: 'prohibited_host' };
    try {
      addresses = await (opts.lookup ?? resolveAll)(bare);
    } catch {
      return { ok: false, reason: 'unresolvable' };
    }
  }
  const first = addresses[0];
  if (first === undefined) return { ok: false, reason: 'unresolvable' };
  const classes = addresses.map(classifyAddress);
  if (classes.includes('refused')) return { ok: false, reason: 'refused_address' };
  if (d.scheme === 'http' && classes.includes('public')) {
    return { ok: false, reason: 'plain_http_public' };
  }
  if (classes.includes('private') && !opts.allowPrivate) {
    return { ok: false, reason: 'private_not_allowed' };
  }
  return { ok: true, address: first, family: isIP(first) === 6 ? 6 : 4 };
}
