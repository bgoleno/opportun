// The OTLP encoding (design.md 14.3, 14.8, 14.10; https://github.com/bgoleno/opportun/issues/342):
// the resource is exactly service.name, service.version and a random service.instance.id, with no
// detector run; instruments are built from the catalog, with its bucket boundaries, cumulative;
// spans and log records are built from the gated records only, with no events, links or status
// text; the protobuf batch carries what it should.
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { JsonLogsSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { AggregationTemporality, DataPointType } from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import { METRICS } from '../src/obs/catalog';
import {
  createMetricPipeline,
  encodeLogs,
  encodeMetrics,
  encodeSpans,
  exportResource,
  toReadableLogs,
  toReadableSpans,
} from '../src/obs/export/otlp';
import type { GatedLogRecord, GatedSpan } from '../src/obs';

const TRACE = '0af7651916cd43dd8448eb211c80319c';

const span: GatedSpan = {
  traceId: TRACE,
  spanId: 'b7ad6b7169203331',
  parentSpanId: '00f067aa0ba902b7',
  name: 'GET',
  kind: 'client',
  startMs: 1_795_600_000_000,
  durationMs: 12.5,
  status: 'error',
  attributes: { 'http.request.method': 'GET', 'error.type': 'TypeError' },
};

const log: GatedLogRecord = {
  event: 'error',
  timeMs: 1_795_600_000_123,
  traceId: TRACE,
  fields: { 'error.type': 'TypeError', 'http.route': '/api/v1/x' },
};

const text = (b: Uint8Array) => Buffer.from(b).toString('latin1');

describe('the resource (14.8)', () => {
  it('is exactly service.name, service.version and service.instance.id', () => {
    const r = exportResource();
    expect(Object.keys(r.attributes).sort()).toEqual([
      'service.instance.id',
      'service.name',
      'service.version',
    ]);
    expect(r.attributes['service.name']).toBe('opportun');
    expect(r.attributes['service.version']).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.attributes['service.instance.id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a new instance id per start: two resources differ', () => {
    // One per process in practice (the manager builds it once); each call is a fresh id.
    expect(exportResource().attributes['service.instance.id']).not.toBe(
      exportResource().attributes['service.instance.id'],
    );
  });
});

describe('the metric pipeline (14.3: instruments from the catalog)', () => {
  it('records each catalogued metric with its own buckets, cumulative, with the resource', async () => {
    const batches: Parameters<typeof encodeMetrics>[0][] = [];
    const resource = exportResource();
    const p = createMetricPipeline({
      resource,
      intervalMs: 60_000,
      exportBatch: async (rm) => {
        batches.push(rm);
        return true;
      },
    });
    p.record('http.server.request.duration', 0.03, { 'http.route': '/x' });
    p.record('http.server.request.duration', 0.2, { 'http.route': '/x' });
    p.record('opportun.obs.dropped', 1, {
      'opportun.obs.signal': 'spans',
      'opportun.obs.reason': 'unknown_key',
    });
    await p.flush();
    await p.shutdown();
    const rm = batches.find((b) => b.scopeMetrics.length > 0);
    expect(rm?.resource.attributes).toEqual(resource.attributes);
    const metrics = rm?.scopeMetrics.flatMap((s) => s.metrics) ?? [];
    const http = metrics.find((m) => m.descriptor.name === 'http.server.request.duration');
    expect(http?.aggregationTemporality).toBe(AggregationTemporality.CUMULATIVE);
    expect(http?.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(http?.descriptor.unit).toBe('s');
    const point = http?.dataPoints[0] as {
      value: { count: number; buckets: { boundaries: number[] } };
    };
    expect(point.value.count).toBe(2);
    expect(point.value.buckets.boundaries).toEqual([
      ...METRICS['http.server.request.duration'].buckets,
    ]);
    const dropped = metrics.find((m) => m.descriptor.name === 'opportun.obs.dropped');
    expect(dropped?.dataPointType).toBe(DataPointType.SUM);
    // The protobuf batch names the metrics and the resource, and nothing else of the process.
    const bytes = text(encodeMetrics(rm!));
    expect(bytes).toContain('http.server.request.duration');
    expect(bytes).toContain('service.instance.id');
    expect(bytes).not.toContain('host.name');
    expect(bytes).not.toContain('process.');
    expect(bytes).not.toContain('telemetry.sdk');
  });

  it('nothing is exported after shutdown', async () => {
    let count = 0;
    const p = createMetricPipeline({
      resource: exportResource(),
      intervalMs: 60_000,
      exportBatch: async () => {
        count += 1;
        return true;
      },
    });
    await p.shutdown();
    p.record('http.server.request.duration', 0.03, { 'http.route': '/x' });
    await p.flush();
    expect(count).toBeLessThanOrEqual(1);
  });
});

describe('spans and log records, from the gated records only', () => {
  it('a span keeps its ids, name, kind, times, status code and attributes; nothing else', () => {
    const resource = exportResource();
    const [s] = toReadableSpans([span], resource);
    expect(s?.spanContext().traceId).toBe(TRACE);
    expect(s?.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
    expect(s?.kind).toBe(SpanKind.CLIENT);
    expect(s?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(s?.events).toEqual([]);
    expect(s?.links).toEqual([]);
    const json = JSON.parse(
      Buffer.from(JsonTraceSerializer.serializeRequest([s!])!).toString(),
    ) as {
      resourceSpans: {
        scopeSpans: { spans: { name: string; attributes: { key: string }[] }[] }[];
      }[];
    };
    const out = json.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(out?.name).toBe('GET');
    expect(out?.attributes.map((a) => a.key).sort()).toEqual(['error.type', 'http.request.method']);
    expect(text(encodeSpans([span], resource))).toContain('http.request.method');
  });

  it('a log record is the event name with its fields and trace id, at error severity for an error', () => {
    const resource = exportResource();
    const [r] = toReadableLogs([log], resource);
    expect(r?.body).toBe('error');
    expect(r?.eventName).toBe('error');
    expect(r?.spanContext?.traceId).toBe(TRACE);
    expect(r?.severityText).toBe('ERROR');
    const json = JSON.parse(Buffer.from(JsonLogsSerializer.serializeRequest([r!])!).toString()) as {
      resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string }[] }[] }[] }[];
    };
    expect(
      json.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes.map((a) => a.key).sort(),
    ).toEqual(['error.type', 'http.route']);
    expect(text(encodeLogs([log], resource))).toContain('http.route');
  });

  it('a log record without a trace has no span context', () => {
    const [r] = toReadableLogs([{ ...log, traceId: null }], exportResource());
    expect(r?.spanContext).toBeUndefined();
  });
});
