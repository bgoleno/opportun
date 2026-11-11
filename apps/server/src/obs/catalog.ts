// The observability catalog (design.md 14.3, 14.4, 14.8; https://github.com/bgoleno/opportun/issues/353):
// every metric, span name, attribute key and event Opportun may record, each attribute with
// the type its value must have. Nothing outside this file is stored, logged or exported:
// obs/gate.ts checks every record against it (NFR-PRV6), so adding a field anywhere means
// adding it here first, with a type narrow enough that no personal data fits.
//
// Each slice appends its own entries (14.12). The base holds the instance metrics of 14.4 and
// the `error` event. FR-T4 part 2 (https://github.com/bgoleno/opportun/issues/344) adds the Gen
// AI entries, importing the names from @opportun/ai (packages/ai/src/telemetry.ts).
import {
  ATTR,
  FEATURES,
  FINISH_REASONS,
  GEN_AI_METRIC,
  KEY_CHECK_TASK,
  OPERATION_CHAT,
  OPERATION_INVOKE_WORKFLOW,
  OUTPUT_TYPES,
  PROVIDERS,
  TASK_KEYS,
  WIRE_PROVIDERS,
} from '@opportun/ai';
import { ATS_REF_KINDS } from '@opportun/core';
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
  // `localOnly`: a code the endpoint chooses (a provider's response id) stays local (14.5).
  | { kind: 'code'; source: string; localOnly?: boolean }
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
export const DROP_REASONS = ['unknown_key', 'invalid_value', 'series_cap', 'buffer_full'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

const int = { kind: 'int' } as const;
const num = { kind: 'number' } as const;

/**
 * The workflows of 14.5: each is the parent span of the AI calls one user action leads to. A new
 * multi-call flow adds a row there and a name here.
 */
export const WORKFLOWS = [
  'tailoring_chat',
  'discovery_run',
  'rank_backlog',
  'capture',
  'mail_sync',
  'company_tags',
] as const;
export type Workflow = (typeof WORKFLOWS)[number];

/** The model a span names: shape-checked here; export keeps only a priced one (14.8). */
const MODEL_SOURCE =
  "the user's own policy (gen_ai.request.model) or what the endpoint reports " +
  '(gen_ai.response.model). Free text, so the local store keeps the shape-checked value and ' +
  'export sends a model only when PRICING lists it, else _OTHER';

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

  // Gen AI (14.5), FR-T4 part 2. The names are @opportun/ai's.
  [ATTR.operationName]: { kind: 'enum', values: [OPERATION_CHAT, OPERATION_INVOKE_WORKFLOW] },
  [ATTR.providerName]: { kind: 'enum', values: WIRE_PROVIDERS },
  [ATTR.aiProvider]: { kind: 'enum', values: PROVIDERS },
  [ATTR.requestModel]: { kind: 'model', source: MODEL_SOURCE },
  [ATTR.responseModel]: { kind: 'model', source: MODEL_SOURCE },
  [ATTR.requestMaxTokens]: int,
  [ATTR.requestTemperature]: num,
  [ATTR.requestStream]: { kind: 'bool' },
  [ATTR.outputType]: { kind: 'enum', values: OUTPUT_TYPES },
  [ATTR.promptName]: { kind: 'enum', values: TASK_KEYS },
  [ATTR.promptVersion]: {
    kind: 'code',
    source: "the caller's own version of its prompt, a number it keeps; never prompt text",
  },
  [ATTR.usageInputTokens]: int,
  [ATTR.usageOutputTokens]: int,
  [ATTR.usageCacheReadInputTokens]: int,
  [ATTR.usageCacheWriteInputTokens]: int,
  [ATTR.responseId]: {
    kind: 'code',
    source: "the provider's id for the response, as the AI SDK reports it",
    // Chosen by the endpoint, which a user may have configured: local only (14.8).
    localOnly: true,
  },
  [ATTR.responseFinishReasons]: { kind: 'enum_list', values: FINISH_REASONS },
  [ATTR.responseTimeToFirstChunk]: num,
  // The tailoring session's row id. Local only (14.5).
  [ATTR.conversationId]: { kind: 'id' },
  [ATTR.aiTask]: { kind: 'enum', values: [...TASK_KEYS, KEY_CHECK_TASK] },
  [ATTR.aiFeature]: { kind: 'enum', values: FEATURES.map((f) => f.key) },
  // The prompt template's row id. Local only (14.5).
  [ATTR.aiPromptId]: { kind: 'id' },
  [ATTR.aiAttempts]: int,
  [ATTR.usageCost]: num,
  [ATTR.agentName]: { kind: 'enum', values: WORKFLOWS },
  [ATTR.tokenModality]: { kind: 'enum', values: ['text'] },
  [ATTR.costEstimated]: { kind: 'bool' },
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

/** The Gen AI conventions' duration buckets, in seconds. */
const GEN_AI_DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];

/** The attributes every Gen AI metric has (14.4). */
const GEN_AI_METRIC_ATTRS = [
  ATTR.operationName,
  ATTR.providerName,
  ATTR.requestModel,
  ATTR.aiTask,
  ATTR.aiFeature,
  ATTR.aiProvider,
] as const;

/** Every metric (14.4). */
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
  // Gen AI (14.4), recorded by lib/ai.ts from the record it writes to task_runs, so the two agree.
  [GEN_AI_METRIC.inferenceDuration]: {
    instrument: 'histogram',
    unit: 's',
    description: 'Duration of AI model calls, retries included.',
    buckets: GEN_AI_DURATION_BUCKETS,
    attributes: [...GEN_AI_METRIC_ATTRS, ATTR.errorType],
    scope: 'user',
  },
  [GEN_AI_METRIC.inputTokens]: {
    instrument: 'counter',
    unit: '{token}',
    description: 'Input tokens of AI model calls.',
    attributes: [...GEN_AI_METRIC_ATTRS, ATTR.tokenModality],
    scope: 'user',
  },
  [GEN_AI_METRIC.outputTokens]: {
    instrument: 'counter',
    unit: '{token}',
    description: 'Output tokens of AI model calls.',
    attributes: [...GEN_AI_METRIC_ATTRS, ATTR.tokenModality],
    scope: 'user',
  },
  [GEN_AI_METRIC.cost]: {
    instrument: 'counter',
    unit: '{USD}',
    description: 'Estimated cost of AI model calls, at the price in force when each ran.',
    attributes: [...GEN_AI_METRIC_ATTRS, ATTR.costEstimated],
    scope: 'user',
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
  // One per router call, made by packages/ai (InferenceSpan). The span store and the export
  // wrapper rebuild it from this entry; a model not shaped like one leaves the name `chat`.
  'gen_ai.inference': {
    template: 'chat {gen_ai.request.model}',
    kind: 'client',
    attributes: [
      ATTR.operationName,
      ATTR.providerName,
      ATTR.requestModel,
      ATTR.responseModel,
      ATTR.requestMaxTokens,
      ATTR.requestTemperature,
      ATTR.requestStream,
      ATTR.outputType,
      ATTR.promptName,
      ATTR.promptVersion,
      ATTR.usageInputTokens,
      ATTR.usageOutputTokens,
      ATTR.usageCacheReadInputTokens,
      ATTR.usageCacheWriteInputTokens,
      ATTR.responseId,
      ATTR.responseFinishReasons,
      ATTR.responseTimeToFirstChunk,
      ATTR.conversationId,
      ATTR.errorType,
      ATTR.userId,
      ATTR.aiProvider,
      ATTR.aiTask,
      ATTR.aiFeature,
      ATTR.aiPromptId,
      ATTR.aiAttempts,
      ATTR.usageCost,
    ],
  },
  // The parent of the AI calls one user action leads to (14.5): obs/workflow.ts starts it.
  'gen_ai.workflow': {
    template: 'invoke_workflow {gen_ai.agent.name}',
    kind: 'internal',
    attributes: [
      ATTR.operationName,
      ATTR.agentName,
      ATTR.userId,
      ATTR.conversationId,
      ATTR.errorType,
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

/** The keys every log record has besides its event's fields (14.9). */
export const LOG_RECORD_KEYS = ['event', 'user.id', 'trace_id'] as const;

/** Every attribute's type by key, as a Map so a lookup by a caller's key is a plain get. */
export const ATTRIBUTE_TYPES: ReadonlyMap<string, AttrType> = new Map(Object.entries(ATTRIBUTES));

/** Whether a key stays local: the local store and log keep it, and export drops it (14.8). */
export function isLocalOnly(key: AttrKey): boolean {
  const type = ATTRIBUTE_TYPES.get(key);
  if (type === undefined || type.kind === 'ip') return true;
  if (type.kind === 'id') return type.exportable !== true;
  if (type.kind === 'code') return type.localOnly === true;
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
