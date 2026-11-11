// The OpenTelemetry side of export (design.md 14.3, 14.8, 14.10;
// https://github.com/bgoleno/opportun/issues/342). The one module under obs/export/ that loads the
// SDK packages, so the manager imports it dynamically when export is turned on: with export off
// they are never loaded (14.3).
//
// - The resource is exactly service.name, service.version and a random service.instance.id per
//   start (14.8). It is built with resourceFromAttributes, which runs no detector, and passed to
//   every provider and encoder explicitly, so neither the default resource nor OTEL_SERVICE_NAME
//   or OTEL_RESOURCE_ATTRIBUTES can add to it.
// - Metrics: one MeterProvider whose instruments are built from the catalog, histograms with the
//   catalog's own bucket boundaries, read every interval with cumulative temporality (which
//   Prometheus's OTLP receiver requires, and the Agent and an OTLP collector accept). Its reader's
//   exporter only hands the batch to the manager, which encodes it and posts it through the one
//   sender (sender.ts): no stock exporter or HTTP client.
// - Spans and log records are built from the gated records (GatedSpan, GatedLogRecord) as the
//   plain shapes the OTLP serializer reads: no events, no links, no status text.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { SpanKind, SpanStatusCode, type HrTime } from '@opentelemetry/api';
import {
  ProtobufLogsSerializer,
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
} from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import type { Attributes as OtelAttributes, Counter, Histogram } from '@opentelemetry/api';
import type { GatedLogRecord, GatedSpan } from '../index';
import { METRICS, type Attributes, type MetricName } from '../catalog';

/** The server's own version, from its package.json (the server has no other version source). */
const SERVICE_VERSION: string = (
  createRequire(import.meta.url)('../../../package.json') as { version: string }
).version;

/** The scope every record is exported under. */
const SCOPE = { name: 'opportun' };

/** The resource of 14.8, and nothing else. One per start: the manager builds it once. */
export function exportResource(): Resource {
  return resourceFromAttributes({
    'service.name': 'opportun',
    'service.version': SERVICE_VERSION,
    'service.instance.id': randomUUID(),
  });
}

/** A gated record's attributes as the API types them: list values copied, not shared. */
function otel(attributes: Attributes): OtelAttributes {
  const out: OtelAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    // eslint-disable-next-line security/detect-object-injection -- keys from a gated record
    out[key] = Array.isArray(value)
      ? [...(value as readonly string[])]
      : (value as string | number | boolean);
  }
  return out;
}

const hr = (ms: number): HrTime => {
  const whole = Math.floor(ms / 1000);
  return [whole, Math.round((ms - whole * 1000) * 1e6)];
};

// ---------------------------------------------------------------------------- metrics

export interface MetricPipeline {
  record(metric: MetricName, value: number, attributes: Attributes): void;
  /** Reads and hands over what is pending now (a test, or a final flush). */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface MetricPipelineOptions {
  resource: Resource;
  intervalMs: number;
  /** Encodes and sends one batch; resolves whether it was accepted. */
  exportBatch(batch: ResourceMetrics): Promise<boolean>;
}

// ExportResultCode from @opentelemetry/core, which this file does not otherwise need.
const SUCCESS = 0;
const FAILED = 1;

/** A MeterProvider with one instrument per catalogued metric, read every interval. */
export function createMetricPipeline(opts: MetricPipelineOptions): MetricPipeline {
  let closed = false;
  const exporter: PushMetricExporter = {
    export: (batch, done) => {
      if (closed) {
        done({ code: FAILED });
        return;
      }
      void opts
        .exportBatch(batch)
        .then((ok) => done({ code: ok ? SUCCESS : FAILED }))
        .catch(() => done({ code: FAILED }));
    },
    forceFlush: async () => undefined,
    shutdown: async () => {
      closed = true;
    },
    selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
  };
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: opts.intervalMs,
    // Under the interval, which the reader requires; the sender's own timeout is 10 seconds.
    exportTimeoutMillis: Math.min(opts.intervalMs, 15_000),
  });
  const provider = new MeterProvider({ resource: opts.resource, readers: [reader] });
  const meter = provider.getMeter(SCOPE.name);
  const instruments = new Map<string, Histogram | Counter>();
  for (const [name, def] of Object.entries(METRICS)) {
    instruments.set(
      name,
      def.instrument === 'histogram'
        ? meter.createHistogram(name, {
            unit: def.unit,
            description: def.description,
            advice: { explicitBucketBoundaries: [...(def.buckets ?? [])] },
          })
        : meter.createCounter(name, { unit: def.unit, description: def.description }),
    );
  }
  return {
    record(metric, value, attributes) {
      if (closed) return;
      const instrument = instruments.get(metric);
      if (instrument === undefined) return;
      if ('record' in instrument) instrument.record(value, otel(attributes));
      else instrument.add(value, otel(attributes));
    },
    flush: () => reader.forceFlush(),
    shutdown: async () => {
      if (closed) return;
      closed = true;
      await provider.shutdown().catch(() => undefined);
    },
  };
}

export function encodeMetrics(batch: ResourceMetrics): Uint8Array {
  return ProtobufMetricsSerializer.serializeRequest(batch) ?? new Uint8Array();
}

// ---------------------------------------------------------------------------- spans

type ReadableSpanShape = Parameters<typeof ProtobufTraceSerializer.serializeRequest>[0][number];

const KINDS = new Map<string, SpanKind>([
  ['internal', SpanKind.INTERNAL],
  ['server', SpanKind.SERVER],
  ['client', SpanKind.CLIENT],
  ['producer', SpanKind.PRODUCER],
  ['consumer', SpanKind.CONSUMER],
]);

/** The serializer's span shape, from the gated span only: no events, links or status text. */
export function toReadableSpans(
  spans: readonly GatedSpan[],
  resource: Resource,
): ReadableSpanShape[] {
  return spans.map((s) => {
    const ctx = { traceId: s.traceId, spanId: s.spanId, traceFlags: 1 };
    return {
      name: s.name,
      kind: KINDS.get(s.kind) ?? SpanKind.INTERNAL,
      spanContext: () => ctx,
      parentSpanContext:
        s.parentSpanId === null
          ? undefined
          : { traceId: s.traceId, spanId: s.parentSpanId, traceFlags: 1 },
      startTime: hr(s.startMs),
      endTime: hr(s.startMs + s.durationMs),
      duration: hr(s.durationMs),
      status: { code: s.status === 'error' ? SpanStatusCode.ERROR : SpanStatusCode.OK },
      attributes: otel(s.attributes),
      links: [],
      events: [],
      ended: true,
      resource,
      instrumentationScope: SCOPE,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
  });
}

export function encodeSpans(spans: readonly GatedSpan[], resource: Resource): Uint8Array {
  return (
    ProtobufTraceSerializer.serializeRequest(toReadableSpans(spans, resource)) ?? new Uint8Array()
  );
}

// ---------------------------------------------------------------------------- log records

type ReadableLogShape = Parameters<typeof ProtobufLogsSerializer.serializeRequest>[0][number];

// SeverityNumber from @opentelemetry/api-logs: INFO and ERROR.
const SEVERITY_INFO = 9;
const SEVERITY_ERROR = 17;

/** The serializer's log record shape: the event name as body and event name, its fields. */
export function toReadableLogs(
  records: readonly GatedLogRecord[],
  resource: Resource,
): ReadableLogShape[] {
  return records.map((r) => {
    const isError = r.event === 'error';
    return {
      hrTime: hr(r.timeMs),
      hrTimeObserved: hr(r.timeMs),
      // A trace id with no span id: the record links to the trace, not to a span. The protobuf
      // writer leaves an empty span id out (an all-zero one would be an invalid id).
      spanContext:
        r.traceId === null ? undefined : { traceId: r.traceId, spanId: '', traceFlags: 1 },
      severityNumber: isError ? SEVERITY_ERROR : SEVERITY_INFO,
      severityText: isError ? 'ERROR' : 'INFO',
      body: r.event,
      eventName: r.event,
      attributes: otel(r.fields),
      resource,
      instrumentationScope: SCOPE,
      droppedAttributesCount: 0,
    } as ReadableLogShape;
  });
}

export function encodeLogs(records: readonly GatedLogRecord[], resource: Resource): Uint8Array {
  return (
    ProtobufLogsSerializer.serializeRequest(toReadableLogs(records, resource)) ?? new Uint8Array()
  );
}
