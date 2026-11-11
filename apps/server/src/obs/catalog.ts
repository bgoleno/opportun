// The observability catalog (design.md 14.3, 14.4, 14.8; https://github.com/bgoleno/opportun/issues/353):
// every metric, span name, attribute key and event Opportun may record, each attribute with
// the type its value must have. Nothing outside this file is stored, logged or exported:
// obs/gate.ts checks every record against it (NFR-PRV6), so adding a field anywhere means
// adding it here first, with a type narrow enough that no personal data fits.
//
// Each slice appends its own entries (14.12). The base holds the instance metrics of 14.4 and
// the `error` event. It has no Gen AI entries: FR-T4 part 2 adds them, importing the names
// from @opportun/ai.
import { ATS_REF_KINDS, DISCOVERY_SOURCE_KINDS } from '@opportun/core';
import { getTableName } from 'drizzle-orm';
import * as schema from '../db/schema';
import { registeredJobKinds } from '../jobs/registry';
import { ATS_ALLOW_HOSTS } from '../lib/safeFetch';

/** A closed list of values, or a function returning one (read when a value is checked). */
type Values = readonly string[] | (() => readonly string[]);

/**
 * The value types of 14.8. Every attribute has exactly one.
 *
 * - An `id` key is local only (kept in the local store and log, dropped by export) unless it
 *   is marked `exportable`: trace and span ids are, a user's row ids never are (14.8).
 * - A `code` or `model` key names its `source`: a name can have the shape of either, so what
 *   makes the value safe is where the code that sets it takes it from, and it may take it from
 *   nowhere else (14.8).
 * - An `ip` key is local only and can never be exported. `client.address` is the only one: the
 *   request's address in the local access log (sec's O7 on PR #352).
 */
export type AttrType =
  | { kind: 'enum'; values: Values }
  | { kind: 'enum_list'; values: Values }
  | { kind: 'int' }
  | { kind: 'number' }
  | { kind: 'bool' }
  | { kind: 'id'; exportable?: boolean }
  | { kind: 'code'; source: string }
  | { kind: 'model'; source: string }
  | { kind: 'route' }
  | { kind: 'ip' };

/** The value every enum and the `model` type accept for "something not on the list" (14.4). */
export const OTHER = '_OTHER';

/** HTTP methods as the HTTP conventions list them; anything else is OTHER. */
export const HTTP_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'CONNECT',
  'TRACE',
  OTHER,
] as const;

/**
 * Named outbound targets (14.4). One per ATS, from @opportun/core, so a new ATS kind is a
 * target without a change here. `public_site` is a page the user captured or a company site.
 */
export const OUTBOUND_TARGETS = [
  'anthropic',
  'openai',
  'ai_compatible',
  'mcp',
  'google',
  'oauth',
  ...ATS_REF_KINDS,
  'reactive_resume',
  'public_site',
] as const;
export type OutboundTarget = (typeof OUTBOUND_TARGETS)[number];

/**
 * The only values `server.address` takes, a literal list (14.8): the public ATS APIs
 * (ATS_ALLOW_HOSTS), the AI providers' fixed API hosts, and Google's. Any other host gets its
 * `opportun.outbound.target` only: a host the user configured, a page they captured, and a
 * tenant's own host such as a Workday board, whose name is the company's.
 */
export const FIXED_SERVICE_HOSTS: readonly string[] = [
  ...ATS_ALLOW_HOSTS,
  'api.anthropic.com',
  'api.openai.com',
  'accounts.google.com',
  'oauth2.googleapis.com',
  'openidconnect.googleapis.com',
  // Drive (lib/google.ts, @googleapis/drive)
  'www.googleapis.com',
  'gmail.googleapis.com',
  // Docs (lib/google.ts, @googleapis/docs)
  'docs.googleapis.com',
];

/** A statement's first keyword (db.operation.name, 14.4). */
export const DB_OPERATIONS = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'WITH',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'PRAGMA',
  'CREATE',
  'ALTER',
  'DROP',
  OTHER,
] as const;

/** The schema's tables (db.collection.name), plus SQLite's full-text index and OTHER. */
function tableNames(): readonly string[] {
  const exported = new Set<string>(schema.TABLE_EXPORTS);
  const tables = Object.entries(schema)
    .filter(([name]) => exported.has(name))
    .map(([, table]) => getTableName(table as Parameters<typeof getTableName>[0]));
  return [...tables, 'search_index', OTHER];
}

export const SIGNALS = ['metrics', 'spans', 'logs'] as const;
export type Signal = (typeof SIGNALS)[number];

/** Why the gate or a buffer dropped something (opportun.obs.dropped). */
export const DROP_REASONS = [
  'unknown_key',
  'invalid_value',
  'series_cap',
  'buffer_full',
  // A log record whose message the catalog does not list: written with a fixed marker (14.8).
  'message_withheld',
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

const int = { kind: 'int' } as const;

/** Every attribute key, with its type (14.8). */
export const ATTRIBUTES = {
  'http.request.method': { kind: 'enum', values: HTTP_METHODS },
  'http.route': { kind: 'route' },
  'http.response.status_code': int,
  'error.type': {
    kind: 'code',
    source:
      "an error's class name or code (outbound.ts errorType), or a fixed code such as an HTTP " +
      "status; never an error's message, never a provider's error body",
  },
  'opportun.outbound.target': { kind: 'enum', values: OUTBOUND_TARGETS },
  'server.address': { kind: 'enum', values: FIXED_SERVICE_HOSTS },
  'db.system.name': { kind: 'enum', values: ['sqlite', 'postgresql'] },
  'db.operation.name': { kind: 'enum', values: DB_OPERATIONS },
  'db.collection.name': { kind: 'enum', values: tableNames },
  'opportun.job.kind': { kind: 'enum', values: () => [...registeredJobKinds(), OTHER] },
  'opportun.job.outcome': { kind: 'enum', values: ['done', 'retry', 'dead'] },
  'opportun.obs.signal': { kind: 'enum', values: SIGNALS },
  'opportun.obs.reason': { kind: 'enum', values: DROP_REASONS },
  // The caller's row id. Local only: export drops it (14.8), and metrics never carry it.
  'user.id': { kind: 'id' },
  // The request's address, for the local access log only (FR-T5 writes it). Never exported.
  'client.address': { kind: 'ip' },

  // The keys of Opportun's own log calls (FR-T5, 14.9): ids, closed lists, codes and counts only.
  // A record names a company, a source or a posting by its row id, never by its name (14.8).
  'opportun.process.signal': { kind: 'enum', values: ['SIGINT', 'SIGTERM'] },
  'opportun.mocks.count': int,
  'server.port': int,
  'opportun.db.gate_label': {
    kind: 'code',
    source:
      "a transaction's TransactionOptions.label, a fixed name in code (db/gate.ts); a stack " +
      'frame used in its place does not fit the type and is dropped',
  },
  'opportun.db.gate_held_ms': int,
  'opportun.db.filesystem': {
    kind: 'code',
    source:
      "the database directory's filesystem type, from the OS mount table (sqliteFilesystem.ts)",
  },
  'opportun.count.described': int,
  'opportun.count.deferred': int,
  'opportun.count.skipped': int,
  'opportun.count.truncated': int,
  'opportun.communication.id': { kind: 'id' },
  'opportun.company.id': { kind: 'id' },
  'opportun.source.id': { kind: 'id' },
  'opportun.opportunity.id': { kind: 'id' },
  'opportun.discovery_result.id': { kind: 'id' },
  'opportun.dedupe_candidate.id': { kind: 'id' },
  'opportun.resume.id': { kind: 'id' },
  'opportun.discovery.source_kind': { kind: 'enum', values: DISCOVERY_SOURCE_KINDS },
  'opportun.ats.kind': { kind: 'enum', values: ATS_REF_KINDS },
  'opportun.fetch.blocked_reason': {
    kind: 'code',
    source: "FetchBlockedError.reason (lib/safeFetch.ts), a fixed code; never the error's detail",
  },
  // OAUTH_PROVIDERS (lib/oauthProviders.ts) and EXTENSION_TARGETS (routes/artifacts.ts), listed
  // here rather than imported to keep the catalog free of route code; a test keeps them in step.
  'opportun.oauth.provider': { kind: 'enum', values: ['google', 'github', 'linkedin'] },
  'opportun.artifact.target': { kind: 'enum', values: ['chrome', 'firefox'] },
} as const satisfies Record<string, AttrType>;

export type AttrKey = keyof typeof ATTRIBUTES;
export type AttrValue = string | number | boolean | readonly string[];
export type Attributes = Partial<Record<AttrKey, AttrValue>>;

export type Instrument = 'histogram' | 'counter';
/** Whose a metric point is (14.7): the instance's, or the user's it was recorded for. */
export type MetricScope = 'instance' | 'user';

export interface MetricDef {
  instrument: Instrument;
  unit: string;
  description: string;
  /** Histogram bucket upper bounds, ascending; the same for the store and for export (14.4). */
  buckets?: readonly number[];
  attributes: readonly AttrKey[];
  scope: MetricScope;
}

/** The HTTP conventions' duration buckets, in seconds. */
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
/** The database conventions' duration buckets, in seconds. */
const DB_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10];
/** Jobs: 10 ms to 15 minutes (14.4). */
const JOB_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600, 900];

/** Every metric (14.4), less the Gen AI ones FR-T4 part 2 adds. */
export const METRICS = {
  'http.server.request.duration': {
    instrument: 'histogram',
    unit: 's',
    description: 'Duration of HTTP server requests.',
    buckets: HTTP_BUCKETS,
    attributes: ['http.request.method', 'http.route', 'http.response.status_code', 'error.type'],
    scope: 'instance',
  },
  'http.client.request.duration': {
    instrument: 'histogram',
    unit: 's',
    description: 'Duration of outbound HTTP requests.',
    buckets: HTTP_BUCKETS,
    attributes: [
      'http.request.method',
      'opportun.outbound.target',
      'server.address',
      'http.response.status_code',
      'error.type',
    ],
    scope: 'instance',
  },
  'db.client.operation.duration': {
    instrument: 'histogram',
    unit: 's',
    description: 'Duration of database statements.',
    buckets: DB_BUCKETS,
    attributes: ['db.system.name', 'db.operation.name', 'db.collection.name', 'error.type'],
    scope: 'instance',
  },
  'opportun.job.duration': {
    instrument: 'histogram',
    unit: 's',
    description: 'Duration of background jobs, from claim to finish.',
    buckets: JOB_BUCKETS,
    attributes: ['opportun.job.kind', 'opportun.job.outcome', 'error.type'],
    scope: 'instance',
  },
  'opportun.obs.dropped': {
    instrument: 'counter',
    unit: '{item}',
    description: 'Telemetry items dropped by the gate or a full buffer.',
    attributes: ['opportun.obs.signal', 'opportun.obs.reason'],
    scope: 'instance',
  },
} as const satisfies Record<string, MetricDef>;

export type MetricName = keyof typeof METRICS;

/** A span the base's own code starts: the name is filled from checked values only (14.8). */
export interface SpanDef {
  /** `{key}` is replaced by that attribute's checked value. */
  template: string;
  kind: 'server' | 'client' | 'internal' | 'consumer' | 'producer';
  attributes: readonly AttrKey[];
}

export const SPANS = {
  'http.client': {
    template: '{http.request.method}',
    kind: 'client',
    attributes: [
      'http.request.method',
      'opportun.outbound.target',
      'server.address',
      'http.response.status_code',
      'error.type',
    ],
  },
} as const satisfies Record<string, SpanDef>;

export type SpanName = keyof typeof SPANS;

export interface EventDef {
  description: string;
  fields: readonly AttrKey[];
}

/** Every event obs.event() writes (14.9). FR-T5 completes the list. */
export const EVENTS = {
  error: {
    description: 'A thrown error in a route, a 5xx response or a failed job.',
    fields: ['error.type', 'http.route', 'opportun.job.kind'],
  },
} as const satisfies Record<string, EventDef>;

export type EventName = keyof typeof EVENTS;

/**
 * Every message Opportun's own log calls write, with the keys each may carry (14.8, 14.9). The log
 * destination (obs/log.ts) keeps a message only when it is listed here or is an event's name, and
 * then only these keys; a library's message is replaced by a fixed marker. A log call's message is
 * a fixed string (a lint rule forbids interpolation), so it can be listed. An error passed as `err`
 * is not a key: the destination reduces it to `error.type` and its frame lines.
 */
const LOG_MESSAGE_ENTRIES: Record<string, readonly AttrKey[]> = {
  // Process and boot (index.ts, app.ts)
  'server failed to start': [],
  'shutting down': ['opportun.process.signal'],
  'error during shutdown': [],
  'TEST MOCKS ENABLED: external provider calls are fake': ['opportun.mocks.count'],
  'no web build found; serving the API only': [],
  'listening on localhost only: this instance cannot be reached from another device until OPPORTUN_HOST names a reachable address (docs/install.md, "Reaching it from another device")':
    ['server.port'],
  // Database
  'postgres idle connection error': [],
  'database collation does not match SQLite ordering: create the database with LOCALE_PROVIDER libc and C collation (docs/install.md)':
    [],
  'database directory is on a filesystem whose locking SQLite cannot depend on (docs/install.md)': [
    'opportun.db.filesystem',
  ],
  'database write gate held too long': ['opportun.db.gate_label', 'opportun.db.gate_held_ms'],
  // Jobs, health, requests
  'job runner': [],
  'healthz database check failed': [],
  'healthz queue lag check failed': [],
  'healthz integrity read failed': [],
  'unhandled error': [],
  'session lookup failed': [],
  'rate limit onLimited hook failed': [],
  'no route for this asset; if the web build was rebuilt while the server was running, restart the server':
    [],
  'refusing to build an oversized artifact': ['opportun.artifact.target'],
  // Sources, discovery and postings
  'workday detail failed': [],
  'workday detail cap reached; the rest are described on later runs': [
    'opportun.count.described',
    'opportun.count.deferred',
  ],
  'MCP items skipped': ['opportun.count.skipped', 'opportun.count.truncated'],
  'workday posting detail failed': [],
  'message body unreadable': ['opportun.communication.id'],
  'posting search board lookup failed': [],
  'ats detection failed': ['opportun.company.id'],
  'discovery run failed': ['opportun.source.id', 'opportun.discovery.source_kind'],
  'ats probe failed': ['opportun.ats.kind'],
  'careers page fetch blocked': ['opportun.company.id', 'opportun.fetch.blocked_reason'],
  'lead resolution lookup failed': ['opportun.source.id'],
  'workday capture retry failed': ['opportun.discovery_result.id'],
  'posting reconciliation failed': ['opportun.opportunity.id'],
  // AI
  'opportunity dedupe AI unavailable': ['opportun.dedupe_candidate.id', 'error.type'],
  'opportunity dedupe AI returned an unrecognized ref': ['opportun.dedupe_candidate.id'],
  'failed to record a streamed AI call': [],
  'could not read the base resume': ['opportun.resume.id'],
  // Accounts and integrations
  'failed to persist a refreshed Google token': ['user.id'],
  'google token exchange failed': [],
  'google token revocation failed': [],
  'oauth sign-in exchange failed': ['opportun.oauth.provider'],
};

export const LOG_MESSAGES: ReadonlyMap<string, readonly AttrKey[]> = new Map(
  Object.entries(LOG_MESSAGE_ENTRIES),
);

/** The keys every log record has besides its event's fields (14.9). */
export const LOG_RECORD_KEYS = ['event', 'user.id', 'trace_id'] as const;

/** Every attribute's type by key, as a Map so a lookup by a caller's key is a plain get. */
export const ATTRIBUTE_TYPES: ReadonlyMap<string, AttrType> = new Map(Object.entries(ATTRIBUTES));

/** Whether a key stays local: the local store and log keep it, and export drops it (14.8). */
export function isLocalOnly(key: AttrKey): boolean {
  const type = ATTRIBUTE_TYPES.get(key);
  if (type === undefined || type.kind === 'ip') return true;
  if (type.kind === 'id') return type.exportable !== true;
  return false;
}

/** The attributes without their local-only keys: what an exporter may receive (14.8). */
export function withoutLocalOnly(attributes: Attributes): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => !isLocalOnly(key as AttrKey)),
  ) as Attributes;
}

// Lookups by a caller's name, as Maps (a get, not an index into an object).
const METRIC_DEFS: ReadonlyMap<string, MetricDef> = new Map(Object.entries(METRICS));
const SPAN_DEFS: ReadonlyMap<string, SpanDef> = new Map(Object.entries(SPANS));
const EVENT_DEFS: ReadonlyMap<string, EventDef> = new Map(Object.entries(EVENTS));

function defOf<T>(defs: ReadonlyMap<string, T>, what: string, name: string): T {
  const def = defs.get(name);
  // Unreachable for a typed caller: names are the catalog's own literal keys.
  if (def === undefined) throw new Error(`obs: no catalogued ${what} named ${name}`);
  return def;
}

export const metricDef = (name: MetricName): MetricDef => defOf(METRIC_DEFS, 'metric', name);
export const spanDef = (name: SpanName): SpanDef => defOf(SPAN_DEFS, 'span', name);
export const eventDef = (name: EventName): EventDef => defOf(EVENT_DEFS, 'event', name);
