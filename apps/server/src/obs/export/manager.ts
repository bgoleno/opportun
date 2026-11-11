// The export manager (design.md 14.3, 14.10; https://github.com/bgoleno/opportun/issues/342).
//
// One destination at a time. While Collect and Export are both on (and never on the demo), it
// builds one exporter per signal the destination's type sends and attaches each to its slot in
// obs/index.ts. Saving the settings rebuilds them; turning export off detaches them, drops what is
// queued and keeps no connection (the sender opens one per request). No restart either way.
//
// Every record passes the one allowlist (allowlist.ts) at its sink, whatever the producer did.
// Every batch is checked against the destination rule again (checkDestination: the name may
// resolve differently now) and posted by the one pinned sender (sender.ts). Metrics leave every
// 60 seconds; spans and log records in batches every 5 seconds (14.10).
//
// The SDK packages load here only, by dynamic import of otlp.ts (and influx.ts for InfluxDB),
// the first time export is built: with export off they are never loaded (14.3).
import type { Db } from '../../db/client';
import { eventDef, metricDef, SIGNALS, type DropReason, type Signal } from '../catalog';
import {
  attachExporter,
  detachExporter,
  FLUSH_INTERVAL_MS,
  isCollecting,
  obs,
  runSuppressed,
  type GatedLogRecord,
  type GatedSpan,
  type LogExportSink,
  type MetricExportSink,
  type SpanExportSink,
} from '../index';
import { exportAttributes, exportSpanName } from './allowlist';
import {
  checkDestination,
  endpointsFor,
  type Destination,
  type DestinationRefusal,
} from './destination';
import type { Resource } from '@opentelemetry/resources';
import type { MetricPipeline } from './otlp';
import { send, type SendOutcome } from './sender';
import { credentialHeaders, credentialOf, readExport } from './settings';

/** Spans and log records leave in batches this often (14.10). */
export const BATCH_INTERVAL_MS = 5_000;
/**
 * At most this many spans, or log records, wait for the next batch; more are dropped and counted
 * (design 14.11's table: a queue of at most 2,048 of each).
 */
export const EXPORT_BUFFER_MAX = 2_048;

const PROTOBUF = 'application/x-protobuf';
const LINE_PROTOCOL = 'text/plain; charset=utf-8';

export interface ExportOptions {
  /** OPPORTUN_TELEMETRY_ALLOW_PRIVATE=1 (config.ts). */
  allowPrivate: boolean;
  metricIntervalMs?: number;
  batchIntervalMs?: number;
  /** Every address a name resolves to; tests replace it. */
  lookup?: (host: string) => Promise<string[]>;
}

export interface Exporters {
  sinks: { metrics?: MetricExportSink; spans?: SpanExportSink; logs?: LogExportSink };
  /** Sends what is pending now (a test, or a final flush). */
  flush(): Promise<void>;
  /** Drops what is queued and stops. Idempotent. */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------- status

/** What an admin sees (14.10): the last success, and the last failure as a class only. */
export interface ExportStatus {
  lastSuccessAt: number | null;
  lastFailure: {
    outcome: Exclude<SendOutcome, 'ok' | 'aborted'>;
    at: number;
    /**
     * Why a send was blocked, as the destination check's closed reason: never the host or the
     * address. A destination saved while OPPORTUN_TELEMETRY_ALLOW_PRIVATE=1 was set is blocked
     * once the server runs without it, and the admin's card says so (#382).
     */
    reason?: DestinationRefusal;
  } | null;
}

const status: ExportStatus = { lastSuccessAt: null, lastFailure: null };

export function exportStatus(): ExportStatus {
  return { lastSuccessAt: status.lastSuccessAt, lastFailure: status.lastFailure };
}

function note(outcome: SendOutcome, reason?: DestinationRefusal): void {
  if (outcome === 'aborted') return; // export stopped: not the destination's failure
  if (outcome === 'ok') status.lastSuccessAt = Date.now();
  else
    status.lastFailure = { outcome, at: Date.now(), ...(reason === undefined ? {} : { reason }) };
}

/** A record the export side removed or could not hold, counted in opportun.obs.dropped. */
function countDrop(signal: Signal, reason: DropReason): void {
  obs.record('opportun.obs.dropped', 1, {
    'opportun.obs.signal': signal,
    'opportun.obs.reason': reason,
  });
}

/**
 * Checks the destination for this batch and posts it to the address checked. `stop` is the
 * running exporter set's: once export is turned off or changed, a batch still in its address
 * check never connects, and one already sending is destroyed, so nothing more reaches the old
 * destination with its credential (design 14.10; sec's Blocking 2 on #377).
 */
async function post(
  destination: Destination,
  url: string,
  body: Uint8Array,
  contentType: string,
  headers: Readonly<Record<string, string>>,
  opts: ExportOptions,
  stop: AbortSignal,
): Promise<boolean> {
  return await runSuppressed(async () => {
    if (stop.aborted) return false;
    const check = await checkDestination(destination, {
      allowPrivate: opts.allowPrivate,
      ...(opts.lookup === undefined ? {} : { lookup: opts.lookup }),
    });
    if (stop.aborted) return false;
    if (!check.ok) {
      note('blocked', check.reason);
      return false;
    }
    const outcome = await send(
      { url, address: check.address, body, contentType, headers },
      { signal: stop },
    );
    note(outcome);
    return outcome === 'ok';
  });
}

// ---------------------------------------------------------------------------- the exporters

/** One process, one resource: its service.instance.id is per start (14.8). */
let resource: Resource | undefined;

/** A queue that leaves every interval, holding at most EXPORT_BUFFER_MAX records. */
function batcher<T>(
  signal: Signal,
  intervalMs: number,
  sendBatch: (items: T[]) => Promise<void>,
): { push(item: T): void; flush(): Promise<void>; shutdown(): void } {
  let queue: T[] = [];
  let closed = false;
  let sending: Promise<void> = Promise.resolve();
  const flush = async (): Promise<void> => {
    await sending;
    if (closed || queue.length === 0) return;
    const items = queue;
    queue = [];
    sending = sendBatch(items).catch(() => undefined);
    await sending;
  };
  const timer = setInterval(() => void flush(), intervalMs);
  timer.unref();
  return {
    push(item) {
      if (closed) return;
      if (queue.length >= EXPORT_BUFFER_MAX) {
        countDrop(signal, 'buffer_full');
        return;
      }
      queue.push(item);
    },
    flush,
    shutdown() {
      closed = true;
      clearInterval(timer);
      queue = [];
    },
  };
}

/** The exporters for one destination: one per signal its type sends. Nothing is attached yet. */
export async function buildExporters(
  destination: Destination,
  credential: string | undefined,
  opts: ExportOptions,
): Promise<Exporters> {
  const otlp = await import('./otlp');
  const res = (resource ??= otlp.exportResource());
  const endpoints = endpointsFor(destination);
  const headers = credentialHeaders(destination, credential);
  const batchMs = opts.batchIntervalMs ?? BATCH_INTERVAL_MS;
  const sinks: Exporters['sinks'] = {};
  const parts: { flush(): Promise<void>; shutdown(): Promise<void> | void }[] = [];
  // Aborted by any stop: the whole set's, or one sink's (detached when export goes off).
  const stop = new AbortController();

  const metricsUrl = endpoints.metrics;
  if (metricsUrl !== undefined) {
    const influx = destination.type === 'influxdb' ? await import('./influx') : undefined;
    const pipeline: MetricPipeline = otlp.createMetricPipeline({
      resource: res,
      intervalMs: opts.metricIntervalMs ?? FLUSH_INTERVAL_MS,
      exportBatch: async (batch) => {
        // Nothing recorded since the start: no request, so no connection for nothing.
        if (batch.scopeMetrics.every((s) => s.metrics.length === 0)) return true;
        if (influx !== undefined) {
          const text = influx.lineProtocol(batch);
          if (text === '') return true;
          return await post(
            destination,
            metricsUrl,
            Buffer.from(text),
            LINE_PROTOCOL,
            headers,
            opts,
            stop.signal,
          );
        }
        return await post(
          destination,
          metricsUrl,
          otlp.encodeMetrics(batch),
          PROTOBUF,
          headers,
          opts,
          stop.signal,
        );
      },
    });
    sinks.metrics = {
      record: (metric, value, attributes) =>
        pipeline.record(
          metric,
          value,
          exportAttributes('metrics', attributes, metricDef(metric).attributes, countDrop),
        ),
      shutdown: () => {
        stop.abort();
        return pipeline.shutdown();
      },
    };
    parts.push(pipeline);
  }

  const spansUrl = endpoints.spans;
  if (spansUrl !== undefined) {
    const queue = batcher<GatedSpan>('spans', batchMs, async (spans) => {
      await post(
        destination,
        spansUrl,
        otlp.encodeSpans(spans, res),
        PROTOBUF,
        headers,
        opts,
        stop.signal,
      );
    });
    sinks.spans = {
      export: (span) =>
        queue.push({
          ...span,
          name: exportSpanName(span.name),
          attributes: exportAttributes('spans', span.attributes, undefined, countDrop),
        }),
      shutdown: async () => {
        stop.abort();
        queue.shutdown();
      },
    };
    parts.push(queue);
  }

  const logsUrl = endpoints.logs;
  if (logsUrl !== undefined) {
    const queue = batcher<GatedLogRecord>('logs', batchMs, async (records) => {
      await post(
        destination,
        logsUrl,
        otlp.encodeLogs(records, res),
        PROTOBUF,
        headers,
        opts,
        stop.signal,
      );
    });
    sinks.logs = {
      emit: (record) =>
        queue.push({
          ...record,
          fields: exportAttributes('logs', record.fields, eventDef(record.event).fields, countDrop),
        }),
      shutdown: async () => {
        stop.abort();
        queue.shutdown();
      },
    };
    parts.push(queue);
  }

  let stopped = false;
  return {
    sinks,
    flush: async () => {
      for (const p of parts) await p.flush();
    },
    shutdown: async () => {
      if (stopped) return;
      stopped = true;
      stop.abort();
      await Promise.allSettled(parts.map((p) => p.shutdown()));
    },
  };
}

// ---------------------------------------------------------------------------- applying the settings

let current: Exporters | undefined;
/** One apply at a time: a save and a Collect change can arrive together. */
let applying: Promise<void> = Promise.resolve();

export interface ExportDeployment {
  demo: boolean;
  telemetryAllowPrivate: boolean;
}

/**
 * Applies the stored settings to this process at once: export is on only while Collect is, the
 * stored switch is on, a destination is set, and the deployment is not the demo (rule 6).
 * Anything already running is stopped first, so a change of destination never sends to the old
 * one again.
 */
export function applyExport(
  db: Db,
  deployment: ExportDeployment,
  over: Partial<ExportOptions> = {},
): Promise<void> {
  applying = applying
    .catch(() => undefined)
    .then(async () => {
      await stopRunning();
      const stored = await readExport(db);
      if (deployment.demo || !isCollecting() || !stored.enabled || stored.destination === null) {
        return;
      }
      let credential: string | undefined;
      try {
        credential = credentialOf(db, stored);
      } catch {
        // A credential the vault key cannot open (a rotated or replaced key): send nothing
        // rather than send without it, and say so as an authentication failure.
        note('auth');
        return;
      }
      const ex = await buildExporters(stored.destination, credential, {
        allowPrivate: deployment.telemetryAllowPrivate,
        ...over,
      });
      const attached = Object.entries(ex.sinks).every(([signal, sink]) =>
        attachExporter(signal as Signal, sink as never),
      );
      if (!attached) {
        // Collect went off while this was being built: nothing may stay attached.
        await stopRunningExporters(ex);
        return;
      }
      current = ex;
    });
  return applying;
}

async function stopRunningExporters(ex: Exporters): Promise<void> {
  for (const signal of SIGNALS) await detachExporter(signal);
  await ex.shutdown();
}

async function stopRunning(): Promise<void> {
  const ex = current;
  current = undefined;
  if (ex !== undefined) await stopRunningExporters(ex);
}

/** Stops export in this process (the app's close, and tests). */
export async function stopExport(): Promise<void> {
  applying = applying.catch(() => undefined).then(stopRunning);
  await applying;
}

/** Sends what the running exporters hold now. */
export async function flushExport(): Promise<void> {
  await current?.flush();
}

/** A test send's outcome class, and why when the destination check blocked it. */
export interface TestOutcome {
  outcome: SendOutcome | 'no_destination';
  reason?: DestinationRefusal;
}

/**
 * "Send a test" (rule 7): one request to the stored destination's first endpoint, with an empty
 * batch, reporting its outcome class only.
 */
export async function sendTest(
  db: Db,
  deployment: ExportDeployment,
  over: Partial<ExportOptions> = {},
): Promise<TestOutcome> {
  const stored = await readExport(db);
  if (stored.destination === null) return { outcome: 'no_destination' };
  const destination = stored.destination;
  const endpoints = endpointsFor(destination);
  const url = endpoints.metrics ?? endpoints.spans ?? endpoints.logs;
  if (url === undefined) return { outcome: 'no_destination' };
  let credential: string | undefined;
  try {
    credential = credentialOf(db, stored);
  } catch {
    return { outcome: 'auth' };
  }
  return await runSuppressed(async (): Promise<TestOutcome> => {
    const check = await checkDestination(destination, {
      allowPrivate: deployment.telemetryAllowPrivate,
      ...(over.lookup === undefined ? {} : { lookup: over.lookup }),
    });
    // Blocked says why, as a closed reason (#382): the admin asked, and is told what to fix.
    if (!check.ok) return { outcome: 'blocked', reason: check.reason };
    // An empty OTLP request is a valid, empty message; an empty write is valid line protocol.
    const outcome = await send({
      url,
      address: check.address,
      body: new Uint8Array(),
      contentType: destination.type === 'influxdb' ? LINE_PROTOCOL : PROTOBUF,
      headers: credentialHeaders(destination, credential),
    });
    return { outcome };
  });
}
