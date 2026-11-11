// What the rest of the server calls for observability (design.md 14.3; issue
// https://github.com/bgoleno/opportun/issues/353): obs.record(), obs.span(), obs.event(), and the
// slots where an exporter attaches for each signal.
//
// Collection is off by default (the owner's spec on #353), and with it off every entry point
// returns after one boolean check (14.11, NFR-OPS7): no aggregator, no timer, no writes, no
// recording span, no log record. startObs() reads the Collect switch once at boot, and
// setCollecting() applies a change at once, so turning it on or off needs no restart.
//
// One process, one runtime: the server binds it to its database at boot (app.ts), and the module
// state below is that binding. A test that builds an app binds it to that app's database.
import { AsyncLocalStorage } from 'node:async_hooks';
import { trace, SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { Db } from '../db/client';
import {
  type Attributes,
  type AttrKey,
  type DropReason,
  eventDef,
  type EventName,
  metricDef,
  type MetricName,
  type Signal,
  spanDef,
  type SpanName,
  withoutLocalOnly,
} from './catalog';
import { gateAttributes } from './gate';
import { flushPoints, MetricAggregator } from './metrics';

/** The logger obs.event() writes to: today's (app.log, pino). FR-T5 moves it to obs/log.ts. */
export interface ObsLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Exporter slots (14.12): where FR-T2 attaches an exporter for each signal. Each slot receives
// records that already passed the gate, with their local-only keys removed (user.id and every
// other id not marked exportable, client.address): export identifies no user (14.8).

/** A metric value for export: the same gated call obs.record() stores, without its owner. */
export interface MetricExportSink {
  record(metric: MetricName, value: number, attributes: Attributes): void;
  shutdown(): Promise<void>;
}

/** A finished span, rebuilt from checked values only (14.8). FR-T4 part 2 builds them. */
export interface GatedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  startMs: number;
  durationMs: number;
  status: 'ok' | 'error';
  attributes: Attributes;
}

export interface SpanExportSink {
  export(span: GatedSpan): void;
  shutdown(): Promise<void>;
}

/** An event or error record (14.9). Exported records are events and errors only. */
export interface GatedLogRecord {
  event: EventName;
  timeMs: number;
  traceId: string | null;
  fields: Attributes;
}

export interface LogExportSink {
  emit(record: GatedLogRecord): void;
  shutdown(): Promise<void>;
}

interface Sinks {
  metrics?: MetricExportSink;
  spans?: SpanExportSink;
  logs?: LogExportSink;
}

// ---------------------------------------------------------------------------
// State

interface Runtime {
  db: Db;
  log: ObsLogger;
  now: () => number;
  flushIntervalMs: number;
}

let collecting = false;
let runtime: Runtime | undefined;
let aggregator: MetricAggregator | undefined;
let timer: NodeJS.Timeout | undefined;
let flushing: Promise<void> = Promise.resolve();
const sinks: Sinks = {};

export const FLUSH_INTERVAL_MS = 60_000;

/** Telemetry about telemetry is suppressed (14.6): the store's writes run inside this. */
const suppressed = new AsyncLocalStorage<true>();

export function runSuppressed<T>(fn: () => T): T {
  return suppressed.run(true, fn);
}

/** True inside the store's own writes, which the database and outbound wrappers skip. */
export function isSuppressed(): boolean {
  return suppressed.getStore() === true;
}

/** Whether collection is on: the one check every entry point makes first. */
export function isCollecting(): boolean {
  return collecting;
}

function countDrop(signal: Signal, reason: DropReason): void {
  if (!collecting || aggregator === undefined || runtime === undefined) return;
  // Known-good attributes, so straight to the aggregator, and always admitted past the series
  // cap: a drop must stay countable when the buffer is full.
  aggregator.add(
    'opportun.obs.dropped',
    1,
    { 'opportun.obs.signal': signal, 'opportun.obs.reason': reason },
    null,
    runtime.now(),
    true,
  );
}

async function flush(): Promise<void> {
  if (runtime === undefined || aggregator === undefined) return;
  const points = aggregator.drain();
  if (points.length === 0) return;
  const { db } = runtime;
  await runSuppressed(() => flushPoints(db, points));
}

/** Flushes now, after any flush already running (tests, and the stop path). */
export async function flushNow(): Promise<void> {
  flushing = flushing.then(flush, flush);
  await flushing;
}

async function shutdownSinks(): Promise<void> {
  const all = [sinks.metrics, sinks.spans, sinks.logs];
  sinks.metrics = undefined;
  sinks.spans = undefined;
  sinks.logs = undefined;
  await Promise.allSettled(all.map((s) => s?.shutdown()));
}

/**
 * Turns collection on or off for this process, at once. Off drops what waits unflushed (with it
 * off nothing may be written) and shuts every exporter down: export is on only while
 * collection is (14.1).
 */
export async function setCollecting(on: boolean): Promise<void> {
  if (on === collecting) return;
  if (on) {
    if (runtime === undefined) throw new Error('obs: setCollecting(true) before startObs');
    aggregator = new MetricAggregator();
    collecting = true;
    timer = setInterval(() => {
      void flushNow().catch(() => undefined);
    }, runtime.flushIntervalMs);
    timer.unref();
    return;
  }
  collecting = false;
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  aggregator = undefined;
  await shutdownSinks();
}

export interface StartObsOptions {
  log: ObsLogger;
  /** The Collect switch as stored (obs/config.ts readCollect). */
  collect: boolean;
  now?: () => number;
  flushIntervalMs?: number;
}

/** Binds observability to the server's database and logger, and applies the Collect switch. */
export async function startObs(db: Db, opts: StartObsOptions): Promise<void> {
  await stopObs();
  runtime = {
    db,
    log: opts.log,
    now: opts.now ?? Date.now,
    flushIntervalMs: opts.flushIntervalMs ?? FLUSH_INTERVAL_MS,
  };
  await setCollecting(opts.collect);
}

/**
 * Flushes what waits and unbinds (the app's onClose). Given a database, it stops only when that
 * is the one bound: an app closing after another started must not unbind the newer one.
 */
export async function stopObs(db?: Db): Promise<void> {
  if (db !== undefined && runtime?.db !== db) return;
  if (collecting) await flushNow().catch(() => undefined);
  await setCollecting(false);
  runtime = undefined;
}

/**
 * Attaches an exporter to a signal's slot (FR-T2). Refused while collection is off: there is
 * nothing to export, and export may be on only while collection is. Returns whether it attached.
 */
export function attachExporter<S extends Signal>(signal: S, sink: Required<Sinks>[S]): boolean {
  if (!collecting) return false;
  if (signal === 'metrics') sinks.metrics = sink as MetricExportSink;
  else if (signal === 'spans') sinks.spans = sink as SpanExportSink;
  else sinks.logs = sink as LogExportSink;
  return true;
}

export async function detachExporter(signal: Signal): Promise<void> {
  const sink = signal === 'metrics' ? sinks.metrics : signal === 'spans' ? sinks.spans : sinks.logs;
  if (signal === 'metrics') sinks.metrics = undefined;
  else if (signal === 'spans') sinks.spans = undefined;
  else sinks.logs = undefined;
  await sink?.shutdown();
}

/** Which signals have an exporter attached. */
export function attachedExporters(): Signal[] {
  return (['metrics', 'spans', 'logs'] as const).filter((s) =>
    s === 'metrics' ? sinks.metrics : s === 'spans' ? sinks.spans : sinks.logs,
  );
}

// ---------------------------------------------------------------------------
// Entry points

/**
 * Records one value of a catalogued metric. `userId` is the owner of a user-scoped metric's
 * point (14.7); it is never an attribute, and the exported value never has it.
 */
function record(
  metric: MetricName,
  value: number,
  attributes?: Readonly<Record<string, unknown>>,
  opts: { userId?: string } = {},
): void {
  if (!collecting) return;
  if (aggregator === undefined || runtime === undefined) return;
  if (!Number.isFinite(value)) {
    countDrop('metrics', 'invalid_value');
    return;
  }
  const def = metricDef(metric);
  const gated = gateAttributes('metrics', def.attributes, attributes, countDrop);
  const owner = def.scope === 'user' ? (opts.userId ?? null) : null;
  if (def.scope === 'user' && owner === null) {
    countDrop('metrics', 'invalid_value');
    return;
  }
  if (!aggregator.add(metric, value, gated, owner, runtime.now())) {
    countDrop('metrics', 'series_cap');
    return;
  }
  sinks.metrics?.record(metric, value, withoutLocalOnly(gated));
}

/** A started span's handle: further attributes pass the same gate. */
export interface ObsSpan {
  set(attributes: Readonly<Record<string, unknown>>): void;
  /** Marks the span failed with a class or code, never a message (14.8). */
  fail(errorType: string): void;
}

const NOOP_SPAN: ObsSpan = { set: () => undefined, fail: () => undefined };

const KINDS = {
  server: SpanKind.SERVER,
  client: SpanKind.CLIENT,
  internal: SpanKind.INTERNAL,
  consumer: SpanKind.CONSUMER,
  producer: SpanKind.PRODUCER,
} as const;

/** A span name from its template, filled with checked values only. */
function spanName(template: string, attributes: Attributes): string {
  return template.replace(/\{([a-z._]+)\}/g, (_m, key: string) => {
    const v = (attributes as Record<string, unknown>)[key as AttrKey];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  });
}

/**
 * Runs `fn` inside a span of a catalogued kind. With collection off it only runs `fn`. The span
 * uses the OpenTelemetry API: until a provider is registered (FR-T4 part 2) it records nothing.
 */
async function span<T>(
  name: SpanName,
  attributes: Readonly<Record<string, unknown>>,
  fn: (span: ObsSpan) => Promise<T>,
): Promise<T> {
  if (!collecting || isSuppressed()) return fn(NOOP_SPAN);
  const def = spanDef(name);
  const gated = gateAttributes('spans', def.attributes, attributes, countDrop);
  const tracer = trace.getTracer('opportun');
  return tracer.startActiveSpan(
    spanName(def.template, gated),
    { kind: KINDS[def.kind], attributes: gated as Record<string, string | number | boolean> },
    async (s: Span) => {
      // A failure the callee already recorded (an outbound error's code) stands: the catch
      // below must not replace it with the rethrown error's class name.
      let failed = false;
      const handle: ObsSpan = {
        set: (more) => {
          s.setAttributes(
            gateAttributes('spans', def.attributes, more, countDrop) as Record<
              string,
              string | number | boolean
            >,
          );
        },
        fail: (errorType) => {
          failed = true;
          const checked = gateAttributes(
            'spans',
            def.attributes,
            { 'error.type': errorType },
            countDrop,
          );
          s.setAttributes(checked as Record<string, string>);
          s.setStatus({ code: SpanStatusCode.ERROR });
        },
      };
      try {
        return await fn(handle);
      } catch (err) {
        if (!failed) handle.fail(err instanceof Error ? err.name : 'Error');
        throw err;
      } finally {
        s.end();
      }
    },
  );
}

/** The active span's W3C traceparent, for enqueue's continueTrace (14.6); null when none. */
export function currentTraceparent(): string | null {
  if (!collecting) return null;
  const ctx = trace.getActiveSpan()?.spanContext();
  if (ctx === undefined || !trace.isSpanContextValid(ctx)) return null;
  return `00-${ctx.traceId}-${ctx.spanId}-${(ctx.traceFlags & 0xff).toString(16).padStart(2, '0')}`;
}

/**
 * Writes one structured event record (14.9) through the gate to the logger: the event name, the
 * time, the user's id, the trace id when there is one, and the event's catalogued fields.
 */
function event(
  name: EventName,
  fields: Readonly<Record<string, unknown>> = {},
  opts: { userId?: string } = {},
): void {
  if (!collecting || runtime === undefined) return;
  const gated = gateAttributes('logs', eventDef(name).fields, fields, countDrop);
  const user = gateAttributes('logs', ['user.id'], { 'user.id': opts.userId }, countDrop);
  const ctx = trace.getActiveSpan()?.spanContext();
  const traceId = ctx !== undefined && trace.isSpanContextValid(ctx) ? ctx.traceId : null;
  const timeMs = runtime.now();
  runtime.log.info(
    { event: name, ...gated, ...user, ...(traceId === null ? {} : { trace_id: traceId }) },
    name,
  );
  sinks.logs?.emit({ event: name, timeMs, traceId, fields: withoutLocalOnly(gated) });
}

export const obs = { record, span, event, isCollecting };
